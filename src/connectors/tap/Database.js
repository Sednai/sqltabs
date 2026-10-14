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
//   gaiapre://[<username>]        -> ESA Gaia pre-release archive (geapre.esac.esa.int)
//   tap://host/path , taps://...  -> any IVOA TAP service (optionally tap://user@host/path)
//
// Sync vs async: by default a query goes to /sync, which the service aborts at its own
// short server-side limit (expensive COUNT/JOIN -> "Job timeout/aborted." from the
// service). Prefix the block marker with `async` to run it via the UWS /async endpoint
// instead -- the job is queued server-side with a much longer allowance and we poll for
// completion. `async` is an EXECUTION directive and composes with the SqlDoc RENDER
// markers, so you can mix them:
//   --- async                     run via /async, render as a table
//   --- async chart line x y       run via /async, render as a chart
// (cancelling the query aborts the job server-side via PHASE=ABORT).
//
// Authentication mirrors the Postgres flow: the connstr carries the username, the app
// prompts for the password (stored encrypted in ~/.sqltabs/config.json, never in the repo),
// and we POST it to the service's /login endpoint to obtain a JSESSIONID session cookie,
// which is then attached to every request. An authenticated session also exposes the user's
// personal "user_<name>" tables (saved/uploaded results) in TAP_SCHEMA.

var https = require('https');
var http = require('http');
var url = require('url');
var crypto = require('crypto');
var zlib = require('zlib');
var async = require('async');
var Words = require('./keywords.js');
var Config = require('../../Config'); // stored secret, so TAP_SCHEMA is readable on auth-only archives
var SchemaCache = require('../../SchemaCache'); // last known word list, so a new session completes at once

var TAP_SYNC_TIMEOUT = 120000;            // abort a sync request after 2 min
var InFlight = {};                        // id -> http request, so cancelQuery(id) can abort
var AsyncJobs = {};                        // id -> {cancelled, base, jobUrl, cookie, timer} for /async cancellation
var Sessions = {};                        // "base|user" -> "JSESSIONID=..." tap-server session cookie
var DataSessions = {};                    // "base|user" -> data-server (DataLink) session cookie
var SchemaWords = {};                     // "base|user" -> cached completion words
var StaleWords = {};                      // "base|user" -> cached list is one upload behind
var Fetching = {};                        // "base|user" -> a schema fetch is in flight
var HadWords = {};                        // "base|user" -> a fetch has succeeded at least once
var DiskServed = {};                      // "base|user" -> the saved list was already served
var FetchGen = {};                        // "base|user" -> bumped per fetch, so a slow
                                          // result cannot overwrite newer data

var ASYNC_POLL_MS = 1500;                 // delay between UWS phase polls
var ASYNC_MAX_MS = 1800000;               // give up after 30 min of polling

// Parse a connection string into { user, base } where base is the TAP endpoint root.
function parseConn(connstr){
    var s = (connstr || '').split('---')[0].trim(); // drop any "--- alias" suffix
    var user = null, base;
    if (s.indexOf('gaiapre://') === 0){              // pre-release archive shortcut
        var restp = s.slice(10);
        if (restp){ user = restp.split('/')[0].split('@')[0] || null; }
        base = 'https://geapre.esac.esa.int/tap-server/tap';
    } else if (s.indexOf('gaia://') === 0){
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
// The DataLink retrieval endpoint lives beside the TAP server: a base of
// https://host/tap-server/tap maps to https://host/data-server/data. The data-server is
// a SEPARATE Tomcat context with its own login + its own Path=/data-server JSESSIONID,
// so it must be authenticated independently of the /tap-server session.
function dataServerBase(c){
    if (/\/tap-server\/tap$/.test(c.base)){ return c.base.replace(/\/tap-server\/tap$/, '/data-server'); }
    return c.base.replace(/\/tap$/, '') + '/data-server'; // best-effort for a generic TAP service
}
function dataServerUrl(c){ return dataServerBase(c) + '/data'; }
function dataLoginUrl(c){ return dataServerBase(c) + '/login'; }

// Dependency-free ZIP reader: returns [{name, content(Buffer)}]. Some DataLink products
// (e.g. EPOCH_SPECTRUM_RVS) are always returned as a ZIP of per-transit CSVs. There is no
// built-in JS module that reads the ZIP container, but Node's zlib does the DEFLATE part;
// we parse the central directory (local headers may omit sizes via a data descriptor) and
// inflate each entry. Only the common store(0)/deflate(8) methods are supported.
function unzipEntries(buf){
    if (!buf || buf.length < 22){ throw new Error('not a zip archive'); }
    var eocd = -1;
    for (var p = buf.length - 22; p >= 0; p--){ if (buf.readUInt32LE(p) === 0x06054b50){ eocd = p; break; } }
    if (eocd < 0){ throw new Error('not a zip archive'); }
    var count = buf.readUInt16LE(eocd + 10);
    var i = buf.readUInt32LE(eocd + 16);
    var entries = [];
    for (var n = 0; n < count; n++){
        if (i + 46 > buf.length || buf.readUInt32LE(i) !== 0x02014b50){ break; } // central directory header
        var method = buf.readUInt16LE(i + 10);
        var compSize = buf.readUInt32LE(i + 20);
        var nameLen = buf.readUInt16LE(i + 28);
        var extraLen = buf.readUInt16LE(i + 30);
        var commentLen = buf.readUInt16LE(i + 32);
        var lho = buf.readUInt32LE(i + 42);
        var name = buf.slice(i + 46, i + 46 + nameLen).toString('utf8');
        var lNameLen = buf.readUInt16LE(lho + 26), lExtraLen = buf.readUInt16LE(lho + 28);
        var dataStart = lho + 30 + lNameLen + lExtraLen;
        var comp = buf.slice(dataStart, dataStart + compSize);
        var content = method === 8 ? zlib.inflateRawSync(comp) : comp;
        entries.push({ name: name, content: content });
        i = i + 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

// Concatenate the CSV bodies of every entry in a ZIP buffer into one CSV (single header).
function zipToCsv(buf){
    var entries = unzipEntries(buf);
    var header = null, bodyLines = [];
    entries.forEach(function(e){
        var rows = e.content.toString('utf8').split(/\r?\n/);
        if (!rows.length){ return; }
        if (header == null){ header = rows[0]; }
        for (var i = 1; i < rows.length; i++){ if (rows[i] !== ''){ bodyLines.push(rows[i]); } }
    });
    if (header == null){ return ''; }
    return [header].concat(bodyLines).join('\n') + '\n';
}

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
    // HTML error page (service-side failure, not a query error): prefer the
    // "Message:" line over dumping raw markup at the user
    var msg = /Message:\s*([\s\S]{10,}?)\s*(?:Cannot process request|<\/p>|<br|<div|<p|$)/i.exec(body || '');
    if (msg){
        return 'HTTP ' + status + ': ' + unescapeXml(msg[1].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 500);
    }
    if (body && body.trim()){ return body.trim().slice(0, 1000); }
    return 'TAP request failed (HTTP ' + status + ')';
}

// Decode the handful of XML entities that appear in VOTABLE attribute/description text.
function unescapeXml(s){
    return String(s == null ? '' : s)
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

// Parse the <FIELD> metadata from a VOTABLE document into column descriptors. Each FIELD
// carries name + datatype, and optionally unit and a nested <DESCRIPTION>. This is how we
// recover column TYPES for tables that TAP_SCHEMA does not describe (e.g. user_<name>).
function fieldsFromVOTable(xml){
    var columns = [];
    var re = /<FIELD\b([^>]*?)(\/>|>([\s\S]*?)<\/FIELD>)/g;
    var m;
    while ((m = re.exec(xml || '')) !== null){
        var attrs = m[1];
        var inner = m[3] || '';
        var attr = function(name){
            var a = new RegExp(name + '\\s*=\\s*"([^"]*)"').exec(attrs);
            return a ? unescapeXml(a[1]) : '';
        };
        var name = attr('name');
        if (!name){ continue; }
        var datatype = attr('datatype');
        var arraysize = attr('arraysize');
        var unit = attr('unit');
        var dm = /<DESCRIPTION>([\s\S]*?)<\/DESCRIPTION>/.exec(inner);
        var descr = dm ? unescapeXml(dm[1]).trim() : '';
        if (unit){ descr = '[' + unit + '] ' + descr; }
        // a char column with arraysize is a variable-length string; surface its length
        var len = (datatype === 'char' && arraysize && arraysize !== '*' && (+arraysize) > 1) ? arraysize : '-1';
        columns.push({ name: name, type: datatype || '', not_null: 'f', max_length: len, default_value: null, description: descr || null });
    }
    return columns;
}

function encodeParams(params){
    return Object.keys(params).map(function(k){ return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
}

// The data-server reports failures as either a VOTABLE <INFO value="ERROR"> or an HTML
// Tomcat page; extract a short human message from whichever it is.
function dlError(status, body){
    var v = /value="ERROR">([\s\S]*?)<\/INFO>/.exec(body || '');
    if (v){ return v[1].replace(/\s+/g, ' ').trim().slice(0, 500); }
    // the data-server's HTML error page buries the real cause in a "Message:"
    // line; the <h1>/<title> is only the generic "SERVICE ERROR - 500"
    var msg = /Message:\s*([\s\S]{10,}?)\s*(?:Cannot process request|<\/p>|<br|<div|<p|$)/i.exec(body || '');
    if (msg){
        return 'HTTP ' + status + ': ' + unescapeXml(msg[1].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 500);
    }
    var h = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(body || '') || /<title>([\s\S]*?)<\/title>/i.exec(body || '');
    if (h){ return h[1].replace(/\s+/g, ' ').trim().slice(0, 500); }
    return 'HTTP ' + status;
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
        // the connection can die mid-body (network drop, server restart): without this
        // neither onResp nor onErr ever fires and the caller -- e.g. Ctrl+I Object
        // Info -- waits forever.
        res.on('error', function(e){ finish(onErr, e.message); });
        res.on('aborted', function(){ finish(onErr, 'connection dropped mid-response'); });
    });
    req.on('error', function(e){ finish(onErr, e.message); });
    req.setTimeout(TAP_SYNC_TIMEOUT, function(){ req.destroy(new Error('TAP request timed out after ' + (TAP_SYNC_TIMEOUT / 1000) + 's')); });
    if (id != null){ InFlight[id] = req; }
    req.write(body);
    req.end();
}

// Low-level multipart/form-data POST. fields is an object of name->value text parts. The
// FILE part is empty for a job-based upload, or carries `file` (a {name, content, type})
// to upload actual data. onResp(status, headers, text) / onErr(message).
function httpPostMultipart(urlStr, fields, cookie, onResp, onErr, file){
    var u = url.parse(urlStr);
    var lib = (u.protocol === 'http:') ? http : https;
    var boundary = '----sqltabs' + crypto.randomBytes(12).toString('hex');
    var parts = [];
    Object.keys(fields).forEach(function(k){
        parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + fields[k] + '\r\n'));
    });
    if (file){
        parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="FILE"; filename="' + file.name + '"\r\nContent-Type: ' + (file.type || 'text/csv') + '\r\n\r\n'));
        parts.push(Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8'));
        parts.push(Buffer.from('\r\n'));
    } else {
        parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="FILE"; filename=""\r\nContent-Type: application/octet-stream\r\n\r\n\r\n'));
    }
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="URL"\r\n\r\n\r\n'));
    parts.push(Buffer.from('--' + boundary + '--\r\n'));
    var body = Buffer.concat(parts);
    var headers = { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length, 'Accept': '*/*' };
    if (cookie){ headers['Cookie'] = cookie; }
    var settled = false;
    var finish = function(fn, a, b, c){ if (settled){ return; } settled = true; fn(a, b, c); };
    var req = lib.request({ method: 'POST', hostname: u.hostname, port: u.port, path: u.path, headers: headers }, function(res){
        var chunks = [];
        res.on('data', function(d){ chunks.push(d); });
        res.on('end', function(){ finish(onResp, res.statusCode, res.headers, Buffer.concat(chunks).toString('utf8')); });
        res.on('error', function(e){ finish(onErr, e.message); });
        res.on('aborted', function(){ finish(onErr, 'connection dropped mid-response'); });
    });
    req.on('error', function(e){ finish(onErr, e.message); });
    req.setTimeout(TAP_SYNC_TIMEOUT, function(){ req.destroy(new Error('upload timed out after ' + (TAP_SYNC_TIMEOUT / 1000) + 's')); });
    req.write(body);
    req.end();
}

// Low-level GET; used to poll a UWS job phase and fetch its results. Does NOT register
// in InFlight (async polling cancellation is handled at the job level, not the socket).
// onResp(status, headers, text, rawBuffer) / onErr(message). The raw Buffer lets binary
// responses (e.g. a ZIP of CSVs) be handled without utf8 corruption.
function httpGet(urlStr, cookie, onResp, onErr){
    var u = url.parse(urlStr);
    var lib = (u.protocol === 'http:') ? http : https;
    var headers = { 'Accept': 'text/plain, text/csv, */*' };
    if (cookie){ headers['Cookie'] = cookie; }
    var settled = false;
    var finish = function(fn, a, b, c, d){ if (settled){ return; } settled = true; fn(a, b, c, d); };
    var req = lib.request({ method: 'GET', hostname: u.hostname, port: u.port, path: u.path, headers: headers }, function(res){
        var chunks = [];
        res.on('data', function(d){ chunks.push(d); });
        res.on('end', function(){ var raw = Buffer.concat(chunks); finish(onResp, res.statusCode, res.headers, raw.toString('utf8'), raw); });
        res.on('error', function(e){ finish(onErr, e.message); });
        res.on('aborted', function(){ finish(onErr, 'connection dropped mid-response'); });
    });
    req.on('error', function(e){ finish(onErr, e.message); });
    req.setTimeout(TAP_SYNC_TIMEOUT, function(){ req.destroy(new Error('TAP request timed out after ' + (TAP_SYNC_TIMEOUT / 1000) + 's')); });
    req.end();
}

// Capture ALL cookies from a Set-Cookie response, not just JSESSIONID. The Gaia archive
// runs /tap-server and /data-server as separate Tomcat contexts: the per-context
// JSESSIONID is Path=/tap-server (a browser would never send it to /data-server), while
// cross-context auth (DataLink downloads) relies on a root-scoped SSO cookie set at login
// (e.g. JSESSIONIDSSO, Path=/). Replaying every name=value pair authenticates both servers.
function extractSessionCookie(headers){
    var sc = headers['set-cookie'];
    if (!sc || !sc.length){ return null; }
    var pairs = [];
    for (var i = 0; i < sc.length; i++){
        var m = /^\s*([^=;]+)=([^;]*)/.exec(sc[i]);
        if (m){ pairs.push(m[1].trim() + '=' + m[2]); }
    }
    return pairs.length ? pairs.join('; ') : null;
}

// The app's PasswordDialog stores passwords URL-encoded (so they can be embedded in a
// connstr); decode before use, exactly like the postgres connector (PqClient `dec`) does.
function decodeSecret(pw){
    if (pw == null){ return pw; }
    try { return decodeURIComponent(pw); } catch (e){ return pw; }
}

// POST username/password to the service's /login endpoint; on success cache the JSESSIONID.
// ok(cookie) / fail({status, msg}). The endpoint intermittently returns 200 with no
// Set-Cookie; retry a couple of times before giving up rather than failing the whole flow.
function tapLogin(connstr, password, ok, fail, _attempt){
    var c = parseConn(connstr);
    var attempt = _attempt || 0;
    httpPost(loginUrl(c), { username: c.user, password: decodeSecret(password) }, null, null,
        function(status, headers, text){
            var cookie = extractSessionCookie(headers);
            // Trust the cookie over the status code: this endpoint is observed to answer 500
            // while still issuing a perfectly usable JSESSIONID (and, other times, 200 with no
            // cookie at all). Rejecting those 500s dropped us to an anonymous session, which
            // silently hides the user's own and "Shared to me" tables. An explicit auth
            // rejection is the exception -- never keep a session from that.
            if (cookie && status !== 401 && status !== 403){
                Sessions[sessionKey(c)] = cookie;
                invalidateWords(sessionKey(c)); // refetch completion now that user tables are visible
                ok(cookie);
                return;
            }
            if (status === 401 || status === 403){
                fail({ status: status, msg: 'Bad credentials' });
                return;
            }
            if (attempt < 3){
                tapLogin(connstr, password, ok, fail, attempt + 1); // no cookie issued: retry
                return;
            }
            fail({ status: status, msg: (status >= 200 && status < 300)
                ? 'login succeeded but no session cookie was returned'
                : errorFromBody(status, text) });
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

// Log in to the data-server (DataLink) context, which is separate from /tap-server and
// issues its own Path=/data-server cookie. ok(cookie) / fail({status,msg}).
function dataLogin(connstr, password, ok, fail, _attempt){
    var c = parseConn(connstr);
    var attempt = _attempt || 0;
    httpPost(dataLoginUrl(c), { username: c.user, password: decodeSecret(password) }, null, null,
        function(status, headers, text){
            if (status >= 200 && status < 300){
                var cookie = extractSessionCookie(headers);
                if (cookie){ DataSessions[sessionKey(c)] = cookie; ok(cookie); }
                else if (attempt < 3){ dataLogin(connstr, password, ok, fail, attempt + 1); } // intermittent: retry
                else { fail({ status: status, msg: 'data-server login returned no session cookie' }); }
            } else {
                fail({ status: status, msg: status === 401 ? 'Bad credentials' : errorFromBody(status, text) });
            }
        },
        function(e){ fail({ status: 0, msg: e }); });
}

// Resolve a data-server session cookie (cached or freshly logged-in). DataLink downloads
// of proprietary releases require it; anonymous (no user) resolves to null.
function ensureDataSession(connstr, password, ok, fail){
    var c = parseConn(connstr);
    if (!c.user){ ok(null); return; }
    var cached = DataSessions[sessionKey(c)];
    if (cached){ ok(cached); return; }
    if (password){ dataLogin(connstr, password, function(ck){ ok(ck); }, fail); return; }
    ok(null);
}

// Normalize an ADQL block before sending it to the TAP service. The block can end with a
// `--` line comment (e.g. a trailing note under the query); without a terminating newline
// the Gaia ADQL parser treats the unterminated comment as a syntax error and returns
// HTTP 500. Trimming trailing whitespace and appending a single newline guarantees any
// trailing line comment is closed. (`--` is a comment, so the leading `--- marker` line is
// already ignored by the service.)
function normalizeAdql(query){
    return (query || '').replace(/\s+$/, '') + '\n';
}

// POST an ADQL query to /sync. ok(bodyText) / fail(message). Re-logs-in once on a 401 when a
// password is available (session expired); id (optional) makes the request cancellable.
// format defaults to 'csv'; pass 'votable' to get the typed VOTABLE document (the body is
// then XML, so success is distinguished from an error by the absence of the ERROR INFO).
function tapSync(connstr, query, password, id, ok, fail, format){
    var c = parseConn(connstr);
    var fmt = format || 'csv';
    var run = function(cookie, allowRetry){
        httpPost(c.base + '/sync', { REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: fmt, QUERY: normalizeAdql(query) }, cookie, id,
            function(status, headers, text){
                if (status === 401 && c.user && password && allowRetry){ // session expired -> re-login once
                    delete Sessions[sessionKey(c)];
                    tapLogin(connstr, password, function(fresh){ run(fresh, false); }, function(e){ fail(e.msg || 'login failed'); });
                    return;
                }
                var isError = /QUERY_STATUS"\s+value="ERROR"/.test(text); // VOTABLE error marker
                // For CSV a successful body is non-XML; a VOTABLE body is XML by design.
                var bad = (fmt === 'votable') ? isError : (/^\s*</.test(text) || isError);
                if (status >= 200 && status < 300 && !bad){ ok(text); }
                else { fail(errorFromBody(status, text)); }
            },
            function(e){ fail(e); });
    };
    ensureSession(connstr, password, function(cookie){ run(cookie, true); }, function(e){ fail(e.msg || 'login failed'); });
}

// The UWS phase is reported either as a bare word (GET .../phase) or inside the job's
// XML document (<uws:phase>...</uws:phase>). Accept both.
function parsePhase(text){
    var t = (text || '').trim();
    var m = /<(?:uws:)?phase>\s*([A-Z]+)\s*<\/(?:uws:)?phase>/.exec(t);
    if (m){ return m[1]; }
    if (/^[A-Z]+$/.test(t)){ return t; }
    return null;
}

// Run an ADQL query via the UWS /async endpoint: create the job, start it, poll its phase
// until it reaches a terminal state, then fetch the CSV result. ok(csvText) / fail(message).
// The job is registered in AsyncJobs[id] so cancelQuery(id) can ABORT it server-side.
function tapAsync(connstr, query, password, id, ok, fail, triedRelogin){
    var c = parseConn(connstr);
    var startTime = performance.now();

    var settled = false;
    var done = function(fn, arg){
        if (settled){ return; }
        settled = true;
        var job = AsyncJobs[id];
        if (job && job.timer){ clearTimeout(job.timer); }
        if (id != null){ delete AsyncJobs[id]; }
        fn(arg);
    };

    var withSession = function(next){
        ensureSession(connstr, password, function(cookie){ next(cookie); }, function(e){ done(fail, e.msg || 'login failed'); });
    };

    withSession(function(cookie){
        if (settled){ return; } // cancelled during login
        AsyncJobs[id] = {
            base: c.base, jobUrl: null, cookie: cookie, timer: null,
            // cancelQuery calls this so an in-flight poll/result GET resolving after the
            // cancel can't still fire ok()/fail() -- it flips this closure's settled flag.
            abort: function(){ settled = true; }
        };

        // PHASE=RUN creates the job already running, so no separate start POST is needed.
        // The 303 redirect's Location header carries the job URL.
        httpPost(c.base + '/async', { REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'csv', PHASE: 'RUN', QUERY: normalizeAdql(query) }, cookie, null,
            function(status, headers, text){
                if (status === 401 && c.user && password && !triedRelogin){ // session expired -> re-login once, retry job
                    delete Sessions[sessionKey(c)];
                    settled = true;                 // make this invocation inert
                    if (id != null){ delete AsyncJobs[id]; }
                    tapAsync(connstr, query, password, id, ok, fail, true);
                    return;
                }
                if (status < 200 || status >= 400){ done(fail, errorFromBody(status, text)); return; }
                var loc = headers['location'];
                if (!loc){ done(fail, 'async job created but no job URL was returned'); return; }
                var jobUrl = loc.indexOf('http') === 0 ? loc : (url.parse(c.base).protocol + '//' + url.parse(c.base).host + loc);
                if (AsyncJobs[id]){ AsyncJobs[id].jobUrl = jobUrl; }
                poll(jobUrl, cookie);
            },
            function(e){ done(fail, e); });
    });

    function poll(jobUrl, cookie){
        if (settled){ return; }
        if (performance.now() - startTime > ASYNC_MAX_MS){ done(fail, 'async job did not finish within ' + (ASYNC_MAX_MS / 60000) + ' min'); return; }
        httpGet(jobUrl + '/phase', cookie,
            function(status, headers, text){
                if (settled){ return; }
                var phase = parsePhase(text);
                if (phase === 'COMPLETED'){ fetchResult(jobUrl, cookie); return; }
                if (phase === 'ERROR'){ fetchError(jobUrl, cookie); return; }
                if (phase === 'ABORTED'){ done(fail, 'async job aborted'); return; }
                // PENDING / QUEUED / EXECUTING / UNKNOWN -> keep polling
                if (AsyncJobs[id]){ AsyncJobs[id].timer = setTimeout(function(){ poll(jobUrl, cookie); }, ASYNC_POLL_MS); }
            },
            function(e){ done(fail, e); });
    }

    function fetchResult(jobUrl, cookie){
        httpGet(jobUrl + '/results/result', cookie,
            function(status, headers, text){
                var looksXml = /^\s*</.test(text);
                if (status >= 200 && status < 300 && !looksXml){ done(ok, text); }
                else { done(fail, errorFromBody(status, text)); }
            },
            function(e){ done(fail, e); });
    }

    function fetchError(jobUrl, cookie){
        httpGet(jobUrl + '/error', cookie,
            function(status, headers, text){ done(fail, errorFromBody(status, text) || 'async job failed'); },
            function(e){ done(fail, e); });
    }
}

var DATALINK_MAX_IDS = 5000;   // the archive's GUI/service caps a retrieval at 5000 sources
var DATALINK_CONCURRENCY = 4;  // parallel per-source GETs (each returns that source's CSV)

// Fetch a DataLink product (e.g. EPOCH_PHOTOMETRY) for a list of source_ids and return the
// rows as one combined CSV. The multi-id endpoint returns a ZIP, so to stay dependency-free
// we request each source individually (plain CSV) with bounded concurrency and concatenate,
// keeping a single header. ok(csvText) / fail(message). retrievalType e.g. 'EPOCH_PHOTOMETRY',
// release e.g. 'Gaia DR3'. Runs in the authenticated session (DR4 etc. need login).
function tapDataLink(connstr, ids, retrievalType, release, password, ok, fail){
    var c = parseConn(connstr);
    if (!ids || ids.length === 0){ fail('no source_id values to retrieve'); return; }
    if (ids.length > DATALINK_MAX_IDS){
        fail('DataLink is limited to ' + DATALINK_MAX_IDS + ' sources per run; got ' + ids.length +
             '. Narrow the query (e.g. add a WHERE filter) or split it.');
        return;
    }
    var base = dataServerUrl(c);

    // DataLink downloads authenticate against the data-server context (its own login +
    // Path=/data-server cookie), NOT the /tap-server session.
    ensureDataSession(connstr, password, function(cookie){
        var header = null;       // first non-empty CSV header, emitted once
        var bodyLines = [];      // data rows from every source, in completion order
        var errors = [];
        var next = 0, active = 0, finished = 0, settled = false;
        var reloginInFlight = null; // dedup concurrent 401 re-logins into one request

        // The data-server can expire its session cookie mid-batch ("Credentials
        // expiration" 401). Re-login once (shared across all in-flight workers that hit
        // 401 together) and retry the affected sources.
        var relogin = function(cb){
            if (reloginInFlight){ reloginInFlight.push(cb); return; }
            if (!(c.user && password)){ cb(null); return; } // can't re-login anonymously
            reloginInFlight = [cb];
            delete DataSessions[sessionKey(c)];
            dataLogin(connstr, password, function(fresh){
                cookie = fresh;
                var waiters = reloginInFlight; reloginInFlight = null;
                waiters.forEach(function(w){ w(fresh); });
            }, function(){
                var waiters = reloginInFlight; reloginInFlight = null;
                waiters.forEach(function(w){ w(null); });
            });
        };

        var fetchOne = function(idx, retried){
            var sid = ids[idx];
            // One id per request -> plain CSV (multiple comma-separated ids return a ZIP).
            var u = base + '?ID=' + encodeURIComponent(release + ' ' + sid) +
                    // DATAMODEL_STANDARD: INDIVIDUAL was deprecated on the archive
                    // (both gea and geapre now answer 500 "The 'INDIVIDUAL' data
                    // structure has been deprecated - use 'DATAMODEL_STANDARD'")
                    '&RETRIEVAL_TYPE=' + encodeURIComponent(retrievalType) + '&FORMAT=CSV&DATA_STRUCTURE=DATAMODEL_STANDARD';
            httpGet(u, cookie, function(status, headers, text, raw){
                if (status === 401 && !retried && c.user && password){ // session expired -> relogin once, retry
                    relogin(function(fresh){
                        if (fresh){ fetchOne(idx, true); }           // retry with the refreshed cookie
                        else { errors.push(sid + ': HTTP 401 (login expired)'); done(); }
                    });
                    return;
                }
                var ct = (headers && headers['content-type']) || '';
                var addRows = function(csv){
                    var rows = (csv || '').split(/\r?\n/);
                    if (rows.length && rows[0] !== ''){
                        if (header == null){ header = rows[0]; }
                        for (var i = 1; i < rows.length; i++){ if (rows[i] !== ''){ bodyLines.push(rows[i]); } }
                    }
                };
                if (status >= 200 && status < 300 && /csv/.test(ct)){
                    addRows(text);
                } else if (status >= 200 && status < 300 && /zip/.test(ct)){
                    // some products (e.g. EPOCH_SPECTRUM_RVS) are always a ZIP of per-transit CSVs
                    try { addRows(zipToCsv(raw)); } catch (e){ errors.push(sid + ': unreadable ZIP (' + e.message + ')'); }
                } else if (status !== 404){ // 404/empty = that source simply has no such product
                    errors.push(sid + ': ' + dlError(status, text));
                }
                done();
            }, function(e){ errors.push(sid + ': ' + e); done(); });
        };

        var done = function(){
            active--; finished++;
            pump();
            if (finished === ids.length && !settled){
                settled = true;
                if (header == null){
                    fail(errors.length ? ('DataLink returned no data. First errors: ' + errors.slice(0, 3).join('; '))
                                       : 'DataLink returned no rows for the requested sources');
                    return;
                }
                ok([header].concat(bodyLines).join('\n') + '\n');
            }
        };

        var pump = function(){
            while (active < DATALINK_CONCURRENCY && next < ids.length){
                var idx = next++; active++; fetchOne(idx, false);
            }
        };
        pump();
    }, function(e){ fail(e.msg || 'login failed'); });
}

// Run an ADQL query as an async job and call ok(jobid) once it reaches COMPLETED (the job
// result stays on the server, ready to be promoted to a user table). fail(message).
function runAsyncJob(connstr, query, cookie, ok, fail){
    var c = parseConn(connstr);
    var startTime = performance.now();
    httpPost(c.base + '/async', { REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'csv', PHASE: 'RUN', QUERY: query }, cookie, null,
        function(status, headers, text){
            if (status < 200 || status >= 400){ fail(errorFromBody(status, text)); return; }
            var loc = headers['location'];
            if (!loc){ fail('async job created but no job URL was returned'); return; }
            var jobUrl = loc.indexOf('http') === 0 ? loc : (url.parse(c.base).protocol + '//' + url.parse(c.base).host + loc);
            var jobid = jobUrl.split('/').pop();
            var poll = function(){
                if (performance.now() - startTime > ASYNC_MAX_MS){ fail('async job did not finish within ' + (ASYNC_MAX_MS / 60000) + ' min'); return; }
                httpGet(jobUrl + '/phase', cookie, function(s, h, t){
                    var phase = parsePhase(t);
                    if (phase === 'COMPLETED'){ ok(jobid); return; }
                    if (phase === 'ERROR'){ httpGet(jobUrl + '/error', cookie, function(es, eh, et){ fail(errorFromBody(es, et) || 'async job failed'); }, function(e){ fail(e); }); return; }
                    if (phase === 'ABORTED'){ fail('async job aborted'); return; }
                    setTimeout(poll, ASYNC_POLL_MS);
                }, function(e){ fail(e); });
            };
            poll();
        },
        function(e){ fail(e); });
}

// The Upload service reports outcome as "TAP_SERVICE_STATUS=..." (success) or, on error,
// a VOTABLE/HTML/plain body (often a bare Tomcat 500). Extract a short human message,
// stripping markup, and fall back to the raw text + HTTP status so failures are never
// reported "without explanation".
// The fullest word list known for a session. A fetch in progress publishes table names
// before the (much slower) column names, so mid-refresh the in-memory list can be a subset
// of what the previous session saved -- prefer the larger one so completions never lose the
// columns they were already offering.
function bestKnownWords(key){
    var mem = SchemaWords[key];
    var disk = SchemaCache.get(key);
    if (mem && disk){ return mem.length >= disk.length ? mem : disk; }
    return mem || disk || null;
}

// Drop the cached completion words for a session. Bumping the generation tells a fetch that
// is still in flight that its result is now stale and must not be cached.
function invalidateWords(key){
    delete SchemaWords[key];
    FetchGen[key] = (FetchGen[key] || 0) + 1;
}

// A freshly uploaded table has to be usable in autocompletion straight away, but refetching
// the schema costs a ~30s round-trip against the archive. We know the name already, so add
// it to the cached word list and mark the list stale: the next completion poll answers
// instantly with the new table, and the one after that refetches in full for its columns.
function noteUploadedTable(c, tableName){
    var key = sessionKey(c);
    var full = 'user_' + c.user + '.' + tableName;
    var words = SchemaWords[key];
    if (words){
        if (words.indexOf(full) < 0){ words.push(full); }
        if (words.indexOf('user_' + c.user) < 0){ words.push('user_' + c.user); }
        StaleWords[key] = true;
        SchemaCache.put(key, words); // keep it across restarts, not just until the next refetch
    } else {
        invalidateWords(key); // nothing cached yet: the next fetch is fresh anyway
    }
}

function uploadStatus(status, body){
    var m = /TAP_SERVICE_STATUS=([\s\S]*)/.exec(body || '');
    if (m){ return m[1].replace(/\s+/g, ' ').trim().slice(0, 300); }
    var parsed = dlError(status, body);          // tries VOTABLE INFO / <h1> / <title>
    if (parsed && !/^HTTP /.test(parsed)){ return parsed; }
    var txt = (body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); // strip tags
    if (txt){ return txt.slice(0, 300) + (status ? ' (HTTP ' + status + ')' : ''); }
    return 'HTTP ' + (status || '?');
}

// A user table name that already exists makes the Upload service answer with an opaque
// 500; add a clear hint when the failure looks like that (TAP upload cannot overwrite).
function uploadFailMessage(status, body, c, tableName){
    var msg = uploadStatus(status, body);
    if (/already\s*exist|exists|duplicate|TableExists|relation .* already/i.test(body || '') ||
        (status === 500 && !/TAP_SERVICE_STATUS/.test(body || ''))){
        msg += '\nThe table user_' + c.user + '.' + tableName + ' may already exist — TAP upload ' +
               'cannot overwrite. Use a different name, or drop the existing table first.';
    }
    return 'Upload failed: ' + msg;
}

// Create a user_<name> table from an ADQL query, server-side: run the query async, then
// POST the finished job to the Upload service (multipart, with an empty FILE part) to
// promote its result table. ok(message) / fail(message).
function tapUpload(connstr, query, tableName, tableDesc, password, ok, fail){
    var c = parseConn(connstr);
    if (!c.user){ fail('Uploading a table requires an authenticated connection (e.g. gaia://<user>)'); return; }
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(tableName)){
        fail('Invalid table name "' + tableName + '": use letters, digits and underscores, starting with a letter');
        return;
    }
    var uploadUrl = (/\/tap$/.test(c.base) ? c.base.replace(/\/tap$/, '') : c.base) + '/Upload';

    var doUpload = function(cookie, allowRetry){
        runAsyncJob(connstr, query, cookie, function(jobid){
            httpPostMultipart(uploadUrl, {
                TASKID: crypto.randomUUID(),
                JOBID: jobid,
                TABLE_NAME: tableName,
                TABLE_DESC: tableDesc || ('Created from sqltabs:\n' + query)
            }, cookie, function(status, headers, text){
                if (status === 401 && allowRetry && password){ // session expired -> re-login once
                    delete Sessions[sessionKey(c)];
                    tapLogin(connstr, password, function(fresh){ doUpload(fresh, false); }, function(e){ fail(e.msg || 'login failed'); });
                    return;
                }
                if (status >= 200 && status < 300 && !/User must be logged in/i.test(text)){
                    noteUploadedTable(c, tableName); // make it autocompletable at once
                    ok('Created table user_' + c.user + '.' + tableName + ' — ' + uploadStatus(status, text));
                } else {
                    fail(uploadFailMessage(status, text, c, tableName));
                }
            }, function(e){ fail(e); });
        }, fail);
    };

    ensureSession(connstr, password, function(cookie){
        if (!cookie){ fail('Uploading a table requires a login; set a password for ' + c.user); return; }
        doUpload(cookie, true);
    }, function(e){ fail(e.msg || 'login failed'); });
}

// Upload an in-memory CSV as a user_<name> table by POSTing it as the multipart FILE part
// (FORMAT=csv). Used for client-assembled data (e.g. DataLink products) that isn't a TAP
// job. ok(message) / fail(message).
function tapUploadFile(connstr, csvText, tableName, tableDesc, password, ok, fail){
    var c = parseConn(connstr);
    if (!c.user){ fail('Uploading a table requires an authenticated connection (e.g. gaia://<user>)'); return; }
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(tableName)){
        fail('Invalid table name "' + tableName + '": use letters, digits and underscores, starting with a letter');
        return;
    }
    var uploadUrl = (/\/tap$/.test(c.base) ? c.base.replace(/\/tap$/, '') : c.base) + '/Upload';

    var doUpload = function(cookie, allowRetry){
        httpPostMultipart(uploadUrl, {
            TASKID: crypto.randomUUID(),
            TABLE_NAME: tableName,
            TABLE_DESC: tableDesc || ('Uploaded from sqltabs'),
            FORMAT: 'csv'
        }, cookie, function(status, headers, text){
            if (status === 401 && allowRetry && password){
                delete Sessions[sessionKey(c)];
                tapLogin(connstr, password, function(fresh){ doUpload(fresh, false); }, function(e){ fail(e.msg || 'login failed'); });
                return;
            }
            if (status >= 200 && status < 300 && !/User must be logged in/i.test(text)){
                noteUploadedTable(c, tableName); // as above: autocompletable at once
                ok('Created table user_' + c.user + '.' + tableName + ' — ' + uploadStatus(status, text));
            } else {
                fail(uploadFailMessage(status, text, c, tableName));
            }
        }, function(e){ fail(e); }, { name: tableName + '.csv', content: csvText, type: 'text/csv' });
    };

    ensureSession(connstr, password, function(cookie){
        if (!cookie){ fail('Uploading a table requires a login; set a password for ' + c.user); return; }
        doUpload(cookie, true);
    }, function(e){ fail(e.msg || 'login failed'); });
}

var Response = function(query){
    this.connector_type = "tap";
    // default to '' so the renderer's query.replace(...)/match(...) calls are safe even
    // for a query-less probe Response (e.g. the one returned from testConnection).
    this.query = query || '';
    this.datasets = [];
    this.start_time = performance.now();
    this.duration = 0; // 0 (not null) so a probe Response that never calls finish() shows "0 ms", not "NaN ms"
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

// Serialize a result dataset back to RFC-4180 CSV (header + rows), quoting fields only
// when needed. Used to re-upload a client-assembled dataset as a user table.
function datasetToCSV(dataset){
    var esc = function(v){
        if (v == null){ return ''; }
        v = String(v);
        return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    var lines = [dataset.fields.map(function(f){ return esc(f.name); }).join(',')];
    dataset.data.forEach(function(row){ lines.push(row.map(esc).join(',')); });
    return lines.join('\n') + '\n';
}

// Project a dataset down to (and in the order of) the requested column names. Unknown
// names are skipped (logged, not fatal); null/empty wantCols returns the dataset as-is.
function projectColumns(dataset, wantCols){
    if (!wantCols || !wantCols.length || !dataset || !dataset.fields){ return dataset; }
    var lc = dataset.fields.map(function(f){ return String(f.name).toLowerCase(); });
    var idxs = [], missing = [];
    wantCols.forEach(function(name){
        var i = lc.indexOf(name);
        if (i >= 0){ idxs.push(i); } else { missing.push(name); }
    });
    if (missing.length){ console.log('datalink cols= unknown column(s) ignored: ' + missing.join(', ')); }
    if (!idxs.length){ return dataset; } // nothing matched -> keep all rather than blank the grid
    return {
        nrecords: dataset.data.length,
        fields: idxs.map(function(i){ return dataset.fields[i]; }),
        explain: false,
        data: dataset.data.map(function(row){ return idxs.map(function(i){ return row[i]; }); }),
        cmdStatus: null, resultStatus: null, resultErrorMessage: null
    };
}

var Database = {

    connector_type: "tap",

    // Resolve a connstr to its login user and real archive host, applying the same
    // scheme->host mapping the connector uses (gaia://->gea.esac.esa.int,
    // gaiapre://->geapre.esac.esa.int, tap(s)://host... -> host). Used e.g. to name a
    // share folder after the actual server rather than the shortcut scheme.
    parseConnInfo: function(connstr){
        var c = parseConn(connstr);
        var hm = /^https?:\/\/([^/]+)/i.exec(c.base || '');
        return { user: c.user || null, host: hm ? hm[1] : (c.base || '') };
    },

    testConnection: function(id, connstr, password, callback, ask_password_callback, err_callback){
        var c = parseConn(connstr);
        // callback expects an ARRAY of responses (like the postgres connector's
        // `callback(id, [result])`); the result store renders it with data.forEach,
        // so a bare Response object would throw "data.forEach is not a function".
        if (c.user){
            if (!password){ ask_password_callback(id, 'Login required for ' + c.user); return; }
            tapLogin(connstr, password,
                function(){ callback(id, [new Response()]); },
                function(e){
                    if (e.status === 401){ ask_password_callback(id, 'Bad credentials for ' + c.user); }
                    else { err_callback(id, e.msg || 'login failed'); }
                });
        } else {
            // anonymous: a tiny ADQL probe confirms the endpoint actually speaks TAP/ADQL
            tapSync(connstr, 'SELECT TOP 1 table_name FROM tap_schema.tables', undefined, null,
                function(){ callback(id, [new Response()]); },
                function(msg){ err_callback(id, msg); });
        }
    },

    runQuery: function(id, connstr, password, query, callback, err_callback){
        // `--- upload <table_name>` promotes the block's query result to a server-side
        // user_<name> table (run async, then create the table from the finished job).
        var up = /^\s*---\s+upload\s+([A-Za-z][A-Za-z0-9_]*)/i.exec(query);
        if (up){
            this._runUpload(id, connstr, password, query, up[1], callback, err_callback);
            return;
        }

        // `--- datalink <retrieval_type> [release]` is an execution directive: run the
        // block's inner ADQL to collect source_ids, then fetch that DataLink product
        // (e.g. epoch photometry) for them and render the combined CSV. Release defaults
        // to "Gaia DR3"; quote a multi-word release, e.g. `--- datalink epoch_rv "Gaia DR4"`.
        var dl = /^\s*---\s+datalink\s+(\S+)\s*("[^"]*"|\S+)?/i.exec(query);
        if (dl){
            this._runDataLink(id, connstr, password, query, dl, callback, err_callback);
            return;
        }

        // `async` is an execution directive: detect it on the leading `--- async ...`
        // marker and strip just that token, leaving any following render marker
        // (chart/csv/...) intact so SqlDoc still sees e.g. "--- chart line x y".
        // The service ignores the `---` line itself (-- is an ADQL line comment), so we
        // hand the connector the original block and only normalize Response.query (which
        // is what SqlDoc inspects to pick the renderer).
        var isAsync = /^\s*---\s+async\b/.test(query);
        var renderQuery = isAsync ? query.replace(/^(\s*---\s+)async\s*/, '$1') : query;
        var run = isAsync ? tapAsync : tapSync;
        var response = new Response(renderQuery);
        run(connstr, query, password, id,
            function(csvText){
                response.finish();
                response.datasets.push(csvDataset(csvText));
                callback(id, [response]);
            },
            function(msg){ err_callback(id, msg); });
    },

    _runDataLink: function(id, connstr, password, query, dlMatch, callback, err_callback){
        var retrievalType = dlMatch[1].toUpperCase();
        var release = (dlMatch[2] || 'Gaia DR3').replace(/^"|"$/g, ''); // strip optional quotes
        var markerLine = query.split(/\r?\n/)[0] || '';
        // Optional `cols=a,b,c` selects which DataLink columns to keep (default: all).
        var colsMatch = /\bcols=([A-Za-z0-9_,]+)/i.exec(markerLine);
        var wantCols = colsMatch ? colsMatch[1].split(',').map(function(s){ return s.trim().toLowerCase(); }).filter(Boolean) : null;
        // Optional `upload=<table>` saves the fetched product as a user_<name> table
        // (via file upload) instead of rendering it.
        var upMatch = /\bupload=([A-Za-z][A-Za-z0-9_]*)/i.exec(markerLine);
        var uploadName = upMatch ? upMatch[1] : null;
        // The inner ADQL is the block minus its marker line; it must return a source_id
        // column.
        var innerQuery = query.replace(/^\s*---\s+datalink\b.*\r?\n?/i, '');
        // keep the render marker (chart/csv) for SqlDoc by re-deriving it from the marker
        // tail, dropping the datalink token, its release, and any cols=/upload= selectors.
        var renderQuery = query
            .replace(/^(\s*---\s+)datalink\s+\S+\s*(?:"[^"]*"|\S+)?\s*/i, '$1')
            .replace(/\bcols=[A-Za-z0-9_,]+\s*/i, '')
            .replace(/\bupload=[A-Za-z][A-Za-z0-9_]*\s*/i, '');
        var response = new Response(renderQuery);

        // 1) run the inner query to get source_ids
        tapSync(connstr, innerQuery, password, id, function(csvText){
            var rows = parseCSV(csvText);
            if (rows.length <= 1){ err_callback(id, 'DataLink: the query returned no rows (need a source_id column)'); return; }
            var header = rows[0];
            var sidCol = -1;
            for (var i = 0; i < header.length; i++){ if (String(header[i]).toLowerCase() === 'source_id'){ sidCol = i; break; } }
            if (sidCol === -1){ sidCol = 0; } // fall back to the first column
            var ids = [], seen = {};
            for (var r = 1; r < rows.length; r++){
                var v = rows[r][sidCol];
                if (v != null && v !== '' && !seen[v]){ seen[v] = 1; ids.push(v); }
            }
            // 2) fetch the DataLink product for those ids
            tapDataLink(connstr, ids, retrievalType, release, password, function(dlCsv){
                var dataset = projectColumns(csvDataset(dlCsv), wantCols);
                if (uploadName){
                    // save the fetched product as a user table instead of rendering it
                    tapUploadFile(connstr, datasetToCSV(dataset), uploadName,
                        'DataLink ' + retrievalType + ' (' + release + ') from sqltabs', password,
                        function(message){
                            response.finish();
                            response.datasets.push({ nrecords: 1, explain: false,
                                fields: [{ name: 'upload', type: 'string' }], data: [[message]],
                                cmdStatus: null, resultStatus: null, resultErrorMessage: null });
                            callback(id, [response]);
                        },
                        function(msg){ err_callback(id, msg); });
                    return;
                }
                response.finish();
                response.datasets.push(dataset);
                callback(id, [response]);
            }, function(msg){ err_callback(id, msg); });
        }, function(msg){ err_callback(id, msg); });
    },

    _runUpload: function(id, connstr, password, query, tableName, callback, err_callback){
        // the query is the block minus its marker line
        var innerQuery = query.replace(/^\s*---\s+upload\b.*\r?\n?/i, '');
        var response = new Response(query);
        tapUpload(connstr, innerQuery, tableName, null, password, function(message){
            response.finish();
            // surface the outcome as a one-row, one-column result so the user sees confirmation
            response.datasets.push({
                nrecords: 1, explain: false,
                fields: [{ name: 'upload', type: 'string' }],
                data: [[message]],
                cmdStatus: null, resultStatus: null, resultErrorMessage: null
            });
            callback(id, [response]);
        }, function(msg){ err_callback(id, msg); });
    },

    cancelQuery: function(id){
        var req = InFlight[id];
        if (req){ delete InFlight[id]; try { req.destroy(new Error('cancelled')); } catch (e){ /* already gone */ } }
        // For an async job, abort it server-side (UWS PHASE=ABORT) and stop polling.
        var job = AsyncJobs[id];
        if (job){
            if (job.abort){ job.abort(); } // make the tapAsync closure inert (no late callback)
            if (job.timer){ clearTimeout(job.timer); }
            delete AsyncJobs[id];
            if (job.jobUrl){
                httpPost(job.jobUrl + '/phase', { PHASE: 'ABORT' }, job.cookie, null, function(){}, function(){});
            }
        }
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
        var host = parseConn(connstr).base.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

        // Ctrl+I with nothing under the cursor -> database info: the service's
        // schemas, each clickable into its table list (same drill-down shape the
        // postgres renderer uses, fed from TAP_SCHEMA instead of pg_catalog).
        if (!tbl){
            var finishDb = function(names){
                callback(id, {
                    object_type: 'database', object_name: host,
                    object: {
                        version: 'IVOA TAP / ADQL service',
                        schemas: names, roles: [], databases: [], tablespaces: [], event_triggers: [],
                    },
                });
            };
            // Gaia registers schemas inconsistently: some only in tap_schema.schemas,
            // some (user tables) only in tap_schema.tables -- union both so neither
            // kind is missing from the browse list.
            var names = [], seen = {};
            var addAll = function(csv){
                var rows = parseCSV(csv);
                for (var i = 1; i < rows.length; i++){
                    var n = rows[i][0];
                    if (n && !seen[n]){ seen[n] = 1; names.push(n); }
                }
            };
            var fromTables = function(){
                tapSync(connstr, "SELECT DISTINCT schema_name FROM tap_schema.tables ORDER BY schema_name", password, id,
                function(csv2){ addAll(csv2); names.sort(); finishDb(names); },
                function(){ names.sort(); finishDb(names); });
            };
            tapSync(connstr, "SELECT schema_name FROM tap_schema.schemas ORDER BY schema_name", password, id,
            function(csv){ addAll(csv); fromTables(); },
            function(){ fromTables(); }); // schemas table absent/failed: tables alone still work
            return;
        }

        // Ctrl+I on "schema." -> schema info: its tables and views from TAP_SCHEMA.
        if (tbl.slice(-1) === '.'){
            var schema = tbl.slice(0, -1);
            var esc = schema.replace(/'/g, "''");
            // no type column: the TAP_SCHEMA standard calls it `kind`, Gaia calls it
            // `table_type`, and other services omit both -- list everything as a
            // table (views still drill down fine via the TOP 0 probe fallback)
            var tablesSql = "SELECT table_name FROM tap_schema.tables WHERE schema_name = '" + esc + "' ORDER BY table_name";
            tapSync(connstr, tablesSql, password, id, function(csv){
                var rows = parseCSV(csv);
                var tables = [], views = [];
                var prefix = schema + '.';
                for (var i = 1; i < rows.length; i++){
                    var name = String(rows[i][0] || '');
                    if (name.indexOf(prefix) === 0) name = name.slice(prefix.length); // renderer re-qualifies
                    if (!name) continue;
                    tables.push(name);
                }
                if (tables.length === 0){
                    // queryable-but-unpublished schemas (Gaia shared/internal ones)
                    // have no TAP_SCHEMA rows: say so instead of an empty page
                    err_callback(id, 'Schema "' + schema + '" is not published in this service\'s TAP_SCHEMA: ' +
                        'its tables can be queried but not listed. (Published schemas come from tap_schema.tables.)');
                    return;
                }
                callback(id, {
                    object_type: 'schema', object_name: schema,
                    object: { current_database: host, tables: tables, functions: [], views: views, sequences: [] },
                });
            }, function(msg){ err_callback(id, 'TAP_SCHEMA tables: ' + msg); });
            return;
        }
        // split schema.table for the ObjectInfo header (it renders schema.relname); a
        // table with no schema qualifier shows an empty schema.
        var dot = tbl.lastIndexOf('.');
        var schema = dot >= 0 ? tbl.slice(0, dot) : '';
        var relname = dot >= 0 ? tbl.slice(dot + 1) : tbl;
        var emit = function(columns){
            callback(id, {
                object_type: 'relation',
                object_name: tbl,
                object: {
                    relkind: 'r', schema: schema, relname: relname, columns: columns,
                    pk: null, check_constraints: null, foreign_keys: null,
                    indexes: null, triggers: null, records: null, size: null, total_size: null
                }
            });
        };

        // Fallback for tables not described in TAP_SCHEMA (e.g. uploaded user_<name>
        // tables): a TOP 0 VOTABLE probe returns the <FIELD> metadata (name, datatype,
        // unit, description) for every column without fetching any rows.
        var probeColumns = function(){
            tapSync(connstr, 'SELECT TOP 0 * FROM ' + tbl, password, null,
                function(xml){
                    var columns = fieldsFromVOTable(xml);
                    if (columns.length === 0){
                        callback(id, { object_type: 'relation', object: null, object_name: tbl });
                        return;
                    }
                    emit(columns);
                },
                // Surface the real reason (auth, unknown table, server error) instead of a
                // generic "not found" -- a user table that needs a login but is being probed
                // anonymously, or a genuine query error, should be visible.
                function(msg){ err_callback(id, msg); },
                'votable');
        };

        var q = "SELECT column_name, datatype, size, unit, description FROM tap_schema.columns " +
                "WHERE table_name = '" + tbl.replace(/'/g, "''") + "' ORDER BY column_index";
        tapSync(connstr, q, password, null,
            function(csvText){
                var rows = parseCSV(csvText);
                if (rows.length <= 1){ // not in TAP_SCHEMA -> probe the table directly
                    probeColumns();
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
                emit(columns);
            },
            function(msg){ err_callback(id, msg); });
    },

    getCompletionWords: function(callback){
        var connstr = this.connstr;
        var c = parseConn(connstr);
        var key = sessionKey(c);
        if (SchemaWords[key]){                        // schema is static per (endpoint,user)
            var cached = bestKnownWords(key);
            if (StaleWords[key]){
                // An upload added a table name to this list. Answer with it now -- the
                // caller gets the new table with no round-trip -- then drop the cache so the
                // next poll refetches in full and picks up the new table's columns too.
                delete StaleWords[key];
                invalidateWords(key);
            }
            callback(cached);
            return;
        }

        // A fetch for this session is already running (the completion poll ticks every 15s,
        // the fetch can take much longer): don't start a second round-trip against the
        // archive. Answer with the base keywords only while nothing better has ever been
        // loaded -- once it has, return null instead, which the caller treats as "no update"
        // rather than replacing a full schema list with 87 keywords.
        if (Fetching[key]){
            // Hand over whatever is already known for this endpoint. Two connection strings
            // can resolve to the same (endpoint, user) -- e.g. gaiapre://me and
            // taps://me@geapre.../tap -- and the second must not sit empty for the whole
            // fetch just because the first one started it. Falling back to null rather than
            // the bare keywords keeps a populated list from being replaced by 87 words.
            var known = bestKnownWords(key);
            callback(known ? known.slice() : (HadWords[key] ? null : Words.slice()));
            return;
        }

        // Claim the fetch slot BEFORE answering from disk below: that callback runs
        // synchronously and the caller may re-enter this function for another connection
        // string on the same endpoint, which would otherwise slip past the guard above and
        // start a second concurrent schema fetch.
        Fetching[key] = true;

        // Nothing in memory yet. Answer once from the list a previous session saved, so table
        // names are completable immediately instead of after the ~25s schema load, then carry
        // on into the fetch below to refresh it. The callback is neutralised so the fetch
        // updates the cache silently and the next poll picks up the fresh list.
        if (!DiskServed[key]){
            DiskServed[key] = true;
            var stored = SchemaCache.get(key);
            if (stored && stored.length){
                HadWords[key] = true; // a poll during the refresh must not downgrade to keywords
                callback(stored.slice());
                callback = function(){};
            }
        }
        // The generation is taken AFTER the session is established: logging in invalidates
        // the cache (it may have been built anonymously), and that bump must not discard the
        // results of this very fetch.
        var gen = null;

        var password = Config.getSecret(connstr); // authenticate the fetch when possible
        var words = Words.slice();
        var seen = new Set(words);
        var add = function(w){ if (w && !seen.has(w)){ seen.add(w); words.push(w); } };
        // add a name and, for a qualified table name, its bare schema prefix too.
        var addName = function(w){
            if (!w){ return; }
            add(w);
            var dot = w.indexOf('.');
            if (dot > 0){ add(w.slice(0, dot)); }
        };

        // Answer the caller once, with whatever has been collected so far.
        var answered = false;
        var publish = function(){
            if (answered){ return; }
            answered = true;
            callback(words.slice());
        };
        // Cache what we have. `done` marks the end of the whole fetch. The generation check
        // drops a slow result whose cache was invalidated meanwhile (login, upload).
        var cache = function(done){
            if (done){ delete Fetching[key]; }
            if (gen === null || FetchGen[key] !== gen){ return; }
            if (words.length > Words.length){
                SchemaWords[key] = words.slice();
                HadWords[key] = true;
                // Persist only the finished list. Saving the intermediate table-names-only
                // stage would overwrite a previous session's fuller list (names AND columns)
                // with a subset, and the next startup would come up short.
                if (done){ SchemaCache.put(key, SchemaWords[key]); }
            }
        };

        // Columns are the slow half -- a tap_schema round-trip over every column in the
        // archive -- and they are not needed to complete a schema or table name. They are
        // therefore loaded AFTER the table names have already been published, so a fresh
        // connection can complete table names in seconds instead of ~30s. Best-effort.
        var addColumns = function(){
            tapSync(connstr, 'SELECT DISTINCT column_name FROM tap_schema.columns ORDER BY column_name', password, null,
                function(csv){
                    var rows = parseCSV(csv);
                    for (var i = 1; i < rows.length; i++){ add(rows[i][0]); }
                    cache(true); publish();
                },
                function(){ cache(true); publish(); });
        };

        // Table/schema names are usable on their own: cache and hand them over at once, then
        // keep loading columns in the background for the next poll to pick up.
        var namesReady = function(){
            cache(false);
            publish();
            addColumns();
        };

        // ADQL fallback for table/schema names if the VOSI endpoint is unavailable.
        var fromTapSchema = function(){
            tapSync(connstr, 'SELECT table_name FROM tap_schema.tables ORDER BY table_name', password, null,
                function(csv){ var rows = parseCSV(csv); for (var i = 1; i < rows.length; i++){ addName(rows[i][0]); } namesReady(); },
                addColumns);
        };

        // Prefer the VOSI /tables metadata endpoint: it lists schemas + tables INCLUDING
        // tables shared with the user ("Shared to me", e.g. user_dr4rc3.*), which the ADQL
        // tap_schema.tables query omits. only_tables=true keeps the document small (names,
        // no column metadata). Needs the authenticated session cookie to see shared/user
        // tables. Falls back to TAP_SCHEMA if the request fails.
        ensureSession(connstr, password, function(cookie){
            gen = FetchGen[key] = (FetchGen[key] || 0) + 1; // logging in has already invalidated
            httpGet(c.base + '/tables?only_tables=true', cookie, function(status, headers, text){
                var names = [];
                if (status >= 200 && status < 300){
                    var re = /<(?:\w+:)?name>([^<]+)<\/(?:\w+:)?name>/g, m;
                    while ((m = re.exec(text)) !== null){ names.push(m[1].trim()); }
                }
                if (names.length){ names.forEach(addName); namesReady(); }
                else { fromTapSchema(); }
            }, function(){ fromTapSchema(); });
        }, function(){ delete Fetching[key]; publish(); }); // no session -> ADQL keywords only
    }
};

module.exports = Database;
