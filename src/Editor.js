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

var React = require('react');
var ReactDOM = require('react-dom');
var Ace = require('brace');
var FormatSQL = require('sql-formatter');
var Range = Ace.acequire('ace/range').Range;
var TabsStore = require('./TabsStore');
var Actions = require('./Actions');
var History = require('./History');
var fs = require('fs');
var $ = require('jquery');
var scrollUtils = require('./ScrollUtils');

require('brace/mode/pgsql');
require('brace/mode/javascript');
require('brace/theme/chrome');
require('brace/theme/idle_fingers');
require('brace/keybinding/vim');
require('./VimMode'); // fix vim prompt key handling + persist : / search history

// Bare modifier presses. They insert nothing, so they are part of NO_COMPLETION_KEYS below,
// but they must never count as a "chord": ctrl's OWN keydown already carries
// e.ctrlKey === true, so treating it as a shortcut would discard the completion queued for
// the word being typed just because the user reached for Ctrl.
var MODIFIER_KEYS = [16, 17, 18, 91, 92, 93]; // shift, ctrl, alt, left/right command, context menu

// Keys that never insert text, so they must not schedule a completion recompute.
// Recomputing on caret movement popped the autocomplete window whenever a plain arrow-key
// navigation happened to land the caret at the end of a word, forcing an
// up->esc->up->esc dance just to move around the script.
var NO_COMPLETION_KEYS = MODIFIER_KEYS.concat([
    37, 38, 39, 40,                     // left, up, right, down
    33, 34, 35, 36,                     // page up, page down, end, home
    27,                                 // escape (also: leaving vim insert mode)
    20, 19, 45, 144, 145,               // caps lock, pause, insert, num lock, scroll lock
    112, 113, 114, 115, 116, 117,       // F1-F6
    118, 119, 120, 121, 122, 123,       // F7-F12
]);

// The subset above that moves the caret or dismisses the popup. These must additionally
// cancel a recompute queued by the PREVIOUS keystroke, which would otherwise fire against
// the new caret position. Modifiers are deliberately excluded: pressing Shift to type a
// capital must not throw away the completion for the word being typed.
var CANCEL_COMPLETION_KEYS = [37, 38, 39, 40, 33, 34, 35, 36, 27];

// Caret movement that should dismiss an open completion popup rather than walk it
// (up/down walk the list; these jump the caret somewhere else entirely). Enter is here so
// the list cannot be left stranded over a new line.
var COMPLETION_DISMISS_KEYS = [37, 39, 27, 33, 34, 35, 36, 13];

var buildExplainQuery = require('./ExplainUtils').buildExplainQuery;

var Editor = React.createClass({

    getInitialState: function(){
        var script = null;
        this._restoreCursor = null;
        this._restoreScrollRow = null;
        if (TabsStore.tmpScript != null){
            script = TabsStore.tmpScript;
            TabsStore.tmpScript = null;
        } else {
            // restored session content (and cursor/scroll) for this tab, if any
            var tab = TabsStore.tabs[this.props.eventKey];
            if (tab != null && tab.script != null){
                script = tab.script;
                this._restoreCursor = tab.cursor || null;
                if (tab.scrollRow != null){ this._restoreScrollRow = tab.scrollRow; }
            }
        }

        this.completion_words = TabsStore.getCompletionWords(TabsStore.getConnstr(this.props.eventKey));

        return {
            theme: TabsStore.getEditorTheme(),
            mode: TabsStore.getEditorMode(),
            script: script,
        };
    },

    componentDidMount: function(){
        this.editor = Ace.edit(this.props.name);
        this.editor.$blockScrolling = Infinity;
        this.editor.setTheme('ace/theme/' + this.state.theme);
        this.editor.setKeyboardHandler(this.state.mode);

        if (TabsStore.tabs[TabsStore.selectedTab].connector_type == 'firebase'){
            this.editor.getSession().setMode('ace/mode/javascript');
        } else {
            this.editor.getSession().setMode('ace/mode/pgsql');
        }

        TabsStore.bind('change', this.changeHandler);
        TabsStore.bind('editor-resize', this.resize);
        TabsStore.bind('change-theme', this.changeHandler);
        TabsStore.bind('change-mode', this.changeHandler);
        TabsStore.bind('open-file-'+this.props.eventKey, this.fileOpenHandler);
        TabsStore.bind('save-file-'+this.props.eventKey, this.fileSaveHandler);
        TabsStore.bind('close-file-'+this.props.eventKey, this.fileCloseHandler);
        TabsStore.bind('execute-script-'+this.props.eventKey, this.execHandler);
        TabsStore.bind('execute-block-'+this.props.eventKey, this.execBlockHandler);
        TabsStore.bind('execute-explain-'+this.props.eventKey, this.execExplainHandler);
        TabsStore.bind('execute-explain-analyze-'+this.props.eventKey, this.execExplainAnalyzeHandler);
        TabsStore.bind('execute-all-'+this.props.eventKey, this.execAllHandler);
        TabsStore.bind('format-block-'+this.props.eventKey, this.reFormatBlockHandler);
        TabsStore.bind('format-all-'+this.props.eventKey, this.reFormatAllHandler);
        TabsStore.bind('editor-find-next', this.findNext);
        TabsStore.bind('object-info-'+this.props.eventKey, this.objectInfoHandler);
        TabsStore.bind('paste-history-item-'+this.props.eventKey, this.pasteHistoryHandler);
        TabsStore.bind('insert-text-'+this.props.eventKey, this.insertTextHandler);
        TabsStore.bind('focus-editor-'+this.props.eventKey, this.focusEditorHandler);
        TabsStore.bind('show-project-'+this.props.eventKey, this.hideCompleter);
        TabsStore.bind('hide-project-'+this.props.eventKey, this.hideCompleter);
        TabsStore.bind('toggle-project-'+this.props.eventKey, this.hideCompleter);
        TabsStore.bind('switch-view-'+this.props.eventKey, this.switchViewHandler);
        TabsStore.bind('completion-update', this.completionUpdateHandler);
        TabsStore.bind('persist-now', this.persistNow);

        this.editor_input = $("#"+this.props.name).children(".ace_text-input").get()[0];
        this.editor_input.addEventListener("keydown", this.keyHandler, true);

        this.editor.commands.addCommand({
            name: "find",
            bindKey: {
                win: "Ctrl-F",
                mac: "Command-F"
            },
            exec: function() {
                Actions.toggleFindBox();
            },
            readOnly: true
        });

        this.editor.commands.addCommand({
            name: "history",
            bindKey: {
                win: "Ctrl-H",
                mac: "Command-Y"
            },
            exec: function() {
                Actions.toggleHistory();
            },
            readOnly: true
        });

        this.editor.commands.addCommand({
            name: "exec all",
            bindKey: {
                win: "Ctrl-Shift-E",
                mac: "Command-Shift-E"
            },
            exec: function() {
                Actions.execAll();
            },
            readOnly: true
        });

        // Ctrl/Cmd+L should jump to the connection bar. Ace binds Ctrl-L to its
        // "gotoline" command (which calls the unsupported window.prompt), so it would
        // otherwise swallow the key while the editor has focus. Replace it with our
        // goto-connstr action.
        this.editor.commands.removeCommand('gotoline');
        this.editor.commands.addCommand({
            name: "goto connstr",
            bindKey: {
                win: "Ctrl-L",
                mac: "Command-L"
            },
            exec: function() {
                Actions.gotoConnstr();
            },
            readOnly: true
        });

        this.editor.getSelectedText = function() {
            return this.session.getTextRange(this.getSelectionRange());
        }

        if (this.state.script != null){ // load script
            this.editor.session.setValue(this.state.script, -1);
            // restore the saved cursor + scroll position for this tab, before the
            // listeners below are attached so the restore doesn't trigger a save
            if (this._restoreCursor != null){
                this.editor.moveCursorToPosition(this._restoreCursor);
                this.editor.clearSelection();
            }
            if (this._restoreScrollRow != null){
                this.editor.renderer.scrollToRow(this._restoreScrollRow);
            }
        }

        // autosave editor content + cursor/scroll to the session (debounced) so the
        // work and the editing position survive a crash/freeze/quit. Attached after
        // the initial setValue/restore above so it doesn't trigger a redundant save.
        this.editor.session.on('change', this.contentChangeHandler);
        this.editor.selection.on('changeCursor', this.contentChangeHandler);

        // A click or a focus change moves the caret without any keydown, so the popup would
        // stay open with completion_mode still true -- and while it is open ace's golineup/
        // golinedown commands are removed, so Up/Down then do nothing at all and the next
        // Tab rewrites whatever word the caret has landed on. Dismiss it on both.
        // Listen on the container in the capture phase rather than via editor.on('mousedown'),
        // whose ace listeners cover only the scroller and scrollbars -- a click on the gutter
        // (line numbers) moves the caret but would leave the popup up. The completion list is
        // a sibling of the container, not a child, so its own clicks are unaffected.
        this.editor.container.addEventListener('mousedown', this.hideCompleter, true);
        this.editor.on('blur', this.hideCompleter);

        this.editor.commands.removeCommand('showSettingsMenu'); // disable Cmd+,

        this.editor.focus();
    },

    componentWillUnmount: function(){
        TabsStore.unbind('change', this.changeHandler);
        TabsStore.unbind('editor-resize', this.resize);
        TabsStore.unbind('change-theme', this.changeTheme);
        TabsStore.unbind('change-mode', this.changeMode);
        TabsStore.unbind('open-file-'+this.props.eventKey, this.fileOpenHandler);
        TabsStore.unbind('save-file-'+this.props.eventKey, this.fileSaveHandler);
        TabsStore.unbind('save-file-'+this.props.eventKey, this.fileCloseHandler);
        TabsStore.unbind('execute-script-'+this.props.eventKey, this.execHandler);
        TabsStore.unbind('execute-block-'+this.props.eventKey, this.execBlockHandler);
        TabsStore.unbind('execute-explain-'+this.props.eventKey, this.execExplainHandler);
        TabsStore.unbind('execute-explain-analyze-'+this.props.eventKey, this.execExplainAnalyzeHandler);
        TabsStore.unbind('execute-all-'+this.props.eventKey, this.execAllHandler);
        TabsStore.unbind('format-block-'+this.props.eventKey, this.reFormatBlockHandler);
        TabsStore.unbind('format-all-'+this.props.eventKey, this.reFormatAllHandler);
        TabsStore.unbind('editor-find-next', this.findNext);
        TabsStore.unbind('object-info-'+this.props.eventKey, this.objectInfoHandler);
        TabsStore.unbind('paste-history-item-'+this.props.eventKey, this.pasteHistoryHandler);
        TabsStore.unbind('insert-text-'+this.props.eventKey, this.insertTextHandler);
        TabsStore.unbind('focus-editor-'+this.props.eventKey, this.focusEditorHandler);
        TabsStore.unbind('show-project-'+this.props.eventKey, this.hideCompleter);
        TabsStore.unbind('hide-project-'+this.props.eventKey, this.hideCompleter);
        TabsStore.unbind('toggle-project-'+this.props.eventKey, this.hideCompleter);
        TabsStore.unbind('switch-view-'+this.props.eventKey, this.switchViewHandler);
        TabsStore.unbind('completion-update', this.completionUpdateHandler);
        TabsStore.unbind('persist-now', this.persistNow);

        if (this._contentTimer){ clearTimeout(this._contentTimer); this._contentTimer = null; }
        if (this._completionTimer){ clearTimeout(this._completionTimer); this._completionTimer = null; }
        if (this._noteTimer){ clearTimeout(this._noteTimer); this._noteTimer = null; }
        if (this.editor){
            this.editor.session.off('change', this.contentChangeHandler);
            this.editor.selection.off('changeCursor', this.contentChangeHandler);
            this.editor.container.removeEventListener('mousedown', this.hideCompleter, true);
            this.editor.off('blur', this.hideCompleter);
        }

        // must match the capture flag used in componentDidMount, or the listener stays put
        this.editor_input.removeEventListener("keydown", this.keyHandler, true);
    },

    // Debounced: push the current editor content into the tab and schedule a
    // session save. Cheap on each keystroke (just resets a timer).
    contentChangeHandler: function(){
        var self = this;
        if (this._contentTimer){ clearTimeout(this._contentTimer); }
        this._contentTimer = setTimeout(function(){
            self._contentTimer = null;
            if (self.editor){
                var pos = self.editor.getCursorPosition();
                TabsStore.setScript(self.props.eventKey, self.editor.getValue(),
                    {row: pos.row, column: pos.column},
                    self.editor.renderer.getScrollTopRow());
            }
        }, 400);
    },

    // Synchronous capture used on window close (before the final session flush)
    // so the last few keystrokes within the debounce window are not lost.
    persistNow: function(){
        var tab = TabsStore.tabs[this.props.eventKey];
        if (tab != null && this.editor){
            tab.script = this.editor.getValue();
            var pos = this.editor.getCursorPosition();
            tab.cursor = { row: pos.row, column: pos.column };
            tab.scrollRow = this.editor.renderer.getScrollTopRow();
        }
    },

    switchViewHandler: function(){
        this.editor.resize();
    },

    execHandler: function() {
        var selected = this.editor.getSelectedText();
        var script;
        if (selected) {
            script = selected;
        } else {
            script = this.editor.getValue();
        }
        Actions.runQuery(this.props.eventKey, script);
    },

    execBlockHandler: function(){
        var selected = this.editor.getSelectedText();
        var script;
        if (selected) {
            script = selected;
        } else {
            var current_line = this.editor.selection.getCursor().row;
            script = this.detectBlock(current_line, this.editor.getValue);
        }
        Actions.runQuery(this.props.eventKey, script);

    },

    execExplainHandler: function(){
        this.execBlockExplain(false);
    },

    execExplainAnalyzeHandler: function(){
        this.execBlockExplain(true);
    },

    execBlockExplain: function(analyze){
        // same target rule as Execute Block: selection wins, else the "---"
        // block around the cursor
        var selected = this.editor.getSelectedText();
        var script;
        if (selected) {
            script = selected;
        } else {
            var current_line = this.editor.selection.getCursor().row;
            script = this.detectBlock(current_line, this.editor.getValue);
        }
        var query = buildExplainQuery(script, analyze);
        if (query == null){ return; }
        // the buffer is NOT modified: no undo noise, the cursor stays, and
        // Ctrl+E on the same block still runs plain SQL. History records the
        // EXPLAIN form (Dispatcher 'run-query' pushes what was executed).
        Actions.runQuery(this.props.eventKey, query);
    },

    execAllHandler: function(){
        var meta = /^\s*---\s*.*/;
        var markdown_start = /^\s*\/\*\*/;
        var markdown_end = /\*\*\/\s*$/;
        var current_line = 0;
        var blocks = [];
        var block = [];
        var inside_markdown = false;
        while (current_line < this.editor.session.getLength()){
            var current_line_text = this.editor.session.getLine(current_line).trim();

            if (current_line_text.match(markdown_start) != null){
                inside_markdown = true;
            }
            if (current_line_text.match(markdown_end) != null){
                inside_markdown = false;
            }
            if (current_line > 0 && current_line_text.match(meta) != null && !inside_markdown){ // new block started
                blocks.push(block.join('\n'));
                block = [];
            }
            block.push(current_line_text);
            current_line++;
        }

        if (block.length > 0){ // append last block if any remained
            blocks.push(block.join('\n'));
        }

        Actions.runAllBlocks(this.props.eventKey, blocks);
    },

    reFormatBlockHandler: function(){
        var current_line = this.editor.selection.getCursor().row;
        this.autoFormatBlock(current_line, this.editor.getValue);
    },

    reFormatAllHandler: function(){
        var meta = /^\s*---\s*.*/;
        var current_line = 0;
        var block_start = 0;
        var block_length = 0;
        while (current_line < this.editor.session.getLength()){
            var current_line_text = this.editor.session.getLine(current_line).trim();
            if (current_line > 0 && meta.test(current_line_text)){ // new block started
                // Reformat detected block
                var block_end = block_start + block_length -1;
                var new_block_length = this.reformatLines(block_start, block_end);
                // Move current line based on how many lines the reformatting added
                current_line += new_block_length - block_length;
                block_start = current_line;
                block_length = 0;
            }
            block_length++;
            current_line++;
        }

        if (block_length > 0){ // append last block if any remained
            this.reformatLines(block_start, block_start + block_length);
        }
    },

    detectBlockLines: function(current_line){
        var meta = /^\s*---\s*.*/;
        var markdown_start = /^\s*\/\*\*/;
        var markdown_end = /\*\*\/\s*$/;
        var inside_markdown = false;
        var start = 0;
        var start_found = false;
        while (!start_found){
            var current_line_text = this.editor.session.getLine(current_line).trim();
            if (current_line_text.match(markdown_end) != null){
                inside_markdown = true;
            }
            if (current_line_text.match(markdown_start) != null){
                inside_markdown = false;
            }

            if (current_line === 0) {
                start = current_line;
                start_found = true;
            } else if (current_line_text.match(meta) != null && !inside_markdown){
                start = current_line;
                start_found = true;
            }
            current_line--;
        }

        var end = null;
        var end_found = false;
        current_line = start;
        while (!end_found){
            current_line_text = this.editor.session.getLine(current_line).trim();
            if (current_line_text.match(markdown_start) != null){
                inside_markdown = true;
            }
            if (current_line_text.match(markdown_end) != null){
                inside_markdown = false;
            }

            if (current_line_text.match(meta) != null && current_line > start && !inside_markdown){
                end = current_line - 1;
                end_found = true;
            } else if (current_line >= this.editor.session.getLength()){
                end = current_line - 1;
                end_found = true;
            }
            current_line++;
        }

        return [start, end];
    },

    detectBlock: function(current_line, script) {
        var lines = this.detectBlockLines(current_line, script);
        return this.editor.session.getLines(lines[0], lines[1]).join('\n');
    },

    reformatLines: function (start, end) {
        var lastLine = this.editor.session.getLine(end);
        var originalCode = this.editor.session.getLines(start, end).join('\n');
        console.log(originalCode);
        var reFormattedCode = FormatSQL.format(originalCode);
        this.editor.session.replace(new Range(start, 0, end, lastLine.length), reFormattedCode);
        return reFormattedCode.split('\n').length;
    },

    autoFormatBlock: function (current_line, script) {
        var lines = this.detectBlockLines(current_line, script);
        this.reformatLines(lines[0], lines[1]);
    },

    componentDidUpdate: function(){
        this.editor.setTheme('ace/theme/' + this.state.theme);
        this.editor.setKeyboardHandler(this.state.mode);
        this.editor.resize();
        this.editor.focus();
    },

    changeHandler: function(){
        this.setState({
            theme: TabsStore.getEditorTheme(),
            mode: TabsStore.getEditorMode(),
        });
    },

    fileOpenHandler: function(){
        var self = this;
        var filename = TabsStore.getEditorFile(this.props.eventKey);
        var data = fs.readFileSync(filename, 'utf8');
        self.editor.session.setValue(data, -1);
    },

    fileSaveHandler: function(){
        var self = this;
        var position = self.editor.getCursorPosition();
        var scrollRow = self.editor.renderer.getScrollTopRow();
        var filename = TabsStore.getEditorFile(this.props.eventKey);
        var content = self.editor.getValue().replace(/[^\S\r\n]+$/gm, ""); // trim trailing spaces

        try {
            // atomic write: write a temp file in the same directory, then rename
            // over the target so an interrupted/failed write can't truncate the
            // original file (a silent way to lose work).
            var tmp = filename + '.sqltabs.tmp';
            fs.writeFileSync(tmp, content);
            fs.renameSync(tmp, filename);
        } catch (err) {
            require('@electron/remote').dialog.showErrorBox(
                'Save failed',
                'Could not save ' + filename + '\n\n' + (err && err.message ? err.message : String(err))
            );
            return;
        }

        self.editor.session.setValue(content);
        self.editor.clearSelection();
        self.editor.gotoLine(position.row+1, 0);
        self.editor.renderer.scrollToRow(scrollRow);
    },

    fileCloseHandler: function(){
        this.editor.setValue('');
    },

    findNext: function(){

        var init_position = this.editor.getCursorPosition();
        var value = TabsStore.getSearchValue();
        var ret = this.editor.find(value ,{
          backwards: false,
          wrap: false,
          caseSensitive: false,
          wholeWord: false,
          regExp: false,
          start: 0,
        });

        if (typeof(ret) == 'undefined'){ // start from the beginning in case of end of file
            this.editor.gotoLine(0, 0, true);
            ret = this.editor.find(value ,{
              backwards: false,
              wrap: false,
              caseSensitive: false,
              wholeWord: false,
              regExp: false,
              start: 0,
            });

            if (typeof(ret) == 'undefined'){ // if nothing found
                this.editor.gotoLine(init_position.row+1, init_position.column, false);
            }
        }
    },

    objectInfoHandler: function(){
        // detect object under cursor
        var pos = this.editor.getCursorPosition();
        var line_text = this.editor.session.getLine(pos.row);
        // Grab the qualified identifier straddling the cursor. Use an explicit class
        // [A-Za-z0-9_.] -- the old "[A-z...]" range also matched the stray punctuation
        // (`[ \ ] ^ _ \``) that sits between 'Z' and 'a' in ASCII.
        var part1 = line_text.substring(0, pos.column);
        part1 = part1.match(/[A-Za-z0-9_.]*$/);
        if (part1 != null){
            part1 = part1[0]
        } else {
            part1 = ""
        }

        var part2 = line_text.substring(pos.column);
        part2 = part2.match(/^[A-Za-z0-9_.]+/);
        if (part2 != null){
            part2 = part2[0]
        } else {
            part2 = ""
        }

        var object = part1 + part2;
        Actions.getObjectInfo(object);
    },

    pasteHistoryHandler: function(){
        var item = History.get(TabsStore.getHistoryItem());
        if (item != null){
            var position = this.editor.getCursorPosition();
            this.editor.getSession().insert(position, item.query);
        }
        this.editor.focus();
    },

    insertTextHandler: function(){
        var text = TabsStore.insertBuffer;
        if (text != null){
            var position = this.editor.getCursorPosition();
            this.editor.getSession().insert(position, text);
        }
        this.editor.focus();
    },

    focusEditorHandler: function(){
        this.editor.focus();
    },

    resize: function(){
        this.editor.resize();
    },

    keyHandler: function(e){
        var self = this;

        // Ctrl+Space explicitly opens the completion list. Handled before the chord test
        // below, which would otherwise class it as a shortcut and suppress it.
        if (e.keyCode == 32 && e.ctrlKey && !e.altKey){
            e.preventDefault();
            e.stopPropagation(); // keep ace from inserting a space and vim from seeing it
            return this.forceCompletion();
        }

        // Ctrl/Cmd chords are app shortcuts (Ctrl+F find, Ctrl+L connection, Ctrl+E execute
        // block, Ctrl+Z undo, vim's <C-[> / <C-c>), not text input. AltGr arrives as
        // ctrl+alt on Windows/Linux layouts and DOES produce text, so it is excluded here.
        var chord = MODIFIER_KEYS.indexOf(e.keyCode) < 0 &&
                    ((e.ctrlKey && !e.altKey) || e.metaKey);

        // Alt+letter app shortcuts (Alt+X explain-analyze) are chords too, but only
        // for the recompute-cancel below: AltGr combos (ctrl+alt) produce text and
        // must keep their queued completion, so altChord deliberately excludes ctrlKey.
        var altChord = !e.ctrlKey && !e.metaKey && e.altKey &&
                       MODIFIER_KEYS.indexOf(e.keyCode) < 0;

        // Plain Tab accepts a hint and Shift+Tab walks back, but Ctrl/Cmd+Tab switches app
        // tabs and Alt+Tab is the window switcher -- those must not be swallowed.
        if (e.keyCode == 9 && !chord && !e.altKey){
            if (this.completion_mode){
                e.preventDefault();
                e.stopPropagation();
                if (e.shiftKey){
                    return this.completePrev();
                } else {
                    return this.completeNext();
                }
            }
        }

        // Arrow/esc handling only applies while the completion popup is open; otherwise
        // let the key reach the editor normally (calling complete* with no active
        // completion threw "Cannot read properties of undefined", especially in vim
        // normal mode where the arrows are used constantly).
        if (this.completion_mode){
            // Only a PLAIN Up/Down walks the list. Held with a modifier they mean something
            // else entirely -- Shift+Up extends the selection, Alt/Cmd+Up jump -- and walking
            // the list would silently rewrite the word under the caret instead.
            var plainArrow = !chord && !e.shiftKey && !e.altKey;
            if (plainArrow && e.keyCode == 40){ // down
                return this.completeNext();
            }
            if (plainArrow && e.keyCode == 38){ // up
                return this.completePrev();
            }

            // Everything else closes the list rather than stranding it: caret jumps, Enter,
            // a MODIFIED arrow (which fell past the walk above), and any shortcut --
            // Ctrl+Z/Ctrl+V rewrite the text under the caret and vim's <C-[>/<C-c> leave
            // insert mode. While the list is open ace's golineup/golinedown commands are
            // removed, so leaving it up turns Up/Down into dead keys.
            if (chord || e.keyCode == 38 || e.keyCode == 40 ||
                COMPLETION_DISMISS_KEYS.indexOf(e.keyCode) != -1){
                return this.hideCompleter();
            }
        }

        if (!chord && NO_COMPLETION_KEYS.indexOf(e.keyCode) < 0){
            var vim_mode = this.getVimMode();
            if (vim_mode == null || vim_mode == 'insert'){ // don't show autocompletion in normal mode of vim
                // debounce: recompute completion only after typing briefly pauses,
                // instead of an O(words) scan + full dropdown rebuild on each keystroke.
                if (this._completionTimer){ clearTimeout(this._completionTimer); }
                this._completionTimer = setTimeout(function(){
                    self._completionTimer = null;
                    self.adjustCompletion();
                }, 120);
            }
        } else if (chord || altChord || CANCEL_COMPLETION_KEYS.indexOf(e.keyCode) != -1){
            // Moving the caret (or invoking a shortcut) cancels a recompute queued by the
            // previous keystroke -- otherwise typing and immediately navigating away pops
            // the list at the new position, since the debounced callback only ever looks at
            // where the caret is when it finally fires.
            this.cancelCompletionTimer();
        }
    },

    completionUpdateHandler: function(){
        this.completion_words = TabsStore.getCompletionWords(TabsStore.getConnstr(this.props.eventKey));
    },

    // Ctrl+Space: ask for the list at the caret, right now. Since completion no longer
    // recomputes on caret movement, arrowing to the end of an existing name deliberately
    // shows nothing -- this is how you get it back, and it also works with no word under
    // the caret (an empty prefix simply lists the first hints).
    forceCompletion: function(){
        this.cancelCompletionTimer();
        // A large TAP archive takes ~25s to report its schema on a first-ever connection, and
        // until it lands there is nothing to match. Say so instead of appearing to ignore the
        // key. (Later sessions read the previous list from disk, so this is rarely seen.)
        if (!this.completion_words || !this.completion_words.length){
            this.showCompletionNote('loading schema …');
            return;
        }
        this.adjustCompletion(true);
    },

    // Show a transient note where the hint list normally goes. completion_mode stays false so
    // this does not hijack Tab/Up/Down the way a real hint list does.
    showCompletionNote: function(text){
        var self = this;
        var completer = $(ReactDOM.findDOMNode(this.refs.completer));
        var cursor = $("#"+this.props.name).find(".ace_cursor");
        this.hints = [];
        this.completion_mode = false;
        completer.html('<ul><li class="completion-hint-message">' + text + '</li></ul>');
        completer.offset({ top: cursor.offset().top + cursor.height(), left: cursor.offset().left });
        completer.show();
        if (this._noteTimer){ clearTimeout(this._noteTimer); }
        this._noteTimer = setTimeout(function(){
            self._noteTimer = null;
            completer.hide();
        }, 2500);
    },

    adjustCompletion: function(force){
        if (!TabsStore.auto_completion && !force){ // an explicit request overrides the setting
            return;
        }
        var completer = $(ReactDOM.findDOMNode(this.refs.completer));
        var cursor = $("#"+this.props.name).find(".ace_cursor");
        var offset = {
            top: cursor.offset().top + cursor.height(),
            left: cursor.offset().left,
        };
        var position = this.editor.selection.getCursor();
        var line = this.editor.session.getLine(position.row);
        line = (line.slice(0, position.column)).toLowerCase();
        // include dots so a schema-qualified name keeps matching as you type past the
        // dot, e.g. "gaiadr3." -> lists that schema's tables (gaiadr3.gaia_source, ...).
        var word = line.match(/[\w.]+$/);
        if (word != null || force){
            word = word != null ? word[0] : '';
            this.getHints(word);
            if (this.hints.length > 0){
                completer.show();
                completer.offset(offset);
                completer.html(this.renderHints());
                this.completion_mode = true;
                this.editor.commands.removeCommand('indent'); // disable tab
                this.editor.commands.removeCommand('golineup'); // disable up
                this.editor.commands.removeCommand('golinedown'); // disable down
                return;
            } else {
                this.hideCompleter();
            }
        } else {
            this.hideCompleter();
        }
    },

    // Drop a queued completion recompute. Dismissing/walking the list must always call this:
    // the debounced callback ignores completion_mode, so a recompute queued by the keystroke
    // before the dismiss would re-open the popup ~120ms later with no further input.
    cancelCompletionTimer: function(){
        if (this._completionTimer){
            clearTimeout(this._completionTimer);
            this._completionTimer = null;
        }
    },

    hideCompleter: function(){
        this.cancelCompletionTimer();
        if (this._noteTimer){ clearTimeout(this._noteTimer); this._noteTimer = null; }
        this.completion_mode = false;
        this.hints = [];
        var completer = $(ReactDOM.findDOMNode(this.refs.completer));
        completer.hide();
        this.editor.commands.addCommand({ // enable tab back
            name: "indent",
            bindKey: {win: "Tab", mac: "Tab"},
            exec: function(editor) { editor.indent(); },
            multiSelectAction: "forEach",
            scrollIntoView: "selectionPart"
        });

        this.editor.commands.addCommand({ // enable up back
            name: "golineup",
            bindKey: {win: "Up", mac: "Up|Ctrl-P"},
            exec: function(editor, args) { editor.navigateUp(args.times); },
            multiSelectAction: "forEach",
            scrollIntoView: "cursor",
            readOnly: true
        });

        this.editor.commands.addCommand({ // enable down back
            name: "golinedown",
            bindKey: {win: "Down", mac: "Down|Ctrl-N"},
            exec: function(editor, args) { editor.navigateDown(args.times); },
            multiSelectAction: "forEach",
            scrollIntoView: "cursor",
            readOnly: true
        });

    },

    getHints: function(word){
        var hints = [];
        var MAX_HINTS = 50; // bound the scan and the rendered dropdown size
        for (var i=0; i< this.completion_words.length && hints.length < MAX_HINTS; i++){
            if (this.completion_words[i].toLowerCase().startsWith(word)){
                hints.push(this.completion_words[i])
            }
        }
        this.hints = hints;
        this.current_hint = -1;
        return hints;
    },

    complete: function(){
        if (!this.hints || !this.hints.length){ return; } // no active completion
        var hint = this.hints[this.current_hint];
        if (hint == null){ return; } // no current hint (empty list / current_hint == -1): nothing to insert
        var position = this.editor.getCursorPosition();
        var line = this.editor.session.getLine(position.row);
        line = line.slice(0, position.column);
        // Match the full qualified token INCLUDING dots. Cycling completions replaces the
        // word under the cursor with the highlighted hint; if the previously-inserted hint
        // was qualified (e.g. "user_dr4rc3.gaia_source"), a plain /\w+$/ would only cover
        // the segment after the last dot and leave the schema prefix behind, so each
        // up/down would accumulate another "schema." in front. /[\w.]+$/ replaces the whole
        // qualified name each cycle.
        line = line.match(/[\w.]+$/);
        if (line != null){
            var word = line[0];
            var range = new Range(position.row, position.column - word.length, position.row, position.column);
            this.editor.getSession().replace(range, hint);
        }

        var completer = $(ReactDOM.findDOMNode(this.refs.completer));
        completer.html(this.renderHints());

    },

    completeNext: function(){
        if (!this.hints || !this.hints.length){ return; }
        // a recompute queued by the keystroke before this one would rebuild the list and
        // reset current_hint to -1, losing our place mid-walk.
        this.cancelCompletionTimer();
        if (this.current_hint < this.hints.length-1){
            this.current_hint = this.current_hint + 1;
        } else if (this.current_hint == this.hints.length-1){
            this.current_hint = 0;
        }

        this.complete();
        scrollUtils.scrollToDown("#completion-list-"+this.props.eventKey, "#completion-hint-active-"+this.props.eventKey);

    },

    completePrev: function(){
        if (!this.hints || !this.hints.length){ return; }
        this.cancelCompletionTimer();
        if (this.current_hint > 0){
            this.current_hint = this.current_hint-1;
        } else {
            // 0 wraps to the end; so does -1, the state getHints() leaves a freshly built
            // list in. Without that, Up on a just-opened popup moved nothing at all -- and
            // ace's golineup command is removed while the popup is open, so the caret was
            // stuck too.
            this.current_hint = this.hints.length-1;
        }
        this.complete();
        scrollUtils.scrollToUp("#completion-list-"+this.props.eventKey, "#completion-hint-active-"+this.props.eventKey);
    },

    renderHints: function(){
        var list = "";
        for (var i=0; i<this.hints.length; i++){
            if (i == this.current_hint){
                list += '<li class="completion-hint-active" id="completion-hint-active-'+this.props.eventKey+'">'+this.hints[i]+'</li>';
            } else {
                list += '<li class="completion-hint">'+this.hints[i]+'</li>';
            }
        }
        return "<ul>"+list+"</ul>";
    },

    getVimMode: function(){
        var normal_mode = $("#editor-"+this.props.eventKey)[0].className.split(" ").indexOf("normal-mode");
        var insert_mode = $("#editor-"+this.props.eventKey)[0].className.split(" ").indexOf("insert-mode");
        if (normal_mode != -1){
            return 'normal';
        }
        if (insert_mode != -1){
            return 'insert';
        }
        return null;
    },

    render: function(){

        return (
            <div className="edit-area">
                <div ref="container" id={this.props.name} mode={this.state.mode}/>
                <div ref="completer" className="completion-list" id={"completion-list-"+this.props.eventKey}/>
            </div>
        );
    },
});

module.exports = Editor;
