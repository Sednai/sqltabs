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

// Local history of queries shared to a cloud folder, kept in its own file under the
// user's .sqltabs directory (alongside config.json / history.json) so the frequently
// rewritten config stays small. Each entry: {time, link, folder, query, connstr}.

var lowdb = require('lowdb');
var path = require('path');
var fs = require('fs');

var config_dir = path.join((process.env.HOME || process.env.HOMEPATH || process.env.APPDATA), '.sqltabs')
var shares_path = path.join(config_dir, 'shared_queries.json')

if (!fs.existsSync(config_dir)){
    fs.mkdirSync(config_dir);
}

var db = lowdb(shares_path)

if (!db.object.shares){
    db.object.shares = [];
}

var shares = db.object.shares;

var ShareHistory = {

    push: function(entry){
        fs.unwatchFile(shares_path);
        shares.unshift(entry);
        if (shares.length > 1000){
            shares.pop();
        }
        try {
            db.saveSync();
        } catch (e) {
            console.log('failed to save shared queries: ' + e);
        } finally {
            fs.watchFile(shares_path, this.fileChangeHandler);
        }
    },

    get: function(idx){
        return (idx >= 0 && idx < shares.length) ? shares[idx] : null;
    },

    all: function(){
        return shares;
    },

    length: function(){
        return shares.length;
    },

    clear: function(){
        fs.unwatchFile(shares_path);
        shares.length = 0;
        try {
            db.saveSync();
        } catch (e) {
            console.log('failed to clear shared queries: ' + e);
        } finally {
            fs.watchFile(shares_path, this.fileChangeHandler);
        }
    },

    fileChangeHandler: function(){
        var db = lowdb(shares_path);
        shares = db.object.shares || [];
    },

}

fs.watchFile(shares_path, ShareHistory.fileChangeHandler);

module.exports = ShareHistory;
