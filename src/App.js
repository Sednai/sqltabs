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

// Electron throws "prompt() is and will not be supported" whenever the bundled Ace
// editor (brace) invokes window.prompt for its gotoline keybinding -- which fired on
// stray keystrokes and spammed the console. Neutralize it with a no-op so the editor
// keybinding degrades silently instead of throwing on every press.
if (typeof window !== 'undefined'){
    window.prompt = function(){ return null; };
}

var React = require('react');
var ReactDOM = require('react-dom');
var PasswordDialog = require('./PasswordDialog');
var About = require('./About');
var TabsNav = require('./TabsNav');
var TabsStore = require('./TabsStore');
var TabContainer = require('./TabContainer');
var HistoryCarousel = require('./HistoryCarousel');
var Config = require('./Config');
var Actions = require('./Actions');
var CloudMessage = require('./CloudMessage');
var UpgradeMessage = require('./UpgradeMessage');
var SessionStore = require('./SessionStore');

require('electron').ipcRenderer.on('open-file', function(event, path) {
    var existing_tab = TabsStore.getTabByFilename(path);
    if (existing_tab != null){
        Actions.select(existing_tab);
    } else {
        Actions.newTab(null, path);
    }
})

require('electron').ipcRenderer.on('open-url', function(event, url) {
    Actions.newTab(null, null, url);
})

require('./Menu');

// Persist the session whenever the tab set / selection / connection changes
// (all of which trigger 'change'). Editor content changes are persisted
// separately from the editor itself. Debounced inside SessionStore.
TabsStore.bind('change', function(){
    SessionStore.scheduleSave(TabsStore);
});

// On window close, capture the latest editor content synchronously and write
// the session immediately so nothing in the debounce window is lost.
window.addEventListener('beforeunload', function(){
    TabsStore.trigger('persist-now');
    SessionStore.flush(TabsStore);
});

var mountNode = document.getElementById('root');

var App = React.createClass({

    render: function(){
        return (
            <div className="tab-app">
                <TabsNav/>
                <TabContainer/>
                <PasswordDialog/>
                <About/>
                <HistoryCarousel/>
                <CloudMessage/>
                <UpgradeMessage/>
            </div>
        );
    },
});

var app = <App/>;

var theme = (Config.getTheme() || 'dark');
var size = (Config.getFontSize() || 'medium');
var schemaFilter = (Config.getSchemaFilter() || {
    enabled: false,
    mode: 'black',
    regex: '.*temp.*',
});
Actions.setTheme(theme);
Actions.setFontSize(size);
Actions.enableSchemaFilter(schemaFilter.enabled);
Actions.setSchemaFilterMode(schemaFilter.mode);
Actions.setSchemaFilterRegEx(schemaFilter.regex);
Actions.upgradeCheck();

ReactDOM.render(app, mountNode);
