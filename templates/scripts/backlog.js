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
 *   add <task> [--p P1..P4] [--evidence x] [--id F-xxx] [--depends-on ids]
 *   take <id> [--handoff path]          Open/Queued -> In progress (pick it up)
 *   queue <id>                          Open -> Queued (allocate to a worker)
 *   unqueue <id>                        Queued -> Open (return an allocated row
 *                                       to the triage pool)
 *   next [--take] [--handoff path]      pick the top unblocked Queued row
 *   archive <id> [--closed note]        -> Archive (shipped · done)
 *   freeze <id> [--why x] [--reopen x]  -> Frozen (parked)
 *   depends <id> --on <ids|?>           set a row's "Depends on" cell (Open/Queued)
 *   owns <id> --files "glob, glob"      record the files/globs a row owns
 *   worktree <id> [--branch b] [--dir d] [--handoff path] [--no-fetch]
 *                                       create a git worktree + branch for <id>
 *                                       and record it in the row's Handoff cell.
 *                                       Branches from the current upstream
 *                                       (origin/main), not a stale local HEAD.
 *                                       Default location: <repo>/../.worktrees/<repo>/<id>
 *                                       (a single container sibling, so one worktree
 *                                       per feature never pollutes the parent folder).
 *
 * Every mutation writes well-formed rows that `npm run test:backlog` accepts:
 * priority P1..P4, non-empty evidence/handoff/reopen, unique IDs, and
 * `Depends on` cells that reference existing rows.
 *
 * `worktree` is the harness's isolation primitive: concurrent sessions should
 * each claim a separate `git worktree` + branch so one session's uncommitted
 * work can never leak into another's pre-push gate (`test:concurrency` fails a
 * push when that collision is provable). Run it from the MAIN tree. `archive`
 * reverses it: a shipped feature's worktree + merged branch are removed, so
 * per-feature checkouts never pile up after sessions close.
 *
 * Because a feature's commits reach `origin/main` from its own worktree, the
 * MAIN checkout's board can lag origin until it is pulled. `worktree` and
 * `archive` therefore sync the main checkout first — fast-forwarding a clean,
 * strictly-behind branch and reporting (never silently rewriting) a diverged
 * one — and `worktree` bases the new branch on the current upstream, not a
 * stale local HEAD. `--no-fetch` skips the network step for offline use.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { splitCells, isSep, formatRow } = require("./qa/board-lib.js");

const PRIORITIES = { P1: 0, P2: 1, P3: 2, P4: 3 };

const SECTIONS = {
  active: { heading: "## Active / next" },
  epics: { heading: "## Epics", header: ["Key", "Label", "Goal"] },
  inprogress: { heading: "## In progress", header: ["ID", "Epic", "Task", "Handoff"] },
  queued: { heading: "## Queued", header: ["ID", "P", "Epic", "Task", "Evidence", "Depends on"] },
  open: { heading: "## Open", header: ["ID", "P", "Epic", "Task", "Evidence", "Depends on"] },
  frozen: { heading: "## Frozen", header: ["ID", "Epic", "Task", "Why frozen / reopen when"] },
  archive: { heading: "## Archive (shipped · done)", header: ["ID", "Epic", "Task", "Closed"] },
};

// ---------------------------------------------------------------- helpers

function normalizeHeading(text) {
  return text.replace(/^#+\s*/, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/* Map a raw heading to its canonical short key (tolerates spacing/variant). */
function canonKey(heading) {
  const h = normalizeHeading(heading);
  if (h === "open") return "open";
  if (h === "queued") return "queued";
  if (h === "in progress") return "inprogress";
  if (h === "frozen") return "frozen";
  if (h === "active / next") return "active";
  if (h === "epics") return "epics";
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

/* Serialize the in-memory board back to disk. `readBacklog` splits on newlines,
 * so a source that ended in a newline carries a trailing "" element and
 * join(eol) already emits that final newline. Appending eol unconditionally
 * (the old `join(eol) + eol`) added one blank line at EOF on every mutation. */
function serializeBacklog(state) {
  const body = state.lines.join(state.eol);
  return state.lines[state.lines.length - 1] === "" ? body : body + state.eol;
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

/* Canonical header / separator lines for a section's table. */
function headerLine(key) {
  return "| " + SECTIONS[key].header.join(" | ") + " |";
}
function sepLine(key) {
  return "|" + SECTIONS[key].header.map(() => "---").join("|") + "|";
}

/* Replace a section's table (header + separator + data rows) with the canonical
 * header and `newCellsList`, preserving the section's prose. Short cells are
 * padded to the section's column count so a legacy row (e.g. an Open row written
 * before the `Depends on` column existed) normalizes to the current schema. */
function setRows(lines, key, newCellsList) {
  const s = requireSection(lines, key);
  const block = tableBlock(lines, s.headingIdx, s.endIdx);
  const out = lines.slice();
  const width = SECTIONS[key].header.length;
  const dataLines = newCellsList.map((cells) => {
    const padded = cells.slice();
    while (padded.length < width) padded.push("?");
    return formatRow(padded.slice(0, width));
  });
  if (block.headerIdx === -1) {
    const insertAt = s.headingIdx + 1;
    out.splice(insertAt, 0, headerLine(key), sepLine(key), ...dataLines);
    return out;
  }
  const start = block.headerIdx;
  const end = block.dataEnd >= block.dataStart ? block.dataEnd : block.sepIdx;
  out.splice(start, end - start + 1, headerLine(key), sepLine(key), ...dataLines);
  return out;
}

function nextId(lines) {
  let max = 0;
  for (const key of ["open", "queued", "inprogress", "frozen", "archive"]) {
    for (const r of getRows(lines, key)) {
      const m = /^(?:F|T)-(\d+)$/i.exec((r.cells[0] || "").trim());
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  }
  return "F-" + String(max + 1).padStart(3, "0");
}

function getAllIds(lines) {
  const ids = new Set();
  for (const key of ["open", "queued", "inprogress", "frozen", "archive"]) {
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
  for (const key of ["open", "queued", "inprogress", "frozen", "archive"]) {
    for (const r of getRows(lines, key)) {
      if ((r.cells[0] || "").trim() === id) return { key, cells: r.cells };
    }
  }
  return null;
}

// ---------------------------------------------------------------- locking
/* The board write path (take / next --take / queue / archive / worktree / ...)
 * is a read-modify-write of BACKLOG.md. Two concurrent sessions could otherwise
 * both read the same Queued row and both claim it. `withLock` serializes that
 * write path across processes via an exclusive `.backlog.lock` DIRECTORY:
 * `fs.mkdirSync(lockPath)` is atomic and the directory's existence *is* the
 * lock, so there is no `open(O_CREAT|O_EXCL)`→`write` window in which a waiter
 * can read an empty lock and mistake it for stale. (The old file lock did
 * exactly that: it read `""`, `pidAlive(NaN)` was false, and it unlinked a live
 * lock under contention — losing rows and assigning duplicate IDs.)
 *
 * The holder's PID is published inside `<lockPath>/pid` via temp-file + rename
 * (atomic), so a waiter never reads a partial pid. A missing/unparseable PID
 * means the creator is mid-setup, so the lock is treated as HELD, never stale;
 * it is broken only when a valid, positive PID is provably dead — never by age
 * alone, since a slow `git worktree add` under the lock must not be mistaken
 * for a stale lock. */
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 15000;
const LOCK_PID_FILE = "pid";

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists but not signalable — still alive
  }
}

function breakLock(lockPath) {
  try {
    fs.rmSync(lockPath, { recursive: true, force: true });
  } catch {
    /* vanished — retry */
  }
}

function withLock(root, fn) {
  const lockPath = path.join(root, ".backlog.lock");
  const pidPath = path.join(lockPath, LOCK_PID_FILE);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let acquired = false;
  while (!acquired) {
    try {
      fs.mkdirSync(lockPath);
      acquired = true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let holderPid = NaN;
      try {
        holderPid = parseInt(fs.readFileSync(pidPath, "utf8"), 10);
      } catch {
        /* pid not published yet (creator mid-setup) — held, never stale */
      }
      if (Number.isFinite(holderPid) && holderPid > 0 && !pidAlive(holderPid)) {
        breakLock(lockPath);
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error("backlog: timed out waiting for the board lock (another session is mid-write).");
      }
      sleep(LOCK_RETRY_MS);
    }
  }
  try {
    const tmp = path.join(
      lockPath,
      `.pid.${process.pid}.${Math.random().toString(36).slice(2)}`
    );
    fs.writeFileSync(tmp, String(process.pid));
    fs.renameSync(tmp, pidPath); // atomic publish — no partial pid ever visible
    return fn();
  } finally {
    breakLock(lockPath);
  }
}

// ---------------------------------------------------------------- epics

/* The top-level ## Epics registry table → [{ key, label, goal }]. */
function readEpics(lines) {
  return getRows(lines, "epics").map((r) => ({
    key: (r.cells[0] || "").trim(),
    label: (r.cells[1] || "").trim(),
    goal: (r.cells[2] || "").trim(),
  }));
}

function getEpicKeys(lines) {
  return new Set(readEpics(lines).map((e) => e.key));
}

/* A valid epic cell is the literal `?` or a registered ## Epics key. */
function isEpicKey(key, lines) {
  return key === "?" || getEpicKeys(lines).has(key);
}

/* Row shapes differ per section — read the right cell by section key.
 * open/queued: [id, p, epic, task, evidence];
 * inprogress/frozen/archive: [id, epic, task, ...]. */
function taskOf(cells, key) {
  return key === "open" || key === "queued" ? cells[3] : cells[2];
}

/* Index of the epic cell within a section's row. */
function epicIndex(key) {
  if (key === "open" || key === "queued") return 2;
  if (key === "inprogress" || key === "frozen" || key === "archive") return 1;
  return -1;
}

function epicOf(cells, key) {
  const i = epicIndex(key);
  return i === -1 ? "?" : (cells[i] || "?");
}

/* "Depends on" cell (Open/Queued only): a comma/space-separated list of row IDs,
 * or `?`/empty for none. */
function dependsOf(cells, key) {
  return key === "open" || key === "queued" ? (cells[5] || "").trim() : "";
}

function isArchived(lines, id) {
  return getRows(lines, "archive").some((r) => (r.cells[0] || "").trim() === id);
}

/* The IDs this row depends on that are NOT yet archived (its blockers). */
function blockedBy(lines, cells, key) {
  const dep = dependsOf(cells, key);
  if (!dep || dep === "?") return [];
  return dep.split(/[\s,]+/).filter(Boolean).filter((d) => !isArchived(lines, d));
}

/* ---------------------------------------------------------------- owned-files registry */
/* `.agents/memory/owned-files.md` maps an active row -> the files/globs it owns,
 * powering the cross-session overlap check in `test:concurrency`. */

function ownedFilesPath(root) {
  return path.join(root, ".agents", "memory", "owned-files.md");
}

function readOwnedRegistry(root) {
  const p = ownedFilesPath(root);
  const map = new Map();
  if (!fs.existsSync(p)) return { map, eol: "\n" };
  const src = fs.readFileSync(p, "utf8");
  const eol = src.includes("\r\n") ? "\r\n" : "\n";
  for (const raw of src.split(/\r?\n/)) {
    const m = raw.match(/^\s*[-*]\s+([A-Za-z]+-\d+)\s*:\s*(.+)$/);
    if (m) map.set(m[1].toUpperCase(), m[2].trim());
  }
  return { map, eol };
}

function writeOwnedRegistry(root, map) {
  const p = ownedFilesPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const header = [
    "# Owned files per active row",
    "",
    "One row per in-progress feature: the files/globs it owns. Drives the",
    "cross-session overlap check in `test:concurrency` (two In-progress rows must",
    "not own the same file). Format: `- <ID>: <glob>[, <glob>...]`.",
    "",
  ];
  const body = [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([id, globs]) => `- ${id}: ${globs}`);
  fs.writeFileSync(p, header.concat(body).join("\n") + "\n", "utf8");
}

// ---------------------------------------------------------------- commands

function truncate(s, n) {
  if (s.length <= n) return s;
  return s.slice(0, n).trimEnd() + "…";
}

function stripEmphasis(s) {
  return s.replace(/[*_]+/g, "").trim();
}

/* Bounded by default: the tool/board path is read by an LLM, so dumping an
 * ever-growing board is a silent context leak. Every section still prints its
 * true count first; rows are shown in file order (Open/Queued are priority-
 * sorted), so the hidden rows are the lowest-priority tail. `--limit 0` = all. */
const LIST_DEFAULT_LIMIT = 40;

function cmdList(state, argv) {
  const full = !!argv.full;
  const TASK_W = full ? Infinity : 120;
  const SUB_W = full ? Infinity : 90;
  let limit = LIST_DEFAULT_LIMIT;
  if (argv.limit != null) {
    const n = Number.parseInt(argv.limit, 10);
    limit = Number.isFinite(n) && n >= 0 ? n : LIST_DEFAULT_LIMIT;
  }

  const active = findSection(state.lines, "active");
  if (active) {
    let printed = 0;
    for (let i = active.headingIdx + 1; i < active.endIdx; i++) {
      const t = state.lines[i].trim();
      if (/^\s*[-*]\s+/.test(t) && !/^\s*[-*]\s+_.*_\s*$/.test(t)) {
        console.log(stripEmphasis(t));
        printed++;
      }
    }
    if (printed) console.log("");
  }

  const groups = [["inprogress", "In progress"], ["queued", "Queued"], ["open", "Open"]];
  if (argv.all) groups.push(["frozen", "Frozen"], ["archive", "Archive"]);

  for (const [key, label] of groups) {
    const rows = getRows(state.lines, key).map((r) => r.cells);
    console.log(`${label} (${rows.length})`);
    const shown = limit > 0 && rows.length > limit ? rows.slice(0, limit) : rows;
    for (const c of shown) {
      if (key === "open" || key === "queued") {
        console.log(`  ${c[0]}  [${c[1]}]  [${c[2]}]  ${truncate(c[3] || "", TASK_W)}`);
        if (c[4] && c[4] !== "?") console.log(`             evidence: ${truncate(c[4], SUB_W)}`);
      } else if (key === "inprogress") {
        console.log(`  ${c[0]}  [${c[1]}]  ${truncate(c[2] || "", TASK_W)}`);
        if (c[3] && c[3] !== "?") console.log(`             handoff: ${truncate(c[3], SUB_W)}`);
      } else if (key === "frozen") {
        console.log(`  ${c[0]}  [${c[1]}]  ${truncate(c[2] || "", TASK_W)}`);
        if (c[3]) console.log(`             reopen: ${truncate(c[3], SUB_W)}`);
      } else {
        console.log(`  ${c[0]}  [${c[1]}]  ${truncate(c[2] || "", TASK_W)}`);
        if (c[3]) console.log(`             closed: ${truncate(c[3], SUB_W)}`);
      }
    }
    if (shown.length < rows.length) {
      console.log(`  … +${rows.length - shown.length} row(s) omitted (--limit ${limit}, 0 = all)`);
    }
    console.log("");
  }
}

/* Build the board's machine-readable snapshot (consumed by the superadmin API).
 * Shape is the JSON contract documented in `.agents/features/superadmin-backlog/scope.md`.
 * `open` rows are returned priority-sorted (P1 -> P4). */
function toBoardJson(state) {
  const active = [];
  const act = findSection(state.lines, "active");
  if (act) {
    for (let i = act.headingIdx + 1; i < act.endIdx; i++) {
      const t = state.lines[i].trim();
      if (/^\s*[-*]\s+/.test(t) && !/^\s*[-*]\s+_.*_\s*$/.test(t)) {
        active.push(stripEmphasis(t).replace(/^\s*[-*]\s+/, "").trim());
      }
    }
  }

  const epics = readEpics(state.lines);
  const open = getRows(state.lines, "open")
    .map((r) => ({ id: r.cells[0], priority: r.cells[1], epic: r.cells[2] || "?", task: r.cells[3] || "", evidence: r.cells[4] || "", dependsOn: r.cells[5] || "" }))
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
  const queued = getRows(state.lines, "queued")
    .map((r) => ({ id: r.cells[0], priority: r.cells[1], epic: r.cells[2] || "?", task: r.cells[3] || "", evidence: r.cells[4] || "", dependsOn: r.cells[5] || "" }))
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
  const inprogress = getRows(state.lines, "inprogress")
    .map((r) => ({ id: r.cells[0], epic: r.cells[1] || "?", task: r.cells[2] || "", handoff: r.cells[3] || "" }));
  const frozen = getRows(state.lines, "frozen")
    .map((r) => ({ id: r.cells[0], epic: r.cells[1] || "?", task: r.cells[2] || "", condition: r.cells[3] || "" }));
  const archive = getRows(state.lines, "archive")
    .map((r) => ({ id: r.cells[0], epic: r.cells[1] || "?", task: r.cells[2] || "", closed: r.cells[3] || "" }));

  return { epics, active, inprogress, queued, open, frozen, archive };
}

function cmdAdd(state, argv) {
  const task = argv._[0];
  if (!task) throw new Error("add: missing <task>.");
  const priority = (argv.p || "P3").toUpperCase();
  if (!(priority in PRIORITIES)) throw new Error(`add: priority must be P1..P4 (got "${priority}").`);
  const evidence = argv.evidence || "?";
  const epic = argv.epic || "?";
  if (!isEpicKey(epic, state.lines)) {
    throw new Error(`add: unknown epic "${epic}" (not in ## Epics) — use ? or epic-add first`);
  }
  const dependsOn = argv["depends-on"] || "?";
  const known = getAllIds(state.lines);
  for (const d of dependsOn.split(/[\s,]+/).filter(Boolean)) {
    if (d !== "?" && !known.has(d)) throw new Error(`add: depends on unknown row ${d}.`);
  }
  const id = argv.id || nextId(state.lines);
  if (getAllIds(state.lines).has(id)) throw new Error(`add: duplicate ID ${id}.`);

  const openRows = getRows(state.lines, "open").map((r) => r.cells);
  const merged = insertOpen(openRows, [id, priority, epic, task, evidence, dependsOn]);
  state.lines = setRows(state.lines, "open", merged);
  return { id, priority, epic, task, evidence, dependsOn };
}

/* epic-add <key> --label <x> [--goal <y>] — append a row to the ## Epics registry. */
function cmdEpicAdd(state, argv) {
  const key = argv._[0];
  if (!key) throw new Error("epic-add: missing <key>.");
  const label = argv.label;
  if (!label) throw new Error("epic-add: missing --label.");
  const goal = argv.goal || "";
  if (getEpicKeys(state.lines).has(key)) throw new Error(`epic-add: duplicate epic "${key}"`);

  const epics = getRows(state.lines, "epics").map((r) => r.cells);
  epics.push([key, label, goal]);
  state.lines = setRows(state.lines, "epics", epics);
  return { key, label, goal };
}

/* epic <id> --to <key> — rewrite a row's epic cell in place (any section). */
function cmdEpic(state, argv) {
  const id = argv._[0];
  if (!id) throw new Error("epic: missing <id>.");
  const to = argv.to;
  if (!isEpicKey(to, state.lines)) throw new Error(`epic: unknown epic "${to}"`);
  const found = findRow(state.lines, id);
  if (!found) throw new Error(`epic: no row ${id}`);

  const i = epicIndex(found.key);
  if (i === -1) throw new Error(`epic: ${id} is ${found.key} — rows there carry no epic column.`);

  const srcRows = getRows(state.lines, found.key).map((r) => r.cells);
  const idx = srcRows.findIndex((c) => (c[0] || "").trim() === id);
  const newRow = srcRows[idx].slice();
  newRow[i] = to;
  srcRows[idx] = newRow;
  state.lines = setRows(state.lines, found.key, srcRows);
  return { id, epic: to };
}

/* A session's Handoff cell must point at a real file under `.agents/handoffs/`
 * named `<id>.md` (or a hyphenated slug — see the handoff skill). Fail fast on a
 * placeholder like `.agents/handoffs/F-<id>.md` (the template's example path —
 * F-104's session recorded that literal and only a later explicit `--handoff`
 * corrected it) or any value that cannot be a real path. */
function validateHandoff(id, raw) {
  const v = (raw || "").trim();
  if (!v || v === "?") return v; // "?" is an allowed "unknown" sentinel
  if (!/^\.agents[\\/]handoffs[\\/].+\.md$/.test(v)) {
    throw new Error(
      `handoff must be a real path under .agents/handoffs/ ending in .md ` +
        `(e.g. .agents/handoffs/${id}.md), not "${raw}"`
    );
  }
  const stem = v.replace(/\.agents[\\/]handoffs[\\/]/i, "").replace(/\.md$/, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(stem)) {
    throw new Error(
      `handoff filename "${stem}" is not a valid <id> or slug ` +
        `(use .agents/handoffs/${id}.md or a hyphenated slug)`
    );
  }
  return v;
}

function cmdTake(state, argv) {
  const id = argv._[0];
  if (!id) throw new Error("take: missing <id>.");
  const found = findRow(state.lines, id);
  if (!found) throw new Error(`take: no row ${id} in BACKLOG.md.`);
  if (found.key === "inprogress") return { id, note: "already In progress" };
  if (found.key === "frozen") throw new Error(`take: ${id} is Frozen — unfreeze it first.`);
  if (found.key === "archive") throw new Error(`take: ${id} is archived.`);

  const blockers = blockedBy(state.lines, found.cells, found.key);
  if (blockers.length) {
    throw new Error(`take: ${id} is blocked — depends on ${blockers.join(", ")} (not yet archived).`);
  }

  const task = taskOf(found.cells, found.key) || id;
  const epic = epicOf(found.cells, found.key);
  const handoff = validateHandoff(id, argv.handoff) || "?";

  const srcRows = getRows(state.lines, found.key).map((r) => r.cells).filter((c) => c[0].trim() !== id);
  state.lines = setRows(state.lines, found.key, srcRows);

  const inprog = getRows(state.lines, "inprogress").map((r) => r.cells);
  inprog.push([id, epic, task, handoff]);
  state.lines = setRows(state.lines, "inprogress", inprog);
  return { id, epic, task, handoff };
}

function cmdQueue(state, argv) {
  const id = argv._[0];
  if (!id) throw new Error("queue: missing <id>.");
  const found = findRow(state.lines, id);
  if (!found) throw new Error(`queue: no row ${id} in BACKLOG.md.`);
  if (found.key === "queued") return { id, note: "already queued" };
  if (found.key !== "open") {
    const where = found.key === "inprogress" ? "In progress" : found.key === "frozen" ? "Frozen" : "Archived";
    throw new Error(`queue: ${id} is ${where} — only Open rows can be queued.`);
  }

  const cells = found.cells.slice(); // open cells: [id, p, epic, task, evidence]
  const srcRows = getRows(state.lines, "open").map((r) => r.cells).filter((c) => c[0].trim() !== id);
  state.lines = setRows(state.lines, "open", srcRows);

  const queuedRows = getRows(state.lines, "queued").map((r) => r.cells);
  state.lines = setRows(state.lines, "queued", insertOpen(queuedRows, cells));
  return { id, epic: cells[2], task: cells[3] };
}

/* unqueue <id> — Queued -> Open (return an allocated row to the triage pool,
 * e.g. re-triaging a row that was queued in error). The inverse of `queue`. */
function cmdUnqueue(state, argv) {
  const id = argv._[0];
  if (!id) throw new Error("unqueue: missing <id>.");
  const found = findRow(state.lines, id);
  if (!found) throw new Error(`unqueue: no row ${id} in BACKLOG.md.`);
  if (found.key === "open") return { id, note: "already Open" };
  if (found.key !== "queued") {
    const where = found.key === "inprogress" ? "In progress" : found.key === "frozen" ? "Frozen" : "Archived";
    throw new Error(`unqueue: ${id} is ${where} — only Queued rows can be returned to Open.`);
  }

  const cells = found.cells.slice(); // queued cells: [id, p, epic, task, evidence, dependsOn]
  const srcRows = getRows(state.lines, "queued").map((r) => r.cells).filter((c) => c[0].trim() !== id);
  state.lines = setRows(state.lines, "queued", srcRows);

  const openRows = getRows(state.lines, "open").map((r) => r.cells);
  state.lines = setRows(state.lines, "open", insertOpen(openRows, cells));
  return { id, priority: cells[1], task: cells[3] };
}

/* next [--take] — report the top-priority UNBLOCKED Queued row; with --take,
 * move it to In progress (the pick-then-go primitive behind /next). A queued row
 * whose "Depends on" IDs are not all archived is skipped (blocked). */
function cmdNext(state, argv) {
  const queued = getRows(state.lines, "queued").map((r) => r.cells);
  if (queued.length === 0) return { empty: true };

  const sorted = queued.slice().sort((a, b) => priorityRank(a[1]) - priorityRank(b[1]));
  let row = null;
  const blocked = [];
  for (const r of sorted) {
    if (blockedBy(state.lines, r, "queued").length) {
      blocked.push(r[0]);
      continue;
    }
    row = r;
    break;
  }
  if (!row) return { empty: true, blocked };

  const id = row[0];
  const priority = row[1];
  const epic = row[2] || "?";
  const task = row[3] || id;
  const evidence = row[4] || "?";
  if (!argv.take) return { id, priority, epic, task, evidence };

  const srcRows = queued.filter((c) => (c[0] || "").trim() !== id);
  state.lines = setRows(state.lines, "queued", srcRows);

  const handoff = validateHandoff(id, argv.handoff) || `.agents/handoffs/${id}.md`;
  const inprog = getRows(state.lines, "inprogress").map((r) => r.cells);
  inprog.push([id, epic, task, handoff]);
  state.lines = setRows(state.lines, "inprogress", inprog);
  return { id, epic, task, handoff };
}

/* A `worktree` row records its isolation target in the Handoff cell as
 * "<handoff> (worktree: <rel>; branch: <branch>)". Parse it back out so
 * `archive` can clean the worktree up when the feature ships. */
function parseWorktree(handoff) {
  if (!handoff) return null;
  const m = /\(worktree:\s*([^;]+);\s*branch:\s*([^)]+)\)/.exec(handoff);
  if (!m) return null;
  return { rel: m[1].trim(), branch: m[2].trim() };
}

/* Best-effort cleanup of a shipped feature's isolation: remove its worktree
 * checkout (the folder that would otherwise hang around) and, if the branch was
 * merged, delete it. Never blocks the board write — a dirty/locked worktree is
 * left in place with a warning rather than force-discarded (zero data loss). */
function cleanupWorktree(root, rel, branch) {
  const abs = path.resolve(root, rel);
  const notes = [];
  const rm = spawnSync("git", ["-C", root, "worktree", "remove", abs], { encoding: "utf8" });
  if (rm.status === 0) {
    notes.push(`removed worktree ${rel}`);
  } else {
    notes.push(`worktree ${rel} left in place (${(rm.stderr || rm.stdout || "not a worktree").trim()})`);
  }
  if (branch) {
    const del = spawnSync("git", ["-C", root, "branch", "-d", branch], { encoding: "utf8" });
    if (del.status === 0) notes.push(`deleted branch ${branch}`);
  }
  return notes;
}

function cmdArchive(state, argv) {
  const id = argv._[0];
  if (!id) throw new Error("archive: missing <id>.");
  const found = findRow(state.lines, id);
  if (!found) throw new Error(`archive: no row ${id} in BACKLOG.md.`);
  if (found.key === "archive") return { id, note: "already archived" };

  const task = taskOf(found.cells, found.key);
  const epic = epicOf(found.cells, found.key);
  const closed = argv.closed || "shipped";

  // A shipped feature no longer needs its isolated checkout: remove the worktree
  // (and merged branch) it recorded in its Handoff cell, so worktrees don't pile
  // up after each session.
  const wt = found.key === "inprogress" ? parseWorktree(found.cells[3]) : null;
  const cleanup = wt ? cleanupWorktree(path.dirname(state.p), wt.rel, wt.branch) : [];

  const srcRows = getRows(state.lines, found.key).map((r) => r.cells).filter((c) => c[0].trim() !== id);
  state.lines = setRows(state.lines, found.key, srcRows);

  const archiveRows = getRows(state.lines, "archive").map((r) => r.cells);
  archiveRows.push([id, epic, task, closed]);
  state.lines = setRows(state.lines, "archive", archiveRows);
  return { id, epic, task, closed, cleanup };
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

  const task = taskOf(found.cells, found.key);
  const epic = epicOf(found.cells, found.key);
  const cond = [why, reopen ? `reopen when ${reopen}` : ""].filter(Boolean).join(" — ");

  const srcRows = getRows(state.lines, found.key).map((r) => r.cells).filter((c) => c[0].trim() !== id);
  state.lines = setRows(state.lines, found.key, srcRows);

  const frozenRows = getRows(state.lines, "frozen").map((r) => r.cells);
  frozenRows.push([id, epic, task, cond]);
  state.lines = setRows(state.lines, "frozen", frozenRows);
  return { id, epic, task, cond };
}

function cmdPriority(state, argv) {
  const id = argv._[0];
  if (!id) throw new Error("priority: missing <id>.");
  const priority = (argv.p || "").toUpperCase();
  if (!(priority in PRIORITIES)) throw new Error(`priority: priority must be P1..P4 (got "${priority || "none"}").`);

  const found = findRow(state.lines, id);
  if (!found) throw new Error(`priority: no row ${id} in BACKLOG.md.`);
  if (found.key !== "open" && found.key !== "queued") {
    const where = found.key === "inprogress" ? "In progress" : found.key === "frozen" ? "Frozen" : "Archive";
    throw new Error(`priority: ${id} is ${where} — only Open/Queued rows have a priority.`);
  }

  const srcRows = getRows(state.lines, found.key).map((r) => r.cells).filter((c) => c[0].trim() !== id);
  const newRow = found.cells.slice();
  newRow[1] = priority;
  state.lines = setRows(state.lines, found.key, insertOpen(srcRows, newRow));
  return { id, priority };
}

/* depends <id> --on <ids|?> — set/clear a row's "Depends on" cell (Open/Queued). */
function cmdDepends(state, argv) {
  const id = argv._[0];
  if (!id) throw new Error("depends: missing <id>.");
  const on = (argv.on || "").trim();
  const found = findRow(state.lines, id);
  if (!found) throw new Error(`depends: no row ${id} in BACKLOG.md.`);
  if (found.key !== "open" && found.key !== "queued") {
    const where = found.key === "inprogress" ? "In progress" : found.key === "frozen" ? "Frozen" : "Archive";
    throw new Error(`depends: ${id} is ${where} — only Open/Queued rows carry dependencies.`);
  }
  const deps = on === "" || on === "?" ? [] : on.split(/[\s,]+/).filter(Boolean);
  const known = getAllIds(state.lines);
  for (const d of deps) {
    if (!known.has(d)) throw new Error(`depends: ${id} references unknown row ${d}.`);
  }
  const srcRows = getRows(state.lines, found.key).map((r) => r.cells).filter((c) => c[0].trim() !== id);
  const newRow = found.cells.slice();
  newRow[5] = on || "?";
  state.lines = setRows(state.lines, found.key, insertOpen(srcRows, newRow));
  return { id, dependsOn: on || "?" };
}

/* owns <id> --files "glob, glob" — record the files/globs a row owns in the
 * `.agents/memory/owned-files.md` registry (feeds `test:concurrency` overlap). */
function cmdOwns(state, argv) {
  const id = (argv._[0] || "").toUpperCase();
  if (!id) throw new Error("owns: missing <id>.");
  const files = (argv.files || "").trim();
  if (files === "") throw new Error('owns: provide --files "glob1, glob2" (or --files "?" to clear).');
  const found = findRow(state.lines, id);
  if (!found) throw new Error(`owns: no row ${id} in BACKLOG.md.`);
  const root = path.dirname(state.p);
  const reg = readOwnedRegistry(root);
  if (files === "?") reg.map.delete(id);
  else reg.map.set(id, files);
  writeOwnedRegistry(root, reg.map);
  return { id, files };
}

// ---------------------------------------------------------------- main checkout sync
/* The board is per-checkout: a feature committed + pushed from its own worktree
 * lands on `origin/main`, but the main checkout's checked-out BACKLOG.md stays
 * put until it is pulled — so the main tree shows a stale board and, worse, a
 * later local/auto-commit on that base diverges from origin. `worktree` and
 * `archive` run from the MAIN tree, so they sync it first: a clean, strictly-
 * behind branch is fast-forwarded; a diverged branch is reported and left alone.
 * Best-effort throughout — offline or no-upstream is a quiet no-op. */
function gitCmd(root, args, opts) {
  return spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    timeout: (opts && opts.timeout) || 0,
  });
}

function currentUpstream(root) {
  const r = gitCmd(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  return r.status === 0 ? (r.stdout || "").trim() : "";
}

function refreshMainCheckout(root, opts) {
  const notes = [];
  const inside = gitCmd(root, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0 || (inside.stdout || "").trim() !== "true") return notes;
  if (!opts || opts.fetch !== false) {
    gitCmd(root, ["fetch", "--quiet", "origin"], { timeout: 10000 });
  }
  const upstream = currentUpstream(root);
  if (!upstream) return notes;
  const counts = gitCmd(root, ["rev-list", "--left-right", "--count", `HEAD...${upstream}`]);
  if (counts.status !== 0) return notes;
  const [ahead, behind] = (counts.stdout || "").trim().split(/\s+/).map((n) => parseInt(n, 10) || 0);
  if (!behind) return notes;
  if (ahead) {
    notes.push(`main is ${behind} behind and ${ahead} ahead of ${upstream} — reconcile (git pull --rebase) before trusting this board`);
    return notes;
  }
  // Tracked modifications only: the live `.backlog.lock` DIRECTORY (and other
  // harness artifacts) are untracked and must not read as "dirty" mid-write.
  const dirty = gitCmd(root, ["status", "--porcelain", "--untracked-files=no"]);
  if ((dirty.stdout || "").trim()) {
    notes.push(`main is ${behind} behind ${upstream} — uncommitted changes present; not fast-forwarding`);
    return notes;
  }
  const ff = gitCmd(root, ["merge", "--ff-only", upstream]);
  if (ff.status === 0) notes.push(`fast-forwarded main to ${upstream} (${behind} commit(s))`);
  else notes.push(`main is ${behind} behind ${upstream} — could not fast-forward; reconcile manually`);
  return notes;
}

/* Run a project-supplied worktree bootstrap after `git worktree add`, so a fresh
 * checkout is immediately gate-runnable. The harness is project-agnostic, so the
 * setup is a CONVENTION script: `scripts/worktree-setup.js`, looked up in the new
 * worktree first and then in the main checkout (so it works before the script
 * itself is committed). It receives the worktree path as argv[2]. Best-effort:
 * a failure warns but never fails the board write. */
function runWorktreeSetup(mainRoot, dir) {
  const candidates = [
    path.join(dir, "scripts", "worktree-setup.js"),
    path.join(mainRoot, "scripts", "worktree-setup.js"),
  ];
  const script = candidates.find((p) => fs.existsSync(p));
  if (!script) return { ran: false };
  process.stdout.write(`worktree: running ${path.relative(mainRoot, script)} ${dir}\n`);
  const res = spawnSync(process.execPath, [script, dir], { cwd: dir, stdio: "inherit" });
  if (res.status !== 0) {
    process.stderr.write(
      `worktree: setup script exited ${res.status === null ? res.signal : res.status} — ` +
        `the worktree may need manual setup (F-183/F-228).\n`
    );
    return { ran: true, ok: false };
  }
  return { ran: true, ok: true };
}

/* Create an isolated `git worktree` + branch for a feature, then record the
 * worktree path + branch in the row's Handoff cell so the board shows WHERE the
 * work happens (and `test:concurrency` can see active sessions are isolated).
 * Run from the MAIN tree: a worktree's BACKLOG.md is only a snapshot. */
function cmdWorktree(state, argv) {
  const id = argv._[0];
  if (!id) throw new Error("worktree: missing <id>.");
  const root = path.dirname(state.p);
  const slug = id.toLowerCase();
  const branch = argv.branch || slug;
  const dir = argv.dir
    ? path.resolve(argv.dir)
    : path.resolve(root, "..", ".worktrees", path.basename(root), slug);

  const found = findRow(state.lines, id);
  if (!found) throw new Error(`worktree: no row ${id} in BACKLOG.md.`);
  if (found.key === "archive") throw new Error(`worktree: ${id} is archived.`);
  if (found.key === "frozen") throw new Error(`worktree: ${id} is Frozen — unfreeze it first.`);

  if (found.key === "open" || found.key === "queued") {
    const blockers = blockedBy(state.lines, found.cells, found.key);
    if (blockers.length) {
      throw new Error(`worktree: ${id} is blocked — depends on ${blockers.join(", ")} (not yet archived).`);
    }
  }

  // Ensure the row is In progress (auto-take if Open/Queued).
  const claimed = argv.handoff !== undefined ? validateHandoff(id, argv.handoff) : "";
  let handoff = claimed || `.agents/handoffs/${id}.md`;
  if (found.key === "open" || found.key === "queued") {
    const task = taskOf(found.cells, found.key) || id;
    const epic = epicOf(found.cells, found.key);
    const srcRows = getRows(state.lines, found.key).map((r) => r.cells).filter((c) => c[0].trim() !== id);
    state.lines = setRows(state.lines, found.key, srcRows);
    const inprog = getRows(state.lines, "inprogress").map((r) => r.cells);
    inprog.push([id, epic, task, handoff]);
    state.lines = setRows(state.lines, "inprogress", inprog);
  } else {
    const existing = found.key === "inprogress" ? (found.cells[3] || "").split(/\s*[|(]/)[0].trim() : "";
    handoff = claimed || existing || `.agents/handoffs/${id}.md`;
  }

  // Create the worktree + branch from the CURRENT upstream (`origin/main`), not
  // a possibly-stale local HEAD left behind by another feature's worktree push.
  // `--no-track` keeps the feature branch from silently tracking main (so a bare
  // `git push` in the worktree can't target main).
  const base = currentUpstream(root) || "HEAD";
  const res = spawnSync("git", ["-C", root, "worktree", "add", "--no-track", "-b", branch, dir, base], {
    encoding: "utf8",
  });
  if (res.status !== 0) {
    const err = (res.stderr || res.stdout || "").trim();
    throw new Error(`worktree: git worktree add failed: ${err}`);
  }

  // Bootstrap the fresh checkout (node_modules / generated client / .env / hooks).
  runWorktreeSetup(root, dir);

  // Record the isolation target in the Handoff cell.
  const rel = path.relative(root, dir) || dir;
  const handoffCell = `${handoff} (worktree: ${rel}; branch: ${branch})`;
  const inprog = getRows(state.lines, "inprogress").map((r) => r.cells);
  const idx = inprog.findIndex((c) => (c[0] || "").trim() === id);
  if (idx !== -1) {
    inprog[idx] = [id, inprog[idx][1], inprog[idx][2], handoffCell];
    state.lines = setRows(state.lines, "inprogress", inprog);
  }

  return { id, branch, dir: rel, base };
}

// ---------------------------------------------------------------- dispatch

function formatResult(cmd, out) {
  if (cmd === "add") return `added ${out.id} [${out.priority}] ${out.task}`;
  if (cmd === "take") return out.note ? `${out.id}: ${out.note}` : `took ${out.id} -> In progress (${out.handoff})`;
  if (cmd === "queue") return out.note ? `${out.id}: ${out.note}` : `queued ${out.id} (${out.task})`;
  if (cmd === "unqueue") return out.note ? `${out.id}: ${out.note}` : `unqueued ${out.id} -> Open (${out.task})`;
  if (cmd === "next") {
    if (out.empty && out.blocked) return `next: all queued rows are blocked (${out.blocked.join(", ")})`;
    if (out.empty) return "no queued rows";
    return out.handoff ? `next -> took ${out.id} (${out.handoff})` : `next: ${out.id} [${out.priority}] ${out.task}`;
  }
  if (cmd === "archive") {
    const base = out.note ? `${out.id}: ${out.note}` : `archived ${out.id} (${out.closed})`;
    return out.cleanup && out.cleanup.length ? `${base} — ${out.cleanup.join("; ")}` : base;
  }
  if (cmd === "freeze") return out.note ? `${out.id}: ${out.note}` : `froze ${out.id} (${out.cond})`;
  if (cmd === "priority") return `set ${out.id} -> ${out.priority}`;
  if (cmd === "depends") return `set ${out.id} -> depends on ${out.dependsOn}`;
  if (cmd === "owns") return `recorded ${out.id} owns: ${out.files}`;
  if (cmd === "worktree")
    return `isolated ${out.id} -> worktree: ${out.dir} (branch: ${out.branch}${out.base && out.base !== "HEAD" ? `; base: ${out.base}` : ""})`;
  if (cmd === "epic-add") return `added epic ${out.key} (${out.label})`;
  if (cmd === "epic") return `set ${out.id} -> ${out.epic}`;
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
    else if (a === "--branch") args.branch = argv[++i];
    else if (a === "--dir") args.dir = argv[++i];
    else if (a === "--epic") args.epic = argv[++i];
    else if (a === "--to") args.to = argv[++i];
    else if (a === "--label") args.label = argv[++i];
    else if (a === "--goal") args.goal = argv[++i];
    else if (a === "--depends-on" || a === "--depends") args["depends-on"] = argv[++i];
    else if (a === "--on") args.on = argv[++i];
    else if (a === "--files") args.files = argv[++i];
    else if (a === "--take") args.take = true;
    else if (a === "--no-fetch") args["no-fetch"] = true;
    else if (a === "--all") args.all = true;
    else if (a === "--full") args.full = true;
    else if (a === "--limit") args.limit = argv[++i];
    else if (a === "--json") args.json = true;
    else if (a === "--root") args.root = argv[++i];
    else args._.push(a);
  }
  return args;
}

function usage() {
  console.log(
    "backlog — deterministic BACKLOG.md editor (no LLM)\n\n" +
      "  node scripts/backlog.js list [--all] [--full] [--limit N] [--json]\n" +
      "  node scripts/backlog.js add <task> [--p P1..P4] [--epic key] [--evidence x] [--id F-xxx] [--depends-on ids]\n" +
      "  node scripts/backlog.js take <id> [--handoff path]\n" +
      "  node scripts/backlog.js queue <id>\n" +
      "  node scripts/backlog.js unqueue <id>\n" +
      "  node scripts/backlog.js next [--take] [--handoff path]\n" +
      "  node scripts/backlog.js archive <id> [--closed note]\n" +
      "  node scripts/backlog.js freeze <id> [--why x] [--reopen x]\n" +
      "  node scripts/backlog.js priority <id> --p P1..P4\n" +
      "  node scripts/backlog.js depends <id> --on <ids|?>\n" +
      "  node scripts/backlog.js owns <id> --files \"glob, glob\"\n" +
      "  node scripts/backlog.js worktree <id> [--branch b] [--dir d] [--handoff path] [--no-fetch]\n" +
      "  node scripts/backlog.js epic-add <key> --label <x> [--goal <y>]\n" +
      "  node scripts/backlog.js epic <id> --to <key>\n"
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

  // Read-only commands never touch the board — no lock, no write.
  if (cmd === "list") {
    const state = readBacklog(root);
    if (args.json) {
      console.log(JSON.stringify(toBoardJson(state), null, 2));
    } else {
      cmdList(state, args);
    }
    return;
  }
  if (cmd === "next" && !args.take) {
    const state = readBacklog(root);
    console.log(formatResult("next", cmdNext(state, args)));
    return;
  }

  // Mutating commands read-modify-write BACKLOG.md (or owned-files.md) under an
  // exclusive lock, so two concurrent sessions can't both claim the same row.
  try {
    withLock(root, () => {
      // `worktree`/`archive` run from the main tree and depend on its board being
      // current; a feature pushed from its own worktree leaves it behind. Sync it
      // first (fast-forward when clean and strictly behind), then read the board.
      let refreshNotes = [];
      if (cmd === "worktree" || cmd === "archive") {
        refreshNotes = refreshMainCheckout(root, { fetch: !args["no-fetch"] });
      }
      const state = readBacklog(root);
      let out;
      if (cmd === "add") out = cmdAdd(state, args);
      else if (cmd === "take") out = cmdTake(state, args);
      else if (cmd === "queue") out = cmdQueue(state, args);
      else if (cmd === "unqueue") out = cmdUnqueue(state, args);
      else if (cmd === "next") out = cmdNext(state, args);
      else if (cmd === "archive") out = cmdArchive(state, args);
      else if (cmd === "freeze") out = cmdFreeze(state, args);
      else if (cmd === "priority") out = cmdPriority(state, args);
      else if (cmd === "depends") out = cmdDepends(state, args);
      else if (cmd === "owns") out = cmdOwns(state, args);
      else if (cmd === "worktree") out = cmdWorktree(state, args);
      else if (cmd === "epic-add") out = cmdEpicAdd(state, args);
      else if (cmd === "epic") out = cmdEpic(state, args);
      else {
        usage();
        process.exitCode = 1;
        return;
      }
      if (cmd === "owns") {
        console.log(formatResult(cmd, out));
      } else {
        fs.writeFileSync(state.p, serializeBacklog(state), "utf8");
        console.log(formatResult(cmd, out));
      }
      for (const note of refreshNotes) console.log(`board: ${note}`);
    });
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
  cmdQueue,
  cmdUnqueue,
  cmdNext,
  cmdArchive,
  cmdFreeze,
  cmdPriority,
  cmdDepends,
  cmdOwns,
  cmdWorktree,
  cmdEpicAdd,
  cmdEpic,
  readEpics,
  toBoardJson,
  withLock,
};
