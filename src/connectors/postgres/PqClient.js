/*
  Copyright (C) 2015  Aliaksandr Aliashkevich

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

var pg = require('pg');
var parseConnstr = require('pg-connection-string').parse;
var util = require('util');
var url = require('url');
var now = require("performance-now")

// The original libpq-based client returned every column as its raw Postgres text
// representation. The rest of the app was built around string cell values (the CSV
// export calls col.replace(), the result grid renders text, booleans show as 't'/'f',
// timestamps in Postgres' own format, etc.). Stock node-postgres instead parses values
// into JS types (numbers, booleans, Date). To keep behaviour identical, disable pg's
// type parsing and hand back the raw text for every type (NULL is still passed through
// as null by pg before the parser runs).
var TEXT_TYPES = { getTypeParser: function(){ return function(val){ return val; }; } };

// pg@8 connects through Node sockets, which throw a bare "AggregateError" when
// every resolved address fails (e.g. localhost resolving to both ::1 and
// 127.0.0.1, both refused). The UI shows error.toString(), so flatten it into a
// readable message that names the actual failure(s) instead of "AggregateError".
var flattenConnError = function(err){
    if (err && err.name === 'AggregateError' && Array.isArray(err.errors) && err.errors.length > 0){
        var seen = {};
        var msgs = [];
        err.errors.forEach(function(e){
            var m = (e && e.message) ? e.message : String(e);
            if (!seen[m]){ seen[m] = true; msgs.push(m); }
        });
        var flat = new Error('could not connect to server: ' + msgs.join('; '));
        flat.code = err.errors[0] && err.errors[0].code;
        return flat;
    }
    return err;
};

var Client = function(connstr, password, redshift){
    var self = this;

    this.connstr = connstr;
    this.password = password;
    this.redshift = redshift;
    this._connstr = normalizeConnstr(connstr, password, self.redshift);
    this.client = new pg.Client(this._connstr);

    this.setPassword = function(password){
        if (password != self.password){
            self.connected = false;
            self.disconnect();
        }
        self.password = password;
        self._connstr = normalizeConnstr(this.connstr, password, self.redshift);
    };

    this.connected = false;

    this.callback = null;

    this.err_callback = null;

    this.finished = false;

    this.error = false;

    this.Response = null;

    this.copy_data = [];

    this.cancel = function(){

        self.query_cancelled = true;

        var xclient = new pg.Client(self._connstr);
        xclient.connect(function(err){
            if (err){
                console.log("failed to connect to cancel query: "+err);
            } else {
                console.log(self.client.processID);
                xclient.query("SELECT pg_cancel_backend($1)", [self.client.processID], function(err){
                    if (err){
                        console.log("failed to cancel query: "+err);
                    }
                    xclient.end();
                });
            }

        });
    };

    this.silentCancel = function(){
        self.client.end();
    };

    this.raiseError = function(err){
        self.error = true;
        self.finished = true;
        self.err_callback(err);
    };

    this.disconnect = function(){
        self.connected = false;
        self.client.end();
    };

    // real sending query
    this._executeQuery = function(query, callback, err_callback){
        self.Response = new Response(query)

        self.client.query({text: query, rowMode: 'array', types: TEXT_TYPES}, function(err, res){
            self.isBusy = false;
            self.Response.finish();
            if (err) {
                if (self.query_cancelled){
                    self.query_cancelled = false;
                    err_callback("query cancelled by user's request");
                } else {
                    var ds = new Dataset({rows: [], fields: [], cmdStatus: ""});
                    ds.resultStatus = "PGRES_BAD_RESPONSE";
                    ds.resultError = err;
                    ds.resultErrorMessage = err.message;
                    self.Response.datasets.push(ds);
                    callback(self.Response);
                }
            } else {
                if (!Array.isArray(res)){ res = [res] }  // single dataset convert to multidataset


                res.forEach(function(r){
                    if (r.cmdStatus == null){
                        // stock node-postgres exposes the command tag as `command`
                        // (e.g. 'SELECT', 'EXPLAIN', 'INSERT'); the old libpq fork
                        // used `cmdStatus`. Map it so Dataset keeps working. Empty
                        // queries report no command -> treat as SELECT.
                        r.cmdStatus = r.command || "SELECT";
                    }
                    ds = new Dataset(r);
                    self.Response.datasets.push(ds);
                });

                callback(self.Response);
            }
        });
    }

    // send query interface, connects first if needed
    this.sendQuery = function(query, callback, err_callback){
        self.isBusy = true;

        if (self.connected){
            self._executeQuery(query, callback, err_callback);
        } else {

            self.client.connect(function(err){
                if (err){
                    self.isBusy = false;
                    err_callback(flattenConnError(err));
                } else {
                    self.connected = true;
                    self._executeQuery(query, callback, err_callback)
                }
            });
        }
    };

    this.noticeHandler = function(message){
        // Stock node-postgres emits a 'notice' event for any server NOTICE/WARNING.
        // These can arrive outside of a query (e.g. a collation-version warning at
        // connect time), when there is no active Response to attach them to -- guard
        // against that instead of crashing. The event payload is a NoticeMessage
        // object, so surface its text rather than the object itself.
        if (self.Response == null){
            return;
        }
        self.Response.datasets.push({
            resultStatus: 'PGRES_NONFATAL_ERROR',
            resultErrorMessage: (message && message.message) ? message.message : String(message),
        });
    };

    this.client.on('notice', this.noticeHandler);

}

var Dataset = function(result){
    // construct dataset object from returned resultset.
    this.data = result.rows
    this.fields = result.fields
    this.explain = false;
    this.nrecords = result.rows.length;
    if (result.cmdStatus.indexOf('SELECT') > -1){
        this.resultStatus = 'PGRES_TUPLES_OK';
    } else if (result.cmdStatus.indexOf('EXPLAIN') > -1){
        this.resultStatus = 'PGRES_TUPLES_OK';
        this.explain = true;
    } else {
        this.resultStatus = 'PGRES_COMMAND_OK';
    }
    this.fields.forEach(function(item){
        item.type = decode_type(item.dataTypeID);
    });
    this.cmdStatus = result.cmdStatus;
}

var Response = function(query){
    this.connector_type = "postgres";
    this.query = query;
    this.datasets = [];
    this.start_time = now();
    this.duration = null;
    this.finish = function(){
        this.duration = Math.round((now() - this.start_time)*1000)/1000;
    }.bind(this);
}

// normalizes connect string: ensures protocol, and substitutes password, rewrite mistaken defaults etc
var normalizeConnstr = function(connstr, password, redshift){
    if (!connstr){
        return;
    }

    var meta_start = connstr.indexOf('---'); // cut sqltabs extension of connect string
    if (meta_start != -1){
        connstr = connstr.substr(0, meta_start).trim();
    }
    if (connstr.lastIndexOf('postgresql://', 0) !== 0 && connstr.lastIndexOf('postgres://', 0) !== 0 && connstr.lastIndexOf('redshift://', 0) !== 0) {
        connstr = 'postgres://'+connstr;
    }

    // Build the pg config from Node's legacy url.parse, and DON'T hand a
    // `postgres://` string to the WHATWG `new URL()` (which is what
    // pg-connection-string and `new pg.Client(string)` use internally). For the
    // non-special `postgres:` scheme, Chromium's URL implementation in the
    // Electron renderer does not parse the authority -- host/port come back empty
    // and the whole authority lands in the path, so pg falls back to its
    // localhost:5432 defaults. Node's url.parse parses it correctly in the
    // renderer, so we use that and assemble the config object ourselves.
    var parsed = url.parse(connstr, true);

    var dec = function(s){ try { return decodeURIComponent(s); } catch(e){ return s; } };

    var user, pass;
    if (parsed.auth != null){
        var ci = parsed.auth.indexOf(':');
        if (ci === -1){
            user = parsed.auth;
        } else {
            user = parsed.auth.slice(0, ci);
            pass = parsed.auth.slice(ci + 1);
        }
    }

    var config = {
        host: parsed.hostname || undefined,
        port: parsed.port || undefined,
        user: (user != null && user !== '') ? dec(user) : undefined,
        password: (password != null) ? password : (pass != null ? dec(pass) : undefined),
        database: (parsed.pathname && parsed.pathname.length > 1) ? dec(parsed.pathname.slice(1)) : undefined,
    };

    // carry over connection parameters (application_name, sslmode, connect_timeout, ...)
    if (parsed.query){
        for (var k in parsed.query){
            if (config[k] == null){
                config[k] = parsed.query[k];
            }
        }
    }

    // map libpq-style sslmode onto pg's `ssl` option
    if (config.sslmode != null){
        var mode = config.sslmode;
        delete config.sslmode;
        if (mode === 'disable'){
            config.ssl = false;
        } else if (mode === 'require' || mode === 'prefer' || mode === 'allow' || mode === 'no-verify'){
            config.ssl = { rejectUnauthorized: false };
        } else { // verify-ca / verify-full
            config.ssl = true;
        }
    }

    if (config.database == null){
        config.database = config.user;
    }
    if (!redshift && config.application_name == null){ // redshift doesn't support this
        config.application_name = 'sqltabs';
    }
    return config;
};

var decode_type = function(type_code){
    var types = {
        16      :'BOOL',
        17      :'BYTEA',
        18      :'CHAR',
        19      :'NAME',
        20      :'INT8',
        21      :'INT2',
        22      :'INT2VECTOR',
        23      :'INT4',
        24      :'REGPROC',
        25      :'TEXT',
        26      :'OID',
        27      :'TID',
        28      :'XID',
        29      :'CID',
        30      :'OIDVECTOR',
        114     :'JSON',
        142     :'XML',
        194     :'PGNODETREE',
        32      :'PGDDLCOMMAND',
        600     :'POINT',
        601     :'LSEG',
        602     :'PATH',
        603     :'BOX',
        604     :'POLYGON',
        628     :'LINE',
        700     :'FLOAT4',
        701     :'FLOAT8',
        702     :'ABSTIME',
        703     :'RELTIME',
        704     :'TINTERVAL',
        705     :'UNKNOWN',
        718     :'CIRCLE',
        790     :'CASH',
        829     :'MACADDR',
        869     :'INET',
        650     :'CIDR',
        1005    :'INT2ARRAY',
        1007    :'INT4ARRAY',
        1009    :'TEXTARRAY',
        1028    :'OIDARRAY',
        1021    :'FLOAT4ARRAY',
        1033    :'ACLITEM',
        1263    :'CSTRINGARRAY',
        1042    :'BPCHAR',
        1043    :'VARCHAR',
        1082    :'DATE',
        1083    :'TIME',
        1114    :'TIMESTAMP',
        1184    :'TIMESTAMPTZ',
        1186    :'INTERVAL',
        1266    :'TIMETZ',
        1560    :'BIT',
        1562    :'VARBIT',
        1700    :'NUMERIC',
        1790    :'REFCURSOR',
        2202    :'REGPROCEDURE',
        2203    :'REGOPER',
        2204    :'REGOPERATOR',
        2205    :'REGCLASS',
        2206    :'REGTYPE',
        4096    :'REGROLE',
        4089    :'REGNAMESPACE',
        2211    :'REGTYPEARRAY',
        2950    :'UUID',
        3220    :'LSN',
        3614    :'TSVECTOR',
        3642    :'GTSVECTOR',
        3615    :'TSQUERY',
        3734    :'REGCONFIG',
        3769    :'REGDICTIONARY',
        3802    :'JSONB',
        3904    :'INT4RANGE',
        2249    :'RECORD',
        2287    :'RECORDARRAY',
        2275    :'CSTRING',
        2276    :'ANY',
        2277    :'ANYARRAY',
        2278    :'VOID',
        2279    :'TRIGGER',
        3838    :'EVTTRIGGER',
        2280    :'LANGUAGE_HANDLER',
        2281    :'INTERNAL',
        2282    :'OPAQUE',
        2283    :'ANYELEMENT',
        2776    :'ANYNONARRAY',
        3500    :'ANYENUM',
        3115    :'FDW_HANDLER',
        3310    :'TSM_HANDLER',
        3831    :'ANYRANGE',
    }

    return types[type_code];
};


module.exports = Client;
