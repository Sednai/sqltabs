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

// Persists the open editor tabs (connection string, filename, unsaved script
// content) to ~/.sqltabs/session.json so work survives a crash, freeze, or quit
// and the tabs are restored on the next start. Writes are debounced and atomic
// (temp file + rename) to avoid losing or corrupting the session on a bad write.

var fs = require('fs');
var path = require('path');

var config_dir = path.join((process.env.HOME || process.env.HOMEPATH || process.env.APPDATA), '.sqltabs');
var session_path = path.join(config_dir, 'session.json');

var saveTimer = null;

var SessionStore = {

    load: function(){
        try {
            if (fs.existsSync(session_path)){
                return JSON.parse(fs.readFileSync(session_path, 'utf8'));
            }
        } catch (e) {
            console.log('failed to read session: ' + e);
        }
        return null;
    },

    // Build a serializable snapshot of the open tabs from the TabsStore.
    // 'about:' tabs (settings/about pages) are not persisted.
    snapshot: function(store){
        var tabs = [];
        var selectedIndex = 0;
        store.order.forEach(function(id){
            var t = store.tabs[id];
            if (t == null){ return; }
            var cs = t.connstr;
            if (typeof cs === 'string' && cs.indexOf('about:') === 0){ return; }
            if (id === store.selectedTab){ selectedIndex = tabs.length; }
            tabs.push({
                connstr: (t.connstr != null ? t.connstr : null),
                filename: (t.filename != null ? t.filename : null),
                script: (t.script != null ? t.script : null),
                cursor: (t.cursor != null ? t.cursor : null),
                scrollRow: (t.scrollRow != null ? t.scrollRow : null),
            });
        });
        return { version: 1, selectedIndex: selectedIndex, tabs: tabs };
    },

    save: function(store){
        try {
            if (!fs.existsSync(config_dir)){ fs.mkdirSync(config_dir); }
            var data = JSON.stringify(this.snapshot(store));
            var tmp = session_path + '.tmp';
            fs.writeFileSync(tmp, data);
            fs.renameSync(tmp, session_path); // atomic replace
        } catch (e) {
            console.log('failed to save session: ' + e);
        }
    },

    // Debounced save: coalesces bursts of edits into a single write.
    scheduleSave: function(store){
        var self = this;
        if (saveTimer){ clearTimeout(saveTimer); }
        saveTimer = setTimeout(function(){
            saveTimer = null;
            self.save(store);
        }, 800);
    },

    // Synchronous save: used on window close so the very latest edits are kept.
    flush: function(store){
        if (saveTimer){ clearTimeout(saveTimer); saveTimer = null; }
        this.save(store);
    },
};

module.exports = SessionStore;
