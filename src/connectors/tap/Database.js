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
//   gaia://                       -> ESA Gaia archive TAP (https://gea.esac.esa.int/tap-server/tap)
//   tap://host/path , taps://...  -> https://host/path  (any IVOA TAP service)

var https = require('https');
var http = require('http');
var url = require('url');
var async = require('async');
var Words = require('./keywords.js');

var TAP_SYNC_TIMEOUT = 120000;            // abort a sync request after 2 min
var InFlight = {};                        // id -> http request, so cancelQuery(id) can abort
var SchemaWords = {};                     // tapBase -> cached completion words (schema is static)

// Resolve a connection string to a TAP base URL (without the trailing /sync).
function tapBase(connstr){
    connstr = (connstr || '').split('---')[0].trim(); // drop any "--- alias" suffix
    if (connstr.indexOf('gaia://') === 0){ return 'https://gea.esac.esa.int/tap-server/tap'; }
    if (connstr.indexOf('taps://') === 0){ return 'https://' + connstr.slice(7); }
    if (connstr.indexOf('tap://')  === 0){ return 'https://' + connstr.slice(6); }
    return connstr;
}
function syncUrl(connstr){ return tapBase(connstr).replace(/\/+$/, '') + '/sync'; }

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

// POST an ADQL query to the TAP /sync endpoint. ok(csvText) / fail(message).
// When id != null the request is registered so cancelQuery(id) can abort it.
function tapSync(connstr, query, id, ok, fail){
    var u = url.parse(syncUrl(connstr));
    var params = { REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'csv', QUERY: query };
    var body = Object.keys(params).map(function(k){ return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
    var lib = (u.protocol === 'http:') ? http : https;
    var settled = false;
    var settle = function(fn, arg){
        if (settled){ return; }
        settled = true;
        if (id != null){ delete InFlight[id]; }
        fn(arg);
    };

    var req = lib.request({
        method: 'POST', hostname: u.hostname, port: u.port, path: u.path,
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body),
            'Accept': 'text/csv, */*'
        }
    }, function(res){
        var chunks = [];
        res.on('data', function(d){ chunks.push(d); });
        res.on('end', function(){
            var text = Buffer.concat(chunks).toString('utf8');
            var looksXml = /^\s*</.test(text); // TAP errors are returned as a VOTABLE document
            if (res.statusCode >= 200 && res.statusCode < 300 && !looksXml){ settle(ok, text); }
            else { settle(fail, errorFromBody(res.statusCode, text)); }
        });
    });
    req.on('error', function(e){ settle(fail, e.message); });
    req.setTimeout(TAP_SYNC_TIMEOUT, function(){ req.destroy(new Error('TAP request timed out after ' + (TAP_SYNC_TIMEOUT / 1000) + 's')); });
    if (id != null){ InFlight[id] = req; }
    req.write(body);
    req.end();
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

    testConnection: function(id, connstr, password, callback, ask_password_callback, err_callback){ // eslint-disable-line no-unused-vars
        // a tiny ADQL probe confirms the endpoint actually speaks TAP/ADQL
        tapSync(connstr, 'SELECT TOP 1 table_name FROM tap_schema.tables', null,
            function(){ callback(id, new Response()); },
            function(msg){ err_callback(id, msg); });
    },

    runQuery: function(id, connstr, password, query, callback, err_callback){ // eslint-disable-line no-unused-vars
        var response = new Response(query);
        tapSync(connstr, query, id,
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

    getObjectInfo: function(id, connstr, password, object, callback, err_callback){ // eslint-disable-line no-unused-vars
        err_callback(id, "Object info is not yet supported for TAP/ADQL");
    },

    getCompletionWords: function(callback){
        var connstr = this.connstr;
        var base = tapBase(connstr);
        if (SchemaWords[base]){ callback(SchemaWords[base]); return; } // schema is static: fetch once

        var words = Words.slice();
        var seen = new Set(words);
        var addNames = function(csvText){
            var rows = parseCSV(csvText);
            for (var i = 1; i < rows.length; i++){ // skip header
                var w = rows[i][0];
                if (w && !seen.has(w)){ seen.add(w); words.push(w); }
            }
        };
        // table names, then column names, from TAP_SCHEMA; cache the merged list
        tapSync(connstr, 'SELECT table_name FROM tap_schema.tables', null, function(t1){
            addNames(t1);
            tapSync(connstr, 'SELECT DISTINCT column_name FROM tap_schema.columns', null, function(t2){
                addNames(t2);
                SchemaWords[base] = words;
                callback(words);
            }, function(){ SchemaWords[base] = words; callback(words); });
        }, function(){ callback(Words); });
    }
};

module.exports = Database;
