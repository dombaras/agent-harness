#!/usr/bin/env node
"use strict";
/*
 * orient — one-call session orientation.
 *
 * A resume/claim session otherwise re-derives the same handful of facts by
 * hand: `git rev-parse --show-toplevel` + `git branch --show-current`
 * (114 calls / 103 sessions in the 2026-09 LibraryOS recon), a `git status`,
 * `serve.js list`, `npm run test:capacity`, the checkpoint, the board row, the
 * owned files, and the last device-run summary — a single F-291 resume spent 21
 * such calls before any real work. This gathers them deterministically in ONE
 * invocation.
 *
 * Pure gatherer + thin CLI. Every source is optional and degrades to a labelled
 * `unavailable` line — orient never invents a value and never throws on a
 * missing file (a fresh checkout has no checkpoint, no lease, no `.serve/`).
 *
 * Usage:
 *   node scripts/orient.js [--feature <id>] [--json] [--root <dir>]
 *
 * The same gatherer is exported for the `.opencode/tools/orient.ts` wrapper and
 * for unit tests (inject `git`/`fs`/`readCheckpoint` to keep it hermetic).
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const checkpoint = require("./checkpoint.js");
const capacity = require("./qa/capacity-lib.js");

const SCHEMA = "orient/1";

function safe(fn, fallback = null) {
  try {
    const v = fn();
    return v == null ? fallback : v;
  } catch (_) {
    return fallback;
  }
}

/* `git -C <root> <args>` trimmed stdout, or null. Injected for tests. */
function gitRunner(root) {
  return (args) => {
    const r = spawnSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    if (r.status !== 0 || typeof r.stdout !== "string") return null;
    return r.stdout.trim();
  };
}

/* "main" when the repo's `.git` is a directory; "linked" when it is a file
 * (a `git worktree`). Walk up from `p` without invoking git. */
function checkoutKind(p) {
  let dir = path.resolve(p);
  while (dir !== path.dirname(dir) && !fs.existsSync(dir)) dir = path.dirname(dir);
  try {
    if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
  } catch (_) {
    /* fall through to the walk */
  }
  for (let i = 0; i < 64; i++) {
    try {
      return fs.statSync(path.join(dir, ".git")).isDirectory() ? "main" : "linked";
    } catch (_) {
      /* no .git here */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function harnessVersion(root) {
  return safe(() => JSON.parse(fs.readFileSync(path.join(root, ".harness.json"), "utf8")).version, null);
}

function lastE2eRun(root) {
  return safe(
    () => {
      const p = path.join(root, ".serve", "mobile-e2e-last-run.json");
      const doc = JSON.parse(fs.readFileSync(p, "utf8"));
      const total = doc.total || doc.flows || doc.flowCount;
      const failed = doc.failed != null ? doc.failed : Array.isArray(doc.failures) ? doc.failures.length : null;
      return { at: doc.startedAt || doc.at || null, total: total != null ? total : null, failed, path: p };
    },
    null
  );
}

/* Read the board JSON via the canonical CLI so orient never re-implements the
 * board parser. Returns { inprogress, queued, open, active } or null. */
function boardSnapshot(root, run) {
  const r = run(["scripts/backlog.js", "list", "--all", "--json"]);
  if (!r) return null;
  return safe(() => JSON.parse(r), null);
}

function ownedFor(root, feature) {
  if (!feature) return null;
  const p = path.join(root, ".agents", "memory", "owned-files.md");
  const src = safe(() => fs.readFileSync(p, "utf8"), null);
  if (!src) return null;
  const re = new RegExp(`^\\s*[-*]\\s+${feature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*(.+)$`, "im");
  const m = src.match(re);
  return m ? m[1].trim() : null;
}

/* The feature this session is working: explicit flag, else the board's single
 * In-progress row, else the branch/dir name when it names a row. */
function inferFeature(explicit, branch, cwd, board) {
  if (explicit) return String(explicit).toUpperCase();
  const inprog = (board && board.inprogress) || [];
  if (inprog.length === 1) return String(inprog[0].id || "").toUpperCase() || null;
  const base = path.basename(String(cwd || "")).toUpperCase();
  const m = base.match(/^F-\d+/) || String(branch || "").toUpperCase().match(/^F-\d+/);
  return m ? m[0] : null;
}

/* The whole orientation as a plain object. `deps` injects git/run for tests. */
function collectOrient(opts = {}) {
  const root = path.resolve(opts.root || process.cwd());
  const runGit = opts.git || gitRunner(root);
  const runCmd = opts.run || null; // (argv[]) -> string|null, cwd=root
  const readCheckpoint = opts.readCheckpoint || checkpoint.readCheckpoint;

  const branch = safe(() => runGit(["rev-parse", "--abbrev-ref", "HEAD"]), null);
  const head = safe(() => runGit(["rev-parse", "--short", "HEAD"]), null);
  const status = safe(() => runGit(["status", "--porcelain"]), null);
  const dirty = status == null ? null : status.split(/\r?\n/).filter(Boolean).length;

  const board = runCmd ? boardSnapshot(root, (argv) => runCmd(argv)) : null;
  const feature = inferFeature(opts.feature, branch, root, board);
  const owned = ownedFor(root, feature);

  const ck = feature
    ? safe(() => readCheckpoint({ feature }), null)
    : null;
  const checkpointState = ck
    ? {
        feature: ck.feature,
        file: ck.file,
        phase: ck.state && ck.state.phase,
        nextAction: ck.state && ck.state.next_action,
        count: ck.state && ck.state.checkpoint_count,
      }
    : null;

  let cap = null;
  try {
    const s = capacity.sample(root);
    const ev = capacity.evaluate(s, {});
    cap = {
      ok: ev.ok,
      reasons: ev.reasons || [],
      line: capacity.formatSummary(s).split("\n")[0],
      serves: s.serves.filter((x) => x.alive).map((x) => x.name),
    };
  } catch (_) {
    cap = null;
  }

  return {
    schema: SCHEMA,
    root,
    repo: {
      kind: checkoutKind(root),
      branch,
      head,
      dirty,
    },
    feature,
    board: board
      ? {
          inprogress: (board.inprogress || []).map((r) => ({ id: r.id, task: r.task, handoff: r.handoff })),
          nextQueued: (board.queued || []).slice(0, 3).map((r) => ({ id: r.id, task: r.task, dependsOn: r.dependsOn })),
        }
      : null,
    ownedFiles: owned,
    checkpoint: checkpointState,
    capacity: cap,
    lastE2e: lastE2eRun(root),
    harnessVersion: harnessVersion(root),
  };
}

function fmt(v, label) {
  return v == null || v === "" ? `${label}: unavailable` : `${label}: ${v}`;
}

function printHuman(o) {
  const lines = [`Session orientation — ${o.root} (harness ${o.harnessVersion || "?"})`, ""];
  lines.push(`repo:    ${o.repo.kind || "outside-git"} @ ${o.repo.branch || "?"} (HEAD ${o.repo.head || "?"})`);
  lines.push(`dirty:   ${o.repo.dirty == null ? "unavailable" : o.repo.dirty + " file(s)"}`);
  lines.push(`feature: ${o.feature || "(none inferred — pass --feature <id>)"}`);
  lines.push(`owned:   ${o.ownedFiles || "unavailable"}`);
  if (o.checkpoint) {
    lines.push(`ckpt:    ${path.basename(o.checkpoint.file)} · phase ${o.checkpoint.phase || "?"} · count ${o.checkpoint.count || 0}`);
    if (o.checkpoint.nextAction) lines.push(`next:    ${o.checkpoint.nextAction}`);
  } else {
    lines.push("ckpt:    none (fresh work unit or feature has no checkpoint yet)");
  }
  if (o.board) {
    const ip = o.board.inprogress.map((r) => r.id).join(", ") || "none";
    lines.push(`board:   In progress [${ip}]`);
    if (o.board.nextQueued.length) {
      lines.push(`         next queued: ${o.board.nextQueued.map((r) => `${r.id} (${r.task || ""})`).join("; ")}`);
    }
  } else {
    lines.push("board:   unavailable (run `node scripts/backlog.js list` directly)");
  }
  if (o.capacity) {
    lines.push(`capacity: ${o.capacity.ok ? "ok" : "EXCEEDED — " + o.capacity.reasons.join("; ")}`);
    lines.push(`         ${o.capacity.line}`);
    lines.push(`serves:  ${o.capacity.serves.join(", ") || "none running"}`);
  } else {
    lines.push("capacity: unavailable");
  }
  lines.push(
    `last e2e: ${o.lastE2e ? `${o.lastE2e.failed || 0} failed / ${o.lastE2e.total != null ? o.lastE2e.total : "?"} (${o.lastE2e.at || "?"})` : "none recorded"}`
  );
  return lines.join("\n");
}

function parseArgs(argv) {
  const out = { feature: null, json: false, root: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--feature") out.feature = argv[++i];
    else if (a.startsWith("--feature=")) out.feature = a.slice("--feature=".length);
    else if (a === "--root") out.root = argv[++i];
    else if (a.startsWith("--root=")) out.root = a.slice("--root=".length);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: node scripts/orient.js [--feature <id>] [--json] [--root <dir>]");
    return;
  }
  // Run board/backlog subprocesses relative to the resolved root.
  const root = path.resolve(args.root || process.cwd());
  const runCmd = (argv) => {
    const r = spawnSync(process.execPath, argv, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15000,
    });
    return r.status === 0 && typeof r.stdout === "string" ? r.stdout : null;
  };
  const o = collectOrient({ root, feature: args.feature, run: runCmd });
  if (args.json) console.log(JSON.stringify(o, null, 2));
  else console.log(printHuman(o));
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error("orient: " + (e && e.message ? e.message : e));
    process.exit(1);
  }
}

module.exports = {
  SCHEMA,
  collectOrient,
  inferFeature,
  checkoutKind,
  ownedFor,
  lastE2eRun,
  boardSnapshot,
  gitRunner,
  parseArgs,
  printHuman,
  fmt,
};
