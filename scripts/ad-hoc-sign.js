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

// electron-builder `afterPack` hook: ad-hoc codesign the packaged macOS .app.
//
// We have no Apple Developer certificate, so the build cannot be properly signed
// or notarized. Without *any* signature an Apple Silicon (arm64) build that has
// been downloaded (and therefore quarantined) is rejected outright with
// "the application is damaged and can't be opened" -- which the normal
// Privacy & Security "Open Anyway" flow cannot override.
//
// An ad-hoc signature ("codesign --sign -") is enough to avoid the "damaged"
// state, so the app can be opened the usual way for unsigned software: try to
// open it, then approve it once under System Settings -> Privacy & Security
// ("Open Anyway"). It does NOT remove that one-time approval -- only a real
// Developer ID signature + notarization would.
//
// `mac.identity` is set to null in package.json so electron-builder skips its own
// signing phase and leaves this signature untouched.

const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function adHocSign(context) {
    if (context.electronPlatformName !== 'darwin') { return; }

    const appName = context.packager.appInfo.productFilename;
    const appPath = path.join(context.appOutDir, appName + '.app');

    // --deep ad-hoc signs the nested helper apps and frameworks too. (--deep is
    // deprecated for real signing, but remains the simplest way to ad-hoc sign a
    // bundle and is fine for unsigned distribution.)
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
    console.log('ad-hoc signed ' + appPath + ' (' + context.arch + ')');
};
