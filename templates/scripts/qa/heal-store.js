#!/usr/bin/env node
"use strict";
/*
 * heal-store — the append-only knowledge base for the self-healing loop (F-076).
 *
 * Everything lives under `.agents/qa-runs/heal/` in the MAIN checkout (shared
 * through the git common dir), never in a disposable feature worktree:
 *   ledger.jsonl        append-only events (items + KPI samples)
 *   audit.jsonl         append-only action audit (Phase 1+)
 *   state.json          derived counters; rebuildable from the ledger
 *   reports/<stamp>/    report.json + report.md
 *   latest.json         pointer to the newest report
 *
 * Phase 0 is read-only: `observe` mode may record *samples* (facts from existing
 * sources) but never creates a repair item and never touches product code or the
 * board. `heal status`/`heal report` write only their requested report artifact.
 *
 * The ledger is the source of truth. A corrupt or partial line is quarantined,
 * never fatal; retention is the one documented rewrite of the log.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const feedback = require("./feedback-lib.js");

const SCHEMA = "heal-event/1";
const STATE_SCHEMA = "heal-state/1";
const REPORT_SCHEMA = "heal-report/1";

function git(root, args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return r.status === 0 ? String(r.stdout || "").trim() : null;
}

/* The main checkout that owns the shared git dir. */
function mainCheckout(root) {
  const common = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common) {
    const clean = common.replace(/[\\/]+$/, "");
    return path.basename(clean) === ".git" ? path.dirname(clean) : clean;
  }
  return git(root, ["rev-parse", "--show-toplevel"]) || root;
}

/* One ledger for every worktree. `healDir` and AGENT_HARNESS_HEAL_DIR are
 * operator/test overrides; they never change policy or classification. */
function storePaths(root, opts = {}) {
  const dir = opts.healDir
    ? path.resolve(opts.healDir)
    : process.env.AGENT_HARNESS_HEAL_DIR
      ? path.resolve(process.env.AGENT_HARNESS_HEAL_DIR)
      : path.join(mainCheckout(path.resolve(root || process.cwd())), ".agents", "qa-runs", "heal");
  return {
    dir,
    ledger: path.join(dir, "ledger.jsonl"),
    audit: path.join(dir, "audit.jsonl"),
    state: path.join(dir, "state.json"),
    latest: path.join(dir, "latest.json"),
    reports: path.join(dir, "reports"),
    corrupt: path.join(dir, "corrupt.jsonl"),
  };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function isoNow(now) {
  if (now == null) return new Date().toISOString();
  const d = new Date(now);
  return Number.isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString();
}

function toMs(value) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

function appendJsonl(file, value) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(value) + "\n", "utf8");
}

/* Read an append-only JSONL file. A malformed line is moved to `corrupt.jsonl`
 * (line + parse error) and skipped; the rest still load. */
function readJsonl(file, opts = {}) {
  const events = [];
  const corrupt = [];
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (_) {
    return { events, corrupt, missing: true };
  }
  const lines = raw.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== "object") throw new Error("not an object");
      events.push(parsed);
    } catch (e) {
      corrupt.push({ line: index + 1, error: e.message, raw: line.slice(0, 500) });
    }
  });
  if (corrupt.length && opts.quarantine !== false) {
    const at = isoNow(opts.now);
    for (const c of corrupt) appendJsonl(opts.corruptPath || path.join(path.dirname(file), "corrupt.jsonl"), { at, file: path.basename(file), ...c });
  }
  return { events, corrupt, missing: false };
}

/* Redact before anything leaves the store: tokens, emails, absolute paths,
 * query strings, and secret-like key/value pairs. Recursive and bounded. */
const TOKEN_RE = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const ABS_PATH_RE = /(?:[A-Za-z]:\\(?:[^\\\s:]+\\)*[^\\\s:]+|\/(?:home|Users|root|tmp|var|opt|mnt|srv)\/[^\s"',)]+)/g;
const QUERY_RE = /([?&][A-Za-z0-9_%=.-]+=[^\s&#"',)]*)/g;

function redactString(text, max = 4000) {
  let s = feedback.redactSecrets(String(text));
  s = s.replace(TOKEN_RE, "[redacted-token]");
  s = s.replace(EMAIL_RE, "[redacted-email]");
  s = s.replace(ABS_PATH_RE, "[redacted-path]");
  s = s.replace(QUERY_RE, "[redacted-query]");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function redact(value, depth = 0) {
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 200)) out[k] = redact(v, depth + 1);
    return out;
  }
  return value;
}

function itemKey(item) {
  return `${item.source}|${item.environment}|${item.signature}`;
}

/* Append a ledger event and return it. `type: "sample"` carries a measured KPI
 * fact; `type: "item"` carries a repair item snapshot. */
function appendEvent(root, event, opts = {}) {
  if (!event || typeof event !== "object") throw new Error("event must be an object");
  const p = storePaths(root, opts);
  const e = {
    schema: SCHEMA,
    at: event.at || isoNow(opts.now),
    type: event.type || (event.item ? "item" : "sample"),
    ...event,
  };
  appendJsonl(p.ledger, redact(e));
  return e;
}

/* Record one normalized item. A repeated observation of the same signature
 * updates last_seen/occurrences (and severity upward) instead of adding a second
 * item — the caller gets the merged record and `created: false`. */
function recordItem(root, item, opts = {}) {
  if (!item || typeof item !== "object") throw new Error("item must be an object");
  if (!item.signature) throw new Error("item.signature is required");
  const p = storePaths(root, opts);
  const state = readState(root, opts);
  const existing = state.items.find((it) => itemKey(it) === itemKey(item));
  const at = opts.now ? isoNow(opts.now) : item.last_seen || isoNow();
  const merged = existing
    ? {
        ...existing,
        last_seen: at,
        occurrences: (existing.occurrences || 1) + 1,
        severity: severityMax(existing.severity, item.severity),
        evidence: mergeEvidence(existing.evidence, item.evidence),
      }
    : { ...item, first_seen: item.first_seen || at, last_seen: item.last_seen || at };
  const event = { type: "item", at, item: merged };
  appendEvent(root, event, opts);
  state.items = state.items.filter((it) => itemKey(it) !== itemKey(merged)).concat(merged);
  writeJsonAtomic(p.state, { ...state, schema: STATE_SCHEMA, generated_at: at });
  return { item: merged, created: !existing, event };
}

const SEVERITY_ORDER = { P1: 0, P2: 1, P3: 2, P4: 3 };
function severityMax(a, b) {
  if (!a) return b || "P2";
  if (!b) return a;
  return (SEVERITY_ORDER[a] ?? 9) <= (SEVERITY_ORDER[b] ?? 9) ? a : b;
}

/* Upsert a state transition without counting a new observation. recordItem is
 * for detection (occurrences + severity); updateItem is for the repair loop's
 * own transitions (attempting/verified/closed/escalated). */
function updateItem(root, item, opts = {}) {
  if (!item || typeof item !== "object") throw new Error("item must be an object");
  if (!item.signature) throw new Error("item.signature is required");
  const at = opts.now ? isoNow(opts.now) : item.last_seen || isoNow();
  const next = { ...item, last_seen: item.last_seen || at };
  appendEvent(root, { type: "item", at, item: next }, opts);
  const state = readState(root, opts);
  state.items = state.items.filter((it) => itemKey(it) !== itemKey(next)).concat(next);
  writeJsonAtomic(storePaths(root, opts).state, { ...state, schema: STATE_SCHEMA, generated_at: at });
  return next;
}

function recordBreaker(root, breaker, opts = {}) {
  return appendEvent(root, {
    type: "breaker",
    at: isoNow(opts.now),
    consecutive_failures: Number(breaker?.consecutive_failures) || 0,
    until: breaker?.until || breaker?.breaker_until || null,
    open: breaker?.open === true,
  }, opts);
}

function mergeEvidence(a, b) {
  const seen = new Set();
  const out = [];
  for (const e of [...(a || []), ...(b || [])]) {
    const key = `${e.kind}|${e.sha256 || e.pointer || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out.slice(-10);
}

/* Record a KPI sample (a measured fact from an existing source). */
function recordSample(root, sample, opts = {}) {
  if (!sample || !sample.name) throw new Error("sample.name is required");
  if (typeof sample.value !== "number" || !Number.isFinite(sample.value)) {
    throw new Error(`sample.value must be a finite number (${sample.name})`);
  }
  const at = sample.at || isoNow(opts.now);
  /* Idempotent ingestion: the same (source, name, at) fact is recorded once, so
   * a repeated `heal run` converges instead of double-counting a baseline. */
  if (opts.dedupe !== false) {
    const state = readState(root, opts);
    const key = `${sample.source || "unknown"}|${sample.name}|${at}`;
    if (state.samples.some((s) => `${s.source || "unknown"}|${s.name}|${s.at}` === key)) return null;
  }
  return appendEvent(root, {
    type: "sample",
    at,
    source: String(sample.source || "unknown"),
    name: String(sample.name),
    value: sample.value,
    unit: sample.unit || "count",
    ok: sample.ok == null ? null : sample.ok === true,
  }, opts);
}

function appendAudit(root, entry, opts = {}) {
  const p = storePaths(root, opts);
  const e = redact({ schema: "heal-audit/1", at: isoNow(opts.now), ...entry });
  appendJsonl(p.audit, e);
  return e;
}

/* Rebuild the derived state from the append-only ledger. Last snapshot per
 * signature wins; security violations and a red main are counted, never guessed. */
function rebuildState(events, opts = {}) {
  const items = new Map();
  const samples = [];
  let redMain = false;
  let errorBudgetFrozen = false;
  let breakerUntil = null;
  let breakerSeen = false;
  let breakerFailures = null;
  const safety = [];

  for (const e of events) {
    if (!e || typeof e !== "object") continue;
    if (e.type === "item" && e.item && e.item.signature) {
      items.set(itemKey(e.item), { ...e.item });
    } else if (e.type === "sample") {
      samples.push({ at: e.at, source: e.source, name: e.name, value: e.value, unit: e.unit, ok: e.ok });
    } else if (e.type === "red_main") {
      redMain = e.red === true;
    } else if (e.type === "error_budget") {
      errorBudgetFrozen = e.frozen === true;
    } else if (e.type === "breaker") {
      breakerFailures = Number(e.consecutive_failures) || 0;
      breakerUntil = e.until || null;
      breakerSeen = true;
    } else if (e.type === "safety") {
      safety.push({ id: e.id || null, reason: e.reason || "safety violation", at: e.at });
    }
  }

  /* Consecutive failures are the trailing run of terminal-bad items ordered by
   * last_seen. A green close resets the run. */
  const ordered = [...items.values()]
    .filter((it) => it.last_seen)
    .sort((a, b) => (toMs(a.last_seen) || 0) - (toMs(b.last_seen) || 0));
  let consecutiveFailures = 0;
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    if (!["escalated", "reverted"].includes(ordered[i].state)) break;
    consecutiveFailures += 1;
  }
  /* An explicit breaker event (Phase 2) is authoritative: it can reset the
   * counter after a success and carries the cooldown timestamp. */
  if (breakerSeen) consecutiveFailures = breakerFailures;

  return {
    schema: STATE_SCHEMA,
    generated_at: isoNow(opts.now),
    items: [...items.values()],
    samples,
    red_main: redMain,
    error_budget_frozen: errorBudgetFrozen,
    consecutive_failures: consecutiveFailures,
    breaker_until: breakerUntil,
    safety,
  };
}

function readState(root, opts = {}) {
  const p = storePaths(root, opts);
  const cached = readJson(p.state, null);
  const { events } = readJsonl(p.ledger, { ...opts, corruptPath: p.corrupt });
  if (!events.length) {
    return cached && cached.schema === STATE_SCHEMA
      ? cached
      : { schema: STATE_SCHEMA, generated_at: isoNow(opts.now), items: [], samples: [], red_main: false, error_budget_frozen: false, consecutive_failures: 0, safety: [] };
  }
  return rebuildState(events, { ...opts, stateFile: p.state });
}

function refreshState(root, opts = {}) {
  const p = storePaths(root, opts);
  const state = readState(root, opts);
  writeJsonAtomic(p.state, state);
  return state;
}

/* Retention: drop ledger events older than `days`, and report dirs beyond
 * `keep_reports`. This is the documented exception to append-only; audit.jsonl
 * is never pruned (the audit trail is the trust artifact). */
function prune(root, policy = {}, opts = {}) {
  const p = storePaths(root, opts);
  const now = toMs(opts.now) || Date.now();
  const days = policy?.retention?.days || 90;
  const keepReports = policy?.retention?.keep_reports ?? 30;
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  let dropped = 0;
  const { events, corrupt } = readJsonl(p.ledger, { ...opts, corruptPath: p.corrupt });
  const kept = events.filter((e) => {
    const at = toMs(e.at);
    if (at != null && at < cutoff) {
      dropped += 1;
      return false;
    }
    return true;
  });
  if (dropped) {
    ensureDir(p.dir);
    const tmp = `${p.ledger}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length ? "\n" : ""), "utf8");
    fs.renameSync(tmp, p.ledger);
  }
  let removedReports = 0;
  try {
    const dirs = fs.readdirSync(p.reports, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    for (const name of dirs.slice(0, Math.max(0, dirs.length - keepReports))) {
      fs.rmSync(path.join(p.reports, name), { recursive: true, force: true });
      removedReports += 1;
    }
  } catch (_) {
    /* no reports yet */
  }
  return { dropped_events: dropped, removed_reports: removedReports, quarantined: corrupt.length };
}

/* Persist a report under reports/<stamp>/ and update latest.json. */
function writeReport(root, report, opts = {}) {
  const p = storePaths(root, opts);
  const stamp = String(report.stamp || (report.generated_at || isoNow(opts.now)).replace(/[:.]/g, "-"));
  const dir = path.join(p.reports, stamp);
  ensureDir(dir);
  const jsonPath = path.join(dir, "report.json");
  writeJsonAtomic(jsonPath, redact(report));
  let mdPath = null;
  if (typeof report.markdown === "string") {
    mdPath = path.join(dir, "report.md");
    fs.writeFileSync(mdPath, redactString(report.markdown, 200000) + "\n", "utf8");
  }
  writeJsonAtomic(p.latest, {
    schema: "heal-latest/1",
    stamp,
    generated_at: report.generated_at || isoNow(opts.now),
    hhi: report.hhi == null ? null : report.hhi,
    report: path.relative(p.dir, jsonPath),
    markdown: mdPath ? path.relative(p.dir, mdPath) : null,
  });
  return { dir, jsonPath, mdPath, stamp };
}

function readLatest(root, opts = {}) {
  return readJson(storePaths(root, opts).latest, null);
}

module.exports = {
  SCHEMA,
  STATE_SCHEMA,
  REPORT_SCHEMA,
  mainCheckout,
  storePaths,
  readJsonl,
  readJson,
  writeJsonAtomic,
  appendEvent,
  recordItem,
  updateItem,
  recordSample,
  recordBreaker,
  appendAudit,
  rebuildState,
  readState,
  refreshState,
  prune,
  writeReport,
  readLatest,
  redact,
  redactString,
  itemKey,
};
