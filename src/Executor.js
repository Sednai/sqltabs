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

var postgres = require('./connectors/postgres/Database.js');
var alasql = require('./connectors/alasql/Database.js');
var tap = require('./connectors/tap/Database.js'); // IVOA TAP / ADQL (e.g. ESA Gaia archive)
// Non-PostgreSQL connectors (cassandra/mysql/mssql/firebase) were dropped during
// the modernization to remove their unmaintained / native (grpc, ODBC) dependencies.
// The connector source files remain under ./connectors/ but are no longer wired in.
var url = require('url');
var path = require('path');
var tunnel = require('tunnel-ssh');
var net = require('net');

var Tunnels = {};
var TunnelPorts = {};
var PortSequence = 15000;

// default error sink for paths that used to call an undefined err_callback
// (a TypeError inside the tunnel error handler left the completion poller's
// in-progress flag stuck for the whole app session)
var logError = function(id, err){ console.log('executor error (tab '+id+'): '+err); };

// the ssh://... half of a connstr, or '' when there is none -- used to tell
// whether editing a connstr invalidated the tab's tunnel
var sshPart = function(connstr){
    if (!connstr) return '';
    var parts = connstr.split('|').map(function(s){ return s.trim(); });
    return (parts.length > 1 && parts[0].indexOf('ssh://') === 0) ? parts[0] : '';
};

function resolveHome(filepath) {
    if (filepath.charAt(0) === '~') {
        return path.join(process.env.HOME, filepath.slice(1));
    }
    return filepath;
}

var Executor = {

    // set by Dispatcher: fired when a tab's DB session reconnects after an
    // unexpected drop (id, connstr)
    onSessionRestored: null,

    getDatabase: function(id, connstr, callback, err_callback){

        var connstr_list = [];
        connstr.split("|").forEach(function(item){ // trim spaces
            connstr_list.push(item.trim());
        });

        if (connstr_list.length > 1 && connstr_list[0].startsWith('ssh://')){
            this.createTunnel(id, connstr, connstr_list, callback, err_callback);
        } else {
            callback(this.getConnector(connstr));
        }

    },

    getConnector: function(connstr, rawConnstr){
        var db = postgres;
        if  (connstr == '' || connstr == null || connstr.indexOf('alasql://') == 0){
            db = alasql;
        } else if (connstr.indexOf('redshift://') == 0){
            db = postgres;
            db.redshift = true;
        } else if (connstr.indexOf('tap://') == 0 || connstr.indexOf('taps://') == 0 || connstr.indexOf('gaia://') == 0 || connstr.indexOf('gaiapre://') == 0){
            db = tap; // IVOA TAP / ADQL service (e.g. ESA Gaia archive)
        }
        db.connstr = connstr;
        // for tunneled connections `connstr` is the mapped localhost:<ephemeral port>
        // url, which changes every time the tunnel is rebuilt; caches that must
        // survive a rebuild key on the raw connstr instead
        db.rawConnstr = (typeof rawConnstr == 'string') ? rawConnstr : connstr;
        return db;
    },

    sshPart: sshPart,

    testSSH: function(id, config, callback, err_callback){
        // single-fire: the probe socket is itself an incoming tunnel connection,
        // so its failure can race with the server's own error handling
        var done = false;
        var client = net.connect({host: config.localHost, port: config.localPort},
            function(){
                if (done) return;
                done = true;
                client.end();
                callback();
            }
        );
        client.setTimeout(5000, function(){
            if (done) return;
            done = true;
            client.end();
            err_callback('ssh probe timed out');
        });
        client.on('error', function(e){
            console.log("test ssh error: "+e);
            if (done) return;
            done = true;
            client.end();
            err_callback(e);
        });
    },

    createTunnel: function(id, connstr, connstr_list, callback, err_callback){

        var self = this;
        var ssh_url = url.parse(connstr_list[0], true);
        var db_url = url.parse(connstr_list[1]);

        if (db_url.port == null){
            db_url.port = self.getConnector(connstr_list[1]).DEFAULT_PORT;
        }

        var auth = db_url.auth+'@'
        if (db_url.auth == null){
            auth = '';
        }

        var url_path;
        if (db_url.path == null){
            url_path= '';
        } else {
            if (db_url.path.indexOf('---') > 0){ // trim connection alias
                url_path = db_url.path.split('---')[0];
                url_path = decodeURI(url_path); // convert possible %20 etc
            } else {
                url_path = decodeURI(db_url.path);
            }
        }

        try{
            var identity_file;
            if (ssh_url.query.identity_file){
                identity_file = require('fs').readFileSync(resolveHome(ssh_url.query.identity_file));
            } else {
                identity_file = require('fs').readFileSync(resolveHome('~/.ssh/id_rsa'));
            }
        }
        catch(e){
            console.log(e);
            identity_file = null;
        }

        var mapped_db_url;
        if (id in Tunnels){
            // safe to reuse unconditionally: a dying tunnel evicts its own entry
            // (see the 'error'/'close' listeners below), so a dead port is never
            // handed out again
            console.log('reuse tunnel: '+id);
            var port = TunnelPorts[id];
            mapped_db_url = db_url.protocol+'//'+auth+'localhost:'+port+url_path;
            return callback(self.getConnector(mapped_db_url, connstr));
        } else {
            console.log('create tunnel: '+id);
            PortSequence = PortSequence + 1;
            mapped_db_url = db_url.protocol+'//'+auth+'localhost:'+PortSequence+url_path;
            var ssh_config = {
                username: ssh_url.auth,
                host: ssh_url.hostname,
                port: ssh_url.port,
                privateKey: identity_file,
                dstHost: db_url.hostname,
                dstPort: db_url.port,
                localHost:'127.0.0.1',
                localPort: PortSequence,
                // keepAlive is a tunnel-ssh option: without it the local listener
                // closes as soon as the last pg connection drops (e.g. between
                // completion polls). keepaliveInterval is the ssh2 option that
                // actually pings the server so NAT/firewalls don't silently reap
                // idle tunnels (ssh2 defaults it to 0 = off).
                keepAlive: true,
                keepaliveInterval: 30000,
                readyTimeout: 30000,
            };

            if (ssh_config.username == null){
                delete ssh_config.username;
            }
            if (ssh_config.port == null){
                delete ssh_config.port;
            }
            console.log(ssh_config);

            var ssh_server = tunnel(ssh_config, function (error, server) {

                if (error){
                    console.log(error);
                    (err_callback || logError)(id, "create ssh tunnel error: "+error);
                    return;
                }

                Tunnels[id] = server;
                TunnelPorts[id] = PortSequence;

                self.testSSH(id, ssh_config, function(){
                    return callback(self.getConnector(mapped_db_url, connstr));
                }, function(err){
                    console.log(err);
                    (err_callback || logError)(id, "ssh tunnel error: "+err);
                });
            });

            // Evict the cache entry whenever this tunnel dies, so the next
            // getDatabase rebuilds it on a fresh port instead of serving
            // ECONNREFUSED forever. The dominant death path is 'close'
            // (tunnel-ssh closes the listener when the SSH channel errors,
            // without emitting 'error' first); 'error' covers handshake and
            // per-connection failures. Identity guard: a dying tunnel must
            // never evict the replacement registered under the same id.
            ssh_server.on('error', function(err){
                console.log('ssh tunnel error (tab '+id+'): '+err);
                if (err_callback) err_callback(id, err);
                if (Tunnels[id] === ssh_server) self.releaseTunnel(id);
            });

            ssh_server.on('close', function(){
                if (Tunnels[id] === ssh_server){
                    console.log('ssh tunnel closed (tab '+id+'): will be recreated on next use');
                    self.releaseTunnel(id);
                }
            });

        }
    },

    releaseTunnel: function(id){
        var srv = Tunnels[id];
        if (typeof(srv) != 'undefined'){
            // delete first, drop listeners before close(): our own 'close'
            // handler must not re-enter and evict a tunnel a newer call has
            // already registered under this id
            delete Tunnels[id];
            delete TunnelPorts[id];
            try {
                srv.removeAllListeners();
                srv.close();
            } catch(e){ console.log(e); }
        }
    },

    // full per-tab teardown: tunnel plus any per-session connector state
    releaseTab: function(id){
        this.releaseTunnel(id);
        postgres.forgetSession(id);
    },

    runQuery: function(id, connstr, password, query, callback, err_callback){
        this.getDatabase(id, connstr,
        function(db){
            db.runQuery(id, db.connstr, password, query, callback, err_callback);
        },
        err_callback);
    },

    cancelQuery: function(id, connstr){
        this.getDatabase(id, connstr, function(db){
            db.cancelQuery(id);
        }, logError);
    },

    getObjectInfo: function(id, connstr, password, object, callback, err_callback){
        this.getDatabase(id, connstr, function(db){
            db.getObjectInfo(id, db.connstr, password, object, callback, err_callback);
        }, err_callback || logError);
    },

    runBlocks: function(id, connstr, password, blocks, callback, err_callback){
        this.getDatabase(id, connstr, function(db){
            db.runBlocks(id, db.connstr, password, blocks, callback, err_callback);
        }, err_callback || logError);
    },


    testConnection: function(id, connstr, password, callback, ask_password_callback, err_callback){
        this.getDatabase(id, connstr,
        function(db){
            db.testConnection(id, db.connstr, password, callback, ask_password_callback, err_callback);
        },
        err_callback);
    },

    // id is the representative tab for this connstr: the poll then reuses that
    // tab's tunnel instead of minting a second one under a shared fake id, and
    // the error path always resolves so the caller's in-progress flag clears
    // (a stuck flag silently killed autocompletion for the whole session after
    // one tunnel failure)
    getCompletionWords: function(id, connstr, callback, err_callback){
        if (connstr){
            this.getDatabase(id, connstr, function(db){
                db.getCompletionWords(callback);
            }, function(tid, err){
                if (err_callback) err_callback(tid, err); else logError(tid, err);
                callback(null);
            });
        } else {
            callback([]);
        }
    },
};

// bridge the connector hook without an import cycle (Dispatcher requires
// Executor, so Executor must not require Dispatcher)
postgres.onSessionRestored = function(id, connstr){
    if (Executor.onSessionRestored) Executor.onSessionRestored(id, connstr);
};

module.exports = Executor;

