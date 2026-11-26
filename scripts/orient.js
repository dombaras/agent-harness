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
const dispatchPersona = require("./qa/dispatch-persona.js");

/* The inquiry-loop parser (F-040). Optional on purpose: an older deploy may not
 * ship `qa/diagnosis-lib.js`, and orient must still orient. */
let diagnosisLib = null;
try {
  diagnosisLib = require("./qa/diagnosis-lib.js");
} catch (_) {
  diagnosisLib = null;
}

/* F-067: the fallback writer also owns the heartbeat (`.agents/auto-checkpoint.json`)
 * — the only evidence an unobserved end (SIGKILL/OOM/power loss) leaves behind.
 * Optional on purpose: an older deploy must still orient. */
let fallbackLib = null;
try {
  fallbackLib = require("./qa/checkpoint-fallback.js");
} catch (_) {
  fallbackLib = null;
}

const SCHEMA = "orient/1";

function safe(fn, fallback = null) {
  try {
    const v = fn();
    return v == null ? fallback : v;
  } catch (_) {
    return fallback;
  }
}

/* Orientation must stay bounded even when a checkpoint records a long next
 * action: the full text lives in the handoff (F-058). */
function clipText(value, max) {
  const s = String(value == null ? "" : value);
  return s.length > max ? s.slice(0, Math.max(0, max - 1)).replace(/\s+$/, "") + "…" : s;
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

/* Deploy != activate: the freshness verdict written by the live opencode service
 * names the deployed build and, best-effort, the build the service actually
 * loaded. Without it `orient` reports the disk version as if it were running.
 * Two lifetimes (F-045): a `restart-needed` verdict dies with its writer process;
 * a `blocked` verdict belongs to the tree and survives it. A legacy `refreshed`
 * record (pre-F-045 success) is read as restart-needed once the deployed version
 * equals its `latest`. */
function freshnessVerdict(root, status) {
  return safe(() => {
    const statusPath = path.join(root, ".serve", "harness-freshness.json");
    const doc = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    const legacy = status === "restart-needed" && doc?.status === "refreshed";
    if (doc?.status !== status && !legacy) return null;
    const deployed = harnessVersion(root);
    const latest = typeof doc.latest === "string" && doc.latest.trim() ? doc.latest.trim() : null;
    let have = typeof doc.have === "string" && doc.have.trim() ? doc.have.trim() : null;
    let active = typeof doc.active === "string" && doc.active.trim() ? doc.active.trim() : null;
    if (legacy) {
      if (!deployed || !latest || deployed !== latest) return null;
      active = have; // the old build the record named before the deploy
      have = deployed;
    }
    if (deployed && have && deployed !== have) return null;
    const wrote = Number(doc.wrote);
    const cfg = path.join(root, ".harness.json");
    if (Number.isFinite(wrote) && fs.statSync(cfg).mtimeMs > wrote + 1000) return null;
    if (status === "restart-needed") {
      const pid = doc.pid;
      if (pid !== undefined && pid !== null) {
        const n = Number(pid);
        if (!Number.isInteger(n) || n <= 0) return null;
        try {
          process.kill(n, 0);
        } catch (err) {
          if (err?.code !== "EPERM") return null;
        }
      }
    }
    return { ...doc, status, have, ...(active ? { active } : {}) };
  }, null);
}

function harnessRestart(root) {
  const doc = freshnessVerdict(root, "restart-needed");
  if (!doc) return null;
  const deployed = harnessVersion(root);
  const active = typeof doc.active === "string" && doc.active.trim() ? doc.active.trim() : null;
  return { deployed: deployed || doc.have || null, active };
}

/* A blocked verdict is the persistent "the automatic update did NOT happen"
 * signal (F-044). The update cache can still name npm's older release, so
 * without this the orientation line reads the stale version as current. */
function harnessBlocked(root) {
  const doc = freshnessVerdict(root, "blocked");
  if (!doc) return null;
  const reason =
    typeof doc.reason === "string" && doc.reason.trim() ? doc.reason.trim() : "update blocked";
  return { reason };
}

/* One status phrase shared by the human and brief renderers: name the build the
 * service loaded first, then the deployed target, so neither reads as active. */
function harnessStatus(o) {
  const deployed = o.harnessVersion || "?";
  if (!o.harnessRestart) {
    if (!o.harnessBlocked) return `harness ${deployed}`;
    const reason =
      o.harnessBlocked.reason === "update failed"
        ? "update failed"
        : o.harnessBlocked.reason === "update available"
          ? "update pending"
          : "update blocked";
    return `harness ${deployed} (${reason})`;
  }
  const active = o.harnessRestart.active;
  return `harness ${active && active !== deployed ? `${active} → ` : ""}${deployed} (restart needed)`;
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

/* Feedback inbox (F-050 Phase 1): the ledger is shared machine state in the main
 * checkout, so a feature worktree reads the same inbox. Read-only and bounded —
 * a missing or corrupt ledger degrades to a plain "unavailable" line. */
function feedbackState(root) {
  try {
    const feedback = require("./feedback.js");
    const lib = require("./qa/feedback-lib.js");
    const items = feedback.readItems(feedback.ledgerDir(root, {}));
    let policy = null;
    try {
      policy = feedback.loadPolicy(root);
    } catch {
      policy = null;
    }
    const m = lib.metrics(items, new Date().toISOString());
    const open = items
      .filter((i) => !["resolved", "ignored"].includes(i.state))
      .sort((a, b) => String(a.first_seen).localeCompare(String(b.first_seen)));
    const oldest = open[0] || null;
    return {
      open: m.open,
      total: m.total,
      observations: m.observations,
      mode: policy ? policy.mode : null,
      enabled: policy ? lib.loopEnabled(policy) : false,
      oldest: oldest
        ? {
            id: oldest.id,
            severity: oldest.severity,
            ageHours: Math.max(0, Math.round((Date.now() - Date.parse(oldest.first_seen)) / 3600000)),
          }
        : null,
    };
  } catch (e) {
    return { unavailable: true, error: e && e.message ? e.message : String(e) };
  }
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

/* An In-progress row's Handoff cell becomes
 * ".agents/handoffs/F-062.md (worktree: ../.worktrees/x/f-062; branch: f-062)"
 * when `backlog.js worktree` pinned it to an isolated tree. Split it so the
 * session-start brief can name the row's title + where it lives: printing ids
 * only made a cleared session spend seven discovery calls before any work
 * (2026-11-27), even though orient had already read this cell. */
function parseHandoffCell(cell) {
  const raw = String(cell == null ? "" : cell).trim();
  const m = /^(.*?)\s*\(worktree:\s*([^;)]+?);\s*branch:\s*([^)]+?)\)\s*$/.exec(raw);
  if (!m) return { handoff: raw, worktree: null, branch: null };
  return { handoff: (m[1] || "").trim(), worktree: m[2].trim(), branch: m[3].trim() };
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

/* The active feature's doc chain (F-063). A cleared session otherwise globs for
 * `.agents/features/<dir>/{intent,scope,plan,tests}.md` after orient. Locate the
 * dir by its own name (f-063, f-063-*) or by the `id` in its meta.json, then
 * report each expected doc present/missing. Read-only and bounded. */
const FEATURE_DOC_FILES = ["intent", "scope", "plan", "tests"];

function featureDocs(root, feature) {
  if (!feature) return null;
  const base = path.join(root, ".agents", "features");
  const want = normalizeId(feature);
  if (!want) return null;
  const entries = safe(
    () =>
      fs
        .readdirSync(base, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort(),
    null
  );
  if (!entries) return { id: feature, dir: null, present: [], missing: FEATURE_DOC_FILES.slice(), none: true };
  // `f-063` matches `f-063-*` but not `f-0630` (a different feature id).
  const prefix = new RegExp(`^${want}([^0-9]|$)`);
  let name = entries.find((n) => normalizeId(n) === want) || entries.find((n) => prefix.test(normalizeId(n)));
  if (!name) {
    name =
      entries.find((n) => {
        const meta = safe(() => JSON.parse(fs.readFileSync(path.join(base, n, "meta.json"), "utf8")), null);
        return meta && normalizeId(meta.id) === want;
      }) || null;
  }
  if (!name) return { id: feature, dir: null, present: [], missing: FEATURE_DOC_FILES.slice(), none: true };
  const dir = path.join(base, name);
  const present = [];
  const missing = [];
  for (const doc of FEATURE_DOC_FILES) {
    if (fs.existsSync(path.join(dir, `${doc}.md`))) present.push(doc);
    else missing.push(doc);
  }
  return { id: feature, dir: path.relative(root, dir), present, missing, none: false };
}

/* One bounded line: where the chain lives and which docs exist. */
function renderFeatureDocs(d) {
  if (!d) return [];
  if (d.none || !d.dir) return [`docs:    none (no .agents/features dir for ${d.id})`];
  const present = d.present.length ? d.present.join(",") : "none";
  const missing = d.missing.length ? d.missing.join(",") : "none";
  return [`docs:    ${d.dir} · present ${present} · missing ${missing}`];
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


/* The feature this session is working. Precedence is deliberate: an explicit
 * flag wins, then the checkout the session is physically in (directory, then
 * branch) — stronger evidence than a board row that may belong to another
 * live session — and only then the board's single In-progress row. */
function inferFeatureDetailed(explicit, branch, cwd, board) {
  if (explicit) return { id: String(explicit).toUpperCase(), source: "explicit" };
  const base = path.basename(String(cwd || "")).toUpperCase();
  let m = base.match(/^F-\d+/);
  if (m) return { id: m[0], source: "directory" };
  m = String(branch || "").toUpperCase().match(/^F-\d+/);
  if (m) return { id: m[0], source: "branch" };
  const inprog = (board && board.inprogress) || [];
  if (inprog.length === 1) {
    const id = String(inprog[0].id || "").toUpperCase() || null;
    return id ? { id, source: "board" } : { id: null, source: null };
  }
  return { id: null, source: null };
}

function inferFeature(explicit, branch, cwd, board) {
  return inferFeatureDetailed(explicit, branch, cwd, board).id;
}

/* Where the id came from, for the brief: "explicit" | "directory" | "branch" |
 * "board" | null. A board-sourced id is a guess — the brief says so and points
 * at --feature so a resume can override it. */
function inferFeatureSource(explicit, branch, cwd, board) {
  return inferFeatureDetailed(explicit, branch, cwd, board).source;
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

/* ------------------------------------------------ persona economics (S3) */
/* The decision-time price list: tier + declared writes from the persona's own
 * contract, observed cost from child sessions in the store (mean input tokens,
 * last used). Bounded to the 8 most recently used; no store => tier/writes only,
 * never a fabricated number. */
const PERSONA_MAX = 8;
const PERSONA_BRIEF_MAX = 4;

function personaTier(model) {
  const m = String(model || "").toLowerCase();
  if (!m) return "unpinned";
  if (/pro/.test(m)) return "reasoning";
  if (/flash|coder|haiku/.test(m)) return "engineering";
  if (/sonnet|gpt|gemini|general/.test(m)) return "content";
  return "general";
}

function personaStats(query, limit = PERSONA_MAX) {
  const rows = query(
    `SELECT agent, COUNT(*) AS runs, CAST(AVG(tokens_input) AS INTEGER) AS mean_input, MAX(time_created) AS last,
       (SELECT idle_outcome FROM session_v2 t WHERE t.agent = s.agent AND t.parent_id IS NOT NULL ORDER BY t.time_created DESC LIMIT 1) AS outcome
     FROM session_v2 s WHERE s.parent_id IS NOT NULL AND s.agent IS NOT NULL
     GROUP BY s.agent ORDER BY last DESC LIMIT ${Number(limit) || PERSONA_MAX}`
  );
  return (rows || []).map((r) => ({
    name: r.agent,
    runs: Number(r.runs) || 0,
    meanInput: Number(r.mean_input) || 0,
    last: Number(r.last) || 0,
    outcome: r.outcome || null,
  }));
}

function personaRows(root, opts = {}) {
  const dir = path.join(root, ".opencode", "agents");
  const names = dispatchPersona.personaNames(root);
  const rows = names.map((name) => {
    let parsed = { model: "", writes: [] };
    try {
      parsed = dispatchPersona.parsePersona(fs.readFileSync(path.join(dir, `${name}.md`), "utf8"));
    } catch {
      /* unreadable persona -> tier/writes unknown, still listed */
    }
    return {
      name,
      tier: personaTier(parsed.model),
      writes: parsed.writes,
      runs: 0,
      meanInput: 0,
      last: 0,
      outcome: null,
    };
  });
  let stats = null;
  try {
    const query = opts.query || require("./qa/store-lib.js").openStore().query;
    stats = personaStats(query);
  } catch {
    stats = null; // store unreachable: tier + writes only, never an estimate
  }
  if (stats) {
    const by = new Map(stats.map((s) => [s.name, s]));
    for (const row of rows) {
      const s = by.get(row.name);
      if (s) Object.assign(row, { runs: s.runs, meanInput: s.meanInput, last: s.last, outcome: s.outcome });
    }
  }
  return rows.sort((a, b) => b.last - a.last || a.name.localeCompare(b.name)).slice(0, PERSONA_MAX);
}

function kTokens(n) {
  if (!n) return "?";
  if (n < 1000) return `~${(Math.round(n / 100) / 10).toFixed(1)}K`;
  return `~${Math.round(n / 1000)}K`;
}

function mmdd(ms) {
  const d = new Date(Number(ms));
  if (!Number.isFinite(d.getTime())) return "?";
  const p = (x) => String(x).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function renderPersonasBlock(rows, max = PERSONA_MAX) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const picked = rows.slice(0, max);
  return picked.map((r, i) => {
    const name = String(r.name || "?").slice(0, 14).padEnd(14);
    const tier = String(r.tier || "?").slice(0, 11).padEnd(11);
    const cost = `${kTokens(r.meanInput)} in/call`.padEnd(13);
    const writes = r.writes && r.writes.length ? `writes ${r.writes.slice(0, 2).join(", ")}` : "reads only";
    const last = r.last ? `last: ${mmdd(r.last)}${r.outcome ? ` ${r.outcome}` : ""}` : "last: never";
    return `${i === 0 ? "personas:" : "         "} ${name} ${tier} ${cost} ${writes}  ${last}`;
  });
}

/* ------------------------------------------------- diagnosis visibility (S5) */
/* The active feature's diagnosis, display-ready. Read-only: orient reports a
 * stale or missing artifact, it never rewrites one — revalidation is a
 * `/diagnose` step, not an orientation side effect. */
function diagnosisState(root, feature, now = {}) {
  if (!feature || !diagnosisLib) return null;
  const rec = safe(() => diagnosisLib.readFeature(root, feature), null);
  if (!rec) {
    // No feature dir in this checkout (a resume from the main tree while the
    // feature lives in a linked worktree): nothing declared here to require.
    return {
      id: feature,
      kind: null,
      required: false,
      ok: true,
      status: null,
      confidence: null,
      stale: null,
      errors: [],
      action: null,
    };
  }
  const errors = Array.isArray(rec.errors) ? rec.errors : [];
  const text = String(rec.diagnosisText || "");
  const missing = errors.some((e) => e.code === "missing") || !text.trim();
  const stale = safe(
    () => diagnosisLib.staleReason(rec, text, { head: now.head, harnessVersion: now.harnessVersion }),
    null
  );
  const facts = diagnosisFacts(text);
  // One-line next step: a missing artifact needs the command, a malformed one
  // needs its first concrete defect. A valid diagnosis stays silent.
  let action = null;
  if (rec.required && !rec.ok) {
    action = missing ? "run /diagnose before editing" : errors[0] && errors[0].message ? errors[0].message : "fix the diagnosis before editing";
  }
  return {
    id: (rec.meta && rec.meta.id) || feature,
    kind: (rec.meta && rec.meta.kind) || null,
    required: Boolean(rec.required),
    ok: Boolean(rec.ok),
    status: rec.status || null,
    confidence: rec.confidence || null,
    stale: stale || null,
    errors,
    action,
    // Display facts for the human line; not part of the gate contract.
    falsifier: facts.falsifier,
    oracle: facts.oracle,
  };
}

/* `falsifier: yes` / `oracle: recorded` for the human line, from the same
 * parser the gate uses (no second interpretation of the markdown). */
function diagnosisFacts(text) {
  if (!diagnosisLib) return { falsifier: "no", oracle: "missing" };
  const sections = safe(() => diagnosisLib.sectionsOf(text), []) || [];
  const scalars = safe(() => diagnosisLib.parseScalars(text), {}) || {};
  const fals = sections.find((s) => /^Falsification\b/i.test(s.name));
  const falsB = fals ? diagnosisLib.parseBullets(fals.lines) : {};
  const falsifier = !diagnosisLib.isBlank(falsB.reviewer) || !diagnosisLib.isBlank(scalars.falsifier) ? "yes" : "no";
  const oracle = sections.find((s) => /^Outcome oracle\b/i.test(s.name));
  const oracleB = oracle ? diagnosisLib.parseBullets(oracle.lines) : {};
  const recorded = ["before-(red)", "after-(green)", "command-/-observation"].every((key) =>
    !diagnosisLib.isBlank(oracleB[key])
  );
  return { falsifier, oracle: recorded ? "recorded" : "missing" };
}

/* The human/brief line(s) for the diagnosis block. Pure; `null` renders nothing. */
function renderDiagnosisLines(d) {
  if (!d) return [];
  let line;
  if (!d.required) {
    line = `diagnosis: not required (${d.kind ? `kind=${d.kind}` : "legacy feature"})`;
  } else if (!d.ok) {
    const missing = (d.errors || []).some((e) => e.code === "missing");
    line = `diagnosis: ${missing ? "MISSING" : "INVALID"} (kind=${d.kind || "?"}) — ${d.action || "fix the diagnosis before editing"}`;
  } else {
    line = `diagnosis: ${d.status || "open"} (${d.confidence || "?"}) · falsifier: ${d.falsifier || "no"} · oracle: ${d.oracle || "missing"}`;
  }
  if (d.stale) line += ` · STALE: ${d.stale}`;
  return [line];
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
  const inferred = inferFeatureDetailed(opts.feature, branch, root, board);
  const feature = inferred.id;
  const featureSource = inferred.source;
  const owned = ownedFor(root, feature);
  const featureDocChain = feature ? featureDocs(root, feature) : null;
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
        // A resolved handoff without a formal block still yields a bounded
        // best-effort excerpt; say so instead of reporting `none` (F-058).
        hasBlock: ck.hasCheckpoint != null ? ck.hasCheckpoint : ck.checkpoint !== false,
        headings: ck.headings || [],
      }
    : null;
  /* Two live work units are routine (a device run + a review). Refusing to
   * infer one is correct — silently hiding both checkpoints is not: a fresh
   * context then reports "ckpt: none" and has to guess an id. List every
   * In-progress row that actually has a checkpoint, bounded. */
  const checkpointCandidates = [];
  if (!checkpointState) {
    for (const row of (board && board.inprogress) || []) {
      const r = safe(() => readCheckpoint({ feature: row.id }), null);
      if (!r || checkpointCandidates.some((c) => path.resolve(c.file) === path.resolve(r.file))) continue;
      checkpointCandidates.push({
        id: row.id,
        feature: r.feature,
        file: r.file,
        phase: r.state && r.state.phase,
        nextAction: r.state && r.state.next_action,
        count: r.state && r.state.checkpoint_count,
      });
      if (checkpointCandidates.length >= 5) break;
    }
  }
  // The inquiry loop's artifact for the active feature: status/confidence, a
  // staleness verdict against this HEAD/harness, and the next action.
  const harnessVer = harnessVersion(root);
  const diagnosis = feature ? diagnosisState(root, feature, { head, harnessVersion: harnessVer }) : null;

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

  /* Only the actionable state is surfaced: a live heartbeat belongs to another
   * running session, and an observed/clean stop removes the file. */
  let heartbeat = null;
  if (fallbackLib) {
    const status = safe(
      () =>
        fallbackLib.heartbeatStatus(root, {
          isAlive: (pid) => {
            try {
              process.kill(pid, 0);
              return true;
            } catch (_) {
              return false;
            }
          },
        }),
      null
    );
    if (status && status.state === "unclean") {
      const doc = status.heartbeat || {};
      heartbeat = {
        session: doc.session || null,
        feature: doc.feature || null,
        activity: doc.activity || null,
        at: doc.at || null,
        ageMs: status.ageMs,
      };
    }
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
    featureSource,
    // Non-null when the feature's work is in a linked worktree and this session
    // is rooted elsewhere (usually the main checkout): move before running tests.
    featureWorktree: worktree ? { path: worktree.path, branch: worktree.branch } : null,
    rootMismatch: Boolean(worktree),
    board: board
      ? {
          inprogress: (board.inprogress || []).map((r) => ({
            id: r.id,
            epic: r.epic,
            task: r.task,
            ...parseHandoffCell(r.handoff),
          })),
          nextQueued: (board.queued || []).slice(0, 3).map((r) => ({
            id: r.id,
            epic: r.epic,
            task: r.task,
            dependsOn: r.dependsOn,
          })),
        }
      : null,
    ownedFiles: owned,
    featureDocs: featureDocChain,
    checkpoint: checkpointState,
    checkpointCandidates,
    diagnosis,
    capacity: cap,
    heartbeat,
    personas: personaRows(root, opts),
    memory: memoryDigest(root),
    lastE2e: lastE2eRun(root),
    nightly: latestNightly(root),
    feedback: feedbackState(root),
    harnessVersion: harnessVer,
    harnessUpdate: harnessUpdateCheck(root),
    harnessRestart: harnessRestart(root),
    harnessBlocked: harnessBlocked(root),
  };
}

function fmt(v, label) {
  return v == null || v === "" ? `${label}: unavailable` : `${label}: ${v}`;
}

/* One board row as a single line: id, epic, title, and the pointers a cleared
 * session would otherwise fetch with `backlog_list` / `git worktree list`. */
function boardRowLine(r, taskMax) {
  const epic = r.epic && r.epic !== "?" ? ` [${r.epic}]` : "";
  const wt = r.worktree ? ` · worktree ${r.worktree}${r.branch ? ` (${r.branch})` : ""}` : "";
  const ho = r.handoff && r.handoff !== "?" ? ` · handoff ${r.handoff}` : "";
  return `${r.id}${epic} ${clipText(r.task || "?", taskMax)}${wt}${ho}`;
}

/* The title of the row this session is on (the brief names the feature id but
 * used to omit what it is, which sent the agent to `backlog_list`). */
function boardTaskFor(o, id) {
  const rows = [...((o.board && o.board.inprogress) || []), ...((o.board && o.board.nextQueued) || [])];
  const row = rows.find((r) => r.id === id);
  return row && row.task ? row.task : null;
}

function printHuman(o) {
  const lines = [`Session orientation — ${o.root} (${harnessStatus(o)})`, ""];
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
      `   Move the session there with tools.opencode.session.move (directory: "${o.featureWorktree.path}") and re-run orient before doing work.`,
      ""
    );
  }
  lines.push(`repo:    ${o.repo.kind || "outside-git"} @ ${o.repo.branch || "?"} (HEAD ${o.repo.head || "?"})`);
  lines.push(`dirty:   ${o.repo.dirty == null ? "unavailable" : o.repo.dirty + " file(s)"}`);
  lines.push(`feature: ${o.feature ? `${o.feature}${o.featureSource ? ` (from ${o.featureSource})` : ""}${o.featureSource === "board" ? " — pass --feature <id> to override" : ""}` : "(none inferred — pass --feature <id>)"}`);
  lines.push(`owned:   ${o.ownedFiles || "unavailable"}`);
  lines.push(...renderFeatureDocs(o.featureDocs));
  if (o.checkpoint) {
    const noBlock = o.checkpoint.hasBlock === false ? " · no ## Checkpoint block (best-effort excerpt)" : "";
    lines.push(
      `ckpt:    ${path.basename(o.checkpoint.file)} · phase ${o.checkpoint.phase || "?"} · count ${o.checkpoint.count || 0}${noBlock}`
    );
    if (o.checkpoint.nextAction) lines.push(`next:    ${clipText(o.checkpoint.nextAction, 600)}`);
    const sections = (o.checkpoint.headings || [])
      .filter((h) => h && h.level <= 2)
      .slice(0, 8)
      .map((h) => h.name);
    if (sections.length) lines.push(`sections: ${sections.join(" · ")}`);
  } else if (o.checkpointCandidates && o.checkpointCandidates.length) {
    lines.push(`ckpt:    ${o.checkpointCandidates.length} resumable checkpoint(s) — pick one with --feature <id>`);
    for (const c of o.checkpointCandidates) {
      const file = path.basename(c.file);
      lines.push(`         ${c.id} · phase ${c.phase || "?"} · next: ${clipText(c.nextAction || "?", 180)} [${file}]`);
    }
  } else {
    lines.push("ckpt:    none (fresh work unit or feature has no checkpoint yet)");
  }
  lines.push(...renderDiagnosisLines(o.diagnosis));
  if (o.board) {
    const ip = o.board.inprogress || [];
    lines.push(`board:   In progress${ip.length ? "" : " none"}`);
    for (const r of ip) lines.push(`         ${boardRowLine(r, 120)}`);
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
  if (o.heartbeat) {
    const who = o.heartbeat.session || "?";
    const feat = o.heartbeat.feature ? ` (${o.heartbeat.feature})` : "";
    const act = o.heartbeat.activity ? ` · last activity: ${clipText(o.heartbeat.activity, 80)}` : "";
    lines.push(`heartbeat: UNCLEAN prior session ${who}${feat} ended unobserved${act} — inspect the working tree before continuing`);
  }
  lines.push(...renderPersonasBlock(o.personas));
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
  const fb = o.feedback;
  if (fb && !fb.unavailable) {
    lines.push(
      fb.open
        ? `feedback: ${fb.open} open / ${fb.total} item(s) · mode ${fb.mode}${fb.oldest ? ` · oldest ${fb.oldest.id} (${fb.oldest.ageHours}h, ${fb.oldest.severity})` : ""}`
        : `feedback: inbox empty (${fb.total} captured) · mode ${fb.mode}`
    );
  } else {
    lines.push("feedback: unavailable");
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
    "tools:   gates (run a tier: `gates --phase=quick`) · where (find a symbol: `where <term>`) · orient (re-orient) · backlog_list (board rows) — prefer these over `npm run … | tail` and shell grep/find"
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
    `${harnessStatus(o)}${o.harnessUpdate ? ` -> v${o.harnessUpdate.latest} available (${o.harnessUpdate.command})` : ""} · root ${o.root}`
  );
  if (o.rootMismatch) {
    lines.push(
      `!! ROOT MISMATCH — ${o.feature} lives in worktree ${o.featureWorktree.path}; move the session there BEFORE running anything (this root's tsc/status are a different tree).`
    );
    lines.push(`   tools.opencode.session.move (directory: "${o.featureWorktree.path}"), then re-run orient.`);
  }
  if (o.feature) {
    const task = boardTaskFor(o, o.feature);
    lines.push(
      `feature ${o.feature}${o.featureSource ? ` (from ${o.featureSource})` : ""}${o.featureSource === "board" ? " — pass --feature <id> to override" : ""}${task ? ` · ${clipText(task, 120)}` : ""}${o.ownedFiles ? ` · owns ${o.ownedFiles}` : ""}`
    );
  }
  lines.push(...renderFeatureDocs(o.featureDocs));
  if (o.checkpoint)
    lines.push(
      `checkpoint ${o.checkpoint.phase || "?"} · next: ${clipText(o.checkpoint.nextAction || "?", 400)}` +
        (o.checkpoint.hasBlock === false ? " (no ## Checkpoint block — best-effort excerpt)" : "")
    );
  else for (const c of (o.checkpointCandidates || []).slice(0, 4)) lines.push(`checkpoint ${c.id}: ${clipText(c.nextAction || "?", 240)}`);
  lines.push(...renderDiagnosisLines(o.diagnosis));
  if (o.board) {
    const ip = o.board.inprogress || [];
    if (ip.length) {
      lines.push("board In progress:");
      for (const r of ip) lines.push(`  ${boardRowLine(r, 96)}`);
    } else {
      lines.push("board In progress none");
    }
    if (o.board.nextQueued.length) {
      lines.push(`next queued: ${o.board.nextQueued.map((r) => `${r.id} ${clipText(r.task || "", 64)}`).join("; ")}`);
    }
  }
  if (o.capacity) lines.push(`capacity ${o.capacity.ok ? "ok" : "EXCEEDED: " + o.capacity.reasons.join("; ")} · serves ${o.capacity.serves.join(", ") || "none"}`);
  if (o.heartbeat) {
    const who = o.heartbeat.session || "?";
    const feat = o.heartbeat.feature ? ` (${o.heartbeat.feature})` : "";
    lines.push(`heartbeat UNCLEAN — prior session ${who}${feat} ended unobserved; inspect the working tree before continuing`);
  }
  lines.push(...renderPersonasBlock(o.personas, PERSONA_BRIEF_MAX));
  if (o.lastE2e) lines.push(`last e2e ${o.lastE2e.failed || 0} failed / ${o.lastE2e.total != null ? o.lastE2e.total : "?"}`);
  if (o.nightly) lines.push(`nightly ${(o.nightly.verdict || "?").toUpperCase()} — ${o.nightly.failed} failing, ${o.nightly.reopened} reopened, ${o.nightly.added} new`);
  const mem = renderMemoryDigest(o.memory);
  if (mem.length) {
    lines.push("memory digest (open a file only for detail):");
    lines.push(...mem);
  }
  // State is only confirmed when the session is rooted in the feature's tree and
  // the feature id was not guessed from the board — never print a green "proceed".
  if (o.rootMismatch) {
    lines.push("DO NOT PROCEED from this root — move the session into the worktree above first.");
  } else if (o.featureSource === "board") {
    lines.push(`Feature ${o.feature} is inferred from the board's In-progress row — pass --feature <id> to confirm before touching files.`);
  } else {
    lines.push("Proceed from the checkpoint/next; do not re-derive git/serve/capacity state by hand.");
  }
  lines.push("tools: gates (run a tier) · where (find a symbol) · orient · backlog_list (board rows) — not `npm run … | tail` / shell grep.");
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
  inferFeatureSource,
  featureWorktree,
  checkoutKind,
  harnessRestart,
  harnessBlocked,
  harnessStatus,
  ownedFor,
  featureDocs,
  renderFeatureDocs,
  FEATURE_DOC_FILES,
  diagnosisState,
  diagnosisFacts,
  renderDiagnosisLines,
  parseFirstTable,
  parseSections,
  memoryDigest,
  renderMemoryDigest,
  personaRows,
  personaStats,
  personaTier,
  renderPersonasBlock,
  PERSONA_MAX,
  PERSONA_BRIEF_MAX,
  lastE2eRun,
  latestNightly,
  boardSnapshot,
  parseHandoffCell,
  boardTaskFor,
  gitRunner,
  parseArgs,
  printHuman,
  printBrief,
  fmt,
};
