#!/usr/bin/env node
"use strict";
/*
 * board-lib — shared BACKLOG.md row primitives (harness-shipped).
 *
 * One home for the markdown-table row logic the board toolchain shares, so a
 * parse/format bug is fixed in exactly one place instead of being copy-pasted
 * across backlog.js + the QA gates (check-backlog / check-concurrency /
 * merge-backlog). F-094 was the cautionary tale: the write-path sanitizer was
 * added only to a deployed copy and silently reverted by the next harness
 * update because it never reached a shared source.
 *
 * Exports:
 *   splitCells(row)          split a markdown table row on unescaped `|`
 *   isSep(cells)             true when a row is a `|---|` separator
 *   sanitizeCell(value)      make a single cell table-safe (single line, no `|`)
 *   formatRow(cells)         join cells into one physical `| a | b |` row
 */
function splitCells(row) {
  const cells = [];
  let cur = "";
  let esc = false;
  for (const ch of row) {
    if (esc) {
      cur += ch;
      esc = false;
    } else if (ch === "\\") {
      esc = true;
      cur += ch;
    } else if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

function isSep(cells) {
  return cells.every((c) => /^[-:|\s]*$/.test(c));
}

/* A markdown table cell is one token on one physical line. A raw newline (or any
 * other control char) or an unescaped `|` would split one logical row into
 * corrupt fragments — the F-094 newline corruption and the F-127 pipe corruption
 * both came from cells written verbatim. Sanitize before ANY cell is written, so
 * no caller (CLI add, backlog_* tools, reports/admin routes that shell the CLI)
 * can corrupt the board through the shared write path. */
function sanitizeCell(value) {
  return String(value)
    .replace(/[\x00-\x1f\x7f]/g, " ") // control chars (incl \n, \r, \t) -> space
    .replace(/\s+/g, " ") // collapse whitespace runs (incl ones we just made)
    .replace(/\|/g, "/") // a pipe can never become a column delimiter
    .trim();
}

function formatRow(cells) {
  return "| " + cells.map(sanitizeCell).join(" | ") + " |";
}

/* Return a cycle (as an `A -> B -> A` id list) in a dependency graph
 * (Map<id, string[]>), or null. A cycle leaves every member permanently
 * "blocked" with no mechanical signal, so the board write path and the gate
 * both reject it. Pure — shared by backlog.js and check-backlog.js. */
function findCycle(graph) {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map();
  const stack = [];
  let cycle = null;
  const visit = (node) => {
    color.set(node, GRAY);
    stack.push(node);
    for (const dep of graph.get(node) || []) {
      if (!graph.has(dep)) continue; // unknown/archived refs are handled elsewhere
      const c = color.get(dep) || WHITE;
      if (c === GRAY) {
        cycle = stack.slice(stack.indexOf(dep)).concat(dep);
        return true;
      }
      if (c === WHITE && visit(dep)) return true;
    }
    stack.pop();
    color.set(node, BLACK);
    return false;
  };
  for (const node of graph.keys()) {
    if ((color.get(node) || WHITE) === WHITE && visit(node)) break;
  }
  return cycle;
}

module.exports = { splitCells, isSep, sanitizeCell, formatRow, findCycle };
