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

// ADQL (IVOA Astronomical Data Query Language) keywords and functions. Catalog table
// and column names are added at runtime from the service's TAP_SCHEMA.
module.exports = [
    // query language
    "SELECT", "TOP", "DISTINCT", "ALL", "AS", "FROM", "WHERE", "AND", "OR", "NOT",
    "NULL", "IS", "IN", "BETWEEN", "LIKE", "EXISTS", "JOIN", "INNER", "OUTER", "LEFT",
    "RIGHT", "FULL", "CROSS", "ON", "USING", "GROUP", "BY", "HAVING", "ORDER", "ASC",
    "DESC", "UNION", "INTERSECT", "EXCEPT", "CASE", "WHEN", "THEN", "ELSE", "END",
    "CAST", "OFFSET",
    // aggregates
    "COUNT", "SUM", "AVG", "MIN", "MAX",
    // numeric / trig functions
    "ABS", "CEILING", "FLOOR", "ROUND", "TRUNCATE", "MOD", "POWER", "SQRT", "EXP",
    "LOG", "LOG10", "PI", "RAND", "SIN", "COS", "TAN", "ASIN", "ACOS", "ATAN",
    "ATAN2", "DEGREES", "RADIANS",
    // string functions
    "LOWER", "UPPER",
    // ADQL geometry / spatial functions
    "POINT", "CIRCLE", "BOX", "POLYGON", "REGION", "CENTROID", "COORD1", "COORD2",
    "COORDSYS", "CONTAINS", "INTERSECTS", "AREA", "DISTANCE",
    // common coordinate systems used as the first POINT/geometry argument
    "ICRS", "GALACTIC", "FK5", "FK4",
];
