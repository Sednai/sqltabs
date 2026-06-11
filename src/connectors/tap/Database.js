/*
  Copyright (C) 2026  Sednai Sàrl

      This program is free software: you can redistribute it and/or modify
      it under the terms of the GNU General Public License as published by
      the Free Software Foundation, either version 3 of the License, or
      (at your option) any later version.

      This program is distributed in the hope that it will be useful,
      but WITHOUT ANY WARRANTY; without even the implied warranty of
      MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
      GNU General Public License for more details.

      You should have received a copy of the GNU General Public License
      along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

// Connector for IVOA TAP (Table Access Protocol) services that speak ADQL over HTTP,
// such as the ESA Gaia archive. Unlike the SQL-wire connectors this talks plain HTTP to
// a /sync endpoint; results are requested as CSV so values arrive as exact text -- which
// matters because Gaia source_id is a 64-bit integer that JSON's doubles would corrupt.
//
// Connection strings:
//   gaia://                       -> ESA Gaia archive TAP, anonymous
//   gaia://<username>             -> ESA Gaia archive TAP, authenticated (password prompted)
//   tap://host/path , taps://...  -> any IVOA TAP service (optionally tap://user@host/path)
//
// Authentication mirrors the Postgres flow: the connstr carries the username, the app
// prompts for the password (stored encrypted in ~/.sqltabs/config.json, never in the repo),
// and we POST it to the service's /login endpoint to obtain a JSESSIONID session cookie,
// which is then attached to every request. An authenticated session also exposes the user's
// personal "user_<name>" tables (saved/uploaded results) in TAP_SCHEMA.

var https = require('https');
var http = require('http');
var url = require('url');
var async = require('async');
var Words = require('./keywords.js');

var TAP_SYNC_TIMEOUT = 120000;            // abort a sync request after 2 min
var InFlight = {};                        // id -> http request, so cancelQuery(id) can abort
var Sessions = {};                        // "base|user" -> "JSESSIONID=..." session cookie
var SchemaWords = {};                     // "base|user" -> cached completion words

// Parse a connection string into { user, base } where base is the TAP endpoint root.
function parseConn(connstr){
    var s = (connstr || '').split('---')[0].trim(); // drop any "--- alias" suffix
    var user = null, base;
    if (s.indexOf('gaia://') === 0){
        var rest = s.slice(7);
        if (rest){ user = rest.split('/')[0].split('@')[0] || null; }
        base = 'https://gea.esac.esa.int/tap-server/tap';
    } else {
        var off = s.indexOf('taps://') === 0 ? 7 : (s.indexOf('tap://') === 0 ? 6 : 0);
        var rest2 = off ? s.slice(off) : s;
        var slash = rest2.indexOf('/');
        var authority = slash >= 0 ? rest2.slice(0, slash) : rest2;
        var pathpart = slash >= 0 ? rest2.slice(slash) : '';
        var at = authority.indexOf('@');
        if (at >= 0){ user = authority.slice(0, at) || null; authority = authority.slice(at + 1); }
        base = 'https://' + authority + pathpart;
    }
    return { user: user, base: base.replace(/\/+$/, '') };
}
function sessionKey(c){ return c.base + '|' + (c.user || ''); }
function loginUrl(c){ return /\/tap$/.test(c.base) ? c.base.replace(/\/tap$/, '/login') : c.base + '/login'; }

// Minimal RFC-4180 CSV parser -> array of rows (each an array of string fields). Handles
// quoted fields containing commas, embedded newlines and doubled ("") quotes.
function parseCSV(text){
    var rows = [], row = [], field = '', i = 0, q = false, n = text.length;
    while (i < n){
        var c = text[i];
        if (q){
            if (c === '"'){
                if (text[i + 1] === '"'){ field += '"'; i += 2; continue; }
                q = false; i++; continue;
            }
            field += c; i++; continue;
        }
        if (c === '"'){ q = true; i++; continue; }
        if (c === ','){ row.push(field); field = ''; i++; continue; }
        if (c === '\r'){ i++; continue; }
        if (c === '\n'){ row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
        field += c; i++;
    }
    if (field.length > 0 || row.length > 0){ row.push(field); rows.push(row); }
    return rows;
}

// A TAP error comes back as a VOTABLE with <INFO ... value="ERROR">message</INFO>.
function errorFromBody(status, body){
    var m = /<INFO name="QUERY_STATUS" value="ERROR">([\s\S]*?)<\/INFO>/.exec(body || '');
    if (m){ return m[1].trim(); }
    if (body && body.trim()){ return body.trim().slice(0, 1000); }
    return 'TAP request failed (HTTP ' + status + ')';
}

function encodeParams(params){
    return Object.keys(params).map(function(k){ return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
}

// Low-level form POST. cookie (optional) authenticates; id (optional) registers the request
// for cancelQuery. onResp(status, headers, text) / onErr(message).
function httpPost(urlStr, params, cookie, id, onResp, onErr){
    var u = url.parse(urlStr);
    var body = encodeParams(params);
    var lib = (u.protocol === 'http:') ? http : https;
    var headers = {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Accept': 'text/csv, */*'
    };
    if (cookie){ headers['Cookie'] = cookie; }
    var settled = false;
    var finish = function(fn, a, b, c){
        if (settled){ return; }
        settled = true;
        if (id != null){ delete InFlight[id]; }
        fn(a, b, c);
    };
    var req = lib.request({ method: 'POST', hostname: u.hostname, port: u.port, path: u.path, headers: headers }, function(res){
        var chunks = [];
        res.on('data', function(d){ chunks.push(d); });
        res.on('end', function(){ finish(onResp, res.statusCode, res.headers, Buffer.concat(chunks).toString('utf8')); });
    });
    req.on('error', function(e){ finish(onErr, e.message); });
    req.setTimeout(TAP_SYNC_TIMEOUT, function(){ req.destroy(new Error('TAP request timed out after ' + (TAP_SYNC_TIMEOUT / 1000) + 's')); });
    if (id != null){ InFlight[id] = req; }
    req.write(body);
    req.end();
}

function extractSessionCookie(headers){
    var sc = headers['set-cookie'];
    if (!sc){ return null; }
    for (var i = 0; i < sc.length; i++){
        var m = /JSESSIONID=([^;]+)/.exec(sc[i]);
        if (m){ return 'JSESSIONID=' + m[1]; }
    }
    return null;
}

// The app's PasswordDialog stores passwords URL-encoded (so they can be embedded in a
// connstr); decode before use, exactly like the postgres connector (PqClient `dec`) does.
function decodeSecret(pw){
    if (pw == null){ return pw; }
    try { return decodeURIComponent(pw); } catch (e){ return pw; }
}

// POST username/password to the service's /login endpoint; on success cache the JSESSIONID.
// ok(cookie) / fail({status, msg}).
function tapLogin(connstr, password, ok, fail){
    var c = parseConn(connstr);
    httpPost(loginUrl(c), { username: c.user, password: decodeSecret(password) }, null, null,
        function(status, headers, text){
            if (status >= 200 && status < 300){
                var cookie = extractSessionCookie(headers);
                if (cookie){
                    Sessions[sessionKey(c)] = cookie;
                    delete SchemaWords[sessionKey(c)]; // refetch completion now that user tables are visible
                    ok(cookie);
                } else {
                    fail({ status: status, msg: 'login succeeded but no session cookie was returned' });
                }
            } else {
                fail({ status: status, msg: status === 401 ? 'Bad credentials' : errorFromBody(status, text) });
            }
        },
        function(e){ fail({ status: 0, msg: e }); });
}

// Resolve a usable session cookie (cached, freshly logged-in, or null for anonymous).
function ensureSession(connstr, password, ok, fail){
    var c = parseConn(connstr);
    if (!c.user){ ok(null); return; }                       // anonymous endpoint/connstr
    var cached = Sessions[sessionKey(c)];
    if (cached){ ok(cached); return; }                      // reuse the established session
    if (password){ tapLogin(connstr, password, ok, fail); return; }
    ok(null);                                               // no session yet, no password: best-effort anonymous
}

// POST an ADQL query to /sync. ok(csvText) / fail(message). Re-logs-in once on a 401 when a
// password is available (session expired); id (optional) makes the request cancellable.
function tapSync(connstr, query, password, id, ok, fail){
    var c = parseConn(connstr);
    var run = function(cookie, allowRetry){
        httpPost(c.base + '/sync', { REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'csv', QUERY: query }, cookie, id,
            function(status, headers, text){
                if (status === 401 && c.user && password && allowRetry){ // session expired -> re-login once
                    delete Sessions[sessionKey(c)];
                    tapLogin(connstr, password, function(fresh){ run(fresh, false); }, function(e){ fail(e.msg || 'login failed'); });
                    return;
                }
                var looksXml = /^\s*</.test(text); // TAP errors come back as a VOTABLE document
                if (status >= 200 && status < 300 && !looksXml){ ok(text); }
                else { fail(errorFromBody(status, text)); }
            },
            function(e){ fail(e); });
    };
    ensureSession(connstr, password, function(cookie){ run(cookie, true); }, function(e){ fail(e.msg || 'login failed'); });
}

var Response = function(query){
    this.connector_type = "tap";
    this.query = query;
    this.datasets = [];
    this.start_time = performance.now();
    this.duration = null;
    var self = this;
    this.finish = function(){ self.duration = Math.round((performance.now() - self.start_time) * 1000) / 1000; };
};

// Build a result dataset (in the shape the grid expects) from a TAP CSV body.
function csvDataset(csvText){
    var rows = parseCSV(csvText);
    if (rows.length === 0){
        return { nrecords: 0, fields: [], explain: false, data: [], cmdStatus: null, resultStatus: null, resultErrorMessage: null };
    }
    var header = rows[0];
    var fields = header.map(function(name){ return { name: name, type: 'string' }; });
    var data = rows.slice(1);
    return { nrecords: data.length, fields: fields, explain: false, data: data, cmdStatus: null, resultStatus: null, resultErrorMessage: null };
}

var Database = {

    testConnection: function(id, connstr, password, callback, ask_password_callback, err_callback){
        var c = parseConn(connstr);
        if (c.user){
            if (!password){ ask_password_callback(id, 'Login required for ' + c.user); return; }
            tapLogin(connstr, password,
                function(){ callback(id, new Response()); },
                function(e){
                    if (e.status === 401){ ask_password_callback(id, 'Bad credentials for ' + c.user); }
                    else { err_callback(id, e.msg || 'login failed'); }
                });
        } else {
            // anonymous: a tiny ADQL probe confirms the endpoint actually speaks TAP/ADQL
            tapSync(connstr, 'SELECT TOP 1 table_name FROM tap_schema.tables', undefined, null,
                function(){ callback(id, new Response()); },
                function(msg){ err_callback(id, msg); });
        }
    },

    runQuery: function(id, connstr, password, query, callback, err_callback){
        var response = new Response(query);
        tapSync(connstr, query, password, id,
            function(csvText){
                response.finish();
                response.datasets.push(csvDataset(csvText));
                callback(id, [response]);
            },
            function(msg){ err_callback(id, msg); });
    },

    cancelQuery: function(id){
        var req = InFlight[id];
        if (req){ delete InFlight[id]; try { req.destroy(new Error('cancelled')); } catch (e){ /* already gone */ } }
    },

    runBlocks: function(id, connstr, password, blocks, callback, err_callback){
        var self = this;
        var results = [];
        var calls = blocks.map(function(block){
            return function(done){
                self.runQuery(id, connstr, password, block,
                    function(id, result){ results.push(result[0]); done(); },
                    function(id, err){ err_callback(err); done(); });
            };
        });
        async.series(calls, function(){ callback(id, results); });
    },

    getObjectInfo: function(id, connstr, password, object, callback, err_callback){
        // Ctrl+I on a TAP table -> its columns, from TAP_SCHEMA (authenticated, so the
        // user's own user_<name> tables work too). Strip trailing ';' and any quotes.
        var tbl = String(object == null ? '' : object).trim().replace(/;+\s*$/, '').replace(/"/g, '');
        if (!tbl){
            err_callback(id, 'Put the cursor on a table name (e.g. gaiadr3.gaia_source) and press Ctrl/Cmd+I');
            return;
        }
        var q = "SELECT column_name, datatype, size, unit, description FROM tap_schema.columns " +
                "WHERE table_name = '" + tbl.replace(/'/g, "''") + "' ORDER BY column_index";
        tapSync(connstr, q, password, null,
            function(csvText){
                var rows = parseCSV(csvText);
                if (rows.length <= 1){ // header only -> unknown table
                    callback(id, { object_type: 'relation', object: null, object_name: tbl });
                    return;
                }
                var columns = [];
                for (var i = 1; i < rows.length; i++){
                    var r = rows[i]; // [column_name, datatype, size, unit, description]
                    var unit = r[3], descr = r[4] || '';
                    if (unit){ descr = '[' + unit + '] ' + descr; }
                    var len = (r[1] === 'char' && r[2] && (+r[2]) > 1) ? r[2] : '-1';
                    columns.push({ name: r[0], type: r[1], not_null: 'f', max_length: len, default_value: null, description: descr || null });
                }
                callback(id, {
                    object_type: 'relation',
                    object_name: tbl,
                    object: {
                        relkind: 'r', columns: columns,
                        pk: null, check_constraints: null, foreign_keys: null,
                        indexes: null, triggers: null, records: null, size: null, total_size: null
                    }
                });
            },
            function(msg){ err_callback(id, msg); });
    },

    getCompletionWords: function(callback){
        var connstr = this.connstr;
        var c = parseConn(connstr);
        var key = sessionKey(c);
        if (SchemaWords[key]){ callback(SchemaWords[key]); return; } // schema is static per (endpoint,user)

        var words = Words.slice();
        var seen = new Set(words);
        var addNames = function(csvText){
            var rows = parseCSV(csvText);
            for (var i = 1; i < rows.length; i++){ // skip header
                var w = rows[i][0];
                if (w && !seen.has(w)){ seen.add(w); words.push(w); }
            }
        };
        // table names then column names from TAP_SCHEMA (authenticated if a session exists,
        // so the user's own user_<name> tables are included); cache the merged list.
        tapSync(connstr, 'SELECT table_name FROM tap_schema.tables', undefined, null, function(t1){
            addNames(t1);
            tapSync(connstr, 'SELECT DISTINCT column_name FROM tap_schema.columns', undefined, null, function(t2){
                addNames(t2);
                SchemaWords[key] = words;
                callback(words);
            }, function(){ SchemaWords[key] = words; callback(words); });
        }, function(){ callback(Words); });
    }
};

module.exports = Database;
