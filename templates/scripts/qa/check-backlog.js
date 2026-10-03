#!/usr/bin/env node
"use strict";
/*
 * test:backlog — canonical-single-backlog gate (repo guard).
 *
 * Mechanically enforces the harness's ONE-write-path rule: `BACKLOG.md` at the
 * repo root is the single source of truth for open work, and every other list
 * (`.agents/features/INDEX.md`, `.agents/memory/todo.md`) is a pointer (or
 * absent), never a live list.
 *
 *   1. Only ONE canonical backlog file exists: the repo-root `BACKLOG.md`.
 *   2. Priority values are from {P1..P4} and apply to open rows only.
 *   3. Every `frozen` row has a non-empty "why / reopen" condition.
 *   4. Every `open` row has non-empty priority and evidence cells. `?` is
 *      allowed but must be explicit — a blank cell is a failure.
 *   5. Every `in progress` row has non-empty task and handoff cells (`?` allowed
 *      for handoff, but not blank).
 *   6. No duplicate IDs across the whole file.
 *   7. `INDEX.md` / `todo.md`, if present, are pointers (content referencing
 *      BACKLOG.md), not live row lists.
 *   8. `BACKLOG.md` is git-tracked (committed), not untracked — the board syncs
 *      across sessions only through git. Skipped outside a git repo.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { splitCells, findCycle } = require("./board-lib.js");

const root = path.resolve(__dirname, "..", "..");

const PRIORITY = new Set(["P1", "P2", "P3", "P4"]);

const failures = [];
const warnings = [];
const check = (ok, msg) => {
  console.log(`  ${ok ? "\u2713" : "\u2717"} ${msg}`);
  if (!ok) failures.push(msg);
};

/* ADR 0001: when the board service is the backend, the gate validates the
 * SERVICE's board (the service enforces every invariant on write), not the
 * legacy file. We map the service JSON into the same `lines`-based `buckets`
 * shape the checks below already consume, so one implementation covers both. */
const boardClient = (() => {
  try {
    return require("./board-client.js");
  } catch {
    return null;
  }
})();
const serviceActive = boardClient && boardClient.enabled(root);
const useService = serviceActive && !process.argv.includes("--file");

if (useService) {
  console.log("backlog gate \u2014 board service integrity (BACKLOG_BACKEND=service)");
} else {
  console.log("backlog gate \u2014 canonical single-file BACKLOG.md");
}

function insideGitRepo() {
  try {
    const r = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: root,
      stdio: "pipe",
    });
    return (r.toString() || "").trim() === "true";
  } catch (_) {
    return false;
  }
}
function gitTracked(rel) {
  try {
    const r = execFileSync("git", ["ls-files", "--error-unmatch", rel], {
      cwd: root,
      stdio: "pipe",
    });
    return (r.toString() || "").trim().length > 0;
  } catch (_) {
    return false;
  }
}
/* Git-tracked paths matching a pathspec glob (relative to the repo root). */
function gitLsFiles(pattern) {
  try {
    const r = execFileSync("git", ["ls-files", "--", pattern], {
      cwd: root,
      stdio: "pipe",
    });
    return (r.toString() || "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

/* Render the service `BacklogBoard` JSON as markdown table lines, so the shared
 * row checks below run against it unchanged. */
function serviceBoardToLines(board) {
  const cell = (v) => String(v == null ? "" : v).replace(/\|/g, "/").replace(/\s+/g, " ").trim();
  const row = (cells) => "| " + cells.map(cell).join(" | ") + " |";
  const out = [];
  out.push("## Epics", "", "| Key | Label | Goal |", "|---|---|---|");
  for (const e of board.epics || []) out.push(row([e.key, e.label, e.goal]));
  out.push("", "## In progress", "", "| ID | Epic | Task | Handoff |", "|---|---|---|---|");
  for (const r of board.inprogress || []) out.push(row([r.id, r.epic, r.task, r.handoff]));
  for (const [key, label] of [["queued", "Queued"], ["open", "Open"]]) {
    out.push("", `## ${label}`, "", "| ID | P | Epic | Task | Evidence | Depends on |", "|---|---|---|---|---|---|");
    for (const r of board[key] || []) out.push(row([r.id, r.priority, r.epic, r.task, r.evidence, r.dependsOn]));
  }
  out.push("", "## Frozen", "", "| ID | Epic | Task | Why frozen / reopen when |", "|---|---|---|---|");
  for (const r of board.frozen || []) out.push(row([r.id, r.epic, r.task, r.condition]));
  out.push("", "## Archive (shipped · done)", "", "| ID | Epic | Task | Closed |", "|---|---|---|---|");
  for (const r of board.archive || []) out.push(row([r.id, r.epic, r.task, r.closed]));
  return out;
}

let lines;
if (useService) {
  let snapshot;
  try {
    snapshot = boardClient.getBoard(root);
  } catch (e) {
    console.error(`FATAL: board service unreachable — ${e.message}`);
    process.exit(2);
  }
  // The service enforces uniqueness/priority/evidence/cycles on write; the gate
  // still re-verifies structure so a corrupt row can never slip through.
  check(true, "board service reachable (BACKLOG_BACKEND=service)");
  const strays = insideGitRepo() ? gitLsFiles("*BACKLOG.md").filter((f) => f !== "BACKLOG.md") : [];
  check(strays.length === 0, `no stray BACKLOG.md boards (found: ${strays.join(", ") || "none"})`);
  lines = serviceBoardToLines(snapshot);
} else {
  // ---- 1. Only ONE canonical backlog file ----------------------------------
  const canonical = path.join(root, "BACKLOG.md");
  if (!fs.existsSync(canonical)) {
    console.error("FATAL: missing BACKLOG.md at repo root (the canonical task list)");
    process.exit(2);
  }
  check(true, "canonical BACKLOG.md present at repo root");

  // No stray/secondary boards: the root file is the ONLY canonical board.
  if (insideGitRepo()) {
    const strays = gitLsFiles("*BACKLOG.md").filter((f) => f !== "BACKLOG.md");
    check(strays.length === 0, `no stray BACKLOG.md boards (found: ${strays.join(", ") || "none"})`);
  } else {
    check(true, "not a git repo \u2014 skipping stray BACKLOG.md check");
  }

  // ---- 7. BACKLOG.md must be git-tracked (committed), not untracked --------
  if (insideGitRepo()) {
    check(
      gitTracked("BACKLOG.md"),
      "BACKLOG.md is git-tracked (run `git add BACKLOG.md` then commit — an untracked board never syncs)"
    );
  } else {
    check(true, "not a git repo \u2014 skipping BACKLOG.md tracking check");
  }

  lines = fs.readFileSync(canonical, "utf8").split(/\r?\n/);
}

// ---- table parsing ----------------------------------------------------------
// Split a markdown table row on unescaped `|` — shared with backlog.js and the
// other board gates via board-lib.js (one home for the row parser, so a parse
// fix never has to be replicated across scripts).

// Group table rows by the last `##`/`###` section heading that preceded them.
// Also records each section's column width (from its separator row) and flags
// data rows with MORE cells than the header — the signature of an unescaped `|`
// (or stray `|` fragment) splitting one logical row into corrupt cells. Over-wide
// rows are reported with a precise message and EXCLUDED from the per-column
// checks below, whose shifted indexes would otherwise produce misleading errors
// ("depends on unknown row 404" when the real defect is a 7-cell Open row).
function parseSectionRows(lines) {
  const buckets = {};
  const widths = {};
  const overWide = [];
  let current = null;
  let rowCount = 0;
  for (const raw of lines) {
    const heading = raw.match(/^#{2,3}\s+(.*)$/);
    if (heading) {
      current = heading[1].trim();
      buckets[current] = buckets[current] || [];
      continue;
    }
    if (!current) continue;
    const row = raw.trim();
    if (!/^\|.*\|$/.test(row)) continue;
    const inner = row.slice(1, -1);
    const cells = splitCells(inner);
    // separator row `|---|---|` — records this section's canonical width
    if (cells.length > 1 && cells.every((c) => /^[-:|\s]*$/.test(c))) {
      if (!(current in widths)) widths[current] = cells.length;
      continue;
    }
    const joined = cells.join("|").trim();
    if (/^([-:|\s]*)$/.test(joined)) continue;
    // skip header rows named ID/P/Epic/Task/... and the Epics registry header (Key/Label/Goal)
    if (cells.some((c) => /^(ID|[Ii]d|P|Epic|Task|Evidence|Handoff|Why frozen \/ reopen when|Closed|Key|Label|Goal|Depends on)$/.test(c))) continue;
    // over-wide row = unescaped `|`/stray fragment split the logical row
    if (widths[current] && cells.length > widths[current]) {
      overWide.push({ heading: current, cells, expected: widths[current] });
      continue;
    }
    buckets[current].push(cells);
    rowCount++;
  }
  return { buckets, widths, overWide, rowCount };
}

const parsed = parseSectionRows(lines);
const { buckets, overWide, rowCount } = parsed;

// ---- honest cell-count diagnostics (before per-column checks) ---------------
for (const bad of overWide) {
  const label = bad.heading.toLowerCase();
  const id = (bad.cells[0] || "?").trim();
  const extra = bad.cells.length - bad.expected;
  check(
    false,
    `row ${id} under "${bad.heading}" has ${bad.cells.length} cells, expected ${bad.expected} ` +
      `(${extra} extra — an unescaped \`|\` or stray fragment is splitting one logical row). ` +
      `Repair the row with the backlog tools (never hand-edit): ` +
      `remove the stray \`|\` or re-add the row via \`node scripts/backlog.js\`.`
  );
}

// Column indexes per section (from the BACKLOG template schema).
const COLS = {
  open: { id: 0, priority: 1, epic: 2, evidence: 4, dependsOn: 5 },
  queued: { id: 0, priority: 1, epic: 2, evidence: 4, dependsOn: 5 },
  "in progress": { id: 0, epic: 1, task: 2, handoff: 3 },
  frozen: { id: 0, epic: 1, reopen: 3 },
  "archive (shipped · done)": { id: 0, epic: 1 },
};

function bucketRows(key) {
  // tolerate loose heading variants
  return buckets[key] || [];
}

const openRows = bucketRows("Open");
const queuedRows = bucketRows("Queued");
const inProgressRows = bucketRows("In progress");
const frozenRows = bucketRows("Frozen");
const archiveRows = bucketRows("Archive (shipped · done)") || bucketRows("Archive");

// ---- Epics registry: parse + validate -------------------------------------
const epicRows = buckets["Epics"] || [];
const epicKeys = new Set();
for (const r of epicRows) {
  const key = (r[0] || "").trim();
  const label = (r[1] || "").trim();
  if (!key) {
    check(false, `epics entry: key must not be blank`);
    continue;
  }
  if (epicKeys.has(key)) check(false, `epics entry "${key}": duplicate key`);
  epicKeys.add(key);
  check(label.length > 0, `epics entry "${key}": label must not be blank`);
}
if (epicRows.length > 0) {
  check(true, `parsed ${epicRows.length} epic(s) from ## Epics`);
}

function checkEpic(id, raw) {
  const epic = (raw || "").trim();
  if (epic.length === 0) {
    check(false, `row ${id}: epic must not be blank (use a declared epic key or \`?\`)`);
    return;
  }
  if (epic !== "?" && !epicKeys.has(epic)) {
    check(false, `row ${id}: epic "${epic}" is not a declared epic (add it to ## Epics or use ?)`);
  } else {
    check(true, `row ${id}: epic \`${epic}\` is valid`);
  }
}

// ---- In progress rows: non-empty task + handoff ----------------------------
for (const r of inProgressRows) {
  const id = r[COLS["in progress"].id] || "?";
  const task = (r[COLS["in progress"].task] || "").trim();
  const handoff = (r[COLS["in progress"].handoff] || "").trim();
  check(task.length > 0, `in-progress row ${id}: task must not be blank`);
  check(
    handoff.length > 0,
    `in-progress row ${id}: handoff must not be blank (session handoff file, or \`?\` if unknown)`
  );
  checkEpic(id, r[COLS["in progress"].epic]);
}

// ---- 3. Frozen requires a reopen condition ---------------------------------
for (const r of frozenRows) {
  const reopen = (r[COLS.frozen.reopen] || "").trim();
  check(
    reopen.length > 0,
    `frozen row ${r[COLS.frozen.id]}: must carry a "why frozen / reopen when" condition`
  );
  checkEpic(r[COLS.frozen.id], r[COLS.frozen.epic]);
}

// ---- 2 + 4. Open rows: valid priority + non-empty evidence -----------------
for (const r of openRows) {
  const id = r[COLS.open.id] || "?";
  const priority = (r[COLS.open.priority] || "").trim();
  const evidence = (r[COLS.open.evidence] || "").trim();
  if (priority.length === 0) {
    check(false, `open row ${id}: priority must not be blank (use P1..P4, or \`?\` if unknown)`);
  } else if (!PRIORITY.has(priority)) {
    check(false, `open row ${id}: priority \`${priority}\` not in {P1,P2,P3,P4}`);
  } else {
    check(true, `open row ${id}: priority \`${priority}\` is valid`);
  }
  check(
    evidence.length > 0,
    `open row ${id}: evidence must not be blank (pointer, or \`?\` if unknown)`
  );
  checkEpic(id, r[COLS.open.epic]);
}

// ---- 2 + 4 (queued). Queued rows: valid priority + evidence + epic ---------
for (const r of queuedRows) {
  const id = r[COLS.queued.id] || "?";
  const priority = (r[COLS.queued.priority] || "").trim();
  const evidence = (r[COLS.queued.evidence] || "").trim();
  if (priority.length === 0) {
    check(false, `queued row ${id}: priority must not be blank (use P1..P4, or \`?\` if unknown)`);
  } else if (!PRIORITY.has(priority)) {
    check(false, `queued row ${id}: priority \`${priority}\` not in {P1,P2,P3,P4}`);
  } else {
    check(true, `queued row ${id}: priority \`${priority}\` is valid`);
  }
  check(
    evidence.length > 0,
    `queued row ${id}: evidence must not be blank (pointer, or \`?\` if unknown)`
  );
  checkEpic(id, r[COLS.queued.epic]);
}

// ---- Archive rows: epic must be declared (or `?`) --------------------------
for (const r of archiveRows) {
  checkEpic(r[COLS["archive (shipped · done)"].id], r[COLS["archive (shipped · done)"].epic]);
}

// ---- 5. No duplicate IDs across the whole file -----------------------------
const allRows = [...openRows.map((r, i) => ({ cells: r, tag: "Open" })),
  ...queuedRows.map((r, i) => ({ cells: r, tag: "Queued" })),
  ...inProgressRows.map((r, i) => ({ cells: r, tag: "In progress" })),
  ...frozenRows.map((r, i) => ({ cells: r, tag: "Frozen" })),
  ...archiveRows.map((r, i) => ({ cells: r, tag: "Archive" }))];
const totalRows = allRows.length;
if (totalRows > 0) {
  check(true, `parsed ${totalRows} row(s) across Open/Queued/In progress/Frozen/Archive`);
  const seen = new Map();
  const allIds = new Set();
  for (const { cells, tag } of allRows) {
    const id = (cells[0] || "").trim();
    if (!id) {
      check(false, `${tag}: a row has no ID — rows must carry an ID (F-001, ...)`);
      continue;
    }
    if (seen.has(id)) check(false, `duplicate ID \`${id}\` (${seen.get(id)} and ${tag})`);
    else seen.set(id, tag);
    allIds.add(id);
  }

  // ---- Depends-on references must name existing rows ---------------------
  const dependsRows = [
    ...openRows.map((r) => ({ id: (r[COLS.open.id] || "").trim(), dep: r[COLS.open.dependsOn] || "", tag: "Open" })),
    ...queuedRows.map((r) => ({ id: (r[COLS.queued.id] || "").trim(), dep: r[COLS.queued.dependsOn] || "", tag: "Queued" })),
  ];
  for (const { id, dep, tag } of dependsRows) {
    const raw = (dep || "").trim();
    if (!raw || raw === "?") continue;
    for (const ref of raw.split(/[\s,]+/).filter(Boolean)) {
      if (!allIds.has(ref)) {
        check(false, `${tag} row ${id}: depends on unknown row \`${ref}\` (no such ID in BACKLOG.md)`);
      } else {
        check(true, `${tag} row ${id}: depends on \`${ref}\` (valid reference)`);
      }
    }
  }

  // ---- Dependency cycles are permanently blocking -------------------------
  const graph = new Map();
  for (const { id, dep } of dependsRows) {
    if (!id) continue;
    const raw = (dep || "").trim();
    graph.set(id, !raw || raw === "?" ? [] : raw.split(/[\s,]+/).filter(Boolean));
  }
  const cycle = findCycle(graph);
  check(
    !cycle,
    cycle
      ? `dependency cycle: ${cycle.join(" -> ")} — every row in the cycle is permanently blocked`
      : "no dependency cycles among Open/Queued rows"
  );
} else {
  check(true, "empty board (no Open/In progress/Frozen/Archive rows yet) — valid for a fresh project");
}

// ---- 6. INDEX.md / todo.md are pointers, not live lists --------------------
for (const rel of [".agents/features/INDEX.md", ".agents/memory/todo.md"]) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) {
    check(true, `${rel} absent`);
    continue;
  }
  const content = fs.readFileSync(p, "utf8");
  const isPointer = /BACKLOG\.md/.test(content);
  const hasList = /^\s*\|.+\|/m.test(content);
  if (isPointer) {
    check(true, `${rel} is a pointer to BACKLOG.md`);
  } else if (hasList) {
    check(false, `${rel} looks like a live list — point it at BACKLOG.md (or remove it)`);
  } else {
    check(true, `${rel} present and not a live list`);
  }
}

console.log(
  `\nRESULT: ${failures.length ? `${failures.length} FAILURE(S)` : "backlog green"}`
);
process.exit(failures.length ? 1 : 0);
