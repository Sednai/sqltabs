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

// Autocompletion word lists persisted per (endpoint, user), in their own file under the
// user's .sqltabs directory. Loading the schema of a large TAP archive is slow -- against
// the Gaia archive the login plus the VOSI /tables document alone take ~25s, before the
// ~4k column names -- so a fresh connection had no completions at all for half a minute.
// Keeping the last known list on disk makes table names available immediately at startup
// while the connector refreshes them in the background.

var lowdb = require('lowdb');
var path = require('path');
var fs = require('fs');

var MAX_AGE_MS = 30 * 24 * 3600 * 1000; // forget a schema not seen for a month
var MAX_ENTRIES = 20;                   // bound the file: keep the most recent endpoints

var config_dir = path.join((process.env.HOME || process.env.HOMEPATH || process.env.APPDATA), '.sqltabs')
var cache_path = path.join(config_dir, 'schema_cache.json')

if (!fs.existsSync(config_dir)){
    fs.mkdirSync(config_dir);
}

// This file is rewritten whenever a schema loads, so treat it as disposable: a truncated or
// hand-edited cache must never stop the app from starting. Fall back to an in-memory store.
var db;
try {
    db = lowdb(cache_path);
} catch (e) {
    console.log('unreadable schema cache, ignoring it: ' + e);
    db = { object: {}, saveSync: function(){} };
}

if (!db.object.schemas || typeof db.object.schemas != 'object'){
    db.object.schemas = {};
}

var schemas = db.object.schemas;

// Drop the oldest entries when there are too many, so the file cannot grow without bound.
function prune(){
    var keys = Object.keys(schemas);
    if (keys.length <= MAX_ENTRIES){ return; }
    keys.sort(function(a, b){ return (schemas[b].time || 0) - (schemas[a].time || 0); });
    keys.slice(MAX_ENTRIES).forEach(function(k){ delete schemas[k]; });
}

var SchemaCache = {

    // Words last loaded for this key, or null when absent or too old to trust.
    get: function(key){
        var entry = schemas[key];
        if (!entry || !Array.isArray(entry.words) || !entry.words.length){ return null; }
        if (entry.time && (Date.now() - entry.time) > MAX_AGE_MS){ return null; }
        return entry.words;
    },

    // Timestamp of the stored list (for reporting), or null.
    age: function(key){
        var entry = schemas[key];
        return (entry && entry.time) ? entry.time : null;
    },

    put: function(key, words){
        if (!key || !Array.isArray(words) || !words.length){ return; }
        schemas[key] = { time: Date.now(), words: words };
        prune();
        this.save();
    },

    clear: function(){
        Object.keys(schemas).forEach(function(k){ delete schemas[k]; });
        this.save();
    },

    save: function(){
        try {
            db.saveSync();
        } catch (e) {
            // a cache is optional: log and carry on rather than breaking completion
            console.log('failed to save schema cache: ' + e);
        }
    },

}

module.exports = SchemaCache;
