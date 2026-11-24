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
 * The same gatherer is exported for the `.opencode/plugins/orient.ts` wrapper and
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

function compareVersions(a, b) {
  const pa = String(a || "0").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "0").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

/* The cached update verdict written by `scripts/harness-update.js refresh` (spawned
 * detached at session start). Read-only on purpose: orient never touches the
 * network, so an offline/registry-less session pays nothing. */
function harnessUpdateCheck(root) {
  return safe(() => {
    const doc = JSON.parse(fs.readFileSync(path.join(root, ".serve", "harness-update.json"), "utf8"));
    const deployed = harnessVersion(root);
    const latest = typeof doc?.latest === "string" && doc.latest.trim() ? doc.latest.trim() : null;
    if (!deployed || !latest || compareVersions(deployed, latest) >= 0) return null;
    return {
      deployed,
      latest,
      command:
        typeof doc.command === "string" && doc.command
          ? doc.command
          : "npx opencode-agent-harness@latest update",
      checkedAt: typeof doc.checkedAt === "string" ? doc.checkedAt : null,
    };
  }, null);
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

/* The last nightly E2E cycle verdict, from `.agents/qa-runs/nightly/latest.json`
 * (written by scripts/nightly.js). This is the morning signal: a red nightly has
 * already reconciled the board (validated fixes / reopened rows / new rows). */
function latestNightly(root) {
  return safe(
    () => {
      const p = path.join(root, ".agents", "qa-runs", "nightly", "latest.json");
      const doc = JSON.parse(fs.readFileSync(p, "utf8"));
      const failures = Array.isArray(doc.failures) ? doc.failures : [];
      const reconcile = Array.isArray(doc.reconcile) ? doc.reconcile : [];
      return {
        verdict: doc.verdict || null,
        at: doc.finishedAt || doc.startedAt || doc.stamp || null,
        failed: failures.length,
        reopened: reconcile.filter((a) => a.kind === "reopen").length,
        added: reconcile.filter((a) => a.kind === "add").length,
        path: p,
      };
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

/* The memory files the operating rules name as session-start reads. Their
 * content is project-owned and open-ended, so orient does not attempt to
 * summarize prose — it extracts the stable, machine-shaped facts (the `##`
 * section index and the FIRST markdown table) and caps them, so a session can
 * often answer its orientation question without opening the file at all. */
const MEMORY_FILES = [
  "environments.md",
  "model-routing.md",
  "orchestration.md",
  "locations.md",
  "product-principles.md",
  "dev-loop.md",
];
const MAX_SECTIONS = 8;
const MAX_TABLE_ROWS = 6;
const MAX_CELL = 64;

function splitRow(line) {
  return String(line)
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim())
    .map((c) => (c.length > MAX_CELL ? c.slice(0, MAX_CELL - 1) + "\u2026" : c));
}

function isTableSeparator(line) {
  return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes("-");
}

/* First markdown table in the source: { header, rows } or null. Pure. */
function parseFirstTable(src) {
  const lines = String(src).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i])) continue;
    const header = splitRow(lines[i]);
    const sep = lines[i + 1];
    // A markdown table must have a separator row of dashes.
    if (!sep || !/^\s*\|/.test(sep) || !isTableSeparator(sep)) continue;
    const rows = [];
    for (let j = i + 2; j < lines.length && /^\s*\|/.test(lines[j]); j++) {
      const cells = splitRow(lines[j]);
      // Skip a blank placeholder row.
      if (cells.some((c) => c.length)) rows.push(cells);
      if (rows.length >= MAX_TABLE_ROWS) break;
    }
    return { header, rows };
  }
  return null;
}

/* `## ` section titles, capped. Pure. */
function parseSections(src) {
  const out = [];
  for (const line of String(src).split(/\r?\n/)) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m && m[1] && m[1] !== "Table of contents") out.push(m[1]);
    if (out.length >= MAX_SECTIONS) break;
  }
  return out;
}

/* Digest every session-start memory file: { file, exists, bytes, sections, table }. */
function memoryDigest(root) {
  return MEMORY_FILES.map((file) => {
    const abs = path.join(root, ".agents", "memory", file);
    const src = safe(() => fs.readFileSync(abs, "utf8"), null);
    if (src == null) return { file, exists: false };
    return {
      file,
      exists: true,
      bytes: Buffer.byteLength(src),
      sections: parseSections(src),
      table: parseFirstTable(src),
    };
  });
}

/* Render the digest as a bounded block for the human/brief output. */
function renderMemoryDigest(memory) {
  const lines = [];
  for (const m of memory || []) {
    if (!m.exists) continue;
    if (m.sections && m.sections.length) lines.push(`  ${m.file}: ${m.sections.join(" · ")}`);
    if (m.table) {
      lines.push(`    ${m.table.header.join(" | ")}`);
      for (const row of m.table.rows) lines.push(`    ${row.join(" | ")}`);
    }
  }
  return lines;
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

/* Compare a feature id ("F-246") to a branch/dir name ("f-246", "F-246-...")
 * ignoring case and separators. */
function normalizeId(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/* The linked worktree a feature actually lives in, when the session root is a
 * different checkout (the main tree). A /resume started in the main checkout
 * otherwise reads the main tree's clean status + a green `tsc` and mistakes them
 * for the feature's state; the work is uncommitted in the worktree. Returns
 * `{ path, branch }` or null. `git` is injectable for tests. */
function featureWorktree(feature, root, git) {
  if (!feature || typeof git !== "function") return null;
  const want = normalizeId(feature);
  if (!want) return null;
  const out = safe(() => git(["worktree", "list", "--porcelain"]), null);
  if (!out) return null;
  let cur = null;
  for (const line of String(out).split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice("worktree ".length).trim(), branch: "" };
    } else if (cur && line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "").trim();
      if (path.resolve(cur.path) === root) continue;
      if (normalizeId(path.basename(cur.path)) === want || normalizeId(cur.branch) === want) {
        return cur;
      }
    }
  }
  return null;
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
  // The feature may live in a linked worktree while this session is rooted in
  // the main checkout. Surface it — a green main `tsc` is not the feature's.
  const worktree = feature && checkoutKind(root) !== "linked" ? featureWorktree(feature, root, runGit) : null;

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
    // Non-null when the feature's work is in a linked worktree and this session
    // is rooted elsewhere (usually the main checkout): move before running tests.
    featureWorktree: worktree ? { path: worktree.path, branch: worktree.branch } : null,
    rootMismatch: Boolean(worktree),
    board: board
      ? {
          inprogress: (board.inprogress || []).map((r) => ({ id: r.id, task: r.task, handoff: r.handoff })),
          nextQueued: (board.queued || []).slice(0, 3).map((r) => ({ id: r.id, task: r.task, dependsOn: r.dependsOn })),
        }
      : null,
    ownedFiles: owned,
    checkpoint: checkpointState,
    capacity: cap,
    memory: memoryDigest(root),
    lastE2e: lastE2eRun(root),
    nightly: latestNightly(root),
    harnessVersion: harnessVersion(root),
    harnessUpdate: harnessUpdateCheck(root),
  };
}

function fmt(v, label) {
  return v == null || v === "" ? `${label}: unavailable` : `${label}: ${v}`;
}

function printHuman(o) {
  const lines = [`Session orientation — ${o.root} (harness ${o.harnessVersion || "?"})`, ""];
  if (o.harnessUpdate) {
    lines.push(
      `harness update: v${o.harnessUpdate.deployed} -> v${o.harnessUpdate.latest} available — ${o.harnessUpdate.command}`,
      "         (then restart opencode so the updated plugins/config load)",
      ""
    );
  }
  if (o.rootMismatch) {
    lines.push(
      `!! ROOT MISMATCH — ${o.feature} lives in the linked worktree ${o.featureWorktree.path} (branch ${o.featureWorktree.branch || "?"})`,
      `   This session is rooted in ${o.root}; status/tsc/tests run here describe a DIFFERENT tree.`,
      "   Move the session there (session_move / `opencode -s <id> <worktree>`) and re-run orient before doing work.",
      ""
    );
  }
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
  if (o.nightly) {
    const n = o.nightly;
    lines.push(
      `nightly:  ${(n.verdict || "?").toUpperCase()} (${n.at || "?"}) — ${n.failed} failing, ${n.reopened} reopened, ${n.added} new (${n.path})`
    );
  } else {
    lines.push("nightly:  none recorded (run `node scripts/nightly.js run`)");
  }
  const mem = renderMemoryDigest(o.memory);
  if (mem.length) {
    lines.push("memory digest (session-start reads — open a file only for detail):");
    lines.push(...mem);
  }
  // The two capabilities the field consistently under-uses (2-week recon: 12
  // `gates` calls vs 1539 hand-truncated gate invocations; 4 `where` calls vs
  // 1129 shell greps): name them where the model actually reads, not only in a
  // buried AGENTS.md bullet.
  lines.push(
    "tools:   gates (run a tier: `gates --phase=quick`) · where (find a symbol: `where <term>`) · orient (re-orient) — prefer these over `npm run … | tail` and shell grep/find"
  );
  return lines.join("\n");
}

/* Compact single-block render for session-start injection: the actionable
 * orientation facts only, bounded so it can ride a plugin nudge without
 * dominating context. */
function printBrief(o) {
  const lines = [];
  lines.push(
    `SESSION ORIENT — ${o.repo.kind || "outside-git"} @ ${o.repo.branch || "?"} (HEAD ${o.repo.head || "?"}, ${o.repo.dirty == null ? "?" : o.repo.dirty} dirty)`
  );
  lines.push(
    `harness ${o.harnessVersion || "?"}${o.harnessUpdate ? ` -> v${o.harnessUpdate.latest} available (${o.harnessUpdate.command})` : ""} · root ${o.root}`
  );
  if (o.rootMismatch) {
    lines.push(
      `!! ROOT MISMATCH — ${o.feature} lives in worktree ${o.featureWorktree.path}; move the session there BEFORE running anything (this root's tsc/status are a different tree).`
    );
  }
  if (o.feature) lines.push(`feature ${o.feature}${o.ownedFiles ? ` · owns ${o.ownedFiles}` : ""}`);
  if (o.checkpoint) lines.push(`checkpoint ${o.checkpoint.phase || "?"} · next: ${o.checkpoint.nextAction || "?"}`);
  if (o.board) {
    const ip = o.board.inprogress.map((r) => r.id).join(", ") || "none";
    lines.push(`board In progress [${ip}]${o.board.nextQueued.length ? ` · next ${o.board.nextQueued.map((r) => r.id).join(", ")}` : ""}`);
  }
  if (o.capacity) lines.push(`capacity ${o.capacity.ok ? "ok" : "EXCEEDED: " + o.capacity.reasons.join("; ")} · serves ${o.capacity.serves.join(", ") || "none"}`);
  if (o.lastE2e) lines.push(`last e2e ${o.lastE2e.failed || 0} failed / ${o.lastE2e.total != null ? o.lastE2e.total : "?"}`);
  if (o.nightly) lines.push(`nightly ${(o.nightly.verdict || "?").toUpperCase()} — ${o.nightly.failed} failing, ${o.nightly.reopened} reopened, ${o.nightly.added} new`);
  const mem = renderMemoryDigest(o.memory);
  if (mem.length) {
    lines.push("memory digest (open a file only for detail):");
    lines.push(...mem);
  }
  lines.push("Proceed from the checkpoint/next; do not re-derive git/serve/capacity state by hand.");
  lines.push("tools: gates (run a tier) · where (find a symbol) · orient — not `npm run … | tail` / shell grep.");
  return lines.join("\n");
}

function parseArgs(argv) {
  const out = { feature: null, json: false, brief: false, root: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--brief") out.brief = true;
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
    console.log("Usage: node scripts/orient.js [--feature <id>] [--json] [--brief] [--root <dir>]");
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
  else if (args.brief) console.log(printBrief(o));
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
  MEMORY_FILES,
  collectOrient,
  inferFeature,
  featureWorktree,
  checkoutKind,
  ownedFor,
  parseFirstTable,
  parseSections,
  memoryDigest,
  renderMemoryDigest,
  lastE2eRun,
  latestNightly,
  boardSnapshot,
  gitRunner,
  parseArgs,
  printHuman,
  printBrief,
  fmt,
};
