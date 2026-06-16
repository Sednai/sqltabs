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

// Runtime fixes for the bundled brace (Ace) vim keybinding, plus persistence of the
// command/search history across restarts. Required once for its side effects.
//
// 1) keyName fix: brace's vim `CodeMirror.keyName` returns the raw `KeyboardEvent.key`
//    when present. Modern Chromium/Electron reports arrows as "ArrowUp"/"ArrowDown" and
//    escape as "Escape", but the `:`/`/` prompt handlers compare against the legacy names
//    "Up"/"Down"/"Esc" -- so pressing Up/Down in the `:` prompt never walked the history
//    (it silently did nothing). We re-derive a legacy-style name (with Ctrl-/Alt-/Cmd-
//    prefixes) from the event so history navigation, Ctrl-U, etc. work again.
//
// 2) history persistence: brace already records ex-command and search history, but only in
//    the in-memory vimGlobalState, which is lost on reload. We seed both history buffers
//    from the config on startup and persist them (debounced) whenever a command is pushed.

var Ace = require('brace');
require('brace/keybinding/vim'); // registers ace/keyboard/vim in the ace module registry
var Config = require('./Config');

var HISTORY_MAX = 200; // cap each persisted history list

var vimMod = Ace.acequire('ace/keyboard/vim');

if (vimMod && vimMod.CodeMirror && vimMod.Vim){
    patchKeyName(vimMod.CodeMirror);
    setupHistoryPersistence(vimMod.Vim);
    freeAppShortcutKeys(vimMod.handler);
}

// The app uses Ctrl+E (Execute Block) and Ctrl+R (Run) as editor shortcuts, but vim's
// default keymap binds <C-e> (scroll down) and <C-r> (redo) and would swallow them in
// vim mode. Drop those two vim bindings so the menu accelerators fire. (vim redo is still
// available via `:redo` or Edit -> Redo / Ctrl+Shift+Z.) The handler's defaultKeymap is
// the very array the key matcher uses, so we mutate it in place.
function freeAppShortcutKeys(handler){
    if (!handler || !Array.isArray(handler.defaultKeymap)){ return; }
    var taken = { '<C-e>': 1, '<C-r>': 1 };
    var km = handler.defaultKeymap;
    for (var i = km.length - 1; i >= 0; i--){
        if (km[i] && taken[km[i].keys]){ km.splice(i, 1); }
    }
}

// Map the few modern KeyboardEvent.key values the vim prompt handlers care about back to
// the legacy names brace's vim compares against.
var KEY_NAMES = {
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Escape: 'Esc', Delete: 'Del', Enter: 'Return', Control: 'Ctrl', Meta: 'Cmd'
};

function patchKeyName(CodeMirror){
    CodeMirror.keyName = function(e){
        var key = e.key;
        if (!key){ return ''; }
        if (Object.prototype.hasOwnProperty.call(KEY_NAMES, key)){ key = KEY_NAMES[key]; }
        if (key.length === 1){ key = key.toUpperCase(); } // letters/symbols -> "U", "[" ...
        var prefix = '';
        if (e.ctrlKey && key !== 'Ctrl'){ prefix += 'Ctrl-'; }
        if (e.altKey  && key !== 'Alt'){  prefix += 'Alt-'; }
        if (e.metaKey && key !== 'Cmd'){  prefix += 'Cmd-'; }
        return prefix + key;
    };
}

var saveTimer = null;

function setupHistoryPersistence(Vim){
    if (typeof Vim.getVimGlobalState_ !== 'function'){ return; }
    var gs = Vim.getVimGlobalState_(); // created when the vim module was required
    if (!gs){ return; }
    var saved = Config.getVimHistory() || {};
    seed(gs.exCommandHistoryController, saved.ex);
    seed(gs.searchHistoryController, saved.search);
    // The controllers live for the app's lifetime (resetVimGlobalState runs only once at
    // module init), so wrapping the instance's pushInput is safe.
    wrap(gs.exCommandHistoryController);
    wrap(gs.searchHistoryController);
}

function seed(ctrl, arr){
    if (!ctrl || !Array.isArray(arr)){ return; }
    ctrl.historyBuffer = arr.slice(-HISTORY_MAX);
    ctrl.reset(); // iterator -> end of buffer, ready for the first Up
}

function wrap(ctrl){
    if (!ctrl || ctrl.__sqltabsWrapped){ return; }
    ctrl.__sqltabsWrapped = true;
    var orig = ctrl.pushInput;
    ctrl.pushInput = function(input){
        orig.call(this, input);
        scheduleSave();
    };
}

function scheduleSave(){
    if (saveTimer){ clearTimeout(saveTimer); }
    saveTimer = setTimeout(persist, 500);
}

function persist(){
    saveTimer = null;
    if (typeof vimMod.Vim.getVimGlobalState_ !== 'function'){ return; }
    var gs = vimMod.Vim.getVimGlobalState_();
    if (!gs){ return; }
    var ex = gs.exCommandHistoryController ? gs.exCommandHistoryController.historyBuffer.slice(-HISTORY_MAX) : [];
    var search = gs.searchHistoryController ? gs.searchHistoryController.historyBuffer.slice(-HISTORY_MAX) : [];
    Config.saveVimHistory({ ex: ex, search: search });
}
