
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

var $ = require("jquery");

function scrollTo(div, to){
    return $(div).animate({scrollTop: $(to).position().top - $(div).parent().offset().top}, 300);
}

function scrollToDown(div, to){

    var d = $(div), t = $(to);
    var dOff = d.offset(), tOff = t.offset();
    if (!dOff || !tOff){ return; } // container or active hint not in the DOM yet

    var scroll = d.scrollTop();
    var position = tOff.top - dOff.top;
    if (position < 0){ // id scrolled away up
        return d.scrollTop(position);
    }
    if (position > d.height()){ // if scrolled away down
        return d.scrollTop(position);
    }
    if (position > d.height() - 2*t.height()){
        return d.scrollTop(scroll + t.height());
    }
}

function scrollToUp(div, to){

    var d = $(div), t = $(to);
    var dOff = d.offset(), tOff = t.offset();
    if (!dOff || !tOff){ return; } // container or active hint not in the DOM yet

    var scroll = d.scrollTop();
    var position = tOff.top - dOff.top;

    if (position + t.height() < 0){ // if scrolled away up
        return d.scrollTop(position);
    }
    if (position > d.height()){ // if scrolled away down
        return d.scrollTop(position);
    }
    if (position - t.height() < 0){
        return d.scrollTop(scroll - t.height());
    }
}

module.exports = {scrollTo, scrollToDown, scrollToUp}

