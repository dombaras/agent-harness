#!/usr/bin/env node
"use strict";
/*
 * Session-lease primitives (harness-shipped). One home for the `.serve/sessions/`
 * lease format + liveness rules, shared by the context-guard plugin (writer) and
 * `check-concurrency.js` (reader) so the two can never disagree on what "live"
 * means.
 *
 * A lease is `.serve/sessions/<sessionID>.json`:
 *   { sessionID, pid, bootId, procStart, startedAt, heartbeatAt }
 *
 * Liveness is deliberately conservative — a false "live" blocks an innocent
 * push, so every signal must agree:
 *   - the pid must exist (EPERM counts as alive: it exists, just not ours);
 *   - the process BIRTH TOKEN must match. `bootId` + `/proc/<pid>/stat`
 *     starttime identify one specific process incarnation, so a recycled pid
 *     (the OS handing the number to a new opencode) is not mistaken for the
 *     session that wrote the lease — the 0.1.67 false-positive this fixes;
 *   - the lease must carry a fresh heartbeat. The plugin touches it on every
 *     event/tool call, so a session that ended without a `session.deleted`
 *     event (TUI closed, server still alive) goes stale instead of lingering
 *     forever.
 *
 * The birth token is Linux/WSL-only (`/proc`); elsewhere `bootId`/`procStart`
 * are null and liveness falls back to pid + heartbeat.
 */
const fs = require("fs");
const path = require("path");

const DEFAULT_MAX_AGE_MS = 12 * 60 * 60 * 1000; // heartbeat freshness window

let cachedBootId;
function bootId() {
  if (cachedBootId !== undefined) return cachedBootId;
  try {
    cachedBootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
  } catch {
    cachedBootId = null;
  }
  return cachedBootId;
}

function processAlive(pid) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !!(err && err.code === "EPERM"); // exists, owned by another user
  }
}

/* Field 22 (`starttime`, clock ticks since boot) of /proc/<pid>/stat. Parsing
 * past the final `)` avoids comm containing spaces/parens. */
function processStart(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close === -1) return null;
    const fields = stat.slice(close + 2).split(" ");
    const starttime = fields[19]; // field 3 begins here, so field 22 is index 19
    return starttime || null;
  } catch {
    return null;
  }
}

function birthToken(pid) {
  return { bootId: bootId(), procStart: processStart(pid) };
}

function leaseDir(root) {
  return path.join(root, ".serve", "sessions");
}

function readLeases(root) {
  const dir = leaseDir(root);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    let rec;
    try {
      rec = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      rec = { sessionID: name.replace(/\.json$/, "") };
    }
    out.push({ file, name, ...rec });
  }
  return out;
}

function heartbeatAt(rec) {
  if (typeof rec.heartbeatAt === "number") return rec.heartbeatAt;
  if (typeof rec.startedAt === "number") return rec.startedAt;
  return 0;
}

/* { live, reason } where reason is one of: live | no-pid | dead | recycled |
 * stale. `now`/`maxAgeMs` are injectable for deterministic tests. */
function leaseStatus(rec, opts = {}) {
  const now = opts.now || Date.now();
  const maxAgeMs = opts.maxAgeMs || DEFAULT_MAX_AGE_MS;
  if (typeof rec.pid !== "number") return { live: false, reason: "no-pid" };
  if (!processAlive(rec.pid)) return { live: false, reason: "dead" };
  if (rec.bootId) {
    const cur = birthToken(rec.pid);
    if (cur.bootId && cur.bootId !== rec.bootId) return { live: false, reason: "recycled" };
    // The pid exists under our boot but is a different incarnation than the one
    // that wrote the lease.
    if (cur.procStart && rec.procStart && cur.procStart !== rec.procStart) {
      return { live: false, reason: "recycled" };
    }
  }
  const hb = heartbeatAt(rec);
  if (!hb || now - hb >= maxAgeMs) return { live: false, reason: "stale" };
  return { live: true, reason: "live" };
}

function liveLeases(root, opts) {
  return readLeases(root).filter((rec) => leaseStatus(rec, opts).live);
}

/* Write/replace this process's lease for a primary session. */
function writeLease(root, sessionID, meta = {}) {
  const dir = leaseDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const tok = birthToken(process.pid);
  const rec = {
    sessionID,
    pid: process.pid,
    bootId: tok.bootId,
    procStart: tok.procStart,
    startedAt: now,
    heartbeatAt: now,
    ...meta,
  };
  fs.writeFileSync(path.join(dir, `${sessionID}.json`), JSON.stringify(rec));
  return rec;
}

/* Refresh the heartbeat so an active-but-quiet session stays live. */
function touchLease(root, sessionID) {
  const file = path.join(leaseDir(root), `${sessionID}.json`);
  try {
    const rec = JSON.parse(fs.readFileSync(file, "utf8"));
    rec.heartbeatAt = Date.now();
    fs.writeFileSync(file, JSON.stringify(rec));
  } catch {
    /* best-effort; a missing lease is re-created on session.created */
  }
}

function clearLease(root, sessionID) {
  try {
    fs.rmSync(path.join(leaseDir(root), `${sessionID}.json`), { force: true });
  } catch {
    /* best-effort */
  }
}

/* Remove every lease that is not live. Returns [{sessionID, reason, pid}]. */
function pruneLeases(root, opts = {}) {
  const removed = [];
  for (const rec of readLeases(root)) {
    const status = leaseStatus(rec, opts);
    if (status.live) continue;
    try {
      fs.rmSync(rec.file, { force: true });
      removed.push({ sessionID: rec.sessionID || rec.name, reason: status.reason, pid: rec.pid });
    } catch {
      /* best-effort */
    }
  }
  return removed;
}

function describeLease(rec, opts = {}) {
  const status = leaseStatus(rec, opts);
  const age = typeof rec.startedAt === "number" ? Math.round((Date.now() - rec.startedAt) / 60000) : null;
  return `${rec.sessionID || rec.name} (pid ${rec.pid}, age ${age == null ? "?" : age + "m"}, ${status.reason})`;
}

module.exports = {
  DEFAULT_MAX_AGE_MS,
  bootId,
  processAlive,
  processStart,
  birthToken,
  leaseDir,
  readLeases,
  heartbeatAt,
  leaseStatus,
  liveLeases,
  writeLease,
  touchLease,
  clearLease,
  pruneLeases,
  describeLease,
};
