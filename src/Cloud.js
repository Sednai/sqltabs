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

var request = require('request');

if (typeof(DEVMODE) == 'undefined'){
    var DEVMODE = true;
}

const Cloud = {

    // Upload a result (CSV) and its query to a Nextcloud/ownCloud public share folder.
    // shareUrl is a public link like "https://host/s/TOKEN" (or ".../index.php/s/TOKEN");
    // the folder must be shared with upload/editing permission. We talk WebDAV to the
    // public endpoint (public.php/webdav) authenticating with the share token as the user
    // and the optional share password. A timestamped subfolder is created (MKCOL) and the
    // two files are PUT into it. callback(folderLink) / err_callback(message).
    share: function(shareUrl, sharePassword, folderName, csv, query, queryFile, callback, err_callback){
        var m = /^(https?:\/\/[^/]+).*\/s\/([^/?#]+)/.exec(shareUrl || '');
        if (!m){
            err_callback('Invalid share link. Expected a Nextcloud/ownCloud public link like https://host/s/TOKEN');
            return;
        }
        var base = m[1];
        var token = m[2];
        var dav = base + '/public.php/webdav/' + encodeURIComponent(folderName);
        var auth = { user: token, pass: sharePassword || '', sendImmediately: true };

        var put = function(name, body, contentType, next){
            request({ method: 'PUT', uri: dav + '/' + name, auth: auth,
                      headers: { 'Content-Type': contentType }, body: body },
                function(err, res){
                    if (err){ err_callback(err.message); return; }
                    if (res.statusCode >= 200 && res.statusCode < 300){ next(); }
                    else { err_callback('Upload of ' + name + ' failed (HTTP ' + res.statusCode + '). ' +
                                        'Check that the link allows uploading.'); }
                });
        };

        // 1) create the subfolder; 201 = created, 405 = already exists (both fine).
        request({ method: 'MKCOL', uri: dav, auth: auth },
            function(err, res){
                if (err){ err_callback(err.message); return; }
                if (res.statusCode === 201 || res.statusCode === 405 ||
                    (res.statusCode >= 200 && res.statusCode < 300)){
                    // 2) upload results then query, then hand back the browsable folder URL.
                    put('results.csv', csv, 'text/csv', function(){
                        put(queryFile || 'query.sql', query, 'application/sql', function(){
                            callback(base + '/index.php/s/' + token + '?path=/' + encodeURIComponent(folderName));
                        });
                    });
                } else if (res.statusCode === 401 || res.statusCode === 403){
                    err_callback('Access denied (HTTP ' + res.statusCode + '). The link may be wrong, ' +
                                 'password-protected, or not allow uploading.');
                } else {
                    err_callback('Could not create folder (HTTP ' + res.statusCode + ').');
                }
            });
    },

    getVersion: function(callback){
        if (!DEVMODE){
            request({
                method: 'GET',
                uri: 'http://www.sqltabs.com/version',
                },
                function(err, res, body){
                    if (err){
                        return; // ignore errors
                    }

                    callback(body);
                });
        } else {
            console.log("skipping check for update in devmode");
        }
    }
}
module.exports = Cloud;
