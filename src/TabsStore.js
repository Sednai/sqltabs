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

var MicroEvent = require('microevent');
var Config = require('./Config');
var SessionStore = require('./SessionStore');
var fs = require('fs');
var os = require('os');
var path = require('path');
var EOL = require('os').EOL;
var Executor = require('./Executor');
var ShareHistory = require('./ShareHistory');

var Sequence = function(start){
    this.curval = start;
    this.nextval = function(){
        this.curval++;
        return this.curval;
    }
}

var TabSequence = new Sequence(0);

// --- helpers for sharing a result to a Nextcloud/ownCloud folder -----------------

// Pull the connection user and server out of a connstr so the share subfolder can be
// named after them. Handles both "scheme://user@host:port/db" (postgres etc.) and
// "scheme://user" (Gaia/TAP, where the host is implied by the scheme). A "--- alias"
// suffix is ignored.
function parseUserHost(connstr){
    var s = (connstr || '').split('---')[0].trim();
    var sm = /^([a-z0-9+]+):\/\//i.exec(s);
    var scheme = sm ? sm[1] : '';
    var m = /^[a-z0-9+]+:\/\/([^/?#]+)/i.exec(s);
    var authority = m ? m[1] : s;
    var user = 'anon', host = '';
    var at = authority.indexOf('@');
    if (at !== -1){ // user@host
        user = authority.slice(0, at).split(':')[0] || 'anon';
        host = authority.slice(at + 1).split('/')[0].split(':')[0];
    } else { // scheme://user  (no explicit host) -> authority is the user
        user = authority.split('/')[0].split(':')[0] || 'anon';
    }
    return { user: user, server: host || scheme || 'server' };
}

// Keep folder/file names to safe WebDAV characters.
function sanitizeName(s){
    return String(s == null ? '' : s).replace(/[^A-Za-z0-9._-]/g, '-');
}

// Local timestamp as YYYY-MM-DD_HHMMSS for a per-share, never-overwriting folder.
function shareTimestamp(){
    var d = new Date();
    var p = function(n){ return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
           '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

// Serialize all result blocks/datasets to a single CSV string (same quoting rules as the
// file export: quote only values that contain a comma, quote, or newline; NULL for null).
function resultToCSV(result){
    var out = [];
    for (var i = 0; i < result.length; i++){
        var block = result[i];
        if (!block.datasets){ continue; }
        for (var j = 0; j < block.datasets.length; j++){
            var dataset = block.datasets[j];
            if (!dataset.fields){ continue; }
            out.push(dataset.fields.map(function(f){ return '"' + f.name + '"'; }).join());
            (dataset.data || []).forEach(function(record){
                out.push(record.map(function(col){
                    if (col == null){ return 'NULL'; }
                    if (/[",\r\n]/.test(col)){ return '"' + String(col).replace(/"/g, '""') + '"'; }
                    return col;
                }).join());
            });
        }
    }
    return out.join(EOL) + EOL;
}

// Concatenate the queries of every result block.
function resultToQuery(result){
    return result.map(function(b){ return (b.query || '').trim(); })
                 .filter(Boolean).join(EOL + EOL) + EOL;
}

// Resolve an export path from a `--- csv <file>` marker: strip surrounding quotes, expand
// a leading ~, and resolve a relative path against the user's home directory (cwd is the
// app dir, which is rarely what the user means).
function resolveExportPath(p){
    p = String(p || '').trim().replace(/^["']|["']$/g, '');
    if (p === '~' || p.indexOf('~/') === 0){ p = path.join(os.homedir(), p.slice(1)); }
    if (!path.isAbsolute(p)){ p = path.join(os.homedir(), p); }
    return p;
}

var Tab = function(id, connstr){
    this.id = id;
    this.connstr = connstr;
    this.connector_type = Executor.getConnector(connstr).connector_type;
    this.password = Config.getSecret(connstr);
    this.result = null;
    this.error = null;
    this.filename = null;
    this.searchValue = '';
    this.searchVisible = false;
    this.objectInfo = null;
    this.historyItem = 0;
    this.newVersion = null;
    this.tmpScript = null;
    this.script = null; // current editor content, kept in sync for session autosave
    this.cursor = null;    // {row, column} editor cursor, for session restore
    this.scrollRow = null; // editor scroll position (top visible row), for session restore

    this.getTitle = function(){
        if (this.filename != null){
            return this.filename;
        } else {
            if (typeof(this.connstr) != 'undefined' && this.connstr != null) {

                    if (this.connstr.indexOf('---') != -1){ // show alias
                       return '[ '+this.connstr.match(/---\s*(.*)/)[1]+' ]';
                    } else if (this.connstr.startsWith('about:')) {
                        return this.connstr[6].toUpperCase() + this.connstr.substr(7).toLowerCase()
                    } else {
                        if (this.connstr.length > 30){ // cut too long connstr
                           return '[...'+this.connstr.substr(this.connstr.length-20)+' ]';
                        } else {
                           return '[ '+this.connstr+' ]';
                        }
                    }
            }
        }
        return '';
    }
};

var _TabsStore = function(){

    this.theme = (Config.getTheme() || 'dark');
    this.mode = (Config.getMode() || 'classic');
    this.tabs = {};
    this.fontSize = (Config.getFontSize() || 'medium');
    this.order = [];
    this.selectedTab = 0;
    this.renderer = 'plain'; // plain or auto
    this.showQuery = false;
    this.sharingServer = (Config.getSharingServer() || 'share.sqltabs.com');
    this.auto_completion = (Config.getAutoCompletion() || true);

    this.connectionHistory = (Config.getConnHistory() || []);
    this.fileHistory = (Config.getFileHistory() || []);
    this.projects = (Config.getProjects() || []);
    this.completion_words = {}; // keyed by connstr so dbs/users/schemas never mix

    this.getAll = function(){return this.tabs;};

    this.getAllAsArray = function () {
        return this.order.map(function (key) { return this.tabs[key];}, this)
    }

    this.findIndexByProperty = function (property, value) {
        var indexOnOrder = this.getAllAsArray().findIndex(function (tab) {
            return tab[property] == value
        })
        if (indexOnOrder === -1) {
            return -1
        }
        return this.order[indexOnOrder]
    }

    this.newTab = function(connstr){
        if (typeof(connstr) === 'undefined'){
            connstr = this.getConnstr(this.selectedTab);
            if (typeof connstr === 'string' && connstr.startsWith('about:')) {
                connstr = ''
            }
        }
        var password = null;
        if (this.selectedTab > 0) {
            password = this.tabs[this.selectedTab].password;
        }

        var newid = TabSequence.nextval();
        this.tabs[newid] = new Tab(newid, connstr, password);
        this.order.push(newid);
        this.selectedTab = newid;
        return newid;
    };

    this.selectTab = function(id){
        if (id in this.tabs) {
            this.selectedTab = id;
        }
    };

    this.closeTab = function(id){
        delete this.tabs[id];
        var idx = this.order.indexOf(id);
        this.order.splice(idx, 1);
        if (id == this.selectedTab) {
            if (idx <= this.order.length-1) {
                this.selectedTab = this.order[idx];
            } else {
                this.selectedTab = this.order[idx-1];
            }
        }
    };

    this.nextTab = function(){
        if (this.order.length <= 1) {
            return;
        }
        var idx = this.order.indexOf(this.selectedTab)+1;
        if (this.order.indexOf(this.selectedTab) == this.order.length-1){
            idx = 0;
        }
        this.selectedTab = this.order[idx];
    };

    this.previosTab = function(){
        if (this.order.length <= 1) {
            return;
        }
        var idx = this.order.indexOf(this.selectedTab)-1;
        if (this.order.indexOf(this.selectedTab) == 0){
            idx = this.order.length-1;
        }
        this.selectedTab = this.order[idx];
    };

    this.setTheme = function(theme){
        this.theme = theme;
    };

    this.getEditorTheme = function(){
        if (this.theme == 'dark'){
            return 'idle_fingers';
        } else {
            return 'chrome';
        }
    };

    this.setMode = function(mode){
        this.mode = mode;
    };

    this.enableSchemaFilter = function (schemaFilter) {
        this.schemaFilter = schemaFilter;
    }

    this.setSchemaFilterMode = function (mode) {
        this.schemaFilterMode = mode;
    }

    this.setSchemaFilterRegex = function (regex) {
        this.schemaFilterRegEx = regex;
        this.schemaFilterCompiledRegEx = new RegExp(regex, 'i');
    }

    this.getEditorMode = function(){
        if (this.mode == 'vim'){
            return 'ace/keyboard/vim';
        } else {
            return '';
        }
    };

    this.setFontSize = function(size){
        this.fontSize = size;
    };

    this.getFontSize = function(){
        return this.fontSize;
    }

    this.getConnstr = function(id){
        if (id in this.tabs) {
            return this.tabs[id].connstr;
        }
    };

    this.getPassword = function(id){
        if (id in this.tabs) {
            return this.tabs[id].password;
        }
    };

    this.getSecret = function(connstr){
        return Config.getSecret(connstr);
    }

    this.setConnection = function(id, connstr){
        // normalize once, here, so the tab connstr, the history entry and the secret
        // lookup key are always identical -- a stray surrounding space must never fork
        // a connection into a second history entry with a mismatched password.
        if (typeof connstr === 'string'){ connstr = connstr.trim(); }
        this.tabs[id].connstr = connstr;
        this.tabs[id].connector_type = Executor.getConnector(connstr).connector_type;
        // load the password saved for THIS connstr (if any), so selecting a saved
        // connection connects with its own credentials -- not whatever password was
        // left over from the previously selected connection.
        this.tabs[id].password = Config.getSecret(connstr);

        if (connstr == null || connstr == ""){ // don't track empty connstr
            return;
        }

        var hist_idx = this.connectionHistory.indexOf(connstr);
        if (hist_idx == -1){ // add to history
            if (this.connectionHistory.length === 20){// limit history size
                this.connectionHistory.pop();
            }
            this.connectionHistory.unshift(connstr);
        } else { // shift to the beginning of history
            this.connectionHistory.splice(hist_idx, 1);
            this.connectionHistory.unshift(connstr);
        }
    };

    this.removeConnectionItem = function(connstr){
        var idx = this.connectionHistory.indexOf(connstr)
        if (idx > -1){
            this.connectionHistory.splice(idx, 1);

        }
    };

    this.setPassword = function(id, password, savePassword){
        this.tabs[id].password = password;
        var connstr = this.getConnstr(id);

        if (savePassword){
            Config.saveSecret(connstr, password);
        } else {
            Config.saveSecret(connstr, null);
        }

        for (var key in this.tabs){ // update password in all tabs with the same connstr
            if (this.tabs[key].connstr == connstr){
                this.tabs[key].password = password;
            }
        }
    };

    this.setResult = function(id, result){
        if (typeof(this.tabs[id]) != 'undefined'){
            this.tabs[id].result = result;
        }
    };

    this.getResult = function(id){
        if (id in this.tabs){
            return this.tabs[id].result;
        }
    };

    this.setError = function(id, error){
        if (id in this.tabs){
            this.tabs[id].error = error;
        }
    };

    this.getError = function(id){
        if (id in this.tabs){
            return this.tabs[id].error;
        }
    };

    this.openFile = function(filename, tabid){
        if (tabid == null){
            tabid = this.selectedTab;
        }
        this.tabs[tabid].filename = filename;
    }

    this.saveFile = function(filename){
        this.tabs[this.selectedTab].filename = filename;
    }

    this.closeFile = function(){
        this.tabs[this.selectedTab].filename = null;
    }

    this.getEditorFile = function(id){
        if (id in this.tabs){
            return this.tabs[id].filename;
        }
    };

    // store the current editor content for a tab and (debounced) persist the
    // session so unsaved work is not lost on a crash/freeze/quit.
    this.setScript = function(id, content, cursor, scrollRow){
        if (id in this.tabs){
            this.tabs[id].script = content;
            if (cursor !== undefined){ this.tabs[id].cursor = cursor; }
            if (scrollRow !== undefined){ this.tabs[id].scrollRow = scrollRow; }
            SessionStore.scheduleSave(this);
        }
    };

    this.getTabByFilename = function(filename){
        for (var id in this.tabs){
            if (this.tabs[id].filename == filename){
                return Number(id);
            }
        }
        return null;
    }

    this.setRenderer = function(renderer){
        this.renderer = renderer
    }

    this.getRenderer = function(){
        return this.renderer;
    }

    this.setSearchValue = function(value){
        this.searchValue = value;
    }

    this.getSearchValue = function(){
        return this.searchValue;
    }

    this.setObjectInfo = function(object){
        this.objectInfo = object;
    }

    this.getObjectInfo = function(){
        return this.objectInfo;
    }

    this.setHistoryItem = function(idx){
        this.historyItem = idx;
    }

    this.getHistoryItem = function(){
        return this.historyItem;
    }

    this.recordFileAccess = function(filename){
        if (!filename){ return; }
        this.fileHistory = this.fileHistory.filter(function(f){ return f != filename; });
        this.fileHistory.unshift(filename);
        if (this.fileHistory.length > 20){ this.fileHistory = this.fileHistory.slice(0, 20); }
        Config.saveFileHistory(this.fileHistory);
    };

    this.rereadConfig = function(){
        this.theme = (Config.getTheme() || 'dark');
        this.mode = (Config.getMode() || 'classic');
        this.connectionHistory = (Config.getConnHistory() || []);
        this.fileHistory = (Config.getFileHistory() || []);
    };

    this.setCloudDoc = function(docid){
        this.cloudDoc = docid;
    };

    this.getCloudDoc = function(){
        return this.cloudDoc;
    };

    this.setCloudError = function(error){
        this.cloudError = error;
    };

    this.getCloudError = function(){
        return this.cloudError;
    };

    this.addProject = function(dirname, alias){
        this.projects.push({path: dirname, alias: alias});
        Config.saveProjects(this.projects);
    }

    this.getProjects = function(){
        return this.projects;
    }

    this.removeProject = function(idx){
        this.projects.splice(idx, 1);
        Config.saveProjects(this.projects);
    }

    this.getCompletionWords = function(connstr){
        return (connstr && this.completion_words[connstr]) || [];
    }

    this.updateCompletionWords = function(connstr, words){
        if (connstr){ this.completion_words[connstr] = words; }
    }

    this.setEcho = function(boolean_echo){
        this.showQuery = boolean_echo;
        this.trigger('change-show-query')
    }

    this.exportResult = function(filename, format){
        if (format == 'json'){
            fs.writeFile(filename, JSON.stringify(this.tabs[this.selectedTab].result), function(err) {
                if(err) {
                    return console.log(err);
                }
            });
            return;
        }
        if (format == 'csv'){
            var file = fs.openSync(filename, 'w');
            for (var i = 0; i < this.tabs[this.selectedTab].result.length; i++){
                var block = this.tabs[this.selectedTab].result[i]
                for (var j = 0; j < block.datasets.length; j++){
                    var dataset = block.datasets[j];
                    // write field names
                    var field_names = [];
                    dataset.fields.forEach(function(field){
                        field_names.push('"' + field.name + '"');
                    });
                    fs.writeSync(file, field_names.join()+EOL);
                    // write records. Quote a field only when it actually needs it
                    // (contains a comma, double-quote, or newline); numbers and plain
                    // strings go out unquoted. Type-based quoting isn't possible here --
                    // the TAP connector tags every field as 'string' and postgres returns
                    // all values as text -- so we key off the value's content instead.
                    dataset.data.forEach(function(record){
                        var values = []
                        record.forEach(function(col){
                            if (col == null){
                                values.push("NULL");
                            } else if (/[",\r\n]/.test(col)){
                                values.push('"' + col.replace(/"/g, '""') + '"');
                            } else {
                                values.push(col);
                            }
                        });
                        fs.writeSync(file, values.join()+EOL);
                    });
                }
            }
            return;
        }

    }

    // Build everything needed to share the active tab's result to a Nextcloud folder:
    // a subfolder name (user_server_date_time) plus the CSV and query text. Returns null
    // when there's no result to share.
    this.getSharePayload = function(){
        var id = this.selectedTab;
        var result = this.getResult(id);
        if (result == null || result.length === 0){ return null; }
        var connstr = this.getConnstr(id);
        var connector = Executor.getConnector(connstr);
        var isAdql = !!(connector && connector.connector_type === 'tap');
        // For TAP/ADQL connections use the connector's own parsing so the real archive
        // host is used (gaia://->gea..., gaiapre://->geapre...), and save the query as .adql.
        var info;
        if (isAdql && typeof connector.parseConnInfo === 'function'){
            var ci = connector.parseConnInfo(connstr);
            info = { user: ci.user || 'anon', server: ci.host || 'tap' };
        } else {
            info = parseUserHost(connstr);
        }
        return {
            folderName: sanitizeName(info.user) + '_' + sanitizeName(info.server) + '_' + shareTimestamp(),
            csv: resultToCSV(result),
            query: resultToQuery(result),
            queryFile: isAdql ? 'query.adql' : 'query.sql',
        };
    };

    // Write any result block that carries a `--- csv <file>` or `--- json <file>` marker to
    // that local path, reusing the same serialization as the manual export. Returns
    // {saved:[paths], errors:[messages]}. A bare `--- csv` (no filename) only affects
    // rendering and is left untouched.
    this.saveMarkedExports = function(result){
        var saved = [], errors = [];
        if (!result || !result.length){ return { saved: saved, errors: errors }; }
        for (var i = 0; i < result.length; i++){
            var block = result[i];
            var firstLine = (block.query || '').split(/\r?\n/)[0] || '';
            var m = /^\s*---\s+(csv|json)\s+(\S.*?)\s*$/i.exec(firstLine);
            if (!m){ continue; }
            var fmt = m[1].toLowerCase();
            var file = resolveExportPath(m[2]);
            try {
                var content = (fmt === 'json')
                    ? JSON.stringify(block.datasets, null, 2)
                    : resultToCSV([block]);
                fs.writeFileSync(file, content);
                saved.push(file);
            } catch (e){
                errors.push(file + ': ' + e.message);
            }
        }
        return { saved: saved, errors: errors };
    };

    // Remembers what is being shared so it can be recorded once the upload succeeds.
    this.pendingShare = null;

    // Append a successfully-shared query to the local shared-queries history
    // (stored in ~/.sqltabs/shared_queries.json).
    this.recordSharedQuery = function(link){
        if (this.pendingShare == null){ return; }
        ShareHistory.push({
            time: new Date().getTime(),
            link: link,
            folder: this.pendingShare.folderName,
            query: this.pendingShare.query,
            connstr: this.pendingShare.connstr,
        });
        this.pendingShare = null;
        this.trigger('shared-queries-changed');
    };

    this.getSharedQueries = function(){
        return ShareHistory.all();
    };

    this.clearSharedQueries = function(){
        ShareHistory.clear();
        this.trigger('shared-queries-changed');
    };

    this.getConnectionColor = function(connstr){
        if (connstr == null){
            connstr = this.getConnstr(this.selectedTab);
        }
        return Config.getConnectionColor(connstr);
    }

    this.saveConnectionColor = function(color){
        var connstr = this.getConnstr(this.selectedTab);
        Config.saveConnectionColor(connstr, color);
    }

    this.setAutocompletion = function(auto_completion){
        this.auto_completion = auto_completion;
        this.trigger('change-auto-completion');
        Config.saveAutoCompletion(auto_completion);
    }

    // restore previously open tabs (and their unsaved content) on startup;
    // fall back to a single tab on the most recent connection string.
    var session = SessionStore.load();
    if (session != null && session.tabs && session.tabs.length > 0){
        var self = this;
        session.tabs.forEach(function(t){
            var id = self.newTab(t.connstr);
            if (t.filename != null){ self.tabs[id].filename = t.filename; }
            if (t.script != null){ self.tabs[id].script = t.script; }
            if (t.cursor != null){ self.tabs[id].cursor = t.cursor; }
            if (t.scrollRow != null){ self.tabs[id].scrollRow = t.scrollRow; }
        });
        var sel = session.selectedIndex;
        if (typeof sel === 'number' && sel >= 0 && sel < this.order.length){
            this.selectedTab = this.order[sel];
        }
    } else if (typeof(Config.getConnHistory()) != 'undefined' && Config.getConnHistory().length > 0){
        var connstr = Config.getConnHistory()[0];
        this.newTab(connstr);
    } else {
        this.newTab();
    }

};

MicroEvent.mixin(_TabsStore);

var TabsStore = new _TabsStore();


module.exports = TabsStore;
