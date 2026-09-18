#!/usr/bin/env node
"use strict";
/*
 * test:concurrency — cross-session working-tree guard (harness-shipped).
 *
 * The anti-collision gate for the single-tree model. The harness shards its own
 * artifacts (qa-plans, handoffs, features) so concurrent sessions never fight
 * over one file — but the git working tree is still shared. A pre-push hook that
 * runs a project gate (`test:quick` → `tsc` + `check-translations`) validates the
 * LIVE tree, so one session's half-done work (e.g. a page referencing translation
 * keys not yet in messages/*.json) makes another session's push fail for no fault
 * of its own.
 *
 * This gate makes that collision *visible and mechanical* instead of surfacing as
 * a random test failure:
 *   - clean tree        -> pass.
 *   - dirty tree + 2+ "In progress" rows -> FAIL: provably another session owns
 *     uncommitted work that will leak into pre-push gates.
 *   - dirty tree + 1 "In progress" row  -> warn (could be your own WIP), pass.
 *   - dirty tree + 0 "In progress" rows -> warn (unowned WIP), pass.
 *
 * When a project declares owned files (`.agents/memory/owned-files.md`), the
 * "2+ In progress" case is sharpened: each dirty file is attributed to the
 * in-progress row(s) whose globs match it, so the gate fails *exactly* when
 * files are contended (owned by 2+ rows, or a mix of different sessions) and
 * passes when every dirty file is cleanly owned by a single session.
 *
 * It also refuses two live primary sessions sharing one checkout, read from the
 * `.serve/sessions/` leases the context-guard plugin writes (`lease-lib.js` owns
 * the liveness rules: alive pid + matching process birth token + fresh
 * heartbeat, so recycled pids and closed TUIs no longer block a push).
 *
 * The fix the message points at is either isolation (`backlog worktree <id>`, or
 * `--open` to root the session there), ownership declaration (`backlog owns <id>
 * --files ...`), committing/stashing the foreign work, or — for leases only —
 * `node scripts/qa/check-concurrency.js --prune`. Exit 0 unless the collision is
 * provable.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { splitCells } = require("./board-lib.js");
const leases = require("./lease-lib.js");

const root = path.resolve(__dirname, "..", "..");

function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (_) {
    return null;
  }
}

function insideGitRepo() {
  const r = git(["rev-parse", "--is-inside-work-tree"]);
  return !!r && r.trim() === "true";
}

/* Dirty files = tracked changes (M/A/D/R/C) + untracked (`??`). Ignored files
 * (node_modules, build output) never show up here because `status` respects
 * .gitignore. */
function dirtyFiles() {
  const out = git(["status", "--porcelain"]) || "";
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => ({ code: l.slice(0, 2).trim(), file: l.slice(3) }));
}

/* Live-session leases. The context-guard plugin writes
 * `.serve/sessions/<sessionID>.json` when a PRIMARY session is created, removes
 * it on delete, and heartbeats it on activity. Two or more live leases in THIS
 * tree mean two primary sessions share one checkout — a collision that exists
 * even on a clean tree (and that the dirty-tree heuristics above cannot see).
 * The liveness rules (pid + process birth token + heartbeat) live in
 * `lease-lib.js` so the writer and this reader can never disagree. A lease for a
 * dead or recycled pid, or a stale heartbeat, is not live. */
function allLeases() {
  return leases.readLeases(root);
}

/* Split a markdown table row on unescaped `|` — shared with backlog.js and the
 * other board gates via board-lib.js (one home for the row parser). */

/* The active-session IDs: first cell of every table row under `## In progress`. */
function inProgressIds() {
  const p = path.join(root, "BACKLOG.md");
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
  let inSection = false;
  const ids = [];
  for (const raw of lines) {
    const h = raw.match(/^#{2,3}\s+(.*)$/);
    if (h) {
      inSection = /^in progress$/i.test(h[1].trim());
      continue;
    }
    if (!inSection) continue;
    const row = raw.trim();
    if (!/^\|.*\|$/.test(row)) continue;
    const cells = splitCells(row.slice(1, -1));
    if (cells.every((c) => /^[-:|\s]*$/.test(c))) continue; // separator
    if (cells.some((c) => /^(ID|[Ii]d|Task|Handoff)$/.test(c.trim()))) continue; // header
    const id = (cells[0] || "").trim();
    if (id) ids.push(id);
  }
  return ids;
}

/* `.agents/memory/owned-files.md` -> Map<ID, glob[]> (upper-cased IDs). */
function ownedFilesMap() {
  const map = new Map();
  const p = path.join(root, ".agents", "memory", "owned-files.md");
  if (!fs.existsSync(p)) return map;
  const src = fs.readFileSync(p, "utf8");
  for (const raw of src.split(/\r?\n/)) {
    const m = raw.match(/^\s*[-*]\s+([A-Za-z]+-\d+)\s*:\s*(.+)$/);
    if (m) map.set(m[1].toUpperCase(), m[2].split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean));
  }
  return map;
}

/* Minimal glob -> regex: `**` (any depth), `*` (within a segment), `?` (one char). */
function globToRegExp(g) {
  let s = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        s += ".*";
        i++;
      } else {
        s += "[^/]*";
      }
    } else if (c === "?") {
      s += "[^/]";
    } else {
      s += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp("^" + s + "$");
}

function matchesGlob(glob, file) {
  const g = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  const f = file.replace(/\\/g, "/").replace(/^\.\//, "");
  return globToRegExp(g).test(f);
}

const failures = [];
const warnings = [];

console.log("concurrency gate \u2014 a concurrent session's uncommitted work must not leak into your push");

if (!insideGitRepo()) {
  console.log("  \u26a0 not a git repo \u2014 concurrency gate skipped");
  console.log("\nRESULT: skipped (0 failures)");
  process.exit(0);
}

/* `--prune` clears dead / recycled / stale leases so a crashed session can never
 * block the gate (the plugin also sweeps on startup). */
if (process.argv.slice(2).includes("--prune")) {
  const removed = leases.pruneLeases(root);
  for (const r of removed) console.log(`  - removed ${r.sessionID} (pid ${r.pid}, ${r.reason})`);
  if (!removed.length) console.log("  no dead/recycled/stale leases to prune");
  console.log(`\nRESULT: pruned ${removed.length} stale lease(s)`);
  process.exit(0);
}

/* Independent of dirtiness: refuse two live primary sessions sharing one tree.
 * Only leases whose pid is alive AND matches the recorded process birth token
 * AND has a fresh heartbeat count — a recycled pid (the 0.1.67 bug) or a lease
 * leaked by a closed TUI no longer blocks an innocent push. */
const all = allLeases();
const live = all.filter((r) => leases.leaseStatus(r).live);
if (live.length > 1) {
  console.log(`  \u2717 ${live.length} live sessions share this working tree:`);
  for (const r of live) console.log(`      ${leases.describeLease(r)}`);
  const ghosts = all.filter((r) => !leases.leaseStatus(r).live);
  if (ghosts.length) {
    console.log(
      `  \u2139 ${ghosts.length} stale lease(s) present but ignored \u2014 clear them with ` +
        `\`node scripts/qa/check-concurrency.js --prune\`.`
    );
  }
  console.log(
    "\nRESULT: 1 FAILURE(S) \u2014 isolate, stash, or commit before push"
  );
  console.log(
    "         Two primary sessions must not share one checkout. Start each session in\n" +
      "         its own feature worktree (`backlog worktree <id> --open`) and work there."
  );
  process.exit(1);
}

const dirty = dirtyFiles();
if (dirty.length === 0) {
  console.log("  \u2713 working tree clean \u2014 nothing for another session's WIP to leak in");
  console.log("\nRESULT: green");
  process.exit(0);
}

for (const d of dirty) console.log(`  ${d.code} ${d.file}`);

const ids = inProgressIds();
const active = ids.length;

// The one file the ownership model cannot cleanly assign is BACKLOG.md itself:
// the board is genuinely shared across every In-progress session (each session's
// board tools write rows into the same file on main). When 2+ sessions are In
// progress AND the shared board is dirty, we cannot tell whose uncommitted row
// edits the tree holds — that is exactly the collision `test:concurrency` exists
// to catch, so it FAILS instead of being tolerated as a warning. (A single
// In-progress session's board delta is that session's own WIP and is handled by
// the existing warn branches below.)
const boardDirty = dirty.some((d) => (d.file || "").replace(/\\/g, "/") === "BACKLOG.md");
if (boardDirty && active >= 2) {
  failures.push(
    `the shared BACKLOG.md is dirty while ${active} sessions are In progress (${ids.join(", ")}) ` +
      `\u2014 the board is one file every session writes on main, so this tree mixes two sessions' board deltas. ` +
      `Commit/stash this board delta before push (it belongs to ONE session), then re-run the gate.`
  );
  console.log("  \u2717 " + failures[failures.length - 1]);
  console.log(
    "\nRESULT: " +
      `${failures.length} FAILURE(S) \u2014 isolate, stash, or commit before push`
  );
  process.exit(1);
}

if (active > 1) {
  // Ownership-aware attribution: if the project declared owned files
  // (`.agents/memory/owned-files.md`), attribute each dirty file to the
  // in-progress row(s) whose globs match it. This makes the collision check
  // precise instead of coarse: fail exactly when dirty files are contended
  // (owned by 2+ rows, or a mix of different rows), pass when they are cleanly
  // attributable to a single session.
  const owns = ownedFilesMap();
  const overlaps = [];
  const ownerOf = new Map();
  const distinctOwners = new Set();
  for (const d of dirty) {
    const owners = [];
    for (const id of ids) {
      const globs = owns.get(id);
      if (globs && globs.some((g) => matchesGlob(g, d.file))) owners.push(id);
    }
    if (owners.length >= 2) overlaps.push({ file: d.file, rows: owners });
    else if (owners.length === 1) {
      ownerOf.set(d.file, owners[0]);
      distinctOwners.add(owners[0]);
    }
  }

  if (overlaps.length) {
    for (const o of overlaps) {
      failures.push(
        `"${o.file}" is owned by ${o.rows.length} In-progress rows (${o.rows.join(", ")}) ` +
          `\u2014 two sessions contend on the same file. Reassign ownership (backlog owns <id> --files ...) ` +
          `or isolate (backlog worktree <id>) before push.`
      );
      console.log("  \u2717 " + failures[failures.length - 1]);
    }
  } else if (ownerOf.size === dirty.length && distinctOwners.size >= 2) {
    failures.push(
      `uncommitted files are owned by ${distinctOwners.size} DIFFERENT In-progress sessions (${[...distinctOwners].join(", ")}) ` +
        `\u2014 this tree mixes two sessions' WIP. Isolate per feature (backlog worktree <id>) before push.`
    );
    console.log("  \u2717 " + failures[failures.length - 1]);
  } else if (ownerOf.size === dirty.length) {
    warnings.push(
      `dirty tree with ${active} In-progress rows, but every uncommitted file is owned by a single session ` +
        `(${[...distinctOwners].join(", ")}) \u2014 no cross-session overlap detected. Commit before push.`
    );
    console.log("  \u26a0 " + warnings[warnings.length - 1]);
  } else {
    failures.push(
      `${active} sessions are In progress (${ids.join(", ")}) while the working tree has ${dirty.length} uncommitted change(s) ` +
        `\u2014 a session other than the one pushing owns uncommitted work that will leak into pre-push gates. ` +
        `Isolate per feature (backlog worktree <id>), declare ownership (backlog owns <id> --files ...), or stash/commit before push.`
    );
    console.log("  \u2717 " + failures[failures.length - 1]);
  }
} else if (active === 1) {
  warnings.push(
    `working tree is dirty with 1 session In progress (${ids[0]}) \u2014 if these uncommitted files belong to a ` +
      `DIFFERENT session, isolate them (backlog worktree) or stash before push; if they are yours, commit them first.`
  );
  console.log("  \u26a0 " + warnings[warnings.length - 1]);
} else {
  warnings.push(
    "working tree is dirty with no In progress rows \u2014 uncommitted work with no owner on the board; commit or stash it."
  );
  console.log("  \u26a0 " + warnings[warnings.length - 1]);
}

console.log(
  "\nRESULT: " +
    (failures.length
      ? `${failures.length} FAILURE(S) \u2014 isolate, stash, or commit before push`
      : "green (dirty tree tolerated \u2014 see warnings)")
);
process.exit(failures.length ? 1 : 0);
