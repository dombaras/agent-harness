#!/usr/bin/env node
"use strict";
/*
 * backlog — deterministic BACKLOG.md editor (no LLM).
 *
 * The canonical task list is `BACKLOG.md` at the repo root. This script reads
 * and mutates it directly, so humans and agents can accumulate / review /
 * delegate work without a model round-trip. It is the single implementation
 * behind the opencode custom tools (`.opencode/plugins/backlog.ts`) and the human
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
 *   worktree <id> [--branch b] [--dir d] [--handoff path] [--no-fetch] [--open]
 *                                       create a git worktree + branch for <id>
 *                                       and record it in the row's Handoff cell.
 *                                       Branches from the current upstream
 *                                       (origin/main), not a stale local HEAD.
 *                                       Default location: <repo>/../.worktrees/<repo>/<id>
 *                                       (a single container sibling, so one worktree
 *                                       per feature never pollutes the parent folder).
 *                                       --open launches the agent CLI in the new
 *                                       worktree after the board is written (so
 *                                       the session's lease + gates scope there).
 *
 * Every mutation writes well-formed rows that `npm run test:backlog` accepts:
 * priority P1..P4, non-empty evidence/handoff/reopen, unique IDs, and
 * `Depends on` cells that reference existing rows.
 *
 * `worktree` is the harness's isolation primitive: concurrent sessions should
 * each claim a separate `git worktree` + branch so one session's uncommitted
 * work can never leak into another's pre-push gate (`test:concurrency` fails a
 * push when that collision is provable). Run it from the MAIN tree — or with
 * `--open`, which also launches the agent CLI in the new worktree so the session
 * is root-scoped there and never writes a `main` lease. `archive` reverses it: a
 * shipped feature's worktree + merged branch are removed, so per-feature
 * checkouts never pile up after sessions close.
 *
 * Because a feature's commits reach `origin/main` from its own worktree, the
 * MAIN checkout's board can lag origin until it is pulled. Every mutating command
 * in the MAIN checkout is therefore a transaction (`qa/board-sync.js`): reconcile
 * the working board against `origin/main` row-aware (an archived-upstream row
 * wins over a stale local take; local-only rows survive), apply the change, then
 * commit + fast-forward push it. Main never carries an uncommitted board copy,
 * so it cannot resurrect a shipped row. A linked feature worktree is CODE
 * isolation only: every board read/write resolves to the MAIN checkout's board
 * (or the shared service), so a row filed mid-feature can never land in a
 * private worktree copy. `--no-fetch` skips the network step for offline use; an
 * offline edit is committed locally and published by `sync`.
 * `--defer` (used by the superadmin API) commits the board locally but skips the
 * network push entirely, so a request path never blocks on fetch/push; a later
 * `sync` (the API schedules it in the background) converges and publishes.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { splitCells, isSep, formatRow, findCycle } = require("./qa/board-lib.js");
const leases = require("./qa/lease-lib.js");
const boardSync = require("./qa/board-sync.js");
const boardClient = require("./qa/board-client.js");

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

/* Walk up from `startDir` to the project root. ADR 0001: the board no longer
 * lives in a BACKLOG.md, so when the service is configured the root is the
 * nearest directory with a `.harness.json` (or, failing that, the git
 * toplevel); the legacy file board still anchors on BACKLOG.md. */
function findRoot(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(dir, "BACKLOG.md"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // No BACKLOG.md anywhere up the tree — resolve a service-backed root.
  dir = path.resolve(startDir || process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(dir, ".harness.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const top = require("child_process").spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: path.resolve(startDir || process.cwd()),
    encoding: "utf8",
  });
  if (top.status === 0 && (top.stdout || "").trim()) return (top.stdout || "").trim();
  return null;
}

/* The canonical board root. ADR 0001 gives the board ONE home per project: the
 * shared service when declared, else the MAIN checkout's BACKLOG.md. A linked
 * feature worktree isolates CODE, not the board — resolving board reads and
 * writes to the main checkout means a row filed mid-feature (e.g. a security
 * finding) can never land in a private worktree copy that main's board never
 * sees.
 *
 * `archive` is the deliberate exception in legacy file mode: `finalize` archives
 * from inside the feature worktree BEFORE the branch lands, and the archive must
 * travel with that branch so a failed ship does not mark unlanded work done on
 * main. The branch commit (and `ship`) carries it. In service mode there is no
 * checkout-local board, so the service is used either way.
 *
 * An explicit `--root` names a local checkout for migration/tests and is left
 * untouched (F-333/F-338). */
function resolveBoardRoot(root, opts) {
  if (!root || (opts && opts.explicitRoot)) return root;
  if (opts && opts.cmd === "archive") return root;
  const main = boardSync.mainWorktreeRoot(root);
  if (main && path.resolve(main) !== path.resolve(root) && fs.existsSync(main)) return path.resolve(main);
  return root;
}

function readBacklog(root) {
  const p = path.join(root, "BACKLOG.md");
  if (!fs.existsSync(p)) {
    throw new Error("BACKLOG.md not found (repo root) — run `npx opencode-agent-harness init` first.");
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

/* Member-report provenance survives the row lifecycle. `reports:sync` stamps an
 * imported report with `source member-report <uuid>` in the Open row's Evidence
 * cell, and both the sync dedup and the superadmin pending notice scan the board
 * for that marker across every section. The In progress / Frozen / Archive
 * sections have no Evidence column, so a marker living only in Evidence would be
 * dropped the moment a report is taken or archived — the handled report then
 * looks pending again (F-276) and the next sync re-imports it as a duplicate.
 * These helpers carry the marker(s) into the destination's free-form cell
 * (Handoff / condition / closed) so provenance is never lost. */
const REPORT_MARKER_PATTERN = /source member-report\s+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function reportMarkersInCells(cells) {
  const found = [];
  for (const cell of cells) {
    const matches = String(cell || "").match(REPORT_MARKER_PATTERN);
    if (matches) for (const m of matches) found.push(m.replace(/\s+/g, " ").toLowerCase());
  }
  return [...new Set(found)];
}

/* Append any markers not already present to a free-form destination note. */
function appendReportMarkers(note, markers) {
  const base = (note || "").trim();
  const haystack = base.toLowerCase();
  const missing = markers.filter((m) => !haystack.includes(m));
  if (!missing.length) return base;
  return [base, ...missing].filter(Boolean).join(" | ");
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

/* The dependency graph over Open/Queued rows: id -> [ids it depends on]. */
function dependencyGraph(lines) {
  const graph = new Map();
  for (const key of ["open", "queued"]) {
    for (const r of getRows(lines, key)) {
      const id = (r.cells[0] || "").trim();
      if (!id) continue;
      const dep = dependsOf(r.cells, key);
      graph.set(id, !dep || dep === "?" ? [] : dep.split(/[\s,]+/).filter(Boolean));
    }
  }
  return graph;
}

/* Reject a mutation that would introduce a dependency cycle. `extra` is the
 * row being (re)written: { id, deps }. The DFS lives in board-lib.js so the
 * write path and `test:backlog` share one implementation. */
function assertNoCycle(lines, extra) {
  const graph = dependencyGraph(lines);
  if (extra) graph.set(extra.id, extra.deps);
  const cycle = findCycle(graph);
  if (cycle) {
    throw new Error(
      `dependency cycle: ${cycle.join(" -> ")} — a cycle leaves every row in it permanently blocked.`
    );
  }
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
  const deps = dependsOn.split(/[\s,]+/).filter(Boolean).filter((d) => d !== "?");
  for (const d of deps) {
    if (!known.has(d)) throw new Error(`add: depends on unknown row ${d}.`);
  }
  const id = argv.id || nextId(state.lines);
  if (getAllIds(state.lines).has(id)) throw new Error(`add: duplicate ID ${id}.`);
  assertNoCycle(state.lines, { id, deps });

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
  const handoff = appendReportMarkers(
    validateHandoff(id, argv.handoff) || "?",
    reportMarkersInCells(found.cells)
  );

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

/* A session that creates its worktree mid-session keeps `context.worktree`
 * pinned to the MAIN tree (`context.worktree` is fixed at launch), so the
 * `backlog_*` tools would keep writing the board to main while the feature lives
 * in the worktree. When the calling tool forwards its session id
 * (`HARNESS_SESSION_ID`), `worktree` records the target under the gitignored
 * `.serve/sessions/` container and `archive` clears it; the tools read it back
 * and root board/handoff/telemetry ops in the worktree. */
function sessionWorktreeFile(root, sessionID) {
  return leases.worktreeFile(root, sessionID);
}

/* The parent pid of `pid` from `/proc/<pid>/stat` (field 4). Parsing past the
 * final `)` avoids a comm containing spaces/parens. Linux/WSL only; returns null
 * elsewhere so the ancestry probe degrades to "no session". */
function parentPid(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close === -1) return null;
    const ppid = Number(stat.slice(close + 2).trim().split(/\s+/)[1]);
    return Number.isInteger(ppid) && ppid > 1 ? ppid : null;
  } catch {
    return null;
  }
}

/* The session that owns this process. A tool call forwards HARNESS_SESSION_ID;
 * the documented bash invocation (`node scripts/backlog.js worktree <id>`) does
 * NOT, so walk the process ancestry to the live lease that owns this shell. The
 * context-guard plugin heartbeats the lease on the `tool.execute.before` of the
 * very bash call that runs this, so it is live and its pid is an ancestor.
 * Without this the mid-session reroot never happens and later tools
 * (`checkpoint_write`) keep writing to the main tree — the F-246 stray handoff. */
function ancestorSessionId(root) {
  const env = process.env.HARNESS_SESSION_ID;
  if (env) return env;
  return leaseAncestorIn(root);
}

/* A live lease under `root` whose pid is this process or an ancestor — i.e. this
 * process is running INSIDE that session's tree. Unlike `ancestorSessionId` this
 * ignores HARNESS_SESSION_ID (which names a session, not a directory), so it can
 * answer "is this specific checkout a session's root?" — the `--open` guard in
 * `cmdWorktreePrune`. */
function leaseAncestorIn(root) {
  let live;
  try {
    live = leases.liveLeases(root);
  } catch {
    return "";
  }
  const byPid = new Map(
    live.filter((r) => typeof r.pid === "number" && r.sessionID).map((r) => [r.pid, r.sessionID])
  );
  if (byPid.size === 0) return "";
  let pid = process.pid;
  for (let i = 0; i < 64 && pid > 1; i++) {
    if (byPid.has(pid)) return byPid.get(pid);
    const next = parentPid(pid);
    if (!next || next === pid) break;
    pid = next;
  }
  return "";
}

function readSessionWorktree(root, sessionID) {
  return leases.readWorktree(root, sessionID);
}

function writeSessionWorktree(root, sessionID, dir) {
  leases.writeWorktree(root, sessionID, dir);
}

function clearSessionWorktree(root, sessionID, onlyDir) {
  leases.clearWorktree(root, sessionID, onlyDir);
}

/* Worktree checkouts a LIVE session still owns, from the `.serve/sessions/
 * <id>.worktree` pointers (written by `worktree`, cleared when that worktree is
 * removed). `worktree-prune` must never remove one of these: a session can be
 * mid-`ship`, watching CI from that very checkout, and deleting it blinds the
 * watch — every `gh` spawn fails on the dead cwd, so a green run looks like a
 * 20-minute timeout and the session is left believing CI is unconfirmed (F-252).
 * A pointer whose lease is stale/dead is ignored, so abandoned worktrees still
 * converge. `worktree-prune --self` lifts this guard for the caller's OWN
 * finished worktree only (see `cmdWorktreePrune`); a foreign session pruning
 * concurrently has no such authorization and still sees the owner's pointer
 * (F-252). */
function liveSessionWorktreeDirs(root) {
  const dirs = new Set();
  let live;
  try {
    live = leases.liveLeases(root);
  } catch {
    return dirs;
  }
  for (const rec of live) {
    const sid = rec.sessionID || (rec.name && rec.name.replace(/\.json$/, ""));
    if (!sid) continue;
    const dir = readSessionWorktree(root, sid);
    if (dir) dirs.add(path.resolve(dir));
  }
  return dirs;
}

/* Best-effort cleanup of a shipped feature's isolation: remove its worktree
 * checkout (the folder that would otherwise hang around) and, if the branch was
 * merged, delete it. Never blocks the board write — a dirty/locked worktree is
 * left in place with a warning rather than force-discarded (zero data loss), and
 * a worktree the archiving session is standing in is never yanked out from under
 * it. */
function cleanupWorktree(root, rel, branch, opts) {
  const abs = path.resolve(root, rel);
  const notes = [];
  const skipRemove = !!(opts && opts.skipRemove);
  if (skipRemove) {
    notes.push(
      `worktree ${rel} left in place (in use by this session) — remove it from the main tree: git worktree remove ${rel}`
    );
  } else {
    const rm = spawnSync("git", ["-C", root, "worktree", "remove", abs], { encoding: "utf8" });
    if (rm.status === 0) {
      notes.push(`removed worktree ${rel}`);
    } else {
      notes.push(`worktree ${rel} left in place (${(rm.stderr || rm.stdout || "not a worktree").trim()})`);
    }
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
  if (found.key === "archive") {
    // Idempotent repair path: an already-archived row is normally a no-op, but a
    // caller supplying `--closed` may rewrite its closed note (used to backfill
    // provenance, e.g. a member-report marker dropped before this preservation
    // existed — F-276). Markers already on the row are kept.
    if (!argv.closed) return { id, note: "already archived" };
    const repaired = appendReportMarkers(argv.closed, reportMarkersInCells(found.cells));
    const rows = getRows(state.lines, "archive").map((r) => r.cells);
    const idx = rows.findIndex((c) => (c[0] || "").trim() === id);
    rows[idx] = [id, epicOf(found.cells, found.key), taskOf(found.cells, found.key), repaired];
    state.lines = setRows(state.lines, "archive", rows);
    return { id, note: "already archived", closed: repaired };
  }

  const task = taskOf(found.cells, found.key);
  const epic = epicOf(found.cells, found.key);
  const closed = appendReportMarkers(argv.closed || "shipped", reportMarkersInCells(found.cells));

  // A shipped feature no longer needs its isolated checkout: remove the worktree
  // (and merged branch) it recorded in its Handoff cell, so worktrees don't pile
  // up after each session. Never remove a worktree the archiving process is
  // inside (that would delete the running session's cwd), and clear the session
  // pointer from BOTH the launch tree and the worktree it points at (the pointer
  // was written by whichever tree `backlog worktree` ran in).
  const wt = found.key === "inprogress" ? parseWorktree(found.cells[3]) : null;
  let cleanup = [];
  if (wt) {
    const cur = path.dirname(state.p);
    const wtAbs = path.resolve(cur, wt.rel);
    const cwd = process.cwd();
    const inside = cwd === wtAbs || cwd.startsWith(wtAbs + path.sep);
    cleanup = cleanupWorktree(cur, wt.rel, wt.branch, { skipRemove: inside });
    // Drop the session pointer ONLY once we are no longer standing in the
    // worktree. `finalize` archives from inside the feature checkout and only
    // THEN runs `ship` (which watches CI from it); clearing the pointer here
    // would make the still-live worktree look abandoned, so a concurrent
    // `worktree-prune` could delete it out from under the CI watch (F-252).
    // When archive runs from the main tree the checkout is being removed, so
    // clearing is safe.
    if (!inside) {
      const sid = process.env.HARNESS_SESSION_ID;
      clearSessionWorktree(cur, sid, wtAbs);
      const main = mainWorktreeRoot(cur);
      if (main && path.resolve(main) !== path.resolve(cur)) clearSessionWorktree(main, sid, wtAbs);
    }
  }

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
  const cond = appendReportMarkers(
    [why, reopen ? `reopen when ${reopen}` : ""].filter(Boolean).join(" — "),
    reportMarkersInCells(found.cells)
  );

  const srcRows = getRows(state.lines, found.key).map((r) => r.cells).filter((c) => c[0].trim() !== id);
  state.lines = setRows(state.lines, found.key, srcRows);

  const frozenRows = getRows(state.lines, "frozen").map((r) => r.cells);
  frozenRows.push([id, epic, task, cond]);
  state.lines = setRows(state.lines, "frozen", frozenRows);
  return { id, epic, task, cond };
}

/* reopen <id> [--reason x] [--p P1..P4] — Archive/Frozen -> Open, preserving the
 * row's ID and Task cell. This is the convergence half of the nightly E2E loop:
 * a nightly run reopens a shipped fix whose journey still fails, so the same row
 * (and its `[nightly:flow=<journey>]` Task marker) is worked again the next day
 * instead of a duplicate being filed. The default priority is P2 (an unresolved
 * regression outranks routine open work); the existing member-report provenance
 * markers are carried into the Open row's Evidence cell so they are not lost. */
function cmdReopen(state, argv) {
  const id = argv._[0];
  if (!id) throw new Error("reopen: missing <id>.");
  const priority = (argv.p || "P2").toUpperCase();
  if (!(priority in PRIORITIES)) throw new Error(`reopen: priority must be P1..P4 (got "${priority}").`);
  const found = findRow(state.lines, id);
  if (!found) throw new Error(`reopen: no row ${id} in BACKLOG.md.`);
  if (found.key === "open") return { id, note: "already Open" };
  if (found.key === "queued" || found.key === "inprogress") {
    const where = found.key === "inprogress" ? "In progress" : "Queued";
    throw new Error(`reopen: ${id} is ${where} — only Archive/Frozen rows are reopened.`);
  }

  const task = taskOf(found.cells, found.key) || id;
  const epic = epicOf(found.cells, found.key);
  const reason = appendReportMarkers(argv.reason || "reopened", reportMarkersInCells(found.cells));

  const srcRows = getRows(state.lines, found.key).map((r) => r.cells).filter((c) => c[0].trim() !== id);
  state.lines = setRows(state.lines, found.key, srcRows);

  const openRows = getRows(state.lines, "open").map((r) => r.cells);
  state.lines = setRows(state.lines, "open", insertOpen(openRows, [id, priority, epic, task, reason, "?"]));
  return { id, priority, epic, task, reason };
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
  assertNoCycle(state.lines, { id, deps });
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
 * later local/auto-commit on that base diverges from origin. The shared
 * board-sync module owns the git-facing logic (classify dirty files, row-aware
 * reconcile, converge, publish); these thin wrappers root it in backlog.js.
 * Only the MAIN checkout is authoritative. `resolveBoardRoot` reroutes a linked
 * feature worktree's board commands there before this code runs, so a worktree
 * never carries a mutable board snapshot. */
function gitCmd(root, args, opts) {
  return boardSync.gitCmd(root, args, opts);
}

function currentUpstream(root) {
  return boardSync.currentUpstream(root);
}

/* The MAIN worktree's path, or null. Used to clear a session's `.worktree`
 * pointer from the tree the pointer was actually written in — a linked feature
 * worktree's git dir cannot see the main tree's `.serve/`. */
function mainWorktreeRoot(root) {
  return boardSync.mainWorktreeRoot(root);
}

/* Sync the canonical checkout before a board read/mutation, returning the notes
 * to print. Best-effort: offline or no-upstream is a quiet no-op, and a linked
 * worktree is skipped. Unlike the old dirty-only reconcile, redundant non-board
 * dirt is cleared and genuine local changes fail the caller closed (see
 * `convergeCanonical`) instead of leaving main silently stale. */
function refreshMainCheckout(root, opts) {
  const notes = [];
  const inside = gitCmd(root, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0 || (inside.stdout || "").trim() !== "true") return notes;
  if (!boardSync.isCanonicalCheckout(root)) return notes;
  const upstream = currentUpstream(root);
  if (!upstream) return notes;
  return boardSync.convergeCanonical(root, upstream, { fetch: !opts || opts.fetch !== false }).notes;
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

/* Plan the board half of `worktree`: validate, ensure the row is In progress,
 * and record the isolation target in its Handoff cell. Split from the filesystem
 * half (`cmdWorktreeApply`) so the canonical transaction can PUBLISH the take
 * before the worktree is created — the new checkout is then based on an
 * `origin/main` that already carries the In-progress row, so the feature's
 * finalize/archive rebases without a same-row conflict. Run from the MAIN tree:
 * a worktree's BACKLOG.md is only a snapshot. */
function cmdWorktreePlan(state, argv) {
  const id = argv._[0];
  if (!id) throw new Error("worktree: missing <id>.");
  const root = path.dirname(state.p);
  const slug = id.toLowerCase();
  const branch = argv.branch || slug;
  const dir = argv.dir
    ? path.resolve(argv.dir)
    : path.resolve(root, "..", ".worktrees", path.basename(root), slug);

  // A worktree inside the repository pollutes `git status` (the nested
  // `.worktrees/` shows as untracked in every session) and confuses the
  // board/landing gates. Guard it even though the default is outside (a
  // mis-resolved root once left `<repo>/.worktrees/<repo>/f-301` behind).
  const rootAbs = path.resolve(root);
  if (dir === rootAbs || dir.startsWith(rootAbs + path.sep)) {
    throw new Error(
      `worktree: refusing a worktree inside the repository (${dir}). ` +
        `Use the default ../.worktrees/${path.basename(rootAbs)}/${slug} or a --dir outside the repo.`
    );
  }

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

  // Record the isolation target in the Handoff cell.
  const rel = path.relative(root, dir) || dir;
  const handoffCell = appendReportMarkers(
    `${handoff} (worktree: ${rel}; branch: ${branch})`,
    reportMarkersInCells(found.cells)
  );
  const inprog = getRows(state.lines, "inprogress").map((r) => r.cells);
  const idx = inprog.findIndex((c) => (c[0] || "").trim() === id);
  if (idx !== -1) {
    inprog[idx] = [id, inprog[idx][1], inprog[idx][2], handoffCell];
    state.lines = setRows(state.lines, "inprogress", inprog);
  }

  return { id, branch, dir: rel, dirAbs: dir, handoff };
}

/* Create the isolated `git worktree` + branch for a planned row. Runs AFTER the
 * canonical transaction publishes the take, so it is based on the CURRENT
 * upstream (`origin/main`), not a stale local HEAD. `--no-track` keeps the
 * feature branch from silently tracking main (a bare `git push` in the worktree
 * can't target main). */
function cmdWorktreeApply(root, plan) {
  const base = currentUpstream(root) || "HEAD";
  const res = spawnSync("git", ["-C", root, "worktree", "add", "--no-track", "-b", plan.branch, plan.dirAbs, base], {
    encoding: "utf8",
  });
  if (res.status !== 0) {
    const err = (res.stderr || res.stdout || "").trim();
    throw new Error(`worktree: git worktree add failed: ${err}`);
  }

  // Bootstrap the fresh checkout (node_modules / generated client / .env / hooks).
  runWorktreeSetup(root, plan.dirAbs);

  // Root this session's tool calls in the worktree even though opencode's
  // `context.worktree` stays pinned to the main tree it launched in. A bash
  // invocation carries no HARNESS_SESSION_ID, so fall back to the live lease
  // that owns this shell (see ancestorSessionId).
  const sessionID = ancestorSessionId(root);
  writeSessionWorktree(root, sessionID, plan.dirAbs);
  if (!sessionID) {
    console.warn(
      "worktree: could not attribute this worktree to the calling session (no HARNESS_SESSION_ID, no live lease ancestor) —\n" +
        "          later tool calls (e.g. checkpoint_write) will keep acting on the MAIN tree. Re-run via the `backlog_worktree`\n" +
        "          tool, or create it with --open so the session is rooted in the worktree."
    );
  }

  return { ...plan, base };
}

/* Backward-compatible wrapper: plan + apply in one call (used by direct
 * callers/tests; the CLI splits them around the board publish). */
function cmdWorktree(state, argv) {
  return cmdWorktreeApply(path.dirname(state.p), cmdWorktreePlan(state, argv));
}

/* `worktree --open` makes the new worktree the session root: launch the agent
 * CLI with its cwd set to the worktree, so the context-guard plugin's lease
 * lands in the worktree's `.serve/sessions/` (not main's) and `test:concurrency`
 * sees one session per checkout. Runs AFTER the board lock is released — the
 * launched session can be long-lived, and holding the lock would freeze the
 * board. Override the binary with `--open-cmd` or `HARNESS_OPEN_CMD` (tests). */
function openWorktreeSession(dir, command) {
  const bin = command || process.env.HARNESS_OPEN_CMD || "opencode";
  const label = path.basename(dir);
  process.stdout.write(`worktree: opening ${bin} in ${dir} (session root = ${label})\n`);
  const res = spawnSync(bin, { cwd: dir, stdio: "inherit", shell: true, encoding: "utf8" });
  if (res.error) {
    process.stderr.write(`worktree: could not launch ${bin}: ${res.error.message}\n`);
    process.exitCode = 1;
  }
  return res.status === null ? 1 : res.status;
}

/* `worktree-prune` — converge the worktree set: remove every linked worktree
 * (outside the main tree) whose branch is already merged into the current
 * upstream AND whose checkout is clean, then delete the merged branch and clear
 * any session pointer that referenced it. Worktrees with uncommitted work or an
 * unmerged branch are reported and left alone (zero data loss). This is the
 * convergence path for worktrees whose session ended without an `archive`
 * (archive only cleans the row it ships).
 *
 * Named branches (`worktree-prune <branch...>`) are pruned explicitly: this is
 * the escape hatch for SQUASH merges, whose commits are not ancestors of the
 * upstream, so `git branch --merged` can never classify them as merged even
 * though the content is fully landed. Explicit names still require a clean
 * checkout and never touch the main tree. */
function cmdWorktreePrune(state, argv) {
  const root = path.dirname(state.p);
  const notes = [];
  const explicit = new Set((argv._ || []).map((s) => String(s).trim()).filter(Boolean));
  const inside = gitCmd(root, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0) return { notes: ["not a git repo — nothing to prune"] };
  const list = gitCmd(root, ["worktree", "list", "--porcelain"]);
  if (list.status !== 0) return { notes: ["could not list worktrees"] };

  const entries = [];
  let cur = null;
  for (const line of (list.stdout || "").split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice("worktree ".length).trim(), branch: "" };
      entries.push(cur);
    } else if (cur && line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).replace(/^branch\s+/, "").replace(/^refs\/heads\//, "").trim();
    }
  }
  const main = mainWorktreeRoot(root) || root;
  const upstream = argv["no-fetch"] ? currentUpstream(root) : (refreshMainCheckout(root, { fetch: true }), currentUpstream(root));
  // Without an upstream there is no trustworthy "merged" reference — refuse
  // rather than guess, UNLESS the caller named the branches explicitly.
  if (!upstream && explicit.size === 0) {
    return { notes: ["no upstream tracking branch — cannot determine merged branches; name them explicitly to prune"], pruned: 0 };
  }
  const mergedOut = upstream ? gitCmd(root, ["branch", "--merged", upstream]) : null;
  const merged = new Set(
    mergedOut && mergedOut.status === 0
      ? (mergedOut.stdout || "")
          .split(/\r?\n/)
          .map((l) => l.replace(/^[*+ ]+/, "").trim())
          .filter(Boolean)
      : []
  );
  const matched = new Set();
  // `--self` is the authorization token `ship` passes after CI is green, so the
  // session that just finished may prune its OWN worktree. It resolves the
  // caller by process ancestry (a bash invocation carries no HARNESS_SESSION_ID)
  // against the MAIN tree's live leases, then lifts the guard ONLY for a
  // checkout the caller's pointer actually names (`isSelf` below). A plain
  // `worktree-prune` (a foreign/concurrent caller, e.g. the F-252 prune) passes
  // no token; and because several sessions can share one opencode pid, the
  // exact-pointer match means a same-pid sibling can never be mistaken for the
  // caller. `--dir <path>` narrows a `--self` run to the single just-shipped
  // checkout, so it can never converge (and thus never remove) another
  // session's worktree.
  const onlyDir = argv.dir ? path.resolve(argv.dir) : null;
  const selfSession = argv.self ? process.env.HARNESS_SESSION_ID || ancestorSessionId(main) : "";
  const selfPointer = selfSession ? readSessionWorktree(main, selfSession) : "";
  const isSelf = (p) => !!(selfPointer && path.resolve(selfPointer) === path.resolve(p));
  const inUse = liveSessionWorktreeDirs(main);

  let pruned = 0;
  for (const e of entries) {
    const label = path.basename(e.path);
    if (path.resolve(e.path) === path.resolve(main)) continue; // never the main tree
    if (onlyDir && path.resolve(e.path) !== onlyDir) continue; // a --self run stays narrow
    if (!e.branch) {
      notes.push(`kept ${label} (detached HEAD)`);
      continue;
    }
    if (explicit.has(e.branch)) matched.add(e.branch);
    // Never remove a checkout this very session is rooted IN. A `--open`
    // session's opencode process lives in the worktree (its lease is under the
    // worktree's own `.serve/sessions/`), so removing it would yank the running
    // session's cwd. A mid-session owner launched in main leaves no lease here,
    // so its finished worktree is still removable.
    if (leaseAncestorIn(e.path)) {
      notes.push(`kept ${label} (this session is rooted in it — prune after the session closes)`);
      continue;
    }
    // A worktree a live session still owns is off-limits even when merged and
    // clean: that session may be mid-`ship`, watching CI from it (F-252). The
    // owner's own `--self` request releases exactly its own checkout.
    if (inUse.has(path.resolve(e.path)) && !isSelf(e.path)) {
      notes.push(`kept ${label} (in use by a live session)`);
      continue;
    }
    const dirty = gitCmd(e.path, ["status", "--porcelain"]);
    if ((dirty.stdout || "").trim()) {
      notes.push(`kept ${label} (uncommitted work)`);
      continue;
    }
    const isMerged = explicit.has(e.branch) || merged.has(e.branch);
    if (!isMerged) {
      notes.push(
        `kept ${label} (branch ${e.branch} not merged into ${upstream || "upstream"} — name it to prune a squash-merged branch)`
      );
      continue;
    }
    const rm = gitCmd(main, ["worktree", "remove", e.path]);
    if (rm.status !== 0) {
      notes.push(`could not remove ${label}: ${(rm.stderr || rm.stdout || "").trim()}`);
      continue;
    }
    gitCmd(root, ["branch", "-d", e.branch]);
    clearSessionWorktree(main, isSelf(e.path) ? selfSession : process.env.HARNESS_SESSION_ID, e.path);
    notes.push(`pruned ${label} (${e.branch})`);
    pruned += 1;
  }
  for (const name of explicit) {
    if (!matched.has(name)) notes.push(`no linked worktree on branch ${name}`);
  }
  if (!notes.length) notes.push("no linked worktrees to consider");
  return { notes, pruned };
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
    const base = out.note
      ? `${out.id}: ${out.note}${out.closed ? "; closed note updated" : ""}`
      : `archived ${out.id} (${out.closed})`;
    return out.cleanup && out.cleanup.length ? `${base} — ${out.cleanup.join("; ")}` : base;
  }
  if (cmd === "freeze") return out.note ? `${out.id}: ${out.note}` : `froze ${out.id} (${out.cond})`;
  if (cmd === "reopen") return out.note ? `${out.id}: ${out.note}` : `reopened ${out.id} -> Open [${out.priority}] (${out.reason})`;
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
    else if (a === "--reason") args.reason = argv[++i];
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
    else if (a === "--self") args.self = true;
    else if (a === "--open") args.open = true;
    else if (a === "--open-cmd") args["open-cmd"] = argv[++i];
    else if (a === "--no-fetch") args["no-fetch"] = true;
    else if (a === "--defer") args.defer = true;
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
      "  node scripts/backlog.js reopen <id> [--reason x] [--p P1..P4]\n" +
      "  node scripts/backlog.js priority <id> --p P1..P4\n" +
      "  node scripts/backlog.js depends <id> --on <ids|?>\n" +
      "  node scripts/backlog.js owns <id> --files \"glob, glob\"\n" +
      "  node scripts/backlog.js sync [--root <dir>] [--no-fetch]\n" +
      "  node scripts/backlog.js worktree <id> [--branch b] [--dir d] [--handoff path] [--no-fetch] [--open]\n" +
      "  node scripts/backlog.js worktree-prune [<branch>...] [--self] [--dir d] [--no-fetch]\n" +
      "  node scripts/backlog.js epic-add <key> --label <x> [--goal <y>]\n" +
      "  node scripts/backlog.js epic <id> --to <key>\n"
  );
}

/* Render the service `BacklogBoard` with the same layout as `cmdList`, so a
 * session's `list` output is identical whichever backend it uses. */
function renderServiceList(board, argv) {
  const full = !!argv.full;
  const TASK_W = full ? Infinity : 120;
  const SUB_W = full ? Infinity : 90;
  let limit = LIST_DEFAULT_LIMIT;
  if (argv.limit != null) {
    const n = Number.parseInt(argv.limit, 10);
    limit = Number.isFinite(n) && n >= 0 ? n : LIST_DEFAULT_LIMIT;
  }

  for (const line of board.active || []) console.log(`- ${stripEmphasis(line)}`);
  if ((board.active || []).length) console.log("");

  const groups = [["inprogress", "In progress"], ["queued", "Queued"], ["open", "Open"]];
  if (argv.all) groups.push(["frozen", "Frozen"], ["archive", "Archive"]);

  for (const [key, label] of groups) {
    const rows = board[key] || [];
    console.log(`${label} (${rows.length})`);
    const shown = limit > 0 && rows.length > limit ? rows.slice(0, limit) : rows;
    for (const r of shown) {
      if (key === "open" || key === "queued") {
        console.log(`  ${r.id}  [${r.priority}]  [${r.epic}]  ${truncate(r.task || "", TASK_W)}`);
        if (r.evidence && r.evidence !== "?") console.log(`             evidence: ${truncate(r.evidence, SUB_W)}`);
      } else if (key === "inprogress") {
        console.log(`  ${r.id}  [${r.epic}]  ${truncate(r.task || "", TASK_W)}`);
        if (r.handoff && r.handoff !== "?") console.log(`             handoff: ${truncate(r.handoff, SUB_W)}`);
      } else if (key === "frozen") {
        console.log(`  ${r.id}  [${r.epic}]  ${truncate(r.task || "", TASK_W)}`);
        if (r.condition) console.log(`             reopen: ${truncate(r.condition, SUB_W)}`);
      } else {
        console.log(`  ${r.id}  [${r.epic}]  ${truncate(r.task || "", TASK_W)}`);
        if (r.closed) console.log(`             closed: ${truncate(r.closed, SUB_W)}`);
      }
    }
    if (shown.length < rows.length) console.log(`  … +${rows.length - shown.length} row(s) omitted (--limit ${limit}, 0 = all)`);
    console.log("");
  }
}

/* The service-backed command path (ADR 0001 Phase 2). Mirrors every read/write
 * the file backend supports; `worktree` does its local git work here and records
 * the row through the service. Returns true when it handled the command. */
function runService(root, cmd, argv) {
  const out = (result, extra) => {
    const formatted = formatResult(cmd, { ...result, ...(extra || {}) });
    if (formatted) console.log(formatted);
    return true;
  };

  if (cmd === "list") {
    const board = boardClient.getBoard(root);
    if (argv.json) console.log(JSON.stringify(board, null, 2));
    else renderServiceList(board, argv);
    return true;
  }
  if (cmd === "next" && !argv.take) return out(boardClient.next(root));
  if (cmd === "next" && argv.take) return out(boardClient.nextTake(root, argv.handoff));
  if (cmd === "add") return out(boardClient.add(root, argv));
  if (cmd === "take") return out(boardClient.take(root, argv._[0], argv.handoff));
  if (cmd === "queue") return out(boardClient.queue(root, argv._[0]));
  if (cmd === "unqueue") return out(boardClient.unqueue(root, argv._[0]));
  if (cmd === "archive") return out(boardClient.archive(root, argv._[0], argv.closed));
  if (cmd === "freeze") return out(boardClient.freeze(root, argv._[0], argv.why, argv.reopen));
  if (cmd === "reopen") return out(boardClient.reopen(root, argv._[0], argv.reason, argv.p));
  if (cmd === "priority") return out(boardClient.priority(root, argv._[0], argv.p));
  if (cmd === "epic") return out(boardClient.setEpic(root, argv._[0], argv.to));
  if (cmd === "depends") return out(boardClient.depends(root, argv._[0], argv.on));
  if (cmd === "owns") {
    const r = boardClient.owns(root, argv._[0], argv.files);
    return out(r, { files: r.files });
  }
  if (cmd === "epic-add") return out(boardClient.epicAdd(root, argv._[0], argv.label, argv.goal));

  if (cmd === "worktree") {
    const id = argv._[0];
    if (!id) throw new Error("worktree: missing <id>.");
    const slug = id.toLowerCase();
    const branch = argv.branch || slug;
    const dir = argv.dir ? path.resolve(argv.dir) : path.resolve(root, "..", ".worktrees", path.basename(root), slug);
    const rootAbs = path.resolve(root);
    if (dir === rootAbs || dir.startsWith(rootAbs + path.sep)) {
      throw new Error(`worktree: refusing a worktree inside the repository (${dir}).`);
    }
    const handoff = argv.handoff !== undefined ? validateHandoff(id, argv.handoff) : `.agents/handoffs/${id}.md`;
    const rel = path.relative(root, dir) || dir;

    // Record the In-progress row + isolation target through the service first.
    boardClient.worktreeRecord(root, id, rel, branch, handoff);
    // Then create the checkout locally (git-side effect stays on this machine).
    const base = currentUpstream(root) || "HEAD";
    const res = spawnSync("git", ["-C", root, "worktree", "add", "--no-track", "-b", branch, dir, base], { encoding: "utf8" });
    if (res.status !== 0) throw new Error(`worktree: git worktree add failed: ${(res.stderr || res.stdout || "").trim()}`);
    runWorktreeSetup(root, dir);
    const sessionID = ancestorSessionId(root);
    writeSessionWorktree(root, sessionID, dir);
    const plan = { id, branch, dir: rel, dirAbs: dir, handoff, base };
    out(plan);
    if (argv.open) openWorktreeSession(dir, argv["open-cmd"]);
    return true;
  }

  usage();
  process.exitCode = 1;
  return true;
}

function main() {
  const raw = process.argv.slice(2);
  const cmd = raw[0];
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    usage();
    return;
  }
  const args = parseArgs(raw.slice(1));

  const explicitRoot = Boolean(args.root);
  const foundRoot = explicitRoot ? path.resolve(args.root) : findRoot(process.cwd());
  if (!foundRoot) {
    console.error("backlog: no board root found (no BACKLOG.md/.harness.json up the tree).");
    process.exitCode = 1;
    return;
  }
  // Board ops from a linked worktree always act on the project's canonical board
  // (the shared service or the main checkout), never the worktree's own copy.
  const root = resolveBoardRoot(foundRoot, { explicitRoot, cmd });

  // Service backend (ADR 0001): the board lives in the external service, so
  // every read/write goes over HTTP. Git-side effects (worktree add/remove) stay
  // local. `BACKLOG_BACKEND=file` forces the legacy path. An explicit `--root`
  // names a local checkout, so it too forces the file backend and can never be
  // redirected to the shared service by ambient config (F-333/F-338).
  if (boardClient.enabled(root, { forceFile: explicitRoot }) && cmd !== "worktree-prune" && cmd !== "sync") {
    try {
      return runService(root, cmd, args);
    } catch (e) {
      console.error(`backlog: ${e.message}`);
      process.exitCode = 1;
      return;
    }
  }

  // Read-only commands never lock or write. They show the working board
  // reconciled against the last-known upstream, so a stale main checkout can't
  // mislead a decision (a shipped row that still shows Open locally).
  if (cmd === "list" || (cmd === "next" && !args.take)) {
    const state = readBacklog(root);
    const upstream = boardSync.isCanonicalCheckout(root) ? currentUpstream(root) : "";
    const disp = boardSync.displayBoard(root, upstream);
    if (disp.board) state.lines = disp.board.split(/\r?\n/);
    if (disp.behind > 0) {
      console.log(`board: main is ${disp.behind} behind ${upstream} — showing the reconciled view`);
    }
    if (cmd === "list") {
      if (args.json) console.log(JSON.stringify(toBoardJson(state), null, 2));
      else cmdList(state, args);
    } else {
      console.log(formatResult("next", cmdNext(state, args)));
    }
    return;
  }

  // Mutating commands read-modify-write BACKLOG.md (or owned-files.md) under an
  // exclusive lock, so two concurrent sessions can't both claim the same row.
  // In the canonical checkout every mutation is a transaction: converge against
  // origin first, apply the row change, then commit + publish it. Main therefore
  // never carries an uncommitted board copy, and a mutation can never resurrect
  // a row that already landed in Archive upstream.
  let worktreeOut = null;
  const defer = !!args.defer;
  try {
    withLock(root, () => {
      const canonical = boardSync.isCanonicalCheckout(root);
      const upstream = canonical ? currentUpstream(root) : "";
      const notes = [];
      let canPublish = true;

      if (canonical && upstream && cmd !== "worktree-prune") {
        const conv = boardSync.convergeCanonical(root, upstream, { fetch: !args["no-fetch"] && !defer });
        notes.push(...conv.notes);
        if (!conv.ok) throw new Error(conv.notes[conv.notes.length - 1] || "canonical checkout is not converged");
        canPublish = conv.canPublish !== false;
      } else if (cmd === "worktree" || cmd === "archive") {
        notes.push(...refreshMainCheckout(root, { fetch: !args["no-fetch"] && !defer }));
      }

      if (cmd === "sync") {
        if (!canonical || !upstream) {
          notes.push("not the canonical checkout (or no upstream) — nothing to publish");
        } else if (!canPublish) {
          notes.push("main is diverged — reconcile manually: git pull --rebase");
        } else {
          const pub = boardSync.publishBoard(root, upstream, "chore(board): sync local rows");
          if (pub.published && pub.committed) notes.push(`published board to ${upstream}`);
          else if (!pub.published) notes.push("committed locally; run `node scripts/backlog.js sync` when the remote is reachable");
        }
        for (const note of notes) console.log(`board: ${note}`);
        return;
      }

      const state = readBacklog(root);
      let out;
      let after = null;
      let publishMessage = null;
      if (cmd === "add") out = cmdAdd(state, args);
      else if (cmd === "take") out = cmdTake(state, args);
      else if (cmd === "queue") out = cmdQueue(state, args);
      else if (cmd === "unqueue") out = cmdUnqueue(state, args);
      else if (cmd === "next") out = cmdNext(state, args);
      else if (cmd === "archive") out = cmdArchive(state, args);
      else if (cmd === "freeze") out = cmdFreeze(state, args);
      else if (cmd === "reopen") out = cmdReopen(state, args);
      else if (cmd === "priority") out = cmdPriority(state, args);
      else if (cmd === "depends") out = cmdDepends(state, args);
      else if (cmd === "owns") out = cmdOwns(state, args);
      else if (cmd === "worktree") {
        out = cmdWorktreePlan(state, args);
        after = () => {
          out = cmdWorktreeApply(root, out);
        };
      } else if (cmd === "worktree-prune") out = cmdWorktreePrune(state, args);
      else if (cmd === "epic-add") out = cmdEpicAdd(state, args);
      else if (cmd === "epic") out = cmdEpic(state, args);
      else {
        usage();
        process.exitCode = 1;
        return;
      }

      if (cmd === "worktree-prune") {
        for (const note of out.notes) console.log(`worktree-prune: ${note}`);
      } else if (cmd === "owns") {
        publishMessage = `chore(board): owns ${out.id}`;
      } else {
        fs.writeFileSync(state.p, serializeBacklog(state), "utf8");
        publishMessage = `chore(board): ${cmd}${out && out.id ? " " + out.id : ""}`;
      }

      // Publish the board BEFORE any filesystem side effect: the worktree must
      // be based on an origin that already carries the In-progress row.
      if (canonical && upstream && publishMessage && canPublish) {
        const pub = boardSync.publishBoard(root, upstream, publishMessage, { deferPush: defer });
        if (pub.published && pub.committed) notes.push(`published board to ${upstream}`);
        else if (!pub.published) {
          notes.push(
            defer
              ? "committed locally; a background sync will publish it"
              : "committed locally; run `node scripts/backlog.js sync` when the remote is reachable"
          );
        }
      } else if (canonical && upstream && publishMessage && !canPublish) {
        notes.push(`not published (main is diverged) — resolve with git pull --rebase, then \`node scripts/backlog.js sync\``);
      }

      if (after) after();
      if (cmd !== "worktree-prune") console.log(formatResult(cmd, out));
      if (cmd === "worktree") worktreeOut = out;
      for (const note of notes) console.log(`board: ${note}`);
    });
  } catch (e) {
    console.error(`backlog: ${e.message}`);
    process.exitCode = 1;
  }

  // The lock is released; now make the worktree the interactive session root.
  if (cmd === "worktree" && args.open && worktreeOut) {
    openWorktreeSession(worktreeOut.dirAbs, args["open-cmd"]);
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
  cmdReopen,
  cmdPriority,
  cmdDepends,
  cmdOwns,
  cmdWorktree,
  cmdWorktreePlan,
  cmdWorktreeApply,
  cmdEpicAdd,
  cmdEpic,
  readEpics,
  toBoardJson,
  withLock,
  dependencyGraph,
  findCycle,
};
