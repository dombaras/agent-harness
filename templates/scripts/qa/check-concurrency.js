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
 * The fix the message points at is either isolation (`backlog worktree <id>`) or
 * committing/stashing the foreign work. Exit 0 unless the collision is provable.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

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

const failures = [];
const warnings = [];

console.log("concurrency gate \u2014 a concurrent session's uncommitted work must not leak into your push");

if (!insideGitRepo()) {
  console.log("  \u26a0 not a git repo \u2014 concurrency gate skipped");
  console.log("\nRESULT: skipped (0 failures)");
  process.exit(0);
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

if (active > 1) {
  failures.push(
    `${active} sessions are In progress (${ids.join(", ")}) while the working tree has ${dirty.length} uncommitted change(s) ` +
      `\u2014 a session other than the one pushing owns uncommitted work that will leak into pre-push gates. ` +
      `Isolate per feature (backlog worktree <id>) or stash/commit before push.`
  );
  console.log("  \u2717 " + failures[failures.length - 1]);
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
