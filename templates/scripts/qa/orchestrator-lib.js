"use strict";
/*
 * orchestrator-lib — the deterministic scheduler behind the parallel feature
 * orchestrator (F-068).
 *
 * Pure by contract: no fs, no git, no clock, no network, no child processes.
 * Every function takes the observed state (jobs, limits, capacity sample,
 * leases) plus an injected `now`, and returns a decision with a machine-readable
 * reason code. That is what makes the control plane testable with a fake clock
 * and a fake capacity envelope instead of a live VM.
 *
 * The LLM is the data plane: it only does the bounded feature work. Queue
 * ordering, admission, conflict checks, retries, pauses and the state machine
 * live here.
 */

/* Lifecycle states. `paused` is a job state as well as a scheduler-wide pause:
 * a paused job keeps its position but cannot be admitted. */
const STATES = Object.freeze([
  "queued",
  "admitted",
  "running",
  "ready",
  "landing",
  "landed",
  "deployed",
  "done",
  "failed",
  "retry_wait",
  "quarantined",
  "paused",
]);

const TERMINAL_STATES = Object.freeze(["done", "quarantined"]);

/* The phases a feature moves through. `resource` is the admission class:
 *   light    — docs/review, no gate, may overlap freely (scout slot)
 *   code     — one bounded builder in its own worktree
 *   heavy    — machine-wide single heavy tier (API/routes/device)
 *   landing  — exactly one lander, owns main
 *   deploy   — UAT deploy, coalesced to the latest landed SHA
 */
const PHASES = Object.freeze({
  prep: { resource: "light", writes: "feature docs", parallel: true },
  implement: { resource: "code", writes: "worktree", parallel: true },
  verify: { resource: "heavy", writes: "none", parallel: false },
  ready: { resource: "light", writes: "commit", parallel: true },
  land: { resource: "landing", writes: "main", parallel: false },
  deploy: { resource: "deploy", writes: "uat", parallel: false },
  done: { resource: "light", writes: "board", parallel: false },
});

/* Legal transitions. Anything not listed is refused with a named reason rather
 * than silently coerced. `paused` may be entered from every non-terminal state
 * and resumes to `queued` (the scheduler re-admits from scratch). */
const TRANSITIONS = Object.freeze({
  queued: ["admitted", "paused", "quarantined"],
  admitted: ["running", "queued", "failed", "paused", "quarantined"],
  running: ["ready", "failed", "paused", "quarantined"],
  ready: ["landing", "retry_wait", "paused", "quarantined"],
  landing: ["landed", "failed", "retry_wait", "quarantined"],
  landed: ["deployed", "done", "failed"],
  deployed: ["done"],
  failed: ["retry_wait", "quarantined", "queued"],
  retry_wait: ["queued", "admitted", "quarantined"],
  quarantined: [],
  done: [],
  paused: ["queued", "retry_wait", "quarantined"],
});

const DEFAULT_LIMITS = Object.freeze({
  maxBuilders: 1,
  maxScouts: 2,
  maxHeavy: 1,
  maxLandings: 1,
});

const DEFAULT_AIMD = Object.freeze({
  min: 1,
  max: 2,
  cooldownMs: 5 * 60 * 1000,
  healthyTicksToIncrease: 2,
  reserveFreeMemMb: 512,
  maxSwapUsedPct: 60,
  maxMemPressureAvg10: 10,
});

const DEFAULT_RETRY = Object.freeze({
  budget: 2,
  baseDelayMs: 30 * 1000,
  maxDelayMs: 10 * 60 * 1000,
});

const PRIORITY_RANK = Object.freeze({
  hotfix: 100,
  p0: 90,
  p1: 80,
  p2: 60,
  p3: 40,
  p4: 20,
});

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function priorityRank(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const key = String(value || "")
    .trim()
    .toLowerCase();
  return PRIORITY_RANK[key] != null ? PRIORITY_RANK[key] : PRIORITY_RANK.p3;
}

function resourceOf(job) {
  if (job && job.resourceClass) return String(job.resourceClass);
  const phase = job && PHASES[job.phase];
  return phase ? phase.resource : "light";
}

function isTerminal(state) {
  return TERMINAL_STATES.includes(state);
}

/* { ok, reason } for a state transition. `reason` is null when legal. */
function checkTransition(from, to) {
  if (!STATES.includes(String(to))) {
    return { ok: false, reason: `unknown state "${to}"` };
  }
  if (!STATES.includes(String(from))) {
    return { ok: false, reason: `unknown state "${from}"` };
  }
  const allowed = TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    return { ok: false, reason: `illegal transition ${from} -> ${to}` };
  }
  return { ok: true, reason: null };
}

function canTransition(from, to) {
  return checkTransition(from, to).ok;
}

/* --------------------------------------------------------------- ownership */

/* Normalize a project-relative path/glob: forward slashes, no leading "./",
 * no duplicate separators, no trailing separator. Case is preserved (Linux). */
function normalizePath(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");
}

/* A conservative path/glob overlap test. Two owned sets conflict when their
 * static prefixes nest or either glob matches the other's pattern. False
 * positives are acceptable (serialize); false negatives are not (two writers
 * on one file), so the test deliberately over-approximates with `**` when a
 * pattern is ambiguous. */
function globToRegExp(glob) {
  const src = normalizePath(glob);
  let out = "^";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "*") {
      if (src[i + 1] === "*") {
        // `**/` matches zero or more directories; a bare `**` matches anything.
        if (src[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if ("\\.^$+{}()|[]".includes(ch)) {
      out += "\\" + ch;
    } else {
      out += ch;
    }
  }
  return new RegExp(out + "$");
}

function globMatches(glob, path) {
  try {
    return globToRegExp(glob).test(normalizePath(path));
  } catch {
    return false;
  }
}

function staticPrefix(pattern) {
  const p = normalizePath(pattern);
  const idx = p.search(/[*?[]/);
  if (idx === -1) return p;
  const literal = p.slice(0, idx);
  const cut = literal.lastIndexOf("/");
  return cut === -1 ? "" : literal.slice(0, cut);
}

function isPathPrefix(parent, child) {
  if (!parent || !child) return false;
  return child === parent || child.startsWith(parent + "/");
}

function overlapsOwned(a, b) {
  const x = normalizePath(a);
  const y = normalizePath(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const px = staticPrefix(x);
  const py = staticPrefix(y);
  if (isPathPrefix(px, py) || isPathPrefix(py, px)) return true;
  return globMatches(x, y) || globMatches(y, x);
}

function asList(value) {
  if (Array.isArray(value)) return value.map((x) => String(x || "").trim()).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  }
  return [];
}

/* Overlap between two jobs' declared write surfaces. Returns the conflicting
 * pairs, empty when the jobs may run together. */
function conflicts(a, b) {
  if (!a || !b) return { owned: [], contracts: [] };
  const owned = [];
  for (const left of asList(a.owned)) {
    for (const right of asList(b.owned)) {
      if (overlapsOwned(left, right)) owned.push([left, right]);
    }
  }
  const rightContracts = new Set(asList(b.contracts).map((c) => c.toLowerCase()));
  const contractHits = asList(a.contracts).filter((c) => rightContracts.has(c.toLowerCase()));
  return { owned, contracts: contractHits };
}

function hasConflict(a, b) {
  const c = conflicts(a, b);
  return c.owned.length > 0 || c.contracts.length > 0;
}

/* --------------------------------------------------------------- ordering */

function readyAt(job) {
  if (job && typeof job.readyAt === "number") return job.readyAt;
  if (job && typeof job.enqueuedAt === "number") return job.enqueuedAt;
  return 0;
}

/* FIFO by ready time, with priority as a deliberate jump. Ties are broken by
 * enqueue time then id so the order is deterministic across processes. */
function compareJobs(a, b) {
  const pa = priorityRank(a && a.priority);
  const pb = priorityRank(b && b.priority);
  if (pa !== pb) return pb - pa;
  const ra = readyAt(a);
  const rb = readyAt(b);
  if (ra !== rb) return ra - rb;
  const ea = typeof a.enqueuedAt === "number" ? a.enqueuedAt : 0;
  const eb = typeof b.enqueuedAt === "number" ? b.enqueuedAt : 0;
  if (ea !== eb) return ea - eb;
  return String(a.id || "").localeCompare(String(b.id || ""));
}

function queueOrder(jobs) {
  return (jobs || [])
    .filter((j) => j && ["queued", "ready", "retry_wait"].includes(j.state))
    .slice()
    .sort(compareJobs);
}

/* A waiting job older than `thresholdMs` (default 30 min) is surfaced so a
 * priority jump never silently starves the queue. */
function starvationCandidates(jobs, now, thresholdMs) {
  const threshold = typeof thresholdMs === "number" ? thresholdMs : 30 * 60 * 1000;
  return queueOrder(jobs).filter((j) => {
    const since = readyAt(j);
    return since > 0 && now - since >= threshold;
  });
}

/* --------------------------------------------------------------- admission */

function activeJobs(jobs) {
  return (jobs || []).filter((j) => j && ["admitted", "running", "landing"].includes(j.state));
}

function countByResource(jobs, resource) {
  return activeJobs(jobs).filter((j) => resourceOf(j) === resource).length;
}

function dependencyBlocked(job, byFeature) {
  const deps = asList(job && job.dependsOn);
  const missing = deps.filter((dep) => {
    const depJob = byFeature && byFeature.get(dep);
    return !depJob || !["landed", "deployed", "done"].includes(depJob.state);
  });
  return missing;
}

function conflictWith(job, active) {
  for (const other of active) {
    if (!other || other.id === job.id) continue;
    if (resourceOf(job) === "light" || resourceOf(other) === "light") continue;
    const hit = conflicts(job, other);
    if (hit.owned.length) {
      return {
        code: "conflict_owned",
        reason: `owned files overlap ${other.id}: ${hit.owned[0][0]} <-> ${hit.owned[0][1]}`,
      };
    }
    if (hit.contracts.length) {
      return {
        code: "conflict_contract",
        reason: `shared contract "${hit.contracts[0]}" with ${other.id}`,
      };
    }
  }
  return null;
}

/*
 * Decide which jobs may start now. Deterministic and side-effect free.
 *
 *   jobs      — every job in the journal
 *   ctx.limits — DEFAULT_LIMITS-shaped overrides
 *   ctx.capacity — { ok, reasons: [] } normalised from capacity-lib.evaluate
 *   ctx.heavyLock — { held, holder } (serve.js machine-wide heavy lock)
 *   ctx.pause — { reason: "provider_funds"|"red_main"|"capacity"|null, detail }
 *   ctx.now   — injected clock
 *
 * Returns { admitted: [{id, resource}], blocked: [{id, code, reason}], limits }.
 */
function admission(jobs, ctx = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(ctx.limits || {}) };
  const now = typeof ctx.now === "number" ? ctx.now : Date.now();
  const pause = ctx.pause || {};
  const capacity = ctx.capacity || { ok: true, reasons: [] };
  const heavyLock = ctx.heavyLock || {};
  const list = (jobs || []).filter(Boolean);
  const byFeature = new Map(list.map((j) => [String(j.feature || j.id), j]));

  const counted = { code: 0, heavy: 0, landing: 0, light: 0 };
  for (const job of activeJobs(list)) {
    const r = resourceOf(job);
    if (r === "code") counted.code++;
    else if (r === "heavy") counted.heavy++;
    else if (r === "landing") counted.landing++;
    else if (r === "light" && job.phase === "prep") counted.light++;
  }

  const admitted = [];
  const blocked = [];
  const admitting = [];

  for (const job of queueOrder(list)) {
    if (pause.reason === "provider_funds") {
      blocked.push({ id: job.id, code: "provider_funds", reason: pause.detail || "provider funds exhausted" });
      continue;
    }
    if (job.state === "ready") {
      if (pause.reason === "red_main") {
        blocked.push({ id: job.id, code: "red_main", reason: pause.detail || "main is red" });
      } else {
        blocked.push({ id: job.id, code: "ready_to_land", reason: "ready; the single lander picks it up" });
      }
      continue;
    }
    if (job.state === "retry_wait" && typeof job.nextAttemptAt === "number" && job.nextAttemptAt > now) {
      blocked.push({ id: job.id, code: "retry_wait", reason: `next attempt at ${job.nextAttemptAt}` });
      continue;
    }
    const waiting = dependencyBlocked(job, byFeature);
    if (waiting.length) {
      blocked.push({
        id: job.id,
        code: "waiting_for_dependency",
        reason: `waits for ${waiting.join(", ")}`,
      });
      continue;
    }
    if (!capacity.ok && resourceOf(job) !== "light") {
      blocked.push({
        id: job.id,
        code: "capacity",
        reason: (capacity.reasons && capacity.reasons[0]) || "capacity envelope exhausted",
      });
      continue;
    }
    const resource = resourceOf(job);
    if (resource === "landing") {
      if (pause.reason === "red_main") {
        blocked.push({ id: job.id, code: "red_main", reason: pause.detail || "main is red" });
        continue;
      }
      if (counted.landing >= limits.maxLandings) {
        blocked.push({ id: job.id, code: "max_landings", reason: `lander slot busy (${limits.maxLandings})` });
        continue;
      }
      if (heavyLock.held && heavyLock.holder !== job.id) {
        blocked.push({ id: job.id, code: "lander_held", reason: `land lock held by ${heavyLock.holder}` });
        continue;
      }
      counted.landing++;
      admitted.push({ id: job.id, resource });
      continue;
    }
    if (resource === "heavy" && counted.heavy >= limits.maxHeavy) {
      blocked.push({ id: job.id, code: "max_heavy", reason: `heavy verifier busy (${limits.maxHeavy})` });
      continue;
    }
    if (resource === "heavy" && heavyLock.held) {
      blocked.push({ id: job.id, code: "heavy_lock", reason: `heavy lock held by ${heavyLock.holder}` });
      continue;
    }
    if (resource === "code" && counted.code >= limits.maxBuilders) {
      blocked.push({ id: job.id, code: "max_builders", reason: `builder slots busy (${limits.maxBuilders})` });
      continue;
    }
    if (resource === "light" && job.phase === "prep" && counted.light >= limits.maxScouts) {
      blocked.push({ id: job.id, code: "max_scouts", reason: `scout slots busy (${limits.maxScouts})` });
      continue;
    }
    if (resource !== "light") {
      const clash = conflictWith(job, [...activeJobs(list), ...admitting]);
      if (clash) {
        blocked.push({ id: job.id, code: clash.code, reason: clash.reason });
        continue;
      }
    }
    if (resource === "code") counted.code++;
    else if (resource === "heavy") counted.heavy++;
    else if (resource === "light" && job.phase === "prep") counted.light++;
    admitting.push(job);
    admitted.push({ id: job.id, resource });
  }

  return { admitted, blocked, limits };
}

/* --------------------------------------------------------------- AIMD */

/* Additive-increase / multiplicative-decrease admission. Any pressure signal
 * drops the builder limit one step and arms a cooldown; two consecutive healthy
 * ticks after the cooldown raise it one step, never above `max`. */
function aimd(state, sample, config) {
  const cfg = { ...DEFAULT_AIMD, ...(config || {}) };
  const now = typeof sample.now === "number" ? sample.now : 0;
  const limit = clamp(typeof state.limit === "number" ? state.limit : cfg.min, cfg.min, cfg.max);
  const cooldownUntil = typeof state.cooldownUntil === "number" ? state.cooldownUntil : 0;
  const reasons = [];

  if (sample.redMain) reasons.push({ code: "red_main", detail: "integration branch is red" });
  if (typeof sample.swapUsedPct === "number" && sample.swapUsedPct >= cfg.maxSwapUsedPct) {
    reasons.push({ code: "swap", detail: `swap ${sample.swapUsedPct}%` });
  }
  if (typeof sample.memAvailable === "number" && sample.memAvailable < cfg.reserveFreeMemMb) {
    reasons.push({ code: "mem", detail: `${sample.memAvailable} MB free` });
  }
  if (typeof sample.psiSome10 === "number" && sample.psiSome10 >= cfg.maxMemPressureAvg10) {
    reasons.push({ code: "psi", detail: `memory pressure ${sample.psiSome10}` });
  }

  if (reasons.length) {
    const decreased = limit > cfg.min ? limit - 1 : limit;
    return {
      limit: decreased,
      action: decreased < limit ? "decrease" : "hold",
      cooldownUntil: now + cfg.cooldownMs,
      healthyTicks: 0,
      reasons,
    };
  }
  if (now < cooldownUntil) {
    return {
      limit,
      action: "hold",
      cooldownUntil,
      healthyTicks: 0,
      reasons: [{ code: "cooldown", detail: `until ${cooldownUntil}` }],
    };
  }
  const healthyTicks = (typeof state.healthyTicks === "number" ? state.healthyTicks : 0) + 1;
  if (healthyTicks >= cfg.healthyTicksToIncrease && limit < cfg.max) {
    return {
      limit: limit + 1,
      action: "increase",
      cooldownUntil: now + cfg.cooldownMs,
      healthyTicks: 0,
      reasons: [{ code: "healthy", detail: `${healthyTicks} healthy tick(s)` }],
    };
  }
  return { limit, action: "hold", cooldownUntil, healthyTicks, reasons: [] };
}

/* --------------------------------------------------------------- retries */

/* A retry needs a changed hypothesis. Repeating the same failed attempt is how a
 * loop burns the budget without progress, so it is refused; the third refusal
 * quarantines the job for a human. */
function retryDecision(job, ctx = {}) {
  const cfg = { ...DEFAULT_RETRY, ...(ctx.retry || {}) };
  const attempts = typeof ctx.attempts === "number" ? ctx.attempts : Number(job.attempts || 0);
  if (!ctx.hypothesisChanged) {
    return {
      action: "refuse",
      code: "retry_no_new_hypothesis",
      attempt: attempts,
      reason: "retry requires a changed hypothesis (new evidence, fix or test)",
    };
  }
  if (attempts >= cfg.budget) {
    return {
      action: "quarantine",
      code: "retry_budget",
      attempt: attempts,
      reason: `attempt budget exhausted (${cfg.budget})`,
    };
  }
  const delayMs = Math.min(cfg.maxDelayMs, cfg.baseDelayMs * Math.pow(2, attempts));
  return {
    action: "retry",
    code: "retry_scheduled",
    attempt: attempts + 1,
    delayMs,
    reason: `retry ${attempts + 1}/${cfg.budget} in ${Math.round(delayMs / 1000)}s`,
  };
}

/* --------------------------------------------------------------- why */

/* One machine-readable reason code plus one human sentence for `orchestrate
 * why <id>`. `ctx` is the same shape admission() takes, plus `landLock`. */
function blockingReason(job, ctx = {}) {
  if (!job) return { code: "not_found", sentence: "no such job" };
  if (job.state === "quarantined") {
    return { code: "quarantined", sentence: job.reason || "quarantined for a human" };
  }
  if (job.state === "retry_wait") {
    return {
      code: "retry_wait",
      sentence: `waiting to retry: ${job.reason || "scheduled"}`,
    };
  }
  if (job.state === "running" || job.state === "landing") {
    return { code: "running", sentence: `${job.state} ${job.phase || ""}`.trim() };
  }
  if (job.state === "done") return { code: "done", sentence: "job is done" };
  if (job.state === "landed" || job.state === "deployed") {
    return { code: job.state, sentence: `${job.state}; waiting for the next phase` };
  }
  const pause = ctx.pause || {};
  if (pause.reason === "provider_funds") {
    return { code: "provider_funds", sentence: "admissions paused: provider funds exhausted" };
  }
  if (pause.reason === "red_main" && (resourceOf(job) === "landing" || job.state === "ready" || job.phase === "land")) {
    return { code: "red_main", sentence: `landings paused: main is red${pause.detail ? ` (${pause.detail})` : ""}` };
  }
  const decision = admission(ctx.jobs || [job], ctx);
  const hit = decision.blocked.find((b) => b.id === job.id);
  if (hit) return { code: hit.code, sentence: hit.reason };
  if (job.state === "ready") {
    return { code: "ready_to_land", sentence: "ready; the lander may pick it up" };
  }
  if (job.state === "queued" || job.state === "admitted") {
    return { code: "admitted", sentence: "admissible now" };
  }
  return { code: "idle", sentence: `state ${job.state}` };
}

/* --------------------------------------------------------------- plan */

/* Phase 0 dry-run planner. Reads board rows (already parsed by the CLI) and
 * prints the phase pipeline each feature would follow, with the resource class
 * and whether it may overlap. Never mutates anything. */
function dryRunPlan(rows, opts = {}) {
  const limit = typeof opts.limit === "number" ? opts.limit : 12;
  const active = (rows || [])
    .filter((r) => r && r.id && !["archived", "done", "shipped"].includes(String(r.status || "").toLowerCase()))
    .slice()
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority))
    .slice(0, limit);
  return active.map((row) => ({
    feature: row.id,
    priority: row.priority || "P3",
    phases: Object.entries(PHASES).map(([phase, meta]) => ({
      phase,
      resource: meta.resource,
      parallel: meta.parallel,
      writes: meta.writes,
    })),
  }));
}

/* Bounded status view shared by `status` and tests. */
function statusSummary(jobs, ctx = {}) {
  const list = (jobs || []).filter(Boolean);
  const counts = {};
  for (const job of list) counts[job.state] = (counts[job.state] || 0) + 1;
  const ready = queueOrder(list.filter((j) => j.state === "ready"));
  const queued = queueOrder(list.filter((j) => j.state === "queued"));
  return {
    counts,
    paused: (ctx.pause && ctx.pause.reason) || null,
    lander: ctx.landLock && ctx.landLock.held ? ctx.landLock.holder : null,
    queue: queued.map((j) => ({ id: j.id, feature: j.feature, phase: j.phase, priority: j.priority })),
    ready: ready.map((j) => ({ id: j.id, feature: j.feature, phase: j.phase })),
    starved: starvationCandidates(list, typeof ctx.now === "number" ? ctx.now : Date.now()).map((j) => j.id),
  };
}

/* Build a stable job id. One active job per (feature, phase): the journal keys
 * on this id, so re-enqueueing the same ready job is idempotent. */
function jobId(feature, phase) {
  return `${String(feature || "").toUpperCase()}:${String(phase || "implement")}`;
}

module.exports = {
  STATES,
  TERMINAL_STATES,
  PHASES,
  TRANSITIONS,
  DEFAULT_LIMITS,
  DEFAULT_AIMD,
  DEFAULT_RETRY,
  PRIORITY_RANK,
  priorityRank,
  resourceOf,
  isTerminal,
  checkTransition,
  canTransition,
  normalizePath,
  globToRegExp,
  globMatches,
  staticPrefix,
  overlapsOwned,
  conflicts,
  hasConflict,
  compareJobs,
  queueOrder,
  starvationCandidates,
  admission,
  aimd,
  retryDecision,
  blockingReason,
  dryRunPlan,
  statusSummary,
  jobId,
};
