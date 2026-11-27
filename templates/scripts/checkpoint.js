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

/* The inquiry-loop parser (F-040). Optional so an older deploy still resumes
 * without the diagnosis artifact. */
let diagnosisLib = null;
try {
  diagnosisLib = require("./qa/diagnosis-lib.js");
} catch (_) {
  diagnosisLib = null;
}

/* One case/separator-insensitive feature resolver shared by checkpoint, orient,
 * finalize and backlog (F-046). Optional so an older deploy still runs; when it
 * is absent, `resolveHandoff` falls back to the legacy exact-name lookup. */
let featureResolver = null;
try {
  featureResolver = require("./qa/feature-resolver.js");
} catch (_) {
  featureResolver = null;
}

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
    if (a === "--feature") {
      out.feature = argv[++i];
      out.featureSet = true;
    } else if (a === "--root") out.root = argv[++i];
    else if (a === "--json") out.json = true;
    else if (a === "--list") out.list = true;
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

/* Resolve a requested feature id to its canonical spelling and the one handoff
 * file across this repo's checkouts (its worktree, this checkout, then main).
 * The resolver compares ids with case and separators ignored, so `f-045` finds
 * `F-045.md` instead of interpolating a second, nonexistent filename. */
function resolveHandoff(feature) {
  if (featureResolver) return featureResolver.resolveFeature(root, feature);
  const base = featureWorktreeRoot(feature) || root;
  const file = path.join(base, ".agents", "handoffs", feature + ".md");
  const exists = fs.existsSync(file);
  return {
    input: feature,
    id: feature,
    source: null,
    file: exists ? path.resolve(file) : null,
    fileRoot: exists ? path.resolve(base) : null,
    worktree: featureWorktreeRoot(feature) ? { path: featureWorktreeRoot(feature), branch: "" } : null,
    roots: [base, root],
    suggestions: [],
  };
}

/* Where a write belongs: an existing handoff in any checkout wins (so a
 * lowercase write updates `F-045.md` instead of creating a second file), else
 * the feature's linked worktree (the state belongs where the work lives), else
 * this checkout. Always the canonical filename. */
function handoffPath(feature) {
  const res = resolveHandoff(feature);
  if (res.file) return path.resolve(res.file);
  const base = (res.worktree && res.worktree.path) || root;
  return path.join(base, ".agents", "handoffs", res.id + ".md");
}

/* Read-only diagnosis state carried by `resume` (F-040). The artifact is never
 * rewritten here: a conclusion proven at another HEAD/version is flagged stale
 * so the resumed session revalidates instead of trusting it. */
function gitHead(dir) {
  const res = spawnSync("git", ["-C", dir, "rev-parse", "--short", "HEAD"], { encoding: "utf8" });
  const out = res.status === 0 && typeof res.stdout === "string" ? res.stdout.trim() : "";
  return out || null;
}

function harnessVersionAt(dir) {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(dir, ".harness.json"), "utf8"));
    return doc && typeof doc.version === "string" && doc.version.trim() ? doc.version.trim() : null;
  } catch (_) {
    return null;
  }
}

/* Up to `limit` unanswered questions from the diagnosis's `## Open questions`.
 * A placeholder ("?", "none") is not a question. Pure read. */
function openQuestions(text, limit = 3) {
  if (!diagnosisLib) return [];
  const section = (diagnosisLib.sectionsOf(text) || []).find((s) => /^Open questions\b/i.test(s.name));
  if (!section) return [];
  const out = [];
  for (const raw of section.lines) {
    const m = String(raw).trim().match(/^[-*+]\s+(.+)$/);
    if (!m) continue;
    const q = m[1].trim();
    if (diagnosisLib.isBlank(q) || /^none\b/i.test(q)) continue;
    out.push(q);
    if (out.length >= limit) break;
  }
  return out;
}

function diagnosisState(feature, baseRoot) {
  if (!diagnosisLib) return null;
  let rec = null;
  try {
    rec = diagnosisLib.readFeature(baseRoot, feature);
  } catch (_) {
    rec = null;
  }
  if (!rec) return null;
  const errors = Array.isArray(rec.errors) ? rec.errors : [];
  let stale = null;
  try {
    stale = diagnosisLib.staleReason(rec, rec.diagnosisText, {
      head: gitHead(baseRoot),
      harnessVersion: harnessVersionAt(baseRoot),
    });
  } catch (_) {
    stale = null;
  }
  return {
    id: (rec.meta && rec.meta.id) || feature,
    kind: (rec.meta && rec.meta.kind) || null,
    required: Boolean(rec.required),
    ok: Boolean(rec.ok),
    status: rec.status || null,
    confidence: rec.confidence || null,
    stale: stale || null,
    questions: openQuestions(rec.diagnosisText),
    errors,
  };
}

function renderDiagnosisBrief(d) {
  if (!d) return [];
  const lines = [];
  if (d.required && !d.ok) {
    const missing = (d.errors || []).some((e) => e.code === "missing");
    const detail = missing
      ? "run /diagnose before editing"
      : (d.errors[0] && d.errors[0].message) || "fix the diagnosis before editing";
    lines.push(`diagnosis: ${missing ? "MISSING" : "INVALID"} (kind=${d.kind || "?"}) — ${detail}`);
  } else if (!d.required) {
    lines.push(`diagnosis: not required (${d.kind ? `kind=${d.kind}` : "legacy feature"})`);
  } else {
    lines.push(`diagnosis: ${d.status || "open"} (${d.confidence || "?"})`);
  }
  if (d.stale) lines.push(`stale: ${d.stale} — revalidate before trusting the conclusion`);
  for (const q of d.questions || []) lines.push(`open question: ${q}`);
  return lines;
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
  const requested = assertFeature(args.feature, "write");
  const resolved = resolveHandoff(requested);
  const feature = resolved.id;
  const hasState =
    Object.values(args.scalars).some((v) => v != null && String(v).trim()) ||
    Object.values(args.lists).some((v) => v && v.length);
  if (!hasState) throw new Error("refusing to write an empty checkpoint — record at least one state field");

  const file = resolved.file
    ? path.resolve(resolved.file)
    : path.join((resolved.worktree && resolved.worktree.path) || root, ".agents", "handoffs", feature + ".md");
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
  const requested = assertFeature(args.feature, "resume");
  const resolved = resolveHandoff(requested);
  const feature = resolved.id;
  if (!resolved.file) {
    const searched = (resolved.roots || [])
      .map((dir) => path.join(dir, ".agents", "handoffs"))
      .join(", ");
    const suggestions = resolved.suggestions || [];
    const hint = suggestions.length ? ` — did you mean ${suggestions.join(", ")}?` : "";
    throw new Error(`no handoff found for "${requested}"${hint}${searched ? ` (searched ${searched})` : ""}`);
  }
  const file = path.resolve(resolved.file);
  const parts = splitCheckpoint(fs.readFileSync(file, "utf8"));
  if (!parts.body) throw new Error(`"${feature}" has no ## Checkpoint block yet — run checkpoint write first`);
  const stateRoot = resolved.fileRoot || root;
  return {
    input: requested,
    feature,
    source: resolved.source,
    suggestions: resolved.suggestions || [],
    file,
    fileRoot: stateRoot,
    root,
    // The feature's linked worktree, when one exists — the tree its work (and
    // therefore tsc/tests) belongs to, independent of where the handoff lives.
    worktree: (resolved.worktree && resolved.worktree.path) || null,
    body: parts.body.trim(),
    state: parseBlock(parts.body),
    // Resolve the diagnosis where the feature actually lives, like the handoff.
    diagnosis: diagnosisState(feature, stateRoot),
  };
}

/* The state of one handoff, or null when it has no checkpoint block. */
function summaryOf(feature, file) {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (_) {
    return null;
  }
  const parts = splitCheckpoint(text);
  if (!parts.body) return null;
  const state = parseBlock(parts.body);
  let updated = 0;
  try {
    updated = fs.statSync(file).mtimeMs;
  } catch (_) {
    updated = 0;
  }
  return {
    feature,
    file: path.resolve(file),
    phase: state.phase || null,
    nextAction: state.next_action || null,
    count: Number(state.checkpoint_count) || 0,
    updated,
  };
}

/* Resumable checkpoints, most actionable first: the board's In-progress rows
 * (honoring a declared slug handoff) and, when the board is unavailable or
 * empty, the most recently written handoffs that carry a checkpoint block.
 * This is the anti-guessing surface for a fresh context that does not know the
 * feature id — it answers "which checkpoint?" without a 250-file glob. */
function listResumable(limit = 10) {
  const out = [];
  const seen = new Set();
  const add = (feature, file) => {
    if (!file) return;
    const abs = path.resolve(file);
    if (seen.has(abs)) return;
    const row = summaryOf(feature, abs);
    if (!row) return;
    seen.add(abs);
    out.push(row);
  };

  const rows = featureResolver && typeof featureResolver.boardRows === "function" ? featureResolver.boardRows(root) : [];
  for (const row of rows) {
    const resolved = resolveHandoff(row.id);
    if (resolved.file) add(row.id, resolved.file);
  }

  if (!out.length) {
    const roots =
      featureResolver && typeof featureResolver.rootsFor === "function"
        ? featureResolver.rootsFor("", root)
        : [root];
    const hs = featureResolver && typeof featureResolver.handoffs === "function" ? featureResolver.handoffs(roots) : [];
    for (const h of hs) {
      const summary = summaryOf(h.id, h.file);
      if (summary) summary.updated = summary.updated || 0;
      if (summary) add(h.id, h.file);
    }
    out.sort((a, b) => b.updated - a.updated || a.feature.localeCompare(b.feature));
  }

  return out.slice(0, Math.max(1, Number(limit) || 10));
}

function renderResumable(rows) {
  const lines = [`resumable checkpoints (${rows.length}):`];
  for (const r of rows) {
    const rel = path.relative(root, r.file).split(path.sep).join("/");
    lines.push(`  ${r.feature} · phase ${r.phase || "?"} · next: ${r.nextAction || "?"} [${rel}]`);
  }
  lines.push("resume one: node scripts/checkpoint.js resume --feature <id>");
  return lines.join("\n");
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
    if (args.list || !args.featureSet) {
      const rows = listResumable();
      if (args.json) {
        console.log(JSON.stringify({ schema: "checkpoint-list/1", root, checkpoints: rows }, null, 2));
        return;
      }
      console.log(renderResumable(rows));
      return;
    }
    const r = readCheckpoint(args);
    if (args.json) {
      console.log(
        JSON.stringify(
          {
            schema: SCHEMA,
            input: r.input,
            feature: r.feature,
            source: r.source,
            file: r.file,
            fileRoot: r.fileRoot,
            suggestions: r.suggestions,
            state: r.state,
            root: r.root,
            worktree: r.worktree,
            diagnosis: r.diagnosis,
          },
          null,
          2
        )
      );
      return;
    }
    // The handoff is resolved through the feature's linked worktree, so a session
    // still rooted in the main checkout would otherwise read the right state and
    // then run tsc/tests against the wrong tree. Say which root the state belongs to.
    if (r.worktree && path.resolve(r.worktree) !== path.resolve(r.root)) {
      console.log(
        `> ROOT MISMATCH — ${r.feature}'s work lives in ${r.worktree}, but this session is rooted in ${r.root}.\n` +
          `> Move the session there with tools.opencode.session.move (directory: "${r.worktree}") before running tsc/tests; this root is a different tree.\n`
      );
    } else if (r.fileRoot && path.resolve(r.fileRoot) !== path.resolve(r.root)) {
      console.log(
        `> handoff lives in another checkout of this repo: ${r.fileRoot} — this session is rooted in ${r.root}.\n`
      );
    }
    console.log(`> handoff: ${r.file}${r.input && r.input !== r.feature ? ` (resolved from "${r.input}")` : ""}`);
    console.log(r.body);
    const dLines = renderDiagnosisBrief(r.diagnosis);
    if (dLines.length) console.log("\n" + dLines.join("\n"));
    return;
  }
  console.error(
    "Usage: node scripts/checkpoint.js write --feature <id> [--objective ...] [--phase ...]\n" +
      "         [--completed item]... [--active item]... [--files-changed path]... [--contracts item]...\n" +
      "         [--facts item]... [--decisions item]... [--risks item]... [--next-action ...] [--session <ses_...>]\n" +
      "       node scripts/checkpoint.js resume --feature <id> [--json]\n" +
      "       node scripts/checkpoint.js resume --list [--json]"
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

module.exports = {
  SCHEMA,
  splitCheckpoint,
  renderBlock,
  parseBlock,
  writeCheckpoint,
  readCheckpoint,
  listResumable,
  summaryOf,
  handoffPath,
  assertFeature,
  diagnosisState,
  openQuestions,
  renderDiagnosisBrief,
};
