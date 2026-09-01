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
 *   5. No duplicate IDs across the whole file.
 *   6. `INDEX.md` / `todo.md`, if present, are pointers (content referencing
 *      BACKLOG.md), not live row lists.
 *   7. `BACKLOG.md` is git-tracked (committed), not untracked — the board syncs
 *      across sessions only through git. Skipped outside a git repo.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..", "..");

const PRIORITY = new Set(["P1", "P2", "P3", "P4"]);

const failures = [];
const warnings = [];
const check = (ok, msg) => {
  console.log(`  ${ok ? "\u2713" : "\u2717"} ${msg}`);
  if (!ok) failures.push(msg);
};

console.log("backlog gate \u2014 canonical single-file BACKLOG.md");

// ---- 1. Only ONE canonical backlog file ------------------------------------
const canonical = path.join(root, "BACKLOG.md");
if (!fs.existsSync(canonical)) {
  console.error("FATAL: missing BACKLOG.md at repo root (the canonical task list)");
  process.exit(2);
}
check(true, "canonical BACKLOG.md present at repo root");

// ---- 7. BACKLOG.md must be git-tracked (committed), not untracked ----------
// The board syncs across sessions only through git; an untracked BACKLOG.md
// never reaches the shared board. Skipped outside a git repo.
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
if (insideGitRepo()) {
  check(
    gitTracked("BACKLOG.md"),
    "BACKLOG.md is git-tracked (run `git add BACKLOG.md` then commit — an untracked board never syncs)"
  );
} else {
  check(true, "not a git repo \u2014 skipping BACKLOG.md tracking check");
}

const src = fs.readFileSync(canonical, "utf8");
const lines = src.split(/\r?\n/);

// ---- table parsing ----------------------------------------------------------
// Split a markdown table row on unescaped `|` (respects `\|` inside cells).
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

// Group table rows by the last `##`/`###` section heading that preceded them.
function parseSectionRows(lines) {
  const buckets = {};
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
    // skip empty rows and separators like `|---|---|`
    if (cells.every((c) => /^[-:|\s]*$/.test(c) && c.trim().length === 0)) continue;
    if (cells.every((c) => /^[-:|\s]*$/.test(c))) continue;
    const joined = cells.join("|").trim();
    if (/^([-:|\s]*)$/.test(joined)) continue;
    // skip header rows named ID/P/Task/...
    if (cells.some((c) => /^(ID|[Ii]d|P|Task|Evidence|Why frozen \/ reopen when|Closed)$/.test(c))) continue;
    buckets[current].push(cells);
    rowCount++;
  }
  return { buckets, rowCount };
}

const { buckets, rowCount } = parseSectionRows(lines);

// Column indexes per section (from the BACKLOG template schema).
const COLS = {
  open: { id: 0, priority: 1, evidence: 3 },
  frozen: { id: 0, reopen: 2 },
  "archive (shipped · done)": { id: 0 },
};

function bucketRows(key) {
  // tolerate loose heading variants
  return buckets[key] || [];
}

const openRows = bucketRows("Open");
const frozenRows = bucketRows("Frozen");
const archiveRows = bucketRows("Archive (shipped · done)") || bucketRows("Archive");

// ---- 3. Frozen requires a reopen condition ---------------------------------
for (const r of frozenRows) {
  const reopen = (r[COLS.frozen.reopen] || "").trim();
  check(
    reopen.length > 0,
    `frozen row ${r[COLS.frozen.id]}: must carry a "why frozen / reopen when" condition`
  );
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
}

// ---- 5. No duplicate IDs across the whole file -----------------------------
const allRows = [...openRows.map((r, i) => ({ cells: r, tag: "Open" })),
  ...frozenRows.map((r, i) => ({ cells: r, tag: "Frozen" })),
  ...archiveRows.map((r, i) => ({ cells: r, tag: "Archive" }))];
const totalRows = allRows.length;
if (totalRows > 0) {
  check(true, `parsed ${totalRows} row(s) across Open/Frozen/Archive`);
  const seen = new Map();
  for (const { cells, tag } of allRows) {
    const id = (cells[0] || "").trim();
    if (!id) {
      check(false, `${tag}: a row has no ID — rows must carry an ID (F-001, ...)`);
      continue;
    }
    if (seen.has(id)) check(false, `duplicate ID \`${id}\` (${seen.get(id)} and ${tag})`);
    else seen.set(id, tag);
  }
} else {
  check(true, "empty board (no Open/Frozen/Archive rows yet) — valid for a fresh project");
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
