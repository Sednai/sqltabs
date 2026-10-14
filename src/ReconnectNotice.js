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

// Non-blocking notice shown when a tab's database session reconnected after an
// unexpected drop (external ssh tunnel died, server restarted, network blip).
// The new backend session is clean: SET GUCs, search_path, temp tables and any
// open transaction are gone -- the user must know, because queries that "worked
// before" may now behave differently.
//
// One global instance (App.js), stacked notices merged per tab: a drop on a
// background tab must still be reported, and separate dialogs per tab would
// cover the app. The bootstrap .modal wrapper is made click-through by CSS
// (.reconnect-modal pointer-events:none) so the app stays usable while the
// notice is up -- unlike UpgradeMessage, this one must not demand attention.

var React = require('react');
var Modal = require('react-bootstrap').Modal;
var Button = require('react-bootstrap').Button;
var TabsStore = require('./TabsStore');

var AUTO_DISMISS_MS = 10000;
var MAX_NOTICES = 3;

var ReconnectNotice = React.createClass({

    getInitialState: function(){
        return { hidden: true, notices: [] };
    },

    componentDidMount: function(){
        TabsStore.bind('session-restored', this.sessionRestoredHandler);
    },

    componentWillUnmount: function(){
        TabsStore.unbind('session-restored', this.sessionRestoredHandler);
        if (this._timer){ clearTimeout(this._timer); }
    },

    sessionRestoredHandler: function(id){
        if (!(id in TabsStore.tabs)){ return; } // tab closed while reconnecting
        var next = this.state.notices.filter(function(n){ return n.id !== id; });
        next.push({ id: id, connstr: TabsStore.getConnstr(id) });
        if (next.length > MAX_NOTICES){ next = next.slice(next.length - MAX_NOTICES); }
        this.setState({ hidden: false, notices: next });
        if (this._timer){ clearTimeout(this._timer); }
        this._timer = setTimeout(this.hide, AUTO_DISMISS_MS);
    },

    hide: function(){
        if (this._timer){ clearTimeout(this._timer); this._timer = null; }
        this.setState({ hidden: true, notices: [] });
    },

    render: function(){

        if (this.state.hidden){
            return <span refs=""/>;
        }

        var notices = this.state.notices;
        var line;
        if (notices.length === 1){
            line = <p>Connection re-established: <b>{notices[0].connstr}</b></p>;
        } else {
            var names = notices.map(function(n){
                return <span key={n.id}>{n.connstr}{' '}</span>;
            });
            line = <p>Connections re-established ({notices.length}): {names}</p>;
        }

        return (
          <div className='static-modal reconnect-modal' onClick={this.hide}>
            <Modal.Dialog
              bsStyle='warning'
              backdrop={false}
              animation={false}
              container={document.body}
              onRequestHide={this.hide}
              dialogClassName='reconnect-notice'
              >
              <Modal.Body>
                {line}
                <p className="reconnect-warning">This is a <b>new session</b>: SET values,
                   search_path, temp tables and any open transaction are gone.</p>
              </Modal.Body>
              <Modal.Footer>
                 <Button onClick={this.hide}>OK</Button>
              </Modal.Footer>
            </Modal.Dialog>
          </div>
        );
    },
});

module.exports = ReconnectNotice;
