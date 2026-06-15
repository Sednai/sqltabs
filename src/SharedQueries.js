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

// A modal listing queries previously shared to the cloud folder. Opened via a shortcut
// (Cmd/Ctrl+Shift+Y). Each entry can be reloaded into the editor, opened in the browser,
// or have its link copied to the clipboard.

var React = require('react');
var Modal = require('react-bootstrap').Modal;
var Button = require('react-bootstrap').Button;
var TabsStore = require('./TabsStore');
var Actions = require('./Actions');
var Shell = require('electron').shell;
var Clipboard = require('electron').clipboard;

function userHost(connstr){
    var s = (connstr || '').split('---')[0].trim();
    var m = /^[a-z0-9+]+:\/\/([^/?#]+)/i.exec(s);
    var authority = m ? m[1] : s;
    var user = '', at = authority.indexOf('@');
    if (at !== -1){ user = authority.slice(0, at).split(':')[0]; authority = authority.slice(at + 1); }
    var host = authority.split('/')[0].split(':')[0];
    return user ? (user + '@' + host) : host;
}

var SharedQueries = React.createClass({

    getInitialState: function(){
        return { hidden: true };
    },

    componentDidMount: function(){
        TabsStore.bind('toggle-shared-queries', this.toggleHandler);
        TabsStore.bind('shared-queries-changed', this.changedHandler);
    },

    componentWillUnmount: function(){
        TabsStore.unbind('toggle-shared-queries', this.toggleHandler);
        TabsStore.unbind('shared-queries-changed', this.changedHandler);
        document.body.removeEventListener('keydown', this.keyHandler);
    },

    toggleHandler: function(){
        if (this.state.hidden){
            document.body.addEventListener('keydown', this.keyHandler);
        } else {
            document.body.removeEventListener('keydown', this.keyHandler);
        }
        this.setState({ hidden: !this.state.hidden });
    },

    changedHandler: function(){
        if (!this.state.hidden){ this.forceUpdate(); }
    },

    keyHandler: function(e){
        if (e.keyCode == 27){ this.hide(); e.preventDefault(); e.stopPropagation(); }
    },

    hide: function(){
        document.body.removeEventListener('keydown', this.keyHandler);
        this.setState({ hidden: true });
        Actions.focusEditor();
    },

    load: function(query){
        Actions.insertText(query);
        this.hide();
    },

    open: function(link){
        if (link){ Shell.openExternal(link); }
    },

    copy: function(link){
        if (link){ Clipboard.writeText(link); }
    },

    clear: function(){
        TabsStore.clearSharedQueries();
    },

    render: function(){
        if (this.state.hidden){ return (<span/>); }

        var self = this;
        var items = TabsStore.getSharedQueries();

        var body;
        if (items.length === 0){
            body = <p> No shared queries yet. </p>;
        } else {
            var rows = items.map(function(item, idx){
                var d = new Date(item.time);
                var when = d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
                var snippet = (item.query || '').replace(/\s+/g, ' ').trim();
                if (snippet.length > 160){ snippet = snippet.slice(0, 160) + '…'; }
                return (
                    <div className="shared-query-item" key={'sq_' + idx}>
                        <div className="shared-query-meta">
                            <span className="shared-query-when">{when}</span>
                            {'  '}
                            <span className="shared-query-host">{userHost(item.connstr)}</span>
                            {'  '}
                            <span className="shared-query-folder">{item.folder}</span>
                        </div>
                        <pre className="shared-query-snippet">{snippet}</pre>
                        <div className="shared-query-actions">
                            <Button bsSize="xsmall" onClick={function(){ self.load(item.query); }}>Load</Button>{' '}
                            <Button bsSize="xsmall" onClick={function(){ self.open(item.link); }}>Open</Button>{' '}
                            <Button bsSize="xsmall" onClick={function(){ self.copy(item.link); }}>Copy link</Button>
                        </div>
                    </div>
                );
            });
            body = <div className="shared-query-list">{rows}</div>;
        }

        return (
            <div className="static-modal">
              <Modal.Dialog
                bsStyle='primary'
                backdrop={false}
                animation={false}
                container={document.body}
                >
                <Modal.Body>
                    <h4>Shared queries</h4>
                    <hr/>
                    {body}
                </Modal.Body>
                <Modal.Footer>
                   <Button onClick={this.clear}>Clear all</Button>
                   <Button onClick={this.hide}>Close</Button>
                </Modal.Footer>
              </Modal.Dialog>
            </div>
        );
    },
});

module.exports = SharedQueries;
