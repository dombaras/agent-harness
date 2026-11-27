"use strict";
/*
 * orchestrator-store — the durable, crash-safe journal behind the parallel
 * feature orchestrator (F-068).
 *
 * The journal is the source of truth, not a model's memory:
 *   .serve/orchestrator/state.json   — jobs, pause flag, AIMD state
 *   .serve/orchestrator/events.jsonl — append-only transition/timing log
 *   .serve/orchestrator/land.lock/   — single-lander lease (dir is atomic)
 *
 * Writes are atomic (tmp + rename); the event log is append-only. The lander
 * lock reuses the same birth-token lease semantics as `.serve/sessions/*` so a
 * recycled pid can never count as a live lander.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const lease = require("./lease-lib");
const lib = require("./orchestrator-lib");

const STATE_VERSION = 1;
const LAND_LOCK_TTL_MS = 15 * 60 * 1000;
const EVENT_LOG_MAX_BYTES = 2 * 1024 * 1024;

function orchestratorDir(root) {
  return path.join(root, ".serve", "orchestrator");
}
function statePath(root) {
  return path.join(orchestratorDir(root), "state.json");
}
function eventsPath(root) {
  return path.join(orchestratorDir(root), "events.jsonl");
}
function landLockDir(root) {
  return path.join(orchestratorDir(root), "land.lock");
}
function landLockHolderPath(root) {
  return path.join(landLockDir(root), "holder.json");
}

function git(root, args, opts = {}) {
  const r = spawnSync("git", args, {
    cwd: opts.cwd || root,
    encoding: "utf8",
    timeout: opts.timeout || 15000,
  });
  return {
    ok: r.status === 0,
    status: r.status,
    out: (r.stdout || "").trim(),
    err: (r.stderr || "").trim(),
  };
}

/* The queue is shared by every feature worktree, so the journal lives in the
 * repository's MAIN checkout, not in whichever linked worktree asked. */
function controlRoot(root) {
  const r = git(root, ["worktree", "list", "--porcelain"]);
  if (r.ok && r.out) {
    const first = r.out.split(/\r?\n/).find((line) => line.startsWith("worktree "));
    if (first) {
      const dir = first.slice("worktree ".length).trim();
      if (dir) return dir;
    }
  }
  return root;
}

function emptyState() {
  return { version: STATE_VERSION, seq: 0, updatedAt: 0, paused: null, aimd: null, jobs: {} };
}

function readState(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(root), "utf8"));
    if (!parsed || typeof parsed !== "object" || !parsed.jobs) return emptyState();
    return {
      version: parsed.version || STATE_VERSION,
      seq: Number(parsed.seq) || 0,
      updatedAt: Number(parsed.updatedAt) || 0,
      paused: parsed.paused || null,
      aimd: parsed.aimd || null,
      jobs: parsed.jobs && typeof parsed.jobs === "object" ? parsed.jobs : {},
    };
  } catch {
    return emptyState();
  }
}

function writeState(root, state) {
  const dir = orchestratorDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const next = { ...state, version: STATE_VERSION, updatedAt: Date.now() };
  const tmp = path.join(dir, `.state.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, statePath(root));
  return next;
}

function appendEvent(root, event) {
  const dir = orchestratorDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const file = eventsPath(root);
  try {
    const st = fs.statSync(file);
    if (st.size > EVENT_LOG_MAX_BYTES) {
      // Keep the log bounded: one rotation, no history tree to maintain.
      fs.renameSync(file, file + ".1");
    }
  } catch {
    /* absent — nothing to rotate */
  }
  const rec = { ts: Date.now(), ...event };
  fs.appendFileSync(file, JSON.stringify(rec) + "\n", "utf8");
  return rec;
}

function readEvents(root, limit) {
  try {
    const lines = fs.readFileSync(eventsPath(root), "utf8").split(/\r?\n/).filter(Boolean);
    const tail = typeof limit === "number" && limit > 0 ? lines.slice(-limit) : lines;
    return tail.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    });
  } catch {
    return [];
  }
}

function bump(state) {
  state.seq = (Number(state.seq) || 0) + 1;
  return state.seq;
}

/* Create (or return) the job for a (feature, phase). Idempotent: an existing
 * job that is not failed/quarantined is returned untouched, so a retried
 * `enqueue` never forks a second job or loses history. */
function createJob(root, input, opts = {}) {
  const phase = input.phase || "ready";
  const id = input.id || lib.jobId(input.feature, phase);
  const state = readState(root);
  const existing = state.jobs[id];
  if (existing && !["failed", "quarantined"].includes(existing.state)) {
    return { job: existing, created: false };
  }
  const now = typeof opts.now === "number" ? opts.now : Date.now();
  const job = {
    id,
    feature: String(input.feature || "").toUpperCase(),
    phase,
    state: input.state || "ready",
    priority: input.priority || "P3",
    resourceClass: input.resourceClass || lib.resourceOf({ phase }),
    branch: input.branch || null,
    worktree: input.worktree || null,
    baseSha: input.baseSha || null,
    owned: Array.isArray(input.owned) ? input.owned : [],
    contracts: Array.isArray(input.contracts) ? input.contracts : [],
    dependsOn: Array.isArray(input.dependsOn) ? input.dependsOn : [],
    attempts: Number(input.attempts) || 0,
    retryBudget: Number(input.retryBudget) || undefined,
    enqueuedAt: now,
    readyAt: now,
    updatedAt: now,
    reason: input.reason || null,
    history: [],
  };
  state.jobs[id] = job;
  bump(state);
  writeState(root, state);
  appendEvent(root, { type: "enqueue", id, feature: job.feature, phase, state: job.state });
  return { job, created: true };
}

/* Move a job through a legal transition. Returns { ok, job?, code, reason }. */
function transitionJob(root, id, to, meta = {}, opts = {}) {
  const state = readState(root);
  const job = state.jobs[id];
  if (!job) return { ok: false, code: "not_found", reason: `no job ${id}` };
  const check = lib.checkTransition(job.state, to);
  if (!check.ok) return { ok: false, job, code: "illegal_transition", reason: check.reason };
  const now = typeof opts.now === "number" ? opts.now : Date.now();
  const from = job.state;
  job.state = to;
  job.updatedAt = now;
  Object.assign(job, meta, { state: to, updatedAt: now });
  job.history = (job.history || []).slice(-19);
  job.history.push({ from, to, ts: now, reason: meta.reason || null });
  bump(state);
  writeState(root, state);
  appendEvent(root, {
    type: "transition",
    id,
    feature: job.feature,
    phase: job.phase,
    from,
    to,
    code: meta.code || null,
    reason: meta.reason || null,
  });
  return { ok: true, job, from, code: "ok" };
}

function setPause(root, reason, detail, opts = {}) {
  const state = readState(root);
  const now = typeof opts.now === "number" ? opts.now : Date.now();
  state.paused = reason ? { reason, detail: detail || null, at: now } : null;
  bump(state);
  writeState(root, state);
  appendEvent(root, { type: reason ? "pause" : "resume", reason: reason || null, detail: detail || null });
  return state.paused;
}

function setAimd(root, next) {
  const state = readState(root);
  state.aimd = next;
  bump(state);
  writeState(root, state);
  return state.aimd;
}

/* --------------------------------------------------------------- land lock */

function readLandLock(root) {
  try {
    return JSON.parse(fs.readFileSync(landLockHolderPath(root), "utf8"));
  } catch {
    return null;
  }
}

function landLockStatus(rec, opts = {}) {
  if (!rec) return { live: false, reason: "absent" };
  return lease.leaseStatus(rec, {
    now: opts.now,
    maxAgeMs: opts.ttlMs || LAND_LOCK_TTL_MS,
  });
}

/* Acquire the single-lander lease. `mkdir` is the atomic primitive; a stale
 * holder (dead/recycled pid or an expired heartbeat) is reclaimed once. */
function acquireLandLock(root, meta = {}, opts = {}) {
  const dir = landLockDir(root);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const now = typeof opts.now === "number" ? opts.now : Date.now();
  const ttlMs = opts.ttlMs || LAND_LOCK_TTL_MS;
  const token = lease.birthToken(process.pid);
  const holder = {
    holder: meta.holder || `pid-${process.pid}`,
    feature: meta.feature || null,
    pid: process.pid,
    bootId: token.bootId,
    procStart: token.procStart,
    startedAt: now,
    heartbeatAt: now,
    ttlMs,
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(landLockHolderPath(root), JSON.stringify(holder), "utf8");
      appendEvent(root, { type: "land_lock", id: "acquire", feature: holder.feature, holder: holder.holder });
      return { acquired: true, holder };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const current = readLandLock(root);
      const status = landLockStatus(current, { now, ttlMs });
      if (status.live) {
        return {
          acquired: false,
          code: "lander_held",
          reason: `land lock held by ${current.holder || "unknown"} (${status.reason})`,
          holder: current,
        };
      }
      // Reclaim exactly once. If another process wins the race, the next mkdir
      // reports EEXIST and the holder is live, which is the correct answer.
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* vanished — retry */
      }
    }
  }
  return { acquired: false, code: "lander_held", reason: "could not acquire the land lock", holder: readLandLock(root) };
}

function heartbeatLandLock(root, holderId, opts = {}) {
  const rec = readLandLock(root);
  if (!rec || rec.holder !== holderId) return { ok: false, code: "not_holder" };
  rec.heartbeatAt = typeof opts.now === "number" ? opts.now : Date.now();
  fs.writeFileSync(landLockHolderPath(root), JSON.stringify(rec), "utf8");
  return { ok: true, holder: rec };
}

function releaseLandLock(root, holderId) {
  const rec = readLandLock(root);
  if (rec && holderId && rec.holder !== holderId) {
    return { ok: false, code: "not_holder", reason: `held by ${rec.holder}` };
  }
  fs.rmSync(landLockDir(root), { recursive: true, force: true });
  appendEvent(root, { type: "land_lock", id: "release", holder: holderId || (rec && rec.holder) || null });
  return { ok: true };
}

/* --------------------------------------------------------------- reconcile */

function remoteHead(root, remote = "origin", branch = "main") {
  const r = git(root, ["ls-remote", remote, `refs/heads/${branch}`]);
  if (!r.ok || !r.out) return null;
  return r.out.split(/\s+/)[0] || null;
}

function localHead(root) {
  const r = git(root, ["rev-parse", "HEAD"]);
  return r.ok ? r.out : null;
}

function branchHead(root, branch) {
  if (!branch) return null;
  const r = git(root, ["rev-parse", "--verify", branch]);
  return r.ok ? r.out : null;
}

function isAncestor(root, commit, of) {
  if (!commit || !of) return false;
  return git(root, ["merge-base", "--is-ancestor", commit, of]).ok;
}

/*
 * Classify a job that was landing when the process died, against remote truth
 * (never against a model's claim):
 *   landed       — the branch (or a commit containing it) is on origin/main
 *   unknown_push — remote moved away from the job's base but we cannot prove
 *                  the branch landed; a human must decide before replay
 *   retry        — the branch is not on origin/main; the idempotent lander may
 *                  run again
 *   untouched    — the job is not in a landing state
 */
function reconcileJob(root, job, opts = {}) {
  if (!job || !["landing", "landed"].includes(job.state)) {
    return { state: "untouched", reason: `job is ${job && job.state}` };
  }
  const remote = opts.remote || "origin";
  const branch = opts.branch || "main";
  const remoteSha = opts.remoteSha || remoteHead(root, remote, branch);
  const wt = job.worktree && fs.existsSync(job.worktree) ? job.worktree : root;
  const head = opts.branchSha || branchHead(wt, job.branch) || null;
  if (!remoteSha) return { state: "retry", code: "no_remote", remoteSha, branchSha: head };
  if (job.state === "landed") return { state: "landed", remoteSha, branchSha: head };
  if (head && (head === remoteSha || isAncestor(root, head, remoteSha))) {
    return { state: "landed", remoteSha, branchSha: head };
  }
  if (job.baseSha && remoteSha !== job.baseSha && !isAncestor(root, job.baseSha, remoteSha)) {
    return {
      state: "unknown_push",
      code: "remote_moved",
      remoteSha,
      branchSha: head,
      baseSha: job.baseSha,
      reason: "origin/main moved and the branch is not contained — inspect before retrying",
    };
  }
  return { state: "retry", code: "not_on_main", remoteSha, branchSha: head };
}

function reconcileJournal(root, opts = {}) {
  const state = readState(root);
  const out = [];
  for (const job of Object.values(state.jobs)) {
    const verdict = reconcileJob(root, job, opts);
    if (verdict.state === "landed" && job.state === "landing") {
      transitionJob(root, job.id, "landed", {
        code: "reconciled",
        reason: "remote truth shows the branch on main",
      });
    }
    if (verdict.state !== "untouched") out.push({ id: job.id, ...verdict });
  }
  return out;
}

module.exports = {
  STATE_VERSION,
  LAND_LOCK_TTL_MS,
  orchestratorDir,
  statePath,
  eventsPath,
  landLockDir,
  controlRoot,
  readState,
  writeState,
  appendEvent,
  readEvents,
  createJob,
  transitionJob,
  setPause,
  setAimd,
  readLandLock,
  landLockStatus,
  acquireLandLock,
  heartbeatLandLock,
  releaseLandLock,
  remoteHead,
  localHead,
  branchHead,
  isAncestor,
  reconcileJob,
  reconcileJournal,
};
