/*
  Copyright (C) 2015  Aliaksandr Aliashkevich
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

var async = require('async');
var PqClient = require('./PqClient');
var Words = require('./keywords.js');

var Clients = {}; // clients used for executing user queries
var InfoClients = {}; // clients used for getting info about objects
var AutocompletionHashes = {}; // legacy; superseded by the bucketed cache below

// ---------------------------------------------------------------------------
// Autocomplete word cache: schema-aware words kept in sync with the catalog with
// almost no recurring server load. A cheap "gate" query runs every poll; only when
// it changes (a real DDL happened) do we run the heavier per-bucket "digest" to find
// WHICH buckets of words changed and refetch just those. An occasional forced digest
// (anti-entropy) reconciles the rare changes the cheap gate cannot see (a column
// rename, a table moved between schemas).
// ---------------------------------------------------------------------------
var WORD_BUCKETS = 4096;      // hash buckets for the digest (~24 words/bucket at 100k)
var FULL_RESYNC_EVERY = 30;   // force a digest every N polls (anti-entropy; ~5min @10s)
// Keyed by CONNECTION STRING, not tab: tabs sharing a connstr are polled once, and a
// connection only ever sees its own catalog -- a different db/user/schema is a different
// key, so suggestions never mix across databases.
var CompletionCache = {};     // connstr -> { gate, polls, buckets:{id:{sig,words}}, words, dirty }

// bigint cast avoids abs(INT_MIN) overflow on hashtext; identical expr in digest+fetch
var BUCKET_EXPR = "(abs(hashtext(word)::bigint) % " + WORD_BUCKETS + ")";

// Completion word universe. Relations/functions outside the connection's search_path
// are schema-qualified so the suggestion is valid SQL; columns and GUC names are bare.
// Restricted to user-facing relkinds (no index/toast/composite noise).
// NB: current_schemas() reflects the completion connection's (default) search_path.
var COMPLETION_WORDS_SQL = "\
SELECT DISTINCT word FROM ( \
    SELECT nspname AS word FROM pg_namespace \
    UNION SELECT CASE WHEN n.nspname = ANY(current_schemas(true)) THEN c.relname \
                      ELSE n.nspname || '.' || c.relname END \
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
          WHERE c.relkind IN ('r','v','m','p','f','S') \
    UNION SELECT CASE WHEN n.nspname = ANY(current_schemas(true)) THEN p.proname \
                      ELSE n.nspname || '.' || p.proname END \
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
    UNION SELECT attname FROM pg_attribute WHERE NOT attisdropped AND attnum > 0 \
    UNION SELECT name FROM pg_settings \
) v";

// Cheap gate (every poll): attribute count (column add/drop) + hash of bare
// relation/function/schema names (object add/drop/rename). ~9ms vs ~80ms for a full
// word hash on a 3000-table catalog -- this is what keeps the cluster idle.
var COMPLETION_GATE_SQL = "/*sqltabs*/ \
SELECT ((SELECT count(*) FROM pg_attribute) || ':' || \
        hashtext(string_agg(word, '' ORDER BY word)))::text AS gate FROM ( \
    SELECT DISTINCT word FROM ( \
        SELECT nspname AS word FROM pg_namespace \
        UNION SELECT relname FROM pg_class WHERE relkind IN ('r','v','m','p','f','S') \
        UNION SELECT proname FROM pg_proc \
    ) v \
) w";

// Digest (only when the gate changed, or anti-entropy): per-bucket count+hash so we
// can tell which buckets changed without transferring every word.
var COMPLETION_DIGEST_SQL = "/*sqltabs*/ \
SELECT b, count(*) AS c, hashtext(string_agg(word, '' ORDER BY word)) AS h FROM ( \
    SELECT word, " + BUCKET_EXPR + " AS b FROM (" + COMPLETION_WORDS_SQL + ") u \
) s GROUP BY b";

var COMPLETION_FETCH_ALL_SQL = "/*sqltabs*/ SELECT word, " + BUCKET_EXPR + " AS b FROM (" + COMPLETION_WORDS_SQL + ") u";

var completionFetchSql = function(buckets){ // refetch only the listed (changed) buckets
    return "/*sqltabs*/ SELECT word, " + BUCKET_EXPR + " AS b FROM (" + COMPLETION_WORDS_SQL +
           ") u WHERE " + BUCKET_EXPR + " IN (" + buckets.join(',') + ")";
};

var Database = {

    DEFAULT_PORT: 5432,

    redshift: false,

    _getClient: function(id, connstr, password, cache){

        var client;
        if (id in cache && cache[id].connstr == connstr && cache[id].connected){
            client = cache[id];
            if (client.isBusy){ // when previous query is running
                client.silentCancel(); // just drop it
                client = new PqClient(connstr, password, this.redshift); // and get new client, so async errors won't come in
                cache[id] = client;
            }
            client.setPassword(password);
        } else {
            client = new PqClient(connstr, password, this.redshift);
            cache[id] = client;
        }
        return client;
    },

    getClient: function(id, connstr, password){
        return this._getClient(id, connstr, password, Clients);
    },

    getInfoClient: function(id, connstr, password){
        return this._getClient(id, connstr, password, InfoClients);
    },

    runQuery: function(id, connstr, password, query, callback, err_callback){
        var client = this.getClient(id, connstr, password);
        client.sendQuery(query,
            function(result){callback(id, [result])},
            function(err){err_callback(id, err)}
        );

    },

    cancelQuery: function(id){
        if (id in Clients){
            Clients[id].cancel();
        }
    },

    runBlocks: function(id, connstr, password, blocks, callback, err_callback){
        var results = [];
        var client = this.getClient(id, connstr, password);

        var calls = [];
        for (var i=0; i<blocks.length; i++){
            var call = function(block){return function(done){
                client.sendQuery(block,
                function(result){
                    results.push(result);
                    done();
                },
                function(err){
                    err_callback(err);
                    done(-1);
                });

            }}(blocks[i]);
            calls.push(call);
        }

        async.series(calls, function(){
            callback(id, results);
        });

    },

    testConnection: function(id, connstr, password, callback, ask_password_callback, err_callback){

        delete Clients[id];

        var client = this.getClient(id, connstr, password);

        client.sendQuery("select 0 as connected where 1=0",
            function(result){
                callback(id, [result]);
            },
            function(err){
                if (typeof(err.code) != 'undefined' && ["28000", "28P01"].indexOf(err.code) > -1){
                    ask_password_callback(id, err);
                } else {
                    err_callback(id, err);
                }
            }
        );
    },


    getObjectInfo: function(id, connstr, password, object, callback, err_callback){

        var self = this;
        var ret;

        // if no object selected then get info about database
        if (typeof(object) == 'undefined' || object == '' || object == null){
            ret = {object_type: 'database', object: null, object_name: null};
            this._get_db_info(id, connstr, password,
            function(db_info){
                ret.object = db_info;
                ret.object_name = db_info.dbname;
                callback(id, ret);
            },
            function(err){
                err_callback(id, err);
            })
            return;
        }

        // if dot placed in the end then get information about schema (example: "myschema." )
        if (object.slice(-1) == '.'){
            var schema_name = object.slice(0, object.length-1);
            ret = {object_type: 'schema', object: null, object_name: schema_name};
            this._get_schema_info(id, connstr, password, schema_name,
            function(schema_info){
                ret.object = schema_info;
                callback(id, ret);
            },
            function(err){
                err_callback(id, err);
            })
            return;
        }

        // if starts with "trigger:" find trigger
        if (object.indexOf('trigger:') == 0){

            ret = {object_type: 'trigger', object: null, object_name: null}
            var oid = object.split(':')[1];

            this._getTrigger(id, connstr, password, oid,
            function(trigger){
                ret.object = trigger;
                ret.object_name = trigger.trigger_name;
                callback(id, ret);
            },
            err_callback);
            return;
        }

        // try to find relation
        object = self._quoteObject(object);
        self._findRelation(id, connstr, password, object,
        function(relation){
            var ret = {object_type: "relation", object: relation, object_name: object};

            if (relation != null){

                callback(id, ret);

            } else {
                // relation not found, try functions
                self._findProc(id, connstr, password, object,
                function(func){
                    if (func && func.scripts.length > 0){
                        var funcs = {object_type: "function", object: func, object_name: null};
                        return callback(id, funcs);
                    } else {
                        return callback(id, ret);
                    }
                },
                function(id, err){
                    return err_callback(id, err);
                });
            }
        },
        function(err){
            err_callback(id, err);
        });


    },


    // for internal use only: runs query and checks for error (not for rendering)
    // returns only data of first dataset
    _getData: function(id, connstr, password, query, callback, err_callback){
        var client = this.getInfoClient(id, connstr, password);
        client.sendQuery(query,
            function(result){
                if (result.datasets.length > 0 && result.datasets[0].resultStatus == 'PGRES_FATAL_ERROR'){
                    err_callback(result.datasets[0].resultErrorMessage);
                } else {
                    callback(result.datasets[0].data);
                }
            },
            function(err){
                err_callback(err);
            }
        );

    },

    _quoteObject: function(object){
        if (object.indexOf('.') > 0){
            var list = object.split('.');
            var quoted = list.map(function(item){return '"'+item+'"';});
            return quoted.join('.');
        } else {
            return '"'+object+'"';
        }
    },

    _unquoteString: function(str){
        if (str.indexOf('"') == 0 && str.lastIndexOf('"') == str.length - 1){
            return str.slice(1, str.length-1)
        } else {
            return str;
        }
    },

    _getCurrentUser: function(id, connstr, password, callback, err_callback){

        var client = this.getInfoClient(id, connstr, password);
        var query = "SELECT current_user;";
        client.sendQuery(query,
        function(result){
            var user = result.datasets[0].data[0][0];
            callback(user);
        },
        function(err){
            err_callback(id, err);
        });
    },

    _normalizeSearchPath: function(id, connstr, password, search_path, callback, err_callback){
        var spath = search_path.split(',');
        if (spath.indexOf('"$user"') > -1){
            this._getCurrentUser(id, connstr, password,
            function(user){
                var idx = spath.indexOf('"$user"');
                spath[idx]=user;
                if (spath.indexOf('pg_catalog') > -1){
                    callback(spath);
                } else {
                    spath.unshift('pg_catalog');
                    callback(spath);
                }
            },
            function(err){
                err_callback(id, err)
            });
        } else {
            if (spath.indexOf('pg_catalog') > -1){
                callback(spath);
            } else {
                spath.unshift('pg_catalog');
                callback(spath);
            }
        }
    },

    _getSearchPath: function(id, connstr, password, callback, err_callback){
        var self = this;
        var client = this.getInfoClient(id, connstr, password);
        var query = "SHOW search_path";
        client.sendQuery(query,
        function(result){
            var search_path = result.datasets[0].data[0][0];
            self._normalizeSearchPath(id, connstr, password, search_path,
            function(search_path){
                callback(search_path);
            },
            function(err){
                err_callback(id, err);
            });
        },
        function(err){
            err_callback(id, err);
        });
    },


    _findRelation: function(id, connstr, password, object, callback, err_callback){
        var self = this;

        // Do NOT compute sizes in this core lookup: pg_relation_size /
        // pg_total_relation_size error out on distributed tables (Postgres-XC/XL),
        // which would fail the whole query and make Object Info wrongly report the
        // table as "not found". Sizes are fetched separately below, tolerating
        // failure (also covers Redshift, which doesn't support them either).
        var query = "select n.nspname, c.relname, c.relkind, reltuples::bigint \
from  \
pg_class c, \
pg_namespace n \
where c.oid = '"+object+"'::regclass \
and n.oid = c.relnamespace;";

        this._getData(id, connstr, password, query,
        function(data){
            if (data.length > 0){
                var row = data[0];
                var relation = {
                    schema: row[0],
                    relname: row[1],
                    relkind: row[2],
                    size: null,        // filled by get_size below when supported
                    total_size: null,
                    records: row[3],
                };

                /// fill the relation object with details

                var get_columns = function(done){
                    self._getRelationColumns(id, connstr, password, object,
                    function(columns){
                        relation.columns = columns;
                        done();
                    },
                    err_callback);
                };

                var get_pk = function(done){
                    self._getRelationPK(id, connstr, password, object,
                    function(pk){
                        relation.pk = pk;
                        done();
                    },
                    err_callback);
                };

                var get_check_constraints = function(done){
                    self._getCheckConstraints(id, connstr, password, object,
                    function(constraints){
                        relation.check_constraints = constraints;
                        done();
                    },
                    err_callback);
                };

                var get_indexes = function(done){
                    self._getRelationIndexes(id, connstr, password, object,
                    function(indexes){
                        relation.indexes = indexes;
                        done();
                    },
                    err_callback);
                };

                var get_triggers = function(done){
                    self._getTriggers(id, connstr, password, object,
                    function(triggers){
                        relation.triggers = triggers;
                        done();
                    },
                    err_callback);
                };

                var get_view_def = function(done){
                    if (relation.relkind == 'v'){
                        var query = "select * from pg_get_viewdef('"+object+"')";
                        self._getData(id, connstr, password, query,
                        function(script){
                            relation.script = 'CREATE OR REPLACE VIEW '+object+' AS \n'+script;
                            done();
                        },
                        err_callback);
                    } else {
                        done();
                    }
                }

                var get_foreign_keys = function(done){
                    var query = "SELECT format('%s %s', conname, pg_catalog.pg_get_constraintdef(r.oid, true)) fk FROM pg_catalog.pg_constraint r WHERE r.conrelid = '"+object+"'::regclass AND r.contype = 'f' ORDER BY 1";
                    self._getData(id, connstr, password, query,
                    function(data){
                        if (data.length > 0){
                            relation.foreign_keys = [];
                            for (var i=0; i < data.length; i++){
                                var fk = {};
                                var splitted = data[i][0].split(' FOREIGN KEY ');
                                fk.name = splitted[0];
                                splitted = splitted[1].split(' REFERENCES ');
                                fk.columns = splitted[0];
                                fk.references = splitted[1];
                                relation.foreign_keys.push(fk);
                            }
                        }
                        done();
                    },
                    err_callback);
                }

                var get_sequence_info = function(done){
                    if (relation.relkind == 'S'){
                        var query = "select last_value, start_value, increment_by, max_value, min_value, cache_value, log_cnt, is_cycled, is_called from "+object;
                        self._getData(id, connstr, password, query,
                        function(data){
                            if (data.length > 0){
                                relation.params = {
                                    last_value: data[0][0],
                                    start_value: data[0][1],
                                    increment_by: data[0][2],
                                    max_value: data[0][3],
                                    min_value: data[0][4],
                                    cache_value: data[0][5],
                                    log_cnt: data[0][6],
                                    is_cycled: data[0][7],
                                    is_called: data[0][8],
                                };
                            }
                            done();
                        },
                        err_callback);
                    } else {
                        done();
                    }
                }

                var get_size = function(done){
                    if (self.redshift){ // redshift doesn't support these
                        done();
                        return;
                    }
                    var query = "select pg_size_pretty(pg_relation_size('"+object+"'::regclass)), \
pg_size_pretty(pg_total_relation_size('"+object+"'::regclass))";
                    self._getData(id, connstr, password, query,
                    function(data){
                        if (data.length > 0){
                            relation.size = data[0][0];
                            relation.total_size = data[0][1];
                        }
                        done();
                    },
                    function(err){ // size unavailable (e.g. distributed/pgxc tables) - ignore
                        console.log(err);
                        done();
                    });
                };

                async.series([get_columns, get_pk, get_check_constraints, get_indexes, get_triggers, get_view_def, get_foreign_keys, get_sequence_info, get_size],
                function(){
                    callback(relation);
                }
                );

            } else {
                callback(null);
            }
        },
        function(err){
            console.log(err);
            callback(null); // ignore error, behave like relation not found
        });
    },

    _findProc: function(id, connstr, password, object, callback, err_callback){
        var self = this;
        this._getSearchPath(id, connstr, password,
        function(search_path){

            // rewrite search path if schema defined
            if (object.indexOf('.') > -1){
                search_path = [object.split('.')[0]];
                object = object.split('.')[1];
            }

            // find oids of functions using search_path
            var oids = [];
            var func = {};
            var error = null;

            var calls_for_oids = search_path.map(function(item){return function(done){
                if (oids.length > 0){ // skip if already found
                    done();
                    return;
                }
                var client = self.getInfoClient(id, connstr, password);

                var schema_name = self._unquoteString(item);
                var proc_name = self._unquoteString(object);

                func.schema_name = schema_name;
                func.function_name = proc_name;
                func.scripts = [];

                var query = "SELECT p.oid from \
pg_proc p, \
pg_namespace n \
where p.pronamespace = n.oid \
and n.nspname = '"+schema_name+"' \
and p.proname = '"+proc_name+"'";

                client.sendQuery(query,
                function(result){
                    oids = result.datasets[0].data;
                    // get scripts for func oids
                    if (oids.length > 0){
                        var calls_for_scripts = oids.map(function(item){return function(cb_inner){
                            var oid = item[0];

                            var client = self.getInfoClient(id, connstr, password);
                            var query = "SELECT pg_get_functiondef("+oid+")";
                            client.sendQuery(query,
                            function(result){
                                if (result.datasets[0].resultStatus == 'PGRES_FATAL_ERROR'){
                                    error = true;
                                    err_callback(id, result.datasets[0].resultErrorMessage);
                                } else {
                                    var script = result.datasets[0].data[0][0];
                                    func.scripts.push(script);
                                }
                                cb_inner();
                            },
                            function(err){
                                err_callback(id, err);
                                cb_inner();
                            });

                        }});

                        async.series(calls_for_scripts, function(){
                            if (error == null) {
                                callback(func);
                            }
                        });
                    }
                    ///
                    done();
                },
                function(err){
                    err_callback(id, err);
                });

            }});

            async.series(calls_for_oids, function(){
                if (oids.length == 0){
                    callback(null);
                }
            });
        },
        function(err){
            err_callback(id, err);
        })
    },

    _getRelationDescription: function(id, connstr, password, object, callback, err_callback){

        var client = this.getInfoClient(id, connstr, password);

        var query = "SELECT description \
FROM pg_description \
WHERE objoid = '"+object+"'::regclass \
AND objsubid = 0";

        client.sendQuery(query,
        function(result){
            var description = result.datasets[0].data[0][0];
            callback(description);
        },
        function(err){
            err_callback(id, err);
        });

    },

    _getRelationColumns: function(id, connstr, password, object, callback, err_callback){ // eslint-disable-line no-unused-vars

        var query = 'SELECT \
    a.attname "name", \
    a.atttypid::regtype "type", \
    atttypmod "max_length", \
    a.attnotnull "not_null", \
    a.atthasdef "has_default", \
    pg_get_expr(c.adbin, c.adrelid) "default_value", \
    b.description "description" \
FROM pg_attribute a \
    LEFT JOIN pg_description b \
        ON b.objoid = a.attrelid AND b.objsubid = a.attnum \
    LEFT JOIN pg_attrdef c \
        ON c.adrelid = a.attrelid AND c.adnum = a.attnum \
WHERE a.attrelid = \''+object+'\'::regclass \
    AND a.attnum > 0 \
ORDER BY a.attnum';

        this._getData(id, connstr, password, query,
        function(data){
            var columns = [];
            for (var i=0; i<data.length; i++){
                var row = data[i];
                var column = {
                    name: row[0],
                    type: row[1],
                    max_length: row[2],
                    not_null: row[3],
                    has_default: row[4],
                    default_value: row[5],
                    description: row[6]
                };
                columns.push(column);
            }
            callback(columns);
        },
        function(err){ // ignore error
            console.log(err);
            callback([]);
        });
    },

    _getRelationPK: function(id, connstr, password, object, callback, err_callback){ // eslint-disable-line no-unused-vars

        var query = " \
SELECT conname, conindid::regclass, array_agg(b.attname ORDER BY attnum) \
FROM pg_constraint a \
JOIN pg_attribute b ON b.attrelid = a.conindid \
WHERE conrelid = '"+object+"'::regclass \
AND contype = 'p' \
GROUP BY conname, conindid;";

        this._getData(id, connstr, password, query,
        function(data){
            if (data.length == 0){
                callback(null);
            } else {
                var row = data[0];
                var pk = {
                    pk_name: row[0],
                    ind_name: row[1],
                    columns: row[2],
                };
                callback(pk);
            }
        },
        function(err){ // ignore error
            console.log(err);
            callback();
        });

    },

    _getCheckConstraints: function(id, connstr, password, object, callback, err_callback){ // eslint-disable-line no-unused-vars

        var query = " \
SELECT conname, pg_get_expr(conbin, conrelid) \
FROM pg_constraint \
WHERE conrelid = '"+object+"'::regclass \
AND contype = 'c'";

        this._getData(id, connstr, password, query,
        function(data){
            if (data.length == 0){
                callback(null);
            } else {
                var constraints = [];
                for (var i=0; i<data.length; i++){
                    var row = data[i];
                    constraints.push({
                        name: row[0],
                        src: row[1],
                    });
                }
                callback(constraints);
            }
        },
        function(err){ // ignore error
            console.log(err);
            callback({});
        });

    },

    _getRelationIndexes: function(id, connstr, password, object, callback, err_callback){ // eslint-disable-line no-unused-vars

        var query = " \
SELECT \
    a.indexrelid::regclass \"name\", \
    a.indisunique \"unique\", \
    d.amname \"method\", \
    array_agg(pg_get_indexdef(a.indexrelid, b.attnum, TRUE) ORDER BY b.attnum) \"fields\", \
    pg_get_expr(a.indpred, a.indrelid, TRUE) predicate, \
    pg_get_indexdef(a.indexrelid, 0, TRUE) indexdef \
FROM \
    pg_index a, \
    pg_attribute b, \
    pg_class c, \
    pg_am d \
WHERE \
        a.indrelid = '"+object+"'::regclass \
    AND NOT a.indisprimary \
    AND b.attrelid = a.indexrelid \
    AND c.OID = a.indexrelid \
    AND d.OID = c.relam \
GROUP BY a.indexrelid, a.indisunique, d.amname, a.indrelid, a.indpred";

        this._getData(id, connstr, password, query,
        function(data){
            if (data.length == 0){
                callback(null);
            } else {
                var indexes = [];
                for (var i=0; i<data.length; i++){
                    var row = data[i];
                    indexes.push({
                        name: row[0],
                        unique: row[1],
                        method: row[2],
                        columns: row[3],
                        predicate: row[4],
                        indexdef: row[5],
                    });
                }
                callback(indexes);
            }
        },
        function(err){ // ignore error
            console.log(err);
            callback([]);
        });
    },

    _getTriggers: function(id, connstr, password, object, callback, err_callback){ // eslint-disable-line no-unused-vars
            var query = " \
select t.tgname, t.oid \
from pg_trigger t, \
pg_class c \
where  \
c.oid = '"+object+"'::regclass \
and t.tgrelid = c.oid \
order by 1 \
";
            this._getData(id, connstr, password, query,
            function(data){
                if (data.length > 0){
                    var triggers = data.map(function(item){
                        return {trigger_name: item[0], oid: item[1]};
                    });
                    callback(triggers);
                } else {
                    callback(null);
                }
            },
            function(err){ // ignore error
                console.log(err);
                callback({});
            });
    },

    _getTrigger: function(id, connstr, password, trigger_oid, callback, err_callback){

        var trigger_name = null;
        var table = null;
        var script = null;

        var query = ' \
select tgname, (tgrelid::regclass)::text, pg_get_triggerdef(oid) \
from pg_trigger t \
where t.oid = '+trigger_oid;

        this._getData(id, connstr, password, query,
        function(data){
            if (data.length > 0){
                trigger_name = data[0][0];
                table = data[0][1];
                script = data[0][2];
            }

            var trigger = {
                trigger_name: trigger_name,
                table: table,
                script: script,
            };

            callback(trigger);
        },
        err_callback);

    },

    _get_db_info: function(id, connstr, password, callback, err_callback){
        var self = this;

        var current_database = null;
        var version = null;
        var schemas = [];
        var databases = [];
        var roles = [];
        var tablespaces = [];
        var event_triggers = [];

        // get current dbname
        var get_current_database = function(done){
            var query = "SELECT current_database(), version()";

            self._getData(id, connstr, password, query,
            function(data){
                if (data.length > 0){
                    current_database = data[0][0];
                    version = data[0][1];
                }
                done();
            },
            err_callback);
        };

        // get schemas
        var get_schemas = function(done){
            var query = " \
SELECT nspname AS schema \
FROM pg_namespace \
ORDER BY 1 \
";
            self._getData(id, connstr, password, query,
            function(data){
                if (data.length > 0){
                    schemas = data.map(function(item){return item[0];});
                }
                done();
            },
            err_callback);
        }

        // get roles
        var get_roles = function(done){
            var query = " \
SELECT rolname AS role \
FROM pg_roles \
ORDER BY 1 \
";
            self._getData(id, connstr, password, query,
            function(data){
                if (data.length > 0){
                    roles = data.map(function(item){return item[0];});
                }
                done();
            },
            function(err){ // ignore error (redshift specific)
                console.log(err);
                done();
            });
        }

        // get databases
        var get_databases = function(done){
            var query = " \
SELECT datname AS db \
FROM pg_database \
ORDER BY 1 \
";
            self._getData(id, connstr, password, query,
            function(data){
                if (data.length > 0){
                    databases = data.map(function(item){return item[0];});
                }
                done();
            },
            err_callback);
        }

        // get tablespaces
        var get_tablespaces = function(done){
            var query = " \
SELECT spcname \
FROM pg_tablespace \
ORDER BY 1 \
";
            self._getData(id, connstr, password, query,
            function(data){
                if (data.length > 0){
                    tablespaces = data.map(function(item){return item[0];});
                }
                done();
            },
            err_callback);
        }

        // get event triggers
        var get_event_triggers = function(done){
            var query = " \
SELECT evtname \
FROM pg_event_trigger \
ORDER BY 1 \
";
            self._getData(id, connstr, password, query,
            function(data){
                if (data.length > 0){
                    event_triggers = data.map(function(item){return item[0];});
                }
                done();
            },
            function(err){ // ignore error (redshift specific)
                console.log(err);
                done()
            });
        }

        async.series([get_current_database, get_schemas, get_roles, get_databases, get_tablespaces, get_event_triggers], function(){
            var database = {
                dbname: current_database,
                version: version,
                schemas: schemas,
                roles: roles,
                databases: databases,
                tablespaces: tablespaces,
                event_triggers: event_triggers,
            };
            return callback(database);
        });
    },

    _get_schema_info: function(id, connstr, password, schema_name, callback, err_callback){
        var self = this;
        var current_database = null;
        var tables = [];
        var functions = [];
        var views = [];
        var sequences = [];

        // get current dbname
        var get_current_database = function(done){
            var query = "SELECT current_database()";

            self._getData(id, connstr, password, query,
            function(data){
                if (data.length > 0){
                    current_database = data[0][0];
                }
                done();
            },
            err_callback);
        };

        // get tables
        var get_tables = function(done){
            var query = " \
select c.relname from \
pg_class c, \
pg_namespace n \
where n.nspname = '"+schema_name+"' \
and c.relnamespace = n.oid \
and c.relkind = 'r' \
order by 1 \
";
            self._getData(id, connstr, password, query,
            function(data){
                if (data.length > 0){
                    tables = data.map(function(item){return item[0];});
                }
                done();
            },
            err_callback);
        }

        // get functions
        var get_functions = function(done){
            var query = " \
select distinct p.proname from \
pg_proc p, \
pg_namespace n \
where \
n.nspname = '"+schema_name+"' \
and p.pronamespace = n.oid \
order by 1  \
";
            self._getData(id, connstr, password, query,
            function(data){
                if (data.length > 0){
                    functions = data.map(function(item){return item[0];});
                }
                done();
            },
            err_callback);

        }

        // get views
        var get_views = function(done){
            var query = " \
select viewname from \
pg_views \
where schemaname = '"+schema_name+"' \
order by 1";

            self._getData(id, connstr, password, query,
            function(data){
                if (data.length > 0){
                    views = data.map(function(item){return item[0];});
                }
                done();
            },
            err_callback);
        }

        // get sequences
        var get_sequences = function(done){
            var query = " \
select c.relname from \
pg_class c, \
pg_namespace n \
where n.nspname = '"+schema_name+"' \
and c.relnamespace = n.oid \
and c.relkind = 'S' \
order by 1 \
";
            self._getData(id, connstr, password, query,
            function(data){
                if (data.length > 0){
                    sequences = data.map(function(item){return item[0];});
                }
                done();
            },
            err_callback);
        }

        async.series([get_current_database, get_tables, get_functions, get_views, get_sequences], function(){
            var schema = {
                schema_name: schema_name,
                tables: tables,
                functions: functions,
                views: views,
                sequences: sequences,
                current_database: current_database,
            };
            callback(schema);
        });

    },

    getCompletionWords: function(callback){

        // Scope completion to THIS connection url. Executor.getConnector() sets db.connstr
        // before calling us; capture it synchronously so concurrent per-connstr polls from
        // Dispatcher don't race on the shared singleton.
        var connstr = this.connstr;
        var fatal = function(res){ return res.datasets.length > 0 && res.datasets[0].resultStatus == 'PGRES_FATAL_ERROR'; };

        var cache = CompletionCache[connstr];
        if (cache == null){ cache = CompletionCache[connstr] = { gate: null, polls: 0, buckets: {}, words: null, dirty: true }; }

        // returned list = base keywords + only THIS connection's cached catalog words
        var buildWords = function(){
            if (!cache.dirty && cache.words != null){ return cache.words; }
            var seen = new Set(Words);
            var out = Words.slice();
            for (var b in cache.buckets){
                var ws = cache.buckets[b].words;
                for (var i = 0; i < ws.length; i++){ if (!seen.has(ws[i])){ seen.add(ws[i]); out.push(ws[i]); } }
            }
            cache.words = out; cache.dirty = false;
            return out;
        };
        var finish = function(){ callback(buildWords()); };

        // One representative live client for this connstr (any tab) supplies password/redshift.
        // Because the cache is keyed by connstr, tabs sharing a connection are synced once.
        var info = null;
        for (var tab in Clients){ if (Clients[tab].connstr === connstr){ info = Clients[tab]; break; } }
        if (info == null || info.redshift){ finish(); return; } // no live pg connection: base + cached only

        // ---- step 1: cheap gate (every poll) ----
        var gateClient = new PqClient(info.connstr, info.password, info.redshift);
        gateClient.sendQuery(COMPLETION_GATE_SQL, function(gres){
            cache.polls += 1;
            var ok = !fatal(gres);
            var gate = (ok && gres.datasets[0].data.length > 0) ? gres.datasets[0].data[0][0] : null;
            gateClient.disconnect();
            if (!ok){ finish(); return; }

            var firstTime = Object.keys(cache.buckets).length === 0;
            var forceFull = (cache.polls % FULL_RESYNC_EVERY) === 0; // anti-entropy
            var changed = firstTime || forceFull || (gate !== cache.gate);
            cache.gate = gate;
            if (!changed){ finish(); return; } // steady state: nothing else hits the server

            // ---- step 2: digest -> which buckets changed ----
            var digestClient = new PqClient(info.connstr, info.password, info.redshift);
            digestClient.sendQuery(COMPLETION_DIGEST_SQL, function(dres){
                var dok = !fatal(dres);
                digestClient.disconnect();
                if (!dok){ finish(); return; }

                var rows = dres.datasets[0].data; // [b, c, h]
                var newSig = {};
                for (var i = 0; i < rows.length; i++){
                    var bn = parseInt(rows[i][0], 10);
                    if (!(bn >= 0)){ continue; }
                    newSig[bn] = rows[i][1] + ':' + rows[i][2];
                }
                // buckets that vanished -> all their words were dropped: prune them
                for (var ob in cache.buckets){
                    if (!(ob in newSig)){ delete cache.buckets[ob]; cache.dirty = true; }
                }
                var changedBuckets = [];
                for (var nb in newSig){
                    if (!cache.buckets[nb] || cache.buckets[nb].sig !== newSig[nb]){ changedBuckets.push(parseInt(nb, 10)); }
                }
                if (changedBuckets.length === 0){ finish(); return; } // anti-entropy no-op

                // ---- step 3: refetch only the changed buckets (or all, if most changed) ----
                var fetchAll = firstTime || changedBuckets.length > (WORD_BUCKETS / 2);
                var fetchSql = fetchAll ? COMPLETION_FETCH_ALL_SQL : completionFetchSql(changedBuckets);
                var fetchClient = new PqClient(info.connstr, info.password, info.redshift);
                fetchClient.sendQuery(fetchSql, function(fres){
                    var fok = !fatal(fres);
                    fetchClient.disconnect();
                    if (!fok){ finish(); return; }

                    var frows = fres.datasets[0].data; // [word, b]
                    var grouped = {};
                    for (var j = 0; j < frows.length; j++){
                        var gb = frows[j][1];
                        (grouped[gb] || (grouped[gb] = [])).push(frows[j][0]);
                    }
                    if (fetchAll){
                        var nbuckets = {};
                        for (var k in grouped){ nbuckets[k] = { sig: newSig[k], words: grouped[k] }; }
                        cache.buckets = nbuckets;
                    } else {
                        for (var m = 0; m < changedBuckets.length; m++){
                            var cb = changedBuckets[m];
                            cache.buckets[cb] = { sig: newSig[cb], words: grouped[cb] || [] };
                        }
                    }
                    cache.dirty = true;
                    finish();
                }, function(){ fetchClient.disconnect(); finish(); });
            }, function(){ digestClient.disconnect(); finish(); });
        }, function(){ gateClient.disconnect(); finish(); });

    },
}

module.exports = Database;
