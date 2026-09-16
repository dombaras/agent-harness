#!/usr/bin/env node
"use strict";
/*
 * provider-stats — deterministic cost/token/turn telemetry from the local
 * opencode store (Phase B of the cost-optimization plan).
 *
 * Reads observed provider data for one project root — including every git
 * worktree registered to it — via `opencode db --format json "<SQL>"` (the
 * stable, cross-platform path; no sqlite dependency). Aggregates the primary
 * orchestrator session plus its subagent child sessions into one "feature run"
 * group, so `cost per shipped feature` has a real join key (the root session
 * id recorded in the handoff `session:` metadata).
 *
 * Nothing here is inferred from character counts: every number is the
 * provider's own recorded value. When the store is unreachable, the script
 * fails loudly instead of printing fabricated totals.
 *
 * Usage:
 *   node scripts/qa/provider-stats.js [--since=14d] [--json]
 *   node scripts/qa/provider-stats.js --session <ses_...> [--json]
 *   node scripts/qa/provider-stats.js --export <file>       # write a fixture
 *   node scripts/qa/provider-stats.js --fixture <file>      # read a fixture
 *   node scripts/qa/provider-stats.js --root <dir> [--opencode <exe>]
 *
 * Fixture schema (stable): { schema, meta, sessions } — the same document the
 * CLI emits on --json, minus aggregates (always recomputed from sessions).
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const CG = require("./context-guard-core.js");

const SCHEMA = "provider-stats/1";
const TURN_UNITS = { h: 3600000, d: 86400000, w: 604800000, m: 2592000000 };

// ---------------------------------------------------------------- pure core

/* Parse `--since`: relative (`14d`, `36h`, `2w`, `1m` = 30d) or an ISO date.
 * Returns an epoch-ms lower bound, or null for "all time". Throws on garbage so
 * a typo can never silently widen the window. */
function parseSince(text, now = Date.now()) {
  if (text == null || String(text).trim() === "" || /^all$/i.test(String(text).trim())) return null;
  const s = String(text).trim();
  const rel = s.match(/^(\d+)\s*([hdwm])$/i);
  if (rel) {
    const unit = TURN_UNITS[rel[2].toLowerCase()];
    return now - Number(rel[1]) * unit;
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) {
    throw new Error(`invalid since value "${text}" — use 14d / 36h / 2w / 1m or an ISO date`);
  }
  return t;
}

/* opencode stores `session.model` as JSON (or a bare string in older rows). */
function parseModelCell(value) {
  const out = { model: "?", provider: "?" };
  if (value == null || value === "") return out;
  const s = String(value).trim();
  if (s.startsWith("{")) {
    try {
      const parsed = JSON.parse(s);
      if (parsed && parsed.id) out.model = String(parsed.id);
      if (parsed && parsed.providerID) out.provider = String(parsed.providerID);
      return out;
    } catch (_) {
      /* fall through to the bare string */
    }
  }
  out.model = s;
  return out;
}

/* Nearest-rank percentile over the finite values (no interpolation). */
function percentile(values, pct) {
  const arr = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (arr.length === 0) return null;
  const idx = Math.min(arr.length - 1, Math.max(0, Math.ceil((pct / 100) * arr.length) - 1));
  return arr[idx];
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function commas(n) {
  return String(Math.round(num(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function money(n) {
  return "$" + num(n).toFixed(4);
}

/* Normalize to the forward-slash form the opencode store records. */
function normalizeRoot(p) {
  return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

function sqlString(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

// ---------------------------------------------------------------- collections

/* Resolve the real opencode executable. On Windows the PATH entry is usually a
 * `.cmd`/`.ps1` shim that Node cannot execFileSync directly, so prefer the real
 * `.exe` next to it (or the npm-global module path); on POSIX the shim runs. */
function resolveOpencode(opts = {}) {
  const platform = opts.platform || process.platform;
  const win32Paths = platform === "win32";
  const p = win32Paths ? path.win32 : path;
  const env = opts.env || process.env;
  const exists = opts.exists || fs.existsSync;
  const exec = opts.execFileSync || execFileSync;
  if (env.OPENCODE_BIN && exists(env.OPENCODE_BIN)) return env.OPENCODE_BIN;
  let found = null;
  try {
    const cmd = platform === "win32" ? "where.exe" : "which";
    const out = exec(cmd, ["opencode"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    found = String(out).split(/\r?\n/).map((l) => l.trim()).find(Boolean) || null;
  } catch (_) {
    found = null;
  }
  if (!found) return null;
  if (win32Paths && !/\.exe$/i.test(found)) {
    // `where.exe` often lists the extensionless POSIX shim first; CreateProcess
    // cannot run it. Prefer the real exe beside it, then the npm-global module.
    // Node's host `path` is POSIX when the harness runs under WSL/Linux, so the
    // win32 branch must use `path.win32` (a Windows path split by the host
    // module yields "." — F-191-adjacent WSL portability).
    const exe = /\.(cmd|ps1)$/i.test(found) ? found.replace(/\.(cmd|ps1)$/i, ".exe") : null;
    for (const cand of [found + ".exe", exe]) {
      if (cand && exists(cand)) return cand;
    }
    const npmExe = p.join(p.dirname(found), "node_modules", "opencode-ai", "bin", "opencode.exe");
    if (exists(npmExe)) return npmExe;
    return null;
  }
  return found;
}

function runDbJson(opencode, sql, opts = {}) {
  const exec = opts.execFileSync || execFileSync;
  const out = exec(opencode, ["db", "--format", "json", sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 1024 * 1024 * 1024,
  });
  const trimmed = String(out).trim();
  return trimmed ? JSON.parse(trimmed) : [];
}

/* Project ids registered for this root: the main worktree plus every git
 * worktree opencode knows about (`project_directory.strategy = git_worktree`).
 * This is what makes a session started inside a feature worktree match. */
function projectIdsSql(root) {
  const wtBase = normalizeRoot(path.posix.join(root, "..", ".worktrees", path.posix.basename(root)));
  return (
    "SELECT DISTINCT project_id AS id FROM project_directory " +
    `WHERE lower(directory) = lower(${sqlString(root)}) ` +
    `OR lower(directory) LIKE lower(${sqlString(wtBase + "/")}) || '%' ` +
    "UNION " +
    `SELECT DISTINCT id FROM project WHERE lower(worktree) = lower(${sqlString(root)})`
  );
}

function sessionsSql(projectIds, sinceMs) {
  const ids = projectIds.map(sqlString).join(", ");
  const since = sinceMs ? ` AND s.time_created >= ${Number(sinceMs)}` : "";
  return (
    "SELECT s.id, s.parent_id, s.title, s.directory, s.agent, s.model, s.cost, " +
    "s.tokens_input, s.tokens_output, s.tokens_reasoning, " +
    "s.tokens_cache_read, s.tokens_cache_write, s.time_created, s.time_updated " +
    `FROM session s WHERE s.project_id IN (${ids})${since} ORDER BY s.time_created`
  );
}

function turnsSql(sessionIds) {
  const ids = sessionIds.map(sqlString).join(", ");
  return (
    "SELECT session_id, COUNT(*) AS turns FROM message " +
    `WHERE session_id IN (${ids}) AND json_valid(data) ` +
    "AND json_extract(data, '$.role') = 'assistant' GROUP BY session_id"
  );
}

function toolPartsSql(sessionIds) {
  const ids = sessionIds.map(sqlString).join(", ");
  return (
    "SELECT session_id, json_extract(data, '$.tool') AS tool, " +
    "json_extract(data, '$.state.input') AS input FROM part " +
    `WHERE session_id IN (${ids}) AND json_valid(data) ` +
    "AND json_extract(data, '$.type') = 'tool'"
  );
}

/* Run one IN-list query in chunks so a 700-session project never overflows the
 * command line / SQL parser. */
function queryChunked(runDb, ids, buildSql, chunk = 250) {
  const rows = [];
  for (let i = 0; i < ids.length; i += chunk) rows.push(...runDb(buildSql(ids.slice(i, i + chunk))));
  return rows;
}

function mapSessionRow(row) {
  const model = parseModelCell(row.model);
  return {
    id: row.id,
    parentId: row.parent_id || null,
    title: row.title || "",
    directory: row.directory || "",
    agent: row.agent || null,
    model: model.model,
    provider: model.provider,
    cost: num(row.cost),
    tokens: {
      input: num(row.tokens_input),
      output: num(row.tokens_output),
      reasoning: num(row.tokens_reasoning),
      cacheRead: num(row.tokens_cache_read),
      cacheWrite: num(row.tokens_cache_write),
    },
    turns: 0,
    toolCalls: 0,
    maxIdentical: 0,
    loops: [],
    timeCreated: row.time_created == null ? null : Number(row.time_created),
    timeUpdated: row.time_updated == null ? null : Number(row.time_updated),
  };
}

/* Keep only `sessionId` and its descendants (subagent sessions). A no-match
 * yields [] so the caller can report "session not found" without guessing. */
function filterDescendants(sessions, sessionId) {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  if (!byId.has(sessionId)) return [];
  const children = new Map();
  for (const s of sessions) {
    if (!s.parentId) continue;
    if (!children.has(s.parentId)) children.set(s.parentId, []);
    children.get(s.parentId).push(s.id);
  }
  const out = [];
  const queue = [sessionId];
  const seen = new Set();
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(byId.get(id));
    for (const child of children.get(id) || []) queue.push(child);
  }
  return out;
}

/* Walk parent_id to the topmost selected ancestor (cycle-safe). */
function rootIdOf(session, byId) {
  let cur = session;
  let guard = 0;
  while (cur.parentId && byId.has(cur.parentId) && guard++ < 1000) cur = byId.get(cur.parentId);
  return cur.id;
}

function enrichTurns(sessions, turnRows) {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  for (const row of turnRows) {
    const s = byId.get(row.session_id);
    if (s) s.turns = num(row.turns);
  }
}

/* Cumulative identical tool+args detection, same canonical key + exemption
 * rules as the live context-guard (`.agents/memory/orchestration.md`
 * `identical_tool_calls`). Only the hash is retained — args can carry secrets. */
function enrichLoops(sessions, partRows, stuck) {
  const threshold = Number.isFinite(stuck?.identical_tool_calls) ? stuck.identical_tool_calls : 3;
  const counts = new Map(sessions.map((s) => [s.id, new Map()]));
  const tools = new Map(sessions.map((s) => [s.id, new Map()]));
  for (const row of partRows) {
    const sessionCounts = counts.get(row.session_id);
    if (!sessionCounts) continue;
    const sessionTools = tools.get(row.session_id);
    sessionTools.set(row.tool, (sessionTools.get(row.tool) || 0) + 1);
    let input = null;
    if (row.input != null) {
      try {
        input = JSON.parse(row.input);
      } catch (_) {
        input = { raw: String(row.input) };
      }
    }
    if (CG.isLoopExempt(row.tool, input)) continue;
    const key = CG.loopKey(row.tool, input);
    sessionCounts.set(key, (sessionCounts.get(key) || 0) + 1);
  }
  for (const s of sessions) {
    const sessionCounts = counts.get(s.id);
    let toolCalls = 0;
    for (const c of tools.get(s.id).values()) toolCalls += c;
    s.toolCalls = toolCalls;
    let max = 0;
    const loops = [];
    for (const [key, count] of sessionCounts) {
      if (count > max) max = count;
      if (count >= threshold) {
        const [tool] = key.split(":");
        loops.push({ tool, hash: CG.shortHash(key), count });
      }
    }
    loops.sort((a, b) => b.count - a.count || a.hash.localeCompare(b.hash));
    s.maxIdentical = max;
    s.loops = loops.slice(0, 10);
  }
}

// ---------------------------------------------------------------- aggregate

/* Machine-readable model-tier targets from `.agents/memory/model-routing.md`
 * (`opportunistic_models:` / `escalation_models:` lines). These classify the
 * observed model mix; anything unlisted is the standard execution tier. */
function parseModelTiers(text) {
  const out = { opportunistic: [], escalation: [] };
  for (const m of String(text || "").matchAll(/^(opportunistic|escalation)_models:\s*(.+)$/gim)) {
    out[m[1].toLowerCase()] = m[2]
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return out;
}

function readModelTiers(root) {
  let text = "";
  try {
    text = fs.readFileSync(path.join(root, ".agents", "memory", "model-routing.md"), "utf8");
  } catch (_) {
    /* missing file -> no declared tiers (everything is standard) */
  }
  return parseModelTiers(text);
}

function tierOf(model, opportunistic, escalation) {
  if (escalation.has(model)) return "escalation";
  if (opportunistic.has(model)) return "opportunistic";
  return "standard";
}

/* Aggregate observed sessions into feature-run groups (a primary orchestrator
 * session + every subagent child session) plus project-wide totals. Pure: all
 * inputs come from `collectStats` (or a fixture), nothing is fabricated. */
function aggregateSessions(sessions, opts = {}) {
  const stuck = opts.stuck || CG.DEFAULT_STUCK;
  const softTurnBudget = Number.isFinite(opts.softTurnBudget)
    ? opts.softTurnBudget
    : CG.DEFAULT_TURNS.soft_turn_budget;
  const escalationModels = new Set(opts.escalationModels || []);
  const opportunisticModels = new Set(opts.opportunisticModels || []);
  const byId = new Map(sessions.map((s) => [s.id, s]));

  const totals = {
    sessions: sessions.length,
    primarySessions: 0,
    subagentSessions: 0,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    turns: 0,
    toolCalls: 0,
  };
  const groups = new Map();
  for (const s of sessions) {
    const rootId = rootIdOf(s, byId);
    if (!groups.has(rootId)) {
      const root = byId.get(rootId);
      groups.set(rootId, {
        rootId,
        title: root ? root.title : rootId,
        rootModel: root ? root.model : "?",
        cost: 0,
        turns: 0,
        totalTurns: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        sessions: 0,
        subagentSessions: 0,
        toolCalls: 0,
        maxIdentical: 0,
        models: new Set(),
      });
    }
    const g = groups.get(rootId);
    g.cost += s.cost;
    g.totalTurns += s.turns;
    if (s.id === rootId) g.turns += s.turns;
    else g.subagentSessions += 1;
    g.sessions += 1;
    g.toolCalls += s.toolCalls;
    if (s.maxIdentical > g.maxIdentical) g.maxIdentical = s.maxIdentical;
    g.models.add(s.model);
    for (const k of Object.keys(totals.tokens)) {
      g.tokens[k] += s.tokens[k];
      totals.tokens[k] += s.tokens[k];
    }
    totals.cost += s.cost;
    totals.turns += s.turns;
    totals.toolCalls += s.toolCalls;
    if (s.id === rootId) totals.primarySessions += 1;
    else totals.subagentSessions += 1;
  }

  const inputDenominator =
    totals.tokens.input + totals.tokens.cacheRead + totals.tokens.cacheWrite;
  totals.cacheReadShare = inputDenominator > 0 ? totals.tokens.cacheRead / inputDenominator : null;

  const groupList = [...groups.values()]
    .map((g) => ({ ...g, models: [...g.models].sort() }))
    .sort((a, b) => b.cost - a.cost || a.rootId.localeCompare(b.rootId));

  const modelMap = new Map();
  for (const s of sessions) {
    const key = s.model + "|" + s.provider;
    if (!modelMap.has(key)) {
      modelMap.set(key, {
        model: s.model,
        provider: s.provider,
        tier: tierOf(s.model, opportunisticModels, escalationModels),
        sessions: 0,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      });
    }
    const m = modelMap.get(key);
    m.sessions += 1;
    m.cost += s.cost;
    for (const k of Object.keys(m.tokens)) m.tokens[k] += s.tokens[k];
  }
  const modelMix = [...modelMap.values()].sort((a, b) => b.cost - a.cost || a.model.localeCompare(b.model));

  /* Tier mix: cost / sessions / tokens rolled up by tier (standard vs declared
   * opportunistic / escalation targets). Never inferred — classification only. */
  const tierMap = new Map();
  for (const s of sessions) {
    const tier = tierOf(s.model, opportunisticModels, escalationModels);
    if (!tierMap.has(tier)) tierMap.set(tier, { tier, sessions: 0, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } });
    const t = tierMap.get(tier);
    t.sessions += 1;
    t.cost += s.cost;
    for (const k of Object.keys(t.tokens)) t.tokens[k] += s.tokens[k];
  }
  const tierOrder = { escalation: 0, standard: 1, opportunistic: 2 };
  const tierMix = [...tierMap.values()].sort(
    (a, b) => (tierOrder[a.tier] ?? 9) - (tierOrder[b.tier] ?? 9) || b.cost - a.cost
  );

  /* Escalation evidence surface: primary (root) sessions observed on a declared
   * escalation model. A pro model on a subagent is a legitimate pinned persona;
   * the primary orchestrator running on one is the thing that needs a recorded
   * reason (agent-report joins that to the handoff). */
  const escalationGroups = groupList.filter((g) => escalationModels.has(g.rootModel));
  const escalation = {
    models: [...escalationModels].sort(),
    count: escalationGroups.length,
    cost: escalationGroups.reduce((a, g) => a + g.cost, 0),
    sessions: escalationGroups.map((g) => ({ id: g.rootId, title: g.title, model: g.rootModel, cost: g.cost })),
    rootIds: escalationGroups.map((g) => g.rootId),
  };
  const opportunistic = {
    models: [...opportunisticModels].sort(),
    sessions: sessions.filter((s) => opportunisticModels.has(s.model)).length,
    cost: sessions.filter((s) => opportunisticModels.has(s.model)).reduce((a, s) => a + s.cost, 0),
  };

  const loopCandidates = sessions
    .filter((s) => s.maxIdentical >= (Number.isFinite(stuck.identical_tool_calls) ? stuck.identical_tool_calls : 3))
    .map((s) => ({
      id: s.id,
      title: s.title,
      parentId: s.parentId,
      tool: s.loops[0] ? s.loops[0].tool : null,
      hash: s.loops[0] ? s.loops[0].hash : null,
      count: s.maxIdentical,
    }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));

  return {
    totals,
    percentiles: {
      primaryCost: {
        p50: percentile(groupList.map((g) => g.cost), 50),
        p90: percentile(groupList.map((g) => g.cost), 90),
      },
      primaryTurns: {
        p50: percentile(groupList.map((g) => g.turns), 50),
        p90: percentile(groupList.map((g) => g.turns), 90),
      },
    },
    modelMix,
    tierMix,
    escalation,
    opportunistic,
    topSessions: groupList.slice(0, 5).map((g) => ({
      id: g.rootId,
      title: g.title,
      cost: g.cost,
      turns: g.turns,
      tokens: g.tokens,
      sessions: g.sessions,
      models: g.models,
    })),
    sessionsOverTurnBudget: {
      threshold: softTurnBudget,
      count: groupList.filter((g) => g.turns > softTurnBudget).length,
      sessions: groupList.filter((g) => g.turns > softTurnBudget).slice(0, 10).map((g) => ({ id: g.rootId, title: g.title, turns: g.turns, cost: g.cost })),
    },
    loopCandidates: {
      threshold: Number.isFinite(stuck.identical_tool_calls) ? stuck.identical_tool_calls : 3,
      count: loopCandidates.length,
      sessions: loopCandidates.slice(0, 10),
    },
    groups: Object.fromEntries(groupList.map((g) => [g.rootId, { cost: g.cost, turns: g.turns, totalTurns: g.totalTurns, sessions: g.sessions, tokens: g.tokens, rootModel: g.rootModel, models: g.models }])),
  };
}

// ---------------------------------------------------------------- collect

function readThresholds(root) {
  let text = "";
  try {
    text = fs.readFileSync(path.join(root, ".agents", "memory", "orchestration.md"), "utf8");
  } catch (_) {
    /* missing file -> documented defaults */
  }
  return CG.parseThresholds(text);
}

/* The script runs from `<project>/scripts/qa/`, so the project root is two
 * levels up. In the harness repo itself (templates/scripts/qa) pass `--root`
 * explicitly; the harness copy is validated through deployed-project tests. */
function defaultRoot() {
  return normalizeRoot(path.resolve(__dirname, "..", ".."));
}

/* Collect observed sessions for a project root. Injectable `runDb` keeps this
 * unit-testable without a live opencode install; `opencode` overrides the
 * executable path; `now` fixes relative `--since` values. */
function collectStats(opts = {}) {
  const root = normalizeRoot(opts.root || defaultRoot());
  const since = parseSince(opts.since, opts.now);
  const thresholds = readThresholds(root);
  const stuck = opts.stuck || thresholds.stuck;
  const softTurnBudget = Number.isFinite(opts.softTurnBudget) ? opts.softTurnBudget : thresholds.turns.soft_turn_budget;
  const opencode = opts.runDb ? opts.opencode || "opencode" : opts.opencode || resolveOpencode();
  if (!opts.runDb && !opencode) {
    throw new Error("opencode CLI not found — install it, or set OPENCODE_BIN / pass --opencode <path>");
  }
  const runDb = opts.runDb || ((sql) => runDbJson(opencode, sql, opts));

  const projectIds = runDb(projectIdsSql(root)).map((r) => r.id).filter(Boolean);
  const meta = {
    schema: SCHEMA,
    generatedAt: new Date(opts.now || Date.now()).toISOString(),
    root,
    since: since ? { arg: String(opts.since), fromMs: since } : null,
    projectIds,
    scope: null,
    stuck,
    softTurnBudget,
    modelTiers: readModelTiers(root),
  };
  if (projectIds.length === 0) return { meta: { ...meta, note: "no opencode project matches this root" }, sessions: [] };

  let sessions = runDb(sessionsSql(projectIds, since)).map(mapSessionRow);
  if (opts.session) {
    const allById = new Map(sessions.map((s) => [s.id, s]));
    const requested = allById.get(opts.session);
    if (!requested) {
      return { meta: { ...meta, scope: { session: opts.session, rootId: null } }, sessions: [] };
    }
    const rootId = rootIdOf(requested, allById);
    sessions = filterDescendants(sessions, rootId);
    meta.scope = { session: opts.session, rootId };
  }

  const ids = sessions.map((s) => s.id);
  enrichTurns(sessions, ids.length ? queryChunked(runDb, ids, turnsSql) : []);
  enrichLoops(sessions, ids.length ? queryChunked(runDb, ids, toolPartsSql) : [], stuck);
  return { meta, sessions };
}

function readFixture(file) {
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!doc || doc.schema !== SCHEMA || !Array.isArray(doc.sessions)) {
    throw new Error(`${file} is not a ${SCHEMA} fixture`);
  }
  return { schema: SCHEMA, meta: { ...(doc.meta || {}), schema: SCHEMA }, sessions: doc.sessions };
}

function writeFixture(file, stats) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schema: SCHEMA, meta: stats.meta, sessions: stats.sessions }, null, 2) + "\n", "utf8");
  return path.resolve(file);
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const out = { json: false, since: null, session: null, exportFile: null, fixture: null, opencode: null, root: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--since") out.since = argv[++i];
    else if (a.startsWith("--since=")) out.since = a.slice("--since=".length);
    else if (a === "--session") out.session = argv[++i];
    else if (a === "--export") out.exportFile = argv[++i];
    else if (a === "--fixture") out.fixture = argv[++i];
    else if (a === "--opencode") out.opencode = argv[++i];
    else if (a === "--root") out.root = argv[++i];
  }
  return out;
}

function printHuman(stats, agg) {
  const { meta } = stats;
  const t = agg.totals;
  const since = meta.since ? meta.since.arg : "all time";
  console.log(`Provider telemetry — ${meta.root} (${since})\n`);
  if (t.sessions === 0) {
    console.log(meta.note ? `No sessions: ${meta.note}` : "No sessions in this window.");
    return;
  }
  if (meta.scope && meta.scope.session) {
    console.log(`Scope: session ${meta.scope.session} (primary ${meta.scope.rootId || "not found"})`);
  }
  console.log(
    `Sessions: ${t.sessions} (${t.primarySessions} primary + ${t.subagentSessions} subagent) · ` +
      `Cost: ${money(t.cost)} · Turns: ${commas(t.turns)}`
  );
  console.log(
    `Tokens: input ${commas(t.tokens.input)} · cache-read ${commas(t.tokens.cacheRead)}` +
      (t.cacheReadShare == null ? "" : ` (${(t.cacheReadShare * 100).toFixed(1)}% of input)`) +
      ` · cache-write ${commas(t.tokens.cacheWrite)} · output ${commas(t.tokens.output)} · reasoning ${commas(t.tokens.reasoning)}`
  );
  console.log(
    `Per primary session: cost P50 ${money(agg.percentiles.primaryCost.p50)} · P90 ${money(agg.percentiles.primaryCost.p90)}` +
      ` · turns P50 ${agg.percentiles.primaryTurns.p50 == null ? "n/a" : agg.percentiles.primaryTurns.p50}` +
      ` · P90 ${agg.percentiles.primaryTurns.p90 == null ? "n/a" : agg.percentiles.primaryTurns.p90}`
  );
  console.log(
    `Primary sessions over ${agg.sessionsOverTurnBudget.threshold} turns: ${agg.sessionsOverTurnBudget.count}` +
      ` · identical-call loops (>= ${agg.loopCandidates.threshold}x): ${agg.loopCandidates.count}`
  );

  console.log("\nModel mix (all sessions):");
  for (const m of agg.modelMix) {
    console.log(
      `  ${(m.provider + "/" + m.model).padEnd(38)} ${String(m.sessions).padStart(4)} sessions  ${money(m.cost).padStart(10)}  ` +
        `in ${commas(m.tokens.input)} · cache ${commas(m.tokens.cacheRead)} · out ${commas(m.tokens.output)}`
    );
  }

  const tiers = agg.tierMix.filter((t) => t.sessions > 0);
  if (tiers.length) {
    console.log("\nModel mix by tier:");
    for (const t of tiers) {
      console.log(`  ${t.tier.padEnd(14)} ${String(t.sessions).padStart(4)} sessions  ${money(t.cost).padStart(10)}`);
    }
  }
  if (agg.escalation.count) {
    console.log(
      `\nEscalation tier: ${agg.escalation.count} primary session(s) on ${agg.escalation.models.join(", ")} — ` +
        `${money(agg.escalation.cost)} (record the reason in the handoff; agent-report flags the missing ones)`
    );
  }
  if (agg.opportunistic.sessions) {
    console.log(
      `Opportunistic tier: ${agg.opportunistic.sessions} session(s) (${money(agg.opportunistic.cost)}) on ${agg.opportunistic.models.join(", ")}`
    );
  }

  if (agg.topSessions.length) {
    console.log("\nTop primary sessions by cost:");
    for (const s of agg.topSessions) {
      console.log(`  ${money(s.cost).padStart(10)}  ${String(s.turns).padStart(4)} turns  ${String(s.sessions).padStart(3)} session(s)  ${s.id}  ${s.title.slice(0, 60)}`);
    }
  }

  if (agg.loopCandidates.sessions.length) {
    console.log(`\nLoop candidates (cumulative identical tool+args >= ${agg.loopCandidates.threshold}):`);
    for (const l of agg.loopCandidates.sessions) {
      console.log(`  ${String(l.count).padStart(3)}x  ${l.tool || "?"} #${l.hash || "?"}  ${l.id}  ${l.title.slice(0, 60)}`);
    }
  }
  console.log("\nAll values are observed provider data (opencode store). Nothing is inferred from text length.");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "Usage: node scripts/qa/provider-stats.js [--since=14d] [--session <id>] [--json]\n" +
        "       [--export <file>] [--fixture <file>] [--root <dir>] [--opencode <path>]"
    );
    return;
  }
  const stats = args.fixture
    ? readFixture(args.fixture)
    : collectStats({ root: args.root || defaultRoot(), since: args.since, session: args.session, opencode: args.opencode });
  const thresholds = readThresholds(stats.meta.root || defaultRoot());
  const tiers = stats.meta.modelTiers || readModelTiers(stats.meta.root || defaultRoot());
  const agg = aggregateSessions(stats.sessions, {
    stuck: stats.meta.stuck || thresholds.stuck,
    softTurnBudget: stats.meta.softTurnBudget,
    opportunisticModels: tiers.opportunistic,
    escalationModels: tiers.escalation,
  });
  if (args.exportFile) {
    const file = writeFixture(args.exportFile, stats);
    console.error(`provider-stats: wrote ${file}`);
  }
  if (args.json) console.log(JSON.stringify({ schema: SCHEMA, ...stats, aggregates: agg }, null, 2));
  else printHuman(stats, agg);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error("provider-stats: " + (e && e.message ? e.message : e));
    process.exit(1);
  }
}

module.exports = {
  SCHEMA,
  parseSince,
  parseModelCell,
  percentile,
  normalizeRoot,
  sqlString,
  resolveOpencode,
  projectIdsSql,
  sessionsSql,
  turnsSql,
  toolPartsSql,
  queryChunked,
  mapSessionRow,
  filterDescendants,
  rootIdOf,
  enrichTurns,
  enrichLoops,
  aggregateSessions,
  parseModelTiers,
  readModelTiers,
  readThresholds,
  defaultRoot,
  collectStats,
  readFixture,
  writeFixture,
  commas,
  money,
};
