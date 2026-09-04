#!/usr/bin/env node
"use strict";
/*
 * merge-backlog — row-aware 3-way merge driver for BACKLOG.md.
 *
 * Registered as a git merge driver: `.gitattributes` carries
 * `BACKLOG.md merge=backlog`, and `agent-harness init/update` wires the driver
 * via `git config merge.backlog.driver "node <abs>/scripts/qa/merge-backlog.js %O %A %B"`.
 * Git invokes it as:
 *
 *   node scripts/qa/merge-backlog.js <base> <ours> <theirs> [<marker-size>]
 *
 * It writes the merged board to <ours> and exits:
 *   0 — clean merge
 *   1 — genuine row conflict (both sides changed the same row differently);
 *       conflict markers are left in <ours> for the human to resolve.
 *
 * Rows are keyed by their first cell (ID for work rows, `Key` for ## Epics), so
 * two sessions that edit DISJOINT rows — the normal concurrent case (one takes
 * F-052, the other archives F-041) — merge without touching each other's edits.
 * Row MOVES (Open→In progress, In progress→Archive) are resolved by 3-way
 * comparison, not by line position, so `merge=union`'s duplicate-row failure mode
 * is avoided. Prose and "Active / next" bullets resolve to the <ours> side
 * (they are explanatory, not row data).
 */
const fs = require("fs");

// ---- small self-contained markdown-table helpers -------------------------

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

function canonKey(heading) {
  const h = heading.replace(/^#+\s*/, "").replace(/\s+/g, " ").trim().toLowerCase();
  if (h === "open") return "open";
  if (h === "queued") return "queued";
  if (h === "in progress") return "inprogress";
  if (h === "frozen") return "frozen";
  if (h.startsWith("archive")) return "archive";
  if (h === "epics") return "epics";
  return null;
}

/* Parse a board into ordered sections: { key, rowOrder: [rowKey], rowLines: Map }. */
function parseBoard(src) {
  const sections = [];
  let cur = null;
  for (const raw of String(src || "").split(/\r?\n/)) {
    const h = raw.match(/^#{2,3}\s+(.*)$/);
    if (h) {
      const key = canonKey(h[1]);
      cur = key ? { key, rowOrder: [], rowLines: new Map() } : null;
      if (cur) sections.push(cur);
      continue;
    }
    if (!cur) continue;
    const row = raw.trim();
    if (!/^\|.*\|$/.test(row)) continue;
    const cells = splitCells(row.slice(1, -1));
    if (isSep(cells)) continue;
    if (cells.every((c) => c.trim() === "")) continue;
    if (cells.some((c) => /^(ID|Key)$/.test(c.trim()))) continue; // header row
    const rowKey = (cells[0] || "").trim();
    if (!rowKey) continue;
    if (!cur.rowLines.has(rowKey)) cur.rowOrder.push(rowKey);
    cur.rowLines.set(rowKey, row);
  }
  return sections;
}

/* Locate each section's table block within a raw line array. */
function sectionBlocks(lines) {
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#{2,3}\s+(.*)$/);
    if (!m) continue;
    const key = canonKey(m[1]);
    if (!key) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^#{2,3}\s/.test(lines[j])) {
        end = j;
        break;
      }
    }
    let headerIdx = -1;
    let sepIdx = -1;
    let dataStart = -1;
    let dataEnd = -1;
    for (let j = i + 1; j < end; j++) {
      if (!/^\s*\|.*\|\s*$/.test(lines[j])) continue;
      if (headerIdx === -1) {
        headerIdx = j;
        continue;
      }
      if (sepIdx === -1) {
        if (isSep(splitCells(lines[j].slice(1, -1)))) {
          sepIdx = j;
          dataStart = j + 1;
          dataEnd = j;
        } else {
          dataEnd = j;
        }
        continue;
      }
      dataEnd = j;
    }
    blocks.push({ key, headerIdx, sepIdx, dataStart, dataEnd });
  }
  return blocks;
}

function decode(v) {
  const i = v.indexOf("\u0000");
  return { section: v.slice(0, i), line: v.slice(i + 1) };
}

function priorityRank(line) {
  const cells = splitCells(line.slice(1, -1));
  const p = (cells[1] || "").trim().toUpperCase();
  const ranks = { P1: 0, P2: 1, P3: 2, P4: 3 };
  return Object.prototype.hasOwnProperty.call(ranks, p) ? ranks[p] : 4;
}

/* 3-way merge keyed by row ID/Key. Returns { resolved: Map, conflicts: [] }. */
function merge(baseSrc, oursSrc, theirsSrc) {
  const toMap = (sections) => {
    const m = new Map();
    for (const s of sections) {
      for (const k of s.rowOrder) m.set(k, s.key + "\u0000" + s.rowLines.get(k));
    }
    return m;
  };
  const bm = toMap(parseBoard(baseSrc));
  const om = toMap(parseBoard(oursSrc));
  const tm = toMap(parseBoard(theirsSrc));

  const keys = new Set([...bm.keys(), ...om.keys(), ...tm.keys()]);
  const resolved = new Map();
  const conflicts = [];

  for (const k of keys) {
    const bv = bm.get(k);
    const ov = om.get(k);
    const tv = tm.get(k);
    if (ov === tv) {
      if (ov !== undefined) resolved.set(k, decode(ov));
      // else: deleted in both -> drop
      continue;
    }
    if (ov === bv) {
      // ours unchanged -> take theirs (or deletion)
      if (tv !== undefined) resolved.set(k, decode(tv));
      continue;
    }
    if (tv === bv) {
      // theirs unchanged -> take ours (or deletion)
      if (ov !== undefined) resolved.set(k, decode(ov));
      continue;
    }
    // both sides changed the same row, and differently -> conflict
    conflicts.push({ key: k, ours: ov, theirs: tv });
  }

  return { resolved, conflicts };
}

/* Rebuild the board from the OURS skeleton, replacing each section's table data
 * rows with the merged rows. Preserves OURS prose, headings, header/separator. */
function rebuild(oursSrc, resolved) {
  const eol = oursSrc.includes("\r\n") ? "\r\n" : "\n";
  const lines = oursSrc.split(/\r?\n/);
  const blocks = sectionBlocks(lines);

  const bySection = new Map();
  for (const [, r] of resolved) {
    if (!bySection.has(r.section)) bySection.set(r.section, []);
    bySection.get(r.section).push(r);
  }

  const oursOrder = new Map();
  for (const s of parseBoard(oursSrc)) oursOrder.set(s.key, s.rowOrder.slice());

  for (const [section, rows] of bySection) {
    const ordered = new Map();
    const seen = new Set();
    for (const k of oursOrder.get(section) || []) {
      const r = rows.find((x) => x.key === k);
      if (r) {
        seen.add(k);
        ordered.set(k, r.line);
      }
    }
    for (const r of rows) if (!seen.has(r.key)) ordered.set(r.key, r.line);

    let arr = [...ordered.entries()].map(([key, line]) => ({ key, line }));
    if (section === "open" || section === "queued") {
      arr.sort(
        (a, b) =>
          priorityRank(a.line) - priorityRank(b.line) ||
          (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
      );
    }
    bySection.set(section, arr);
  }

  // splice from the last block backwards so earlier indices stay valid
  for (let bi = blocks.length - 1; bi >= 0; bi--) {
    const b = blocks[bi];
    const rows = (bySection.get(b.key) || []).map((r) => r.line);
    if (b.headerIdx === -1) continue;
    const headerLine = lines[b.headerIdx];
    const sepLine = b.sepIdx !== -1 ? lines[b.sepIdx] : "";
    const start = b.headerIdx;
    const end = b.dataEnd >= b.dataStart ? b.dataEnd : b.sepIdx;
    const replacement = [headerLine];
    if (sepLine) replacement.push(sepLine);
    replacement.push(...rows);
    lines.splice(start, end - start + 1, ...replacement);
  }
  return lines.join(eol);
}

function conflictBlock(conflicts, eol) {
  const out = ["<<<<<<< ours"];
  for (const c of conflicts) {
    out.push(c.ours ? c.ours.slice(c.ours.indexOf("\u0000") + 1) : `(deleted) ${c.key}`);
  }
  out.push("=======");
  for (const c of conflicts) {
    out.push(c.theirs ? c.theirs.slice(c.theirs.indexOf("\u0000") + 1) : `(deleted) ${c.key}`);
  }
  out.push(">>>>>>> theirs");
  return out.join(eol);
}

function main() {
  const base = process.argv[2];
  const ours = process.argv[3];
  const theirs = process.argv[4];

  const oursSrc = ours && fs.existsSync(ours) ? fs.readFileSync(ours, "utf8") : "";
  const baseSrc = base && fs.existsSync(base) ? fs.readFileSync(base, "utf8") : "";
  const theirsSrc = theirs && fs.existsSync(theirs) ? fs.readFileSync(theirs, "utf8") : "";

  const { resolved, conflicts } = merge(baseSrc, oursSrc, theirsSrc);
  const eol = oursSrc.includes("\r\n") ? "\r\n" : "\n";
  let out = rebuild(oursSrc, resolved);

  if (conflicts.length) {
    out = out.replace(/\s*$/, "") + eol + eol + conflictBlock(conflicts, eol) + eol;
    fs.writeFileSync(ours, out, "utf8");
    console.error(
      `merge-backlog: ${conflicts.length} conflicting row(s): ${conflicts.map((c) => c.key).join(", ")}`
    );
    process.exit(1);
  }

  fs.writeFileSync(ours, out, "utf8");
  process.exit(0);
}

if (require.main === module) main();

module.exports = { splitCells, parseBoard, merge, rebuild, priorityRank };
