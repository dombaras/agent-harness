#!/usr/bin/env node
"use strict";
/*
 * backlog — deterministic BACKLOG.md editor (no LLM).
 *
 * The canonical task list is `BACKLOG.md` at the repo root. This script reads
 * and mutates it directly, so humans and agents can accumulate / review /
 * delegate work without a model round-trip. It is the single implementation
 * behind the opencode custom tools (`.opencode/tools/backlog.ts`) and the human
 * CLI (`npm run backlog -- <cmd>`).
 *
 * Commands:
 *   list [--all]                        show active rows (In progress + Open)
 *   add <task> [--p P1..P4] [--evidence x] [--id F-xxx]
 *   take <id> [--handoff path]          Open -> In progress (pick it up)
 *   archive <id> [--closed note]        -> Archive (shipped · done)
 *   freeze <id> [--why x] [--reopen x]  -> Frozen (parked)
 *
 * Every mutation writes well-formed rows that `npm run test:backlog` accepts:
 * priority P1..P4, non-empty evidence/handoff/reopen, unique IDs.
 */
const fs = require("fs");
const path = require("path");

const PRIORITIES = { P1: 0, P2: 1, P3: 2, P4: 3 };

const SECTIONS = {
  active: { heading: "## Active / next" },
  inprogress: { heading: "## In progress", header: ["ID", "Task", "Handoff"] },
  open: { heading: "## Open", header: ["ID", "P", "Task", "Evidence"] },
  frozen: { heading: "## Frozen", header: ["ID", "Task", "Why frozen / reopen when"] },
  archive: { heading: "## Archive (shipped · done)", header: ["ID", "Task", "Closed"] },
};

// ---------------------------------------------------------------- helpers

/* Split a markdown table row on unescaped `|` (respects `\|` inside cells). */
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

function normalizeHeading(text) {
  return text.replace(/^#+\s*/, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/* Map a raw heading to its canonical short key (tolerates spacing/variant). */
function canonKey(heading) {
  const h = normalizeHeading(heading);
  if (h === "open") return "open";
  if (h === "in progress") return "inprogress";
  if (h === "frozen") return "frozen";
  if (h === "active / next") return "active";
  if (h.startsWith("archive")) return "archive";
  return null;
}

/* Walk up from `startDir` to the directory containing BACKLOG.md. */
function findRoot(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(dir, "BACKLOG.md"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readBacklog(root) {
  const p = path.join(root, "BACKLOG.md");
  if (!fs.existsSync(p)) {
    throw new Error("BACKLOG.md not found (repo root) — run `npx @dombaras/agent-harness init` first.");
  }
  const src = fs.readFileSync(p, "utf8");
  const eol = src.includes("\r\n") ? "\r\n" : "\n";
  return { p, eol, lines: src.split(/\r?\n/) };
}

/* Locate a section (## heading) by its normalized key. */
function findSection(lines, key) {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#{2,3}\s+(.*)$/);
    if (m && canonKey(m[1]) === key) {
      let end = lines.length;
      for (let j = i + 1; j < lines.length; j++) {
        if (/^#{2,3}\s/.test(lines[j])) {
          end = j;
          break;
        }
      }
      return { headingIdx: i, endIdx: end };
    }
  }
  return null;
}

/* Find the markdown table block (header / separator / data rows) in a section. */
function tableBlock(lines, headingIdx, endIdx) {
  let headerIdx = -1;
  let sepIdx = -1;
  let dataStart = -1;
  let dataEnd = -1;
  for (let i = headingIdx + 1; i < endIdx; i++) {
    if (!/^\s*\|.*\|\s*$/.test(lines[i])) continue;
    if (headerIdx === -1) {
      headerIdx = i;
      continue;
    }
    if (sepIdx === -1) {
      if (isSep(splitCells(lines[i].slice(1, -1)))) {
        sepIdx = i;
        dataStart = i + 1;
        dataEnd = i;
      } else {
        dataEnd = i;
      }
      continue;
    }
    dataEnd = i;
  }
  return { headerIdx, sepIdx, dataStart, dataEnd };
}

/* Non-empty data rows (cell arrays) in a section's table. */
function dataRows(lines, block) {
  if (block.sepIdx === -1) return [];
  const rows = [];
  for (let i = block.dataStart; i <= block.dataEnd; i++) {
    const cells = splitCells(lines[i].slice(1, -1));
    if (cells.every((c) => c.trim() === "")) continue;
    rows.push({ idx: i, cells });
  }
  return rows;
}

function getRows(lines, key) {
  const s = findSection(lines, key);
  if (!s) return [];
  return dataRows(lines, tableBlock(lines, s.headingIdx, s.endIdx));
}

function requireSection(lines, key) {
  const s = findSection(lines, key);
  if (!s) {
    throw new Error(`BACKLOG.md is missing the "${SECTIONS[key].heading}" section — restore it from the template.`);
  }
  return s;
}

/* Replace a section's data rows with `newCellsList`, preserving header + prose. */
function setRows(lines, key, newCellsList) {
  const s = requireSection(lines, key);
  const block = tableBlock(lines, s.headingIdx, s.endIdx);
  const out = lines.slice();
  const newLines = newCellsList.map(formatRow);
  if (block.dataStart === -1 || block.dataEnd < block.dataStart) {
    const insertAt = block.sepIdx !== -1 ? block.sepIdx + 1 : block.headerIdx + 1;
    out.splice(insertAt, 0, ...newLines);
    return out;
  }
  out.splice(block.dataStart, block.dataEnd - block.dataStart + 1, ...newLines);
  return out;
}

function formatRow(cells) {
  return "| " + cells.join(" | ") + " |";
}

function nextId(lines) {
  let max = 0;
  for (const key of ["open", "inprogress", "frozen", "archive"]) {
    for (const r of getRows(lines, key)) {
      const m = /^(?:F|T)-(\d+)$/i.exec((r.cells[0] || "").trim());
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  }
  return "F-" + String(max + 1).padStart(3, "0");
}

function getAllIds(lines) {
  const ids = new Set();
  for (const key of ["open", "inprogress", "frozen", "archive"]) {
    for (const r of getRows(lines, key)) if (r.cells[0]) ids.add(r.cells[0]);
  }
  return ids;
}

function priorityRank(p) {
  return Object.prototype.hasOwnProperty.call(PRIORITIES, p) ? PRIORITIES[p] : 4;
}

/* Insert an open row in priority order (P1 -> P4, unknown last). */
function insertOpen(rows, newRow) {
  const newRank = priorityRank(newRow[1]);
  const out = rows.slice();
  let idx = out.length;
  for (let i = 0; i < out.length; i++) {
    if (priorityRank(out[i][1] || "?") > newRank) {
      idx = i;
      break;
    }
  }
  out.splice(idx, 0, newRow);
  return out;
}

function findRow(lines, id) {
  for (const key of ["open", "inprogress", "frozen", "archive"]) {
    for (const r of getRows(lines, key)) {
      if ((r.cells[0] || "").trim() === id) return { key, cells: r.cells };
    }
  }
  return null;
}

// ---------------------------------------------------------------- commands

function cmdList(state, argv) {
  const active = findSection(state.lines, "active");
  if (active) {
    for (let i = active.headingIdx + 1; i < active.endIdx; i++) {
      const t = state.lines[i].trim();
      if (/^\s*[-*]\s+/.test(t) && !/^\s*[-*]\s+_.*_\s*$/.test(t)) console.log(t);
    }
    console.log("");
  }
  for (const key of ["inprogress", "open"]) {
    const rows = getRows(state.lines, key).map((r) => r.cells);
    console.log(SECTIONS[key].heading.replace(/^##\s*/, ""));
    if (rows.length === 0) {
      console.log("  (none)");
    } else {
      for (const c of rows) {
        if (key === "open") console.log(`  ${c[0]}  [${c[1]}] ${c[2]}  (${c[3]})`);
        else console.log(`  ${c[0]}  ${c[1]}  (${c[2]})`);
      }
    }
    console.log("");
  }
  if (argv.all) {
    for (const key of ["frozen", "archive"]) {
      const rows = getRows(state.lines, key).map((r) => r.cells);
      console.log(SECTIONS[key].heading.replace(/^##\s*/, ""));
      if (rows.length === 0) {
        console.log("  (none)");
      } else {
        for (const c of rows) {
          if (key === "frozen") console.log(`  ${c[0]}  ${c[1]}  — ${c[2]}`);
          else console.log(`  ${c[0]}  ${c[1]}  (${c[2]})`);
        }
      }
      console.log("");
    }
  }
}

function cmdAdd(state, argv) {
  const task = argv._[0];
  if (!task) throw new Error("add: missing <task>.");
  const priority = (argv.p || "P3").toUpperCase();
  if (!(priority in PRIORITIES)) throw new Error(`add: priority must be P1..P4 (got "${priority}").`);
  const evidence = argv.evidence || "?";
  const id = argv.id || nextId(state.lines);
  if (getAllIds(state.lines).has(id)) throw new Error(`add: duplicate ID ${id}.`);

  const openRows = getRows(state.lines, "open").map((r) => r.cells);
  const merged = insertOpen(openRows, [id, priority, task, evidence]);
  state.lines = setRows(state.lines, "open", merged);
  return { id, priority, task, evidence };
}

function cmdTake(state, argv) {
  const id = argv._[0];
  if (!id) throw new Error("take: missing <id>.");
  const found = findRow(state.lines, id);
  if (!found) throw new Error(`take: no row ${id} in BACKLOG.md.`);
  if (found.key === "inprogress") return { id, note: "already In progress" };
  if (found.key === "frozen") throw new Error(`take: ${id} is Frozen — unfreeze it first.`);
  if (found.key === "archive") throw new Error(`take: ${id} is archived.`);

  const task = found.cells[2] || id; // open cells: [id, p, task, evidence]
  const handoff = argv.handoff || "?";

  const openRows = getRows(state.lines, "open").map((r) => r.cells).filter((c) => c[0].trim() !== id);
  state.lines = setRows(state.lines, "open", openRows);

  const inprog = getRows(state.lines, "inprogress").map((r) => r.cells);
  inprog.push([id, task, handoff]);
  state.lines = setRows(state.lines, "inprogress", inprog);
  return { id, task, handoff };
}

function cmdArchive(state, argv) {
  const id = argv._[0];
  if (!id) throw new Error("archive: missing <id>.");
  const found = findRow(state.lines, id);
  if (!found) throw new Error(`archive: no row ${id} in BACKLOG.md.`);
  if (found.key === "archive") return { id, note: "already archived" };

  const task = found.key === "open" ? found.cells[2] : found.cells[1];
  const closed = argv.closed || "shipped";

  const srcRows = getRows(state.lines, found.key).map((r) => r.cells).filter((c) => c[0].trim() !== id);
  state.lines = setRows(state.lines, found.key, srcRows);

  const archiveRows = getRows(state.lines, "archive").map((r) => r.cells);
  archiveRows.push([id, task, closed]);
  state.lines = setRows(state.lines, "archive", archiveRows);
  return { id, task, closed };
}

function cmdFreeze(state, argv) {
  const id = argv._[0];
  if (!id) throw new Error("freeze: missing <id>.");
  const why = argv.why || "";
  const reopen = argv.reopen || "";
  if (!why && !reopen) {
    throw new Error("freeze: provide --why and/or --reopen (the reopen condition is required by test:backlog).");
  }
  const found = findRow(state.lines, id);
  if (!found) throw new Error(`freeze: no row ${id} in BACKLOG.md.`);
  if (found.key === "frozen") return { id, note: "already frozen" };

  const task = found.key === "open" ? found.cells[2] : found.cells[1];
  const cond = [why, reopen ? `reopen when ${reopen}` : ""].filter(Boolean).join(" — ");

  const srcRows = getRows(state.lines, found.key).map((r) => r.cells).filter((c) => c[0].trim() !== id);
  state.lines = setRows(state.lines, found.key, srcRows);

  const frozenRows = getRows(state.lines, "frozen").map((r) => r.cells);
  frozenRows.push([id, task, cond]);
  state.lines = setRows(state.lines, "frozen", frozenRows);
  return { id, task, cond };
}

// ---------------------------------------------------------------- dispatch

function formatResult(cmd, out) {
  if (cmd === "add") return `added ${out.id} [${out.priority}] ${out.task}`;
  if (cmd === "take") return out.note ? `${out.id}: ${out.note}` : `took ${out.id} -> In progress (${out.handoff})`;
  if (cmd === "archive") return out.note ? `${out.id}: ${out.note}` : `archived ${out.id} (${out.closed})`;
  if (cmd === "freeze") return out.note ? `${out.id}: ${out.note}` : `froze ${out.id} (${out.cond})`;
  return "";
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--p" || a === "--priority") args.p = argv[++i];
    else if (a === "--evidence" || a === "-e") args.evidence = argv[++i];
    else if (a === "--handoff") args.handoff = argv[++i];
    else if (a === "--closed") args.closed = argv[++i];
    else if (a === "--why") args.why = argv[++i];
    else if (a === "--reopen") args.reopen = argv[++i];
    else if (a === "--id") args.id = argv[++i];
    else if (a === "--all") args.all = true;
    else if (a === "--root") args.root = argv[++i];
    else args._.push(a);
  }
  return args;
}

function usage() {
  console.log(
    "backlog — deterministic BACKLOG.md editor (no LLM)\n\n" +
      "  node scripts/backlog.js list [--all]\n" +
      "  node scripts/backlog.js add <task> [--p P1..P4] [--evidence x] [--id F-xxx]\n" +
      "  node scripts/backlog.js take <id> [--handoff path]\n" +
      "  node scripts/backlog.js archive <id> [--closed note]\n" +
      "  node scripts/backlog.js freeze <id> [--why x] [--reopen x]\n"
  );
}

function main() {
  const raw = process.argv.slice(2);
  const cmd = raw[0];
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    usage();
    return;
  }
  const args = parseArgs(raw.slice(1));

  const root = args.root ? path.resolve(args.root) : findRoot(process.cwd());
  if (!root) {
    console.error("backlog: BACKLOG.md not found (repo root).");
    process.exitCode = 1;
    return;
  }
  const state = readBacklog(root);

  try {
    let out;
    if (cmd === "list") out = cmdList(state, args);
    else if (cmd === "add") out = cmdAdd(state, args);
    else if (cmd === "take") out = cmdTake(state, args);
    else if (cmd === "archive") out = cmdArchive(state, args);
    else if (cmd === "freeze") out = cmdFreeze(state, args);
    else {
      usage();
      process.exitCode = 1;
      return;
    }
    if (cmd !== "list") {
      fs.writeFileSync(state.p, state.lines.join(state.eol) + state.eol, "utf8");
      console.log(formatResult(cmd, out));
    }
  } catch (e) {
    console.error(`backlog: ${e.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  splitCells,
  findRoot,
  readBacklog,
  findSection,
  tableBlock,
  dataRows,
  getRows,
  setRows,
  nextId,
  cmdAdd,
  cmdTake,
  cmdArchive,
  cmdFreeze,
};
