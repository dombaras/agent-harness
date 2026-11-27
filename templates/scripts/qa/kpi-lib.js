#!/usr/bin/env node
"use strict";
/*
 * kpi-lib — pure metric math for the harness health loop (F-076, Phase 0).
 *
 * No IO, no clock, no model. Callers pass records + a window and persist what
 * this returns. That keeps every KPI reproducible offline and makes the HHI a
 * reporting number, never a hidden merge gate.
 *
 * Contracts:
 *   kpi/1       one computed KPI row (id, value, unit, direction, target)
 *   kpi-report/1  window summary (current, baseline, delta, hhi)
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/* The Phase 0 catalog. `direction` says whether a rising value is good ("up")
 * or bad ("down"). Targets are initial SLOs; `null` means "baseline only" until
 * 14 days of evidence calibrate it. */
const KPI_CATALOG = [
  { id: "gate_pass_rate", label: "Gate pass rate (first attempt)", unit: "ratio", direction: "up", target: 0.95, source: "gate" },
  { id: "ci_first_attempt", label: "CI first-attempt success", unit: "ratio", direction: "up", target: 0.9, source: "ci" },
  { id: "change_failure_rate", label: "Change failure rate (7d)", unit: "ratio", direction: "down", target: 0.1, source: "git" },
  { id: "mttr_min", label: "MTTR (median, minutes)", unit: "minutes", direction: "down", target: 30, source: "heal" },
  { id: "mttd_cycles", label: "MTTD (median cycles)", unit: "count", direction: "down", target: null, source: "heal" },
  { id: "rollback_rate", label: "Rollback rate", unit: "ratio", direction: "down", target: 0.05, source: "git" },
  { id: "reopen_rate", label: "Regression reopen rate", unit: "ratio", direction: "down", target: 0.1, source: "board" },
  { id: "flake_rate", label: "Flake rate", unit: "ratio", direction: "down", target: 0.15, source: "feedback" },
  { id: "test_integrity_blocked", label: "Test-integrity blocks", unit: "ratio", direction: "up", target: 1, source: "feedback" },
  { id: "queue_time_min", label: "Queue time (p50, minutes)", unit: "minutes", direction: "down", target: 10, source: "orchestrator" },
  { id: "fix_throughput", label: "Signals closed per week", unit: "count", direction: "up", target: 5, source: "heal" },
  { id: "wip", label: "Work in progress", unit: "count", direction: "down", target: 3, source: "orchestrator" },
  { id: "auto_fix_acceptance", label: "Auto-fix acceptance", unit: "ratio", direction: "up", target: 0.95, source: "heal" },
  { id: "task_success_rate", label: "Task success rate", unit: "ratio", direction: "up", target: null, source: "agent-report" },
  { id: "pass_k", label: "pass^k (k=3)", unit: "ratio", direction: "up", target: 0.8, source: "eval" },
  { id: "dispatch_success", label: "Dispatch success", unit: "ratio", direction: "up", target: 0.9, source: "agent-report" },
  { id: "tool_error_rate", label: "Tool-call error rate", unit: "ratio", direction: "down", target: 0.02, source: "agent-report" },
  { id: "wrong_tool_rate", label: "Wrong-tool/argument rate", unit: "ratio", direction: "down", target: 0.03, source: "agent-report" },
  { id: "escalation_rate", label: "Escalation rate", unit: "ratio", direction: "down", target: 0.2, source: "agent-report" },
  { id: "human_interventions", label: "Human interventions per feature", unit: "count", direction: "down", target: null, source: "agent-report" },
  { id: "retries_per_success", label: "Retries per success", unit: "ratio", direction: "down", target: 1.3, source: "agent-report" },
  { id: "context_resets", label: "Context resets per feature", unit: "count", direction: "down", target: 1, source: "agent-report" },
  { id: "cost_per_feature_usd", label: "Cost per shipped feature (USD)", unit: "usd", direction: "down", target: 5, source: "agent-report" },
  { id: "cost_per_signal_usd", label: "Cost per resolved signal (USD)", unit: "usd", direction: "down", target: 5, source: "heal" },
  { id: "tokens_per_success", label: "Tokens per successful task", unit: "count", direction: "down", target: null, source: "agent-report" },
  { id: "cache_hit_rate", label: "Cache hit rate", unit: "ratio", direction: "up", target: 0.4, source: "agent-report" },
  { id: "wasted_spend_ratio", label: "Wasted-spend ratio", unit: "ratio", direction: "down", target: 0.2, source: "agent-report" },
  { id: "budget_utilization", label: "Budget utilization", unit: "ratio", direction: "up", target: 0.7, source: "agent-report" },
  { id: "high_risk_auto_lands", label: "High-risk auto-lands", unit: "count", direction: "down", target: 0, source: "heal" },
  { id: "unauthorized_writes", label: "Unauthorized writes", unit: "count", direction: "down", target: 0, source: "heal" },
  { id: "weakening_attempts_blocked", label: "Test weakening blocked", unit: "ratio", direction: "up", target: 1, source: "feedback" },
  { id: "kill_switch_latency_sec", label: "Kill-switch latency (s)", unit: "seconds", direction: "down", target: 60, source: "heal" },
  { id: "audit_completeness", label: "Audit completeness", unit: "ratio", direction: "up", target: 1, source: "heal" },
  { id: "injection_detections", label: "Injection detections", unit: "count", direction: "down", target: 0, source: "heal" },
  { id: "recurrence_rate", label: "Recurrence rate (30d)", unit: "ratio", direction: "down", target: 0.1, source: "heal" },
  { id: "playbook_hit_rate", label: "Playbook hit rate", unit: "ratio", direction: "up", target: 0.6, source: "heal" },
  { id: "time_to_playbook_days", label: "Time to playbook (days)", unit: "days", direction: "down", target: 7, source: "heal" },
  { id: "eval_coverage", label: "Eval coverage", unit: "ratio", direction: "up", target: 1, source: "eval" },
  { id: "improvement_acceptance", label: "Improvement acceptance", unit: "ratio", direction: "up", target: 0.3, source: "heal" },
  { id: "version_skew", label: "Version skew (minors)", unit: "count", direction: "down", target: 1, source: "doctor" },
  { id: "doctor_pass_rate", label: "Doctor pass rate", unit: "ratio", direction: "up", target: 0.98, source: "doctor" },
  { id: "drift_count", label: "Harness-owned drift count", unit: "count", direction: "down", target: 0, source: "doctor" },
  { id: "update_success_rate", label: "Update success rate", unit: "ratio", direction: "up", target: 0.95, source: "doctor" },
];

/* HHI dimension weights from the research brief (§6.7). */
const HHI_WEIGHTS = {
  reliability: 0.3,
  delivery: 0.2,
  quality: 0.2,
  cost: 0.15,
  learning: 0.1,
  deployed_health: 0.05,
};

const HHI_DIMENSIONS = {
  reliability: ["gate_pass_rate", "ci_first_attempt", "change_failure_rate", "mttr_min", "rollback_rate", "reopen_rate", "flake_rate", "test_integrity_blocked"],
  delivery: ["queue_time_min", "fix_throughput", "wip", "auto_fix_acceptance"],
  quality: ["task_success_rate", "pass_k", "dispatch_success", "tool_error_rate", "wrong_tool_rate", "escalation_rate", "retries_per_success"],
  cost: ["cost_per_feature_usd", "cost_per_signal_usd", "wasted_spend_ratio"],
  learning: ["recurrence_rate", "playbook_hit_rate", "eval_coverage", "improvement_acceptance"],
  deployed_health: ["version_skew", "doctor_pass_rate", "drift_count", "update_success_rate"],
};

function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function toMs(value) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

/* Filter records to [since, until). A record without a parseable timestamp is
 * excluded (never silently bucketed into "now"): a KPI must be reproducible. */
function inWindow(record, opts = {}) {
  const at = toMs(record && (record.at || record.ts || record.time || record.timestamp));
  if (at == null) return false;
  const since = toMs(opts.since);
  const until = toMs(opts.until);
  if (since != null && at < since) return false;
  if (until != null && at >= until) return false;
  return true;
}

function ratio(numerator, denominator) {
  if (!isNum(numerator) || !isNum(denominator) || denominator <= 0) return null;
  return numerator / denominator;
}

function clamp01(v) {
  if (!isNum(v)) return null;
  return Math.min(1, Math.max(0, v));
}

function sorted(values) {
  return (values || []).filter(isNum).slice().sort((a, b) => a - b);
}

/* Nearest-rank percentile (p in [0,1]). Returns null for an empty set. */
function percentile(values, p) {
  const xs = sorted(values);
  if (!xs.length) return null;
  const q = Math.min(1, Math.max(0, isNum(p) ? p : 0.5));
  const rank = q === 0 ? 0 : Math.ceil(q * xs.length) - 1;
  return xs[Math.min(xs.length - 1, Math.max(0, rank))];
}

function median(values) {
  const xs = sorted(values);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/* Burn rate = observed bad rate / allowed bad rate. `allowedBadRate` is
 * 1 - target. A zero allowed rate with any observed badness is +Infinity; with
 * zero badness it is 0. Never divide by zero silently. */
function burnRate(observedBadRate, allowedBadRate) {
  if (!isNum(observedBadRate) || !isNum(allowedBadRate)) return null;
  if (allowedBadRate <= 0) return observedBadRate > 0 ? Infinity : 0;
  return observedBadRate / allowedBadRate;
}

/* pass^k: every one of the first k trials passed. `trials` is an array of
 * boolean arrays (one per task); `k` defaults to 3. A task with fewer than k
 * trials counts as failed (an unobserved trial is not a pass). */
function passK(trials, k = 3) {
  if (!Array.isArray(trials) || !trials.length || !isNum(k) || k <= 0) return null;
  let ok = 0;
  for (const row of trials) {
    if (!Array.isArray(row) || row.length < k) continue;
    if (row.slice(0, k).every((v) => v === true)) ok += 1;
  }
  return ok / trials.length;
}

function costPerSuccess(costUsd, successes) {
  if (!isNum(costUsd) || !isNum(successes) || successes <= 0) return null;
  return costUsd / successes;
}

/* Normalize one observed value against a Phase 0 baseline and the SLO target,
 * clipped to [0,1]. "up" metrics improve as they rise; "down" metrics improve
 * as they fall. With baseline == target, any observed value at the target is 1
 * and a miss is 0. A null value is "unobserved", never a fabricated pass. */
function normalizeSubscore(value, opts = {}) {
  if (!isNum(value) || !isNum(opts.baseline) || !isNum(opts.target)) return null;
  const { baseline, target } = opts;
  const direction = opts.direction === "down" ? "down" : "up";
  if (baseline === target) {
    const atTarget = direction === "up" ? value >= target : value <= target;
    return atTarget ? 1 : 0;
  }
  const raw = direction === "up" ? (value - baseline) / (target - baseline) : (baseline - value) / (baseline - target);
  return clamp01(raw);
}

/* Geometric weighted mean, 0–100. Any hard safety violation zeroes the index
 * for the whole window (research §6.7). Unobserved dimensions are dropped and
 * their weight is renormalized — HHI never invents a subscore. */
function hhi(subscores, opts = {}) {
  if (opts.safetyViolation) return 0;
  const weights = opts.weights || HHI_WEIGHTS;
  const keys = Object.keys(weights).filter((k) => isNum(subscores && subscores[k]));
  if (!keys.length) return null;
  const totalWeight = keys.reduce((sum, k) => sum + weights[k], 0);
  if (totalWeight <= 0) return null;
  let weightedLog = 0;
  for (const k of keys) {
    const v = Math.min(1, Math.max(0, subscores[k]));
    weightedLog += (weights[k] / totalWeight) * Math.log(v === 0 ? 1e-12 : v);
  }
  return Math.round(100 * Math.exp(weightedLog) * 100) / 100;
}

/* Aggregate catalog rows into the six HHI dimensions. Missing observations are
 * omitted, not defaulted to 1. */
function subScores(rows) {
  const byId = new Map((rows || []).map((r) => [r.id, r]));
  const out = {};
  for (const [dimension, ids] of Object.entries(HHI_DIMENSIONS)) {
    const values = ids.map((id) => byId.get(id)).filter((r) => r && isNum(r.normalized)).map((r) => r.normalized);
    if (!values.length) continue;
    out[dimension] = values.reduce((a, b) => a + b, 0) / values.length;
  }
  return out;
}

/* Merge current + baseline values into catalog rows. `current` and `baseline`
 * are maps of id → observed number. */
function buildRows(current = {}, baseline = {}) {
  return KPI_CATALOG.map((kpi) => {
    const value = isNum(current[kpi.id]) ? current[kpi.id] : null;
    const base = isNum(baseline[kpi.id]) ? baseline[kpi.id] : null;
    const normalized = normalizeSubscore(value, {
      baseline: base,
      target: kpi.target,
      direction: kpi.direction,
    });
    return {
      ...kpi,
      value,
      baseline: base,
      delta: isNum(value) && isNum(base) ? Math.round((value - base) * 10000) / 10000 : null,
      normalized,
    };
  });
}

/* Top burn driver: the row with the highest observed-bad/allowed-bad ratio for
 * "down" metrics, or the lowest target-attainment for "up" metrics. Only rows
 * with a target and an observation compete; the result names the reason. */
function topBurnDriver(rows) {
  let best = null;
  for (const row of rows || []) {
    if (!isNum(row.value) || !isNum(row.target)) continue;
    const bad = row.direction === "down" ? row.value : 1 - row.value;
    const allowed = row.direction === "down" ? row.target : 1 - row.target;
    const burn = burnRate(bad, allowed);
    if (burn == null) continue;
    if (!best || burn > best.burn) {
      best = {
        id: row.id,
        label: row.label,
        value: row.value,
        target: row.target,
        burn: Number.isFinite(burn) ? Math.round(burn * 100) / 100 : null,
        infinite: burn === Infinity,
      };
    }
  }
  return best;
}

/* A window summary: rows + HHI + the top driver. `current`/`baseline` are
 * maps of id → number; `safetyViolation` is a boolean the caller derives from
 * hard guardrails (never inferred here). */
function summarize(current = {}, baseline = {}, opts = {}) {
  const rows = buildRows(current, baseline);
  const subs = subScores(rows);
  const index = hhi(subs, { safetyViolation: opts.safetyViolation === true });
  return {
    schema: "kpi-report/1",
    window_days: isNum(opts.windowDays) ? opts.windowDays : 14,
    rows,
    subscores: subs,
    hhi: index,
    top_driver: topBurnDriver(rows),
    observed: rows.filter((r) => r.value != null).length,
    catalog: rows.length,
  };
}

module.exports = {
  DAY_MS,
  KPI_CATALOG,
  HHI_WEIGHTS,
  HHI_DIMENSIONS,
  inWindow,
  toMs,
  ratio,
  percentile,
  median,
  burnRate,
  passK,
  costPerSuccess,
  normalizeSubscore,
  hhi,
  subScores,
  buildRows,
  topBurnDriver,
  summarize,
};
