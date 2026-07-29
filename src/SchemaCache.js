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

// Autocompletion word lists persisted per (endpoint, user) under the user's .sqltabs
// directory. Loading the schema of a large TAP archive is slow -- against the Gaia archive
// the login plus the VOSI /tables document alone take ~25s, before the ~4k column names --
// so a fresh connection had no completions at all for half a minute. Keeping the last known
// list on disk makes table names available immediately at startup while the connector
// refreshes them in the background.
//
// One file per connection, not one shared file, because each list is ~75KB: a single file
// meant rewriting every endpoint's words (synchronously, on the renderer thread) to save
// one, parsing them all at startup even when unused, letting a second app instance clobber
// the entries of the first, and losing every cache to one corrupt file. Writes go to a
// temporary file and are renamed into place, so an interrupted write cannot leave a
// half-written cache behind.

var path = require('path');
var fs = require('fs');
var crypto = require('crypto');

var MAX_AGE_MS = 30 * 24 * 3600 * 1000; // forget a schema not seen for a month
var MAX_ENTRIES = 20;                   // bound the directory: keep the most recent endpoints

var config_dir = path.join((process.env.HOME || process.env.HOMEPATH || process.env.APPDATA), '.sqltabs')
var cache_dir = path.join(config_dir, 'schema_cache')
var legacy_path = path.join(config_dir, 'schema_cache.json')

var memo = {}; // key -> words, so repeated lookups in a session don't re-read the file

function ensureDir(){
    try {
        if (!fs.existsSync(config_dir)){ fs.mkdirSync(config_dir); }
        if (!fs.existsSync(cache_dir)){ fs.mkdirSync(cache_dir); }
        return true;
    } catch (e) {
        console.log('cannot create schema cache directory: ' + e);
        return false;
    }
}

// A readable file name plus a hash of the full key, so distinct endpoints never collide
// however their host and user names are mangled by sanitising.
function fileFor(key){
    var hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 8);
    var label = String(key)
        .replace(/^https?:\/\//, '')
        .replace(/[^A-Za-z0-9._-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 60);
    return path.join(cache_dir, (label || 'schema') + '-' + hash + '.json');
}

// Keep only the most recently written entries.
function prune(){
    try {
        var files = fs.readdirSync(cache_dir).filter(function(f){ return /\.json$/.test(f); });
        if (files.length <= MAX_ENTRIES){ return; }
        files.map(function(f){
            var p = path.join(cache_dir, f);
            var t = 0;
            try { t = fs.statSync(p).mtimeMs || 0; } catch (e) { /* vanished */ }
            return { p: p, t: t };
        }).sort(function(a, b){ return b.t - a.t; })
          .slice(MAX_ENTRIES)
          .forEach(function(x){ try { fs.unlinkSync(x.p); } catch (e) { /* already gone */ } });
    } catch (e) {
        console.log('failed to prune schema cache: ' + e);
    }
}

// One-off import of the single-file cache written by v1.3.6, so the lists it already holds
// (each of which cost a slow schema load) are not thrown away on upgrade.
function migrateLegacy(){
    if (!fs.existsSync(legacy_path)){ return; }
    try {
        var old = JSON.parse(fs.readFileSync(legacy_path, 'utf8'));
        var schemas = (old && old.schemas) || {};
        Object.keys(schemas).forEach(function(key){
            var entry = schemas[key];
            if (!entry || !Array.isArray(entry.words) || !entry.words.length){ return; }
            if (fs.existsSync(fileFor(key))){ return; }
            writeEntry(key, entry.words, entry.time || Date.now());
        });
    } catch (e) {
        console.log('could not import the previous schema cache: ' + e);
    }
    try { fs.unlinkSync(legacy_path); } catch (e) { /* leave it if it cannot be removed */ }
}

function writeEntry(key, words, time){
    var target = fileFor(key);
    var tmp = target + '.tmp';
    var body = JSON.stringify({ key: key, time: time, words: words });
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, target); // atomic: readers never observe a partial file
}

var SchemaCache = {

    // Words last loaded for this key, or null when absent, unreadable or too old to trust.
    get: function(key){
        if (!key){ return null; }
        if (memo[key]){ return memo[key]; }
        var file = fileFor(key);
        try {
            if (!fs.existsSync(file)){ return null; }
            var entry = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (!entry || !Array.isArray(entry.words) || !entry.words.length){ return null; }
            if (entry.time && (Date.now() - entry.time) > MAX_AGE_MS){ return null; }
            memo[key] = entry.words;
            return entry.words;
        } catch (e) {
            // a cache is optional: a damaged file is ignored, never fatal
            console.log('ignoring unreadable schema cache for ' + key + ': ' + e);
            return null;
        }
    },

    // Timestamp of the stored list (for reporting), or null.
    age: function(key){
        if (!key){ return null; }
        try {
            var file = fileFor(key);
            if (!fs.existsSync(file)){ return null; }
            return JSON.parse(fs.readFileSync(file, 'utf8')).time || null;
        } catch (e) {
            return null;
        }
    },

    put: function(key, words){
        if (!key || !Array.isArray(words) || !words.length){ return; }
        if (!ensureDir()){ return; }
        memo[key] = words.slice();
        try {
            writeEntry(key, memo[key], Date.now());
            prune();
        } catch (e) {
            console.log('failed to save schema cache for ' + key + ': ' + e);
        }
    },

    clear: function(){
        memo = {};
        try {
            if (!fs.existsSync(cache_dir)){ return; }
            fs.readdirSync(cache_dir).forEach(function(f){
                if (/\.json(\.tmp)?$/.test(f)){
                    try { fs.unlinkSync(path.join(cache_dir, f)); } catch (e) { /* already gone */ }
                }
            });
        } catch (e) {
            console.log('failed to clear schema cache: ' + e);
        }
    },

}

if (ensureDir()){ migrateLegacy(); }

module.exports = SchemaCache;
