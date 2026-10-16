#!/usr/bin/env node
"use strict";
/*
 * diff — a bounded change view for agents (the missing "inspect the diff"
 * capability behind the 2026-10-16 field review).
 *
 * The thinker personas (`qa-architect`, `planner`, `system-architect`) are
 * dispatched to inspect a change, but have no shell and no `diff` tool: the
 * LibraryOS field showed qa-architect at 799 `Read` / 132 `Grep` / 0 bash, and
 * the single largest cause of its `Maximum steps` truncations (10 all-time).
 * `git diff` returns changed paths + hunks, bounded, so the change is read in
 * one call instead of mass-reading whole files.
 *
 * Usage:
 *   node scripts/qa/diff.js [--staged] [--base <ref>] [--paths a,b] [--stat]
 *                           [--files] [--unified N] [--limit N] [--json] [--root <dir>]
 *
 * Defaults to the working tree vs HEAD (staged + unstaged). Always lists
 * untracked files (they have no diff). Output is capped (`--limit` lines,
 * default 400) so a large change cannot flood the transcript.
 *
 * Dependency-free and injectable (`opts.run`) so bounding and formatting are
 * unit-testable without a repo.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const DEFAULT_LIMIT = 400;

function parseArgs(argv) {
  const out = {
    root: null,
    staged: false,
    base: null,
    paths: [],
    stat: false,
    files: false,
    unified: 3,
    limit: DEFAULT_LIMIT,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--staged" || a === "--cached") out.staged = true;
    else if (a === "--base" && argv[i + 1]) out.base = argv[++i];
    else if (a.startsWith("--base=")) out.base = a.slice("--base=".length);
    else if (a === "--paths" && argv[i + 1]) out.paths = splitPaths(argv[++i]);
    else if (a.startsWith("--paths=")) out.paths = splitPaths(a.slice("--paths=".length));
    else if (a === "--stat") out.stat = true;
    else if (a === "--files") out.files = true;
    else if (a === "--unified" && argv[i + 1]) out.unified = clamps(Number(argv[++i]), 3, 0, 50);
    else if (a.startsWith("--unified=")) out.unified = clamps(Number(a.slice("--unified=".length)), 3, 0, 50);
    else if (a === "--limit" && argv[i + 1]) out.limit = clamps(Number(argv[++i]), DEFAULT_LIMIT, 20, 5000);
    else if (a.startsWith("--limit=")) out.limit = clamps(Number(a.slice("--limit=".length)), DEFAULT_LIMIT, 20, 5000);
    else if (a === "--json") out.json = true;
    else if (a === "--root" && argv[i + 1]) out.root = path.resolve(argv[++i]);
    else if (a.startsWith("--root=")) out.root = path.resolve(a.slice("--root=".length));
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function clamps(n, fallback, lo, hi) {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : fallback;
}

/* `a,b,c` / `a b c` / `a, b` → a clean path list. A `--paths` value may be
 * repeated via commas only (the tool builds it from one arg). */
function splitPaths(raw) {
  return String(raw || "")
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/* The git argv (without the `git`/`-C <root>` prefix) that produces the diff. */
function gitArgs(opts) {
  const range = opts.staged ? ["--cached"] : opts.base ? [opts.base] : ["HEAD"];
  const args = ["diff"];
  if (opts.files) args.push("--name-status");
  else if (opts.stat) args.push("--stat");
  else args.push("--no-color", `--unified=${opts.unified}`);
  args.push(...range);
  if (opts.paths.length) args.push("--", ...opts.paths);
  return args;
}

function untrackedArgs(opts) {
  const args = ["ls-files", "--others", "--exclude-standard"];
  if (opts.paths.length) args.push("--", ...opts.paths);
  return args;
}

/* Cap `text` to `limit` lines, appending a visible truncation marker. Pure —
 * the whole reason this tool exists is that an unbounded diff floods context. */
function capLines(text, limit) {
  const lines = String(text || "").replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
  if (lines.length <= limit) return { text: lines.join("\n"), truncated: 0 };
  const kept = lines.slice(0, limit);
  return { text: kept.join("\n"), truncated: lines.length - limit };
}

function renderHuman(opts, res) {
  const out = [];
  out.push(res.body || "(no changes)");
  if (res.untracked.length) {
    out.push("");
    out.push(`untracked: ${res.untracked.join(", ")}`);
  }
  if (res.truncated > 0) {
    out.push("");
    out.push(`[diff truncated: ${res.truncated} more line(s) — scope with --paths <glob> or raise --limit]`);
  }
  return out.join("\n");
}

function collect(opts, run) {
  const root = opts.root || process.cwd();
  const diff = run(root, gitArgs(opts));
  const untrackedRaw = run(root, untrackedArgs(opts));
  const untracked = String(untrackedRaw || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const capped = capLines(diff, opts.limit);
  return { body: capped.text, truncated: capped.truncated, untracked };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      "Usage: node scripts/qa/diff.js [--staged] [--base <ref>] [--paths a,b] [--stat] [--files] [--unified N] [--limit N] [--json] [--root <dir>]"
    );
    return;
  }
  const root = opts.root || process.cwd();
  const run = (dir, args) => {
    const r = spawnSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return r.status === 0 && typeof r.stdout === "string" ? r.stdout : "";
  };
  const res = collect(opts, run);
  if (opts.json) console.log(JSON.stringify({ root, base: opts.base || (opts.staged ? "--cached" : "HEAD"), ...res }, null, 2));
  else console.log(renderHuman(opts, res));
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error("diff: " + (e && e.message ? e.message : e));
    process.exit(1);
  }
}

module.exports = {
  DEFAULT_LIMIT,
  parseArgs,
  splitPaths,
  gitArgs,
  untrackedArgs,
  capLines,
  collect,
  renderHuman,
  clamps,
};
