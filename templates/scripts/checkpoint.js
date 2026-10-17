#!/usr/bin/env node
"use strict";
/*
 * checkpoint — deterministic bounded-state checkpoint for one session handoff.
 *
 * Writes the compact state block described in `.agents/rules/00-operating.md`
 * §Context budget & lifecycle (objective/phase, completed + active dispatches,
 * files changed, contracts, known facts, decisions, risks, next_action) into
 * `.agents/handoffs/<feature>.md`, replacing only its own `## Checkpoint`
 * section. `resume` prints that block alone — the bounded context a fresh
 * session reads instead of replaying the transcript.
 *
 * Deterministic: no timestamps, stable ordering, `unknown` for anything not
 * recorded (never invented). Writing identical state is a no-op; changing it
 * increments `checkpoint_count`.
 *
 * Usage:
 *   node scripts/checkpoint.js write --feature F-001 [--objective ...] [--phase ...]
 *     [--completed item]... [--active item]... [--files-changed path]...
 *     [--contracts item]... [--facts item]... [--decisions item]... [--risks item]...
 *     [--next-action ...] [--session ses_...]
 *   node scripts/checkpoint.js resume --feature F-001 [--json]
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

/* The project root. Resolve from an explicit `--root <dir>` when given, else
 * `process.cwd()` when it looks like a project root, and only fall back to
 * `__dirname/..`. Under the harness dogfood the repo `scripts` dir is symlinked
 * to `templates/scripts`; Node realpaths the script, so `__dirname/..` is
 * `templates/` — writing a checkpoint into the tree `update` ships to every
 * project (F-26/H-49). The tool wrappers spawn this CLI with `cwd` = session
 * directory (see `scripts/qa/tool-lib.js` sessionRoot()), so cwd is the tree. */
function looksLikeRoot(dir) {
  return fs.existsSync(path.join(dir, ".agents")) || fs.existsSync(path.join(dir, ".git"));
}

function resolveRoot(argv, cwd) {
  const i = Array.isArray(argv) ? argv.indexOf("--root") : -1;
  if (i !== -1 && argv[i + 1]) return path.resolve(argv[i + 1]);
  const c = cwd || process.cwd();
  if (looksLikeRoot(c)) return c;
  return path.resolve(__dirname, "..");
}

let root = resolveRoot(process.argv.slice(2), process.cwd());
const SCHEMA = "checkpoint/1";
const HEADING_RE = /^#{1,6}\s*Checkpoint\b.*$/im;
const MARKER = "<!-- agent-harness checkpoint — machine-written; edit via scripts/checkpoint.js -->";

const SCALARS = [
  ["feature", "feature"],
  ["objective", "objective"],
  ["phase", "phase"],
  ["next_action", "next_action"],
  ["session", "session"],
];
const LISTS = [
  ["completed", "completed"],
  ["active", "active"],
  ["files_changed", "filesChanged"],
  ["contracts", "contracts"],
  ["known_facts", "facts"],
  ["decisions", "decisions"],
  ["risks", "risks"],
];

function parseArgs(argv) {
  const out = { _: [], lists: {}, scalars: {} };
  const listFlags = new Set(LISTS.map(([key]) => key));
  const scalarFlags = new Set(["objective", "phase", "next-action", "session"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--feature") out.feature = argv[++i];
    else if (a === "--root") out.root = argv[++i];
    else if (a === "--json") out.json = true;
    else if (a.startsWith("--") && listFlags.has(a.slice(2))) {
      const key = a.slice(2);
      if (!out.lists[key]) out.lists[key] = [];
      for (const item of String(argv[++i] || "").split(/\s*;\s*/)) if (item.trim()) out.lists[key].push(item.trim());
    } else if (a.startsWith("--") && scalarFlags.has(a.slice(2))) {
      out.scalars[a.slice(2).replace(/-/g, "_")] = argv[++i];
    } else out._.push(a);
  }
  return out;
}

/* Compare a feature id ("F-246") to a branch/dir name ("f-246", "F-246-...")
 * ignoring case and separators. */
function normalizeId(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/* When the session root is the MAIN tree but the feature has its own linked
 * worktree (the mid-session-reroot case that is missed when `backlog worktree`
 * is invoked via bash and no session pointer is recorded), the handoff belongs
 * in the tree the work actually lives in. Returns the worktree path or null. */
function featureWorktreeRoot(feature) {
  const res = spawnSync("git", ["-C", root, "worktree", "list", "--porcelain"], { encoding: "utf8" });
  if (res.status !== 0) return null;
  const want = normalizeId(feature);
  let cur = null;
  for (const line of String(res.stdout || "").split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice("worktree ".length).trim(), branch: "" };
    } else if (cur && line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "").trim();
      if (path.resolve(cur.path) === root) continue;
      if (normalizeId(path.basename(cur.path)) === want || normalizeId(cur.branch) === want) {
        return cur.path;
      }
    }
  }
  return null;
}

function handoffPath(feature) {
  const base = featureWorktreeRoot(feature) || root;
  return path.join(base, ".agents", "handoffs", feature + ".md");
}

/* A feature id must be a real slug. Reject the stringified sentinels a tool
 * wrapper produces from an unset arg (`undefined`/`null`), which otherwise
 * match the slug regex and silently write a `.agents/handoffs/undefined.md`
 * (the H-14 stray-handoff defect: `.agents/handoffs/undefined.md` left on main
 * by a `checkpoint_write` call that omitted `feature`). */
const RESERVED_FEATURE = new Set(["undefined", "null", "none", "nan", "nil"]);
function assertFeature(raw, verb) {
  const feature = String(raw == null ? "" : raw).trim();
  if (!feature || RESERVED_FEATURE.has(feature.toLowerCase()) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(feature)) {
    throw new Error(
      `${verb} requires --feature <id or slug> (letters, digits, dot, dash, underscore); ` +
        `refusing the value ${JSON.stringify(raw == null ? "" : raw)} — pass the BACKLOG row id (e.g. F-001)`
    );
  }
  return feature;
}

/* Split the file into [before, checkpointBody, after] around the existing
 * `## Checkpoint` section (until the next heading), any of which may be null. */
function splitCheckpoint(src) {
  const m = src.match(HEADING_RE);
  if (!m) return { before: src, body: null, after: "" };
  const start = m.index;
  const rest = src.slice(start + m[0].length);
  const next = rest.match(/^#{1,6}\s/m);
  const end = next ? start + m[0].length + next.index : src.length;
  return { before: src.slice(0, start), body: src.slice(start, end), after: src.slice(end) };
}

function countOf(body) {
  const m = body && body.match(/^- checkpoint_count:\s*(\d+)\s*$/m);
  return m ? Number(m[1]) : 0;
}

function renderBlock(args, feature, count) {
  const lines = ["## Checkpoint (resume)", "", MARKER, ""];
  for (const [label, key] of SCALARS) {
    lines.push(`- ${label}: ${args.scalars[key] || (key === "feature" ? feature : "unknown")}`);
  }
  for (const [label] of LISTS) {
    lines.push(`- ${label}:`);
    const items = args.lists[label] || [];
    if (items.length === 0) lines.push("  - (none recorded)");
    else for (const item of items) lines.push(`  - ${item}`);
  }
  lines.push(`- checkpoint_count: ${count}`);
  return lines.join("\n") + "\n";
}

function writeCheckpoint(args) {
  const feature = assertFeature(args.feature, "write");
  const hasState =
    Object.values(args.scalars).some((v) => v != null && String(v).trim()) ||
    Object.values(args.lists).some((v) => v && v.length);
  if (!hasState) throw new Error("refusing to write an empty checkpoint — record at least one state field");

  const file = handoffPath(feature);
  const existed = fs.existsSync(file);
  const src = existed ? fs.readFileSync(file, "utf8") : "";
  const parts = splitCheckpoint(src);
  const existingCount = countOf(parts.body);
  const sameBlock = parts.body ? renderBlock(args, feature, existingCount) : null;
  if (sameBlock && parts.body.trim() === sameBlock.trim()) {
    return { feature, file, changed: false, count: existingCount, created: false };
  }
  const block = renderBlock(args, feature, existingCount + 1);
  const nextCount = existingCount + 1;

  const before = parts.before.replace(/\s*$/, "");
  const after = parts.after.replace(/^\s*/, "");
  // A checkpoint can create the handoff before the session wraps up, so the new
  // file carries an honest placeholder dispatch-log line — `test:governance`
  // never blocks on a mid-session checkpoint, and the handoff skill replaces
  // the line with the real log at wrap-up.
  const head = existed
    ? before
    : `# Where we stopped (handoff) — ${feature}\n\nDate: unknown\n\n## Dispatch log\n- (checkpoint only — dispatch log recorded at wrap-up)\n`;
  const body = [head, "", block.trim(), after ? "\n" + after : ""].join("\n").replace(/\n{4,}/g, "\n\n\n");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body.endsWith("\n") ? body : body + "\n", "utf8");
  return { feature, file, changed: true, count: nextCount, created: !existed };
}

function parseBlock(body) {
  const state = {};
  let current = null;
  for (const raw of String(body || "").split(/\r?\n/)) {
    const scalar = raw.match(/^- ([a-z_]+):\s*(.*)$/);
    if (scalar) {
      current = null;
      if (scalar[2] === "") current = scalar[1];
      else state[scalar[1]] = scalar[2];
      continue;
    }
    const item = raw.match(/^\s{2,}- (.*)$/);
    if (item && current) {
      if (!Array.isArray(state[current])) state[current] = [];
      if (item[1] !== "(none recorded)") state[current].push(item[1]);
    }
  }
  if (Array.isArray(state.checkpoint_count)) state.checkpoint_count = Number(state.checkpoint_count[0] || 0);
  else state.checkpoint_count = Number(state.checkpoint_count || 0);
  return state;
}

function readCheckpoint(args) {
  const feature = assertFeature(args.feature, "resume");
  const file = handoffPath(feature);
  if (!fs.existsSync(file)) throw new Error(`no handoff found for "${feature}" (${path.relative(root, file)})`);
  const parts = splitCheckpoint(fs.readFileSync(file, "utf8"));
  if (!parts.body) throw new Error(`"${feature}" has no ## Checkpoint block yet — run checkpoint write first`);
  return { feature, file, body: parts.body.trim(), state: parseBlock(parts.body) };
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));
  if (cmd === "write") {
    const r = writeCheckpoint(args);
    if (r.changed) {
      console.log(
        `checkpoint: ${r.created ? "created" : "updated"} ${path.relative(root, r.file).split(path.sep).join("/")} (checkpoint_count ${r.count})`
      );
    } else {
      console.log(`checkpoint: ${path.relative(root, r.file).split(path.sep).join("/")} already matches — unchanged`);
    }
    return;
  }
  if (cmd === "resume") {
    const r = readCheckpoint(args);
    if (args.json) {
      console.log(JSON.stringify({ schema: SCHEMA, feature: r.feature, state: r.state }, null, 2));
      return;
    }
    console.log(r.body);
    return;
  }
  console.error(
    "Usage: node scripts/checkpoint.js write --feature <id> [--objective ...] [--phase ...]\n" +
      "         [--completed item]... [--active item]... [--files-changed path]... [--contracts item]...\n" +
      "         [--facts item]... [--decisions item]... [--risks item]... [--next-action ...] [--session <ses_...>]\n" +
      "       node scripts/checkpoint.js resume --feature <id> [--json]"
  );
  process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error("checkpoint: " + (e && e.message ? e.message : e));
    process.exit(1);
  }
}

module.exports = { SCHEMA, splitCheckpoint, renderBlock, parseBlock, writeCheckpoint, readCheckpoint, handoffPath, assertFeature };
