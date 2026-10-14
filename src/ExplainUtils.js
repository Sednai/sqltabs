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

// Prefix a block with EXPLAIN [ANALYZE] without disturbing a leading `--- <marker>`
// line: SqlDoc.getRenderer matches the marker anchored at the START of the query
// string, so `--- csv out.csv` / `--- chart` directives keep working only if the
// marker stays on line 1 -- the keyword goes on the first real SQL line instead.
// An existing EXPLAIN prefix is stripped first, so toggling plain->EXPLAIN->
// EXPLAIN ANALYZE on the same block never stacks keywords.
// Returns null when there is nothing to explain (empty or markers-only block).

var buildExplainQuery = function(script, analyze){
    if (!script) return null;
    var kw = analyze ? 'EXPLAIN ANALYZE' : 'EXPLAIN';
    var eol = script.indexOf('\r\n') >= 0 ? '\r\n' : '\n'; // keep the block's line endings
    var lines = script.split(/\r?\n/);
    var i = 0;
    while (i < lines.length && /^\s*(---.*)?$/.test(lines[i])) i++; // skip markers + blanks
    if (i >= lines.length) return null;                             // nothing but markers
    lines[i] = lines[i].replace(/^\s*EXPLAIN(\s+ANALYZE)?\s*/i, '');
    var ind = /^\s*/.exec(lines[i])[0];
    lines[i] = ind + kw + ' ' + lines[i].slice(ind.length);
    return lines.join(eol);
};

module.exports = { buildExplainQuery: buildExplainQuery };
