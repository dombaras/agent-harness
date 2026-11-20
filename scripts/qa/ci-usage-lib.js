#!/usr/bin/env node
'use strict';
/*
 * ci-usage-lib — GitHub Actions cost model + billing-block classification.
 *
 * The 2026-10 incident: the account had no payment method, exhausted its
 * included Actions quota, and GitHub answered every dispatch with a job that
 * provisions NO runner (`runner_name` empty, `steps: 0`, ~4-6s) and a generic
 * `failure`. Every automated reader treated that as a real test failure — so a
 * nine-day, account-wide outage looked like a product regression, filed board
 * rows, and blocked the landing path.
 *
 * This module makes both halves mechanical:
 *   1. `classifyJob`/`classifyRun` turn the zero-step signature into a distinct
 *      `infra-block` state, so callers can name it instead of "tests failed".
 *   2. `billableMinutes`/`estimateUsage` price a run list with the vendor rate
 *      card (per-job runtime rounded UP to the next whole minute), so the budget
 *      is visible without a `user`-scoped billing token.
 *
 * Dependency-free and pure given its inputs (jobs/runs as parsed JSON), so the
 * model is unit-testable without a network or `gh`.
 */

/* Vendor per-minute rates (USD), GitHub-hosted standard runners.
 * Source: docs.github.com/en/billing/concepts/product-billing/github-actions */
const RATES = {
  linux_slim: 0.002,
  linux: 0.006,
  linux_arm: 0.005,
  windows: 0.01,
  windows_arm: 0.01,
  macos: 0.062,
};

/* Included minutes per billing cycle for private repos on the Free plan. Public
 * repos and self-hosted runners are free and are not modelled here. */
const FREE_MINUTES = { free: 2000, pro: 3000, team: 3000 };

/* A scheduled run every N minutes burns ~1440/N jobs/day. This is the single
 * most common way a "free" account silently leaves the free tier: a sub-minute
 * probe on a 30-minute cron is still a billed job EVERY time it runs. */
function jobsPerMonth(cronMinutes) {
  if (!Number.isFinite(cronMinutes) || cronMinutes <= 0) return 0;
  return Math.round(((60 / cronMinutes) * 24 * 30));
}

/* Map a GitHub runner label (`runs-on`) to a rate key. Larger macOS/Windows
 * runners are always charged and are NOT covered by included minutes — the
 * caller must treat `isLarger` results as paywalled rather than free-tier. */
function rateForLabel(label) {
  const l = String(label || '').toLowerCase();
  if (!l) return { key: 'linux', rate: RATES.linux, isLarger: false };
  if (l.includes('macos') || l.includes('macos-')) {
    // macos-13/14/15/26 are standard; a `-large`/`-xlarge`/`-m2` suffix is larger.
    const larger = /(-large|-xlarge|-xxlarge|\d+-core|m2|m4|pro)/.test(l) && !/^macos-\d+$/.test(l.split(' ')[0]);
    return { key: 'macos', rate: RATES.macos, isLarger: larger };
  }
  if (l.includes('windows')) {
    const larger = /(-large|-xlarge)/.test(l);
    return { key: 'windows', rate: RATES.windows, isLarger: larger };
  }
  if (l.includes('arm')) return { key: 'linux_arm', rate: RATES.linux_arm, isLarger: false };
  return { key: 'linux', rate: RATES.linux, isLarger: false };
}

/* A job's billable minutes: wall-clock from start to completion, rounded UP to
 * the next whole minute (a 6-second job is one billed minute). Returns 0 when a
 * job never provisioned a runner, so a blocked job costs nothing. */
function billableMinutes(job) {
  if (!job) return 0;
  const steps = Array.isArray(job.steps) ? job.steps.length : 0;
  const runner = job.runner_name == null ? '' : String(job.runner_name).trim();
  const started = Date.parse(job.started_at || job.startedAt || '');
  const done = Date.parse(job.completed_at || job.completedAt || '');
  if (steps === 0 && !runner) return 0;
  if (!Number.isFinite(started) || !Number.isFinite(done) || done < started) return 1;
  const secs = (done - started) / 1000;
  if (secs < 30 && steps === 0 && !runner) return 0;
  return Math.max(1, Math.ceil(secs / 60));
}

/* The billing-block signature on ONE job: it completed with zero steps and no
 * runner was ever provisioned. Distinct from a job that ran and failed. */
function isBlockedJob(job) {
  if (!job) return false;
  const steps = Array.isArray(job.steps) ? job.steps.length : 0;
  const runner = job.runner_name == null ? '' : String(job.runner_name).trim();
  return steps === 0 && runner === '';
}

/* Classify a run from its jobs (or, when jobs are unavailable, from the run's
 * own shape). `infra-block` means no runner was provisioned for ANY job while
 * the run is not green — the caller must NOT report this as a test failure. */
function classifyRun(run, jobs) {
  if (!run) return 'unknown';
  const conclusion = String(run.conclusion || '');
  const green = ['success', 'skipped', 'neutral'].includes(conclusion);
  if (!conclusion) return 'incomplete';
  if (green) return 'green';
  if (Array.isArray(jobs) && jobs.length > 0) {
    if (jobs.every(isBlockedJob)) return 'infra-block';
    return 'failed';
  }
  // No job detail: only the cheap run-list shape. A red run that completed in
  // under ~30s never provisioned a runner (a real gate cannot run that fast).
  const created = Date.parse(run.createdAt || run.created_at || '');
  const updated = Date.parse(run.updatedAt || run.updated_at || '');
  if (Number.isFinite(created) && Number.isFinite(updated) && updated - created < 30000) return 'infra-block';
  return 'failed';
}

/* Price a set of runs. `runs` is `[{ jobs: [...] }]` for accuracy, or run-list
 * rows (priced as one Linux minute each — an explicit, conservative floor).
 * Returns { minutes, usd, byRate, blockedJobs, billedJobs }. */
function estimateUsage(runs) {
  const byRate = {};
  let minutes = 0;
  let usd = 0;
  let blockedJobs = 0;
  let billedJobs = 0;
  for (const run of runs || []) {
    const jobs = Array.isArray(run && run.jobs) ? run.jobs : null;
    if (jobs) {
      for (const job of jobs) {
        if (isBlockedJob(job)) {
          blockedJobs += 1;
          continue;
        }
        const labels = Array.isArray(job.labels) && job.labels.length ? job.labels : ['ubuntu-latest'];
        const { key, rate } = rateForLabel(labels[0]);
        const m = billableMinutes(job);
        if (m <= 0) continue;
        billedJobs += 1;
        minutes += m;
        usd += m * rate;
        byRate[key] = byRate[key] || { minutes: 0, usd: 0 };
        byRate[key].minutes += m;
        byRate[key].usd += m * rate;
      }
    } else if (run && run.conclusion) {
      // Coarse fallback: one Linux minute per completed run.
      minutes += 1;
      usd += RATES.linux;
      billedJobs += 1;
      byRate.linux = byRate.linux || { minutes: 0, usd: 0 };
      byRate.linux.minutes += 1;
      byRate.linux.usd += RATES.linux;
    }
  }
  return { minutes, usd, byRate, blockedJobs, billedJobs };
}

/* Compare estimated usage against an allowance. `allowanceMinutes` defaults to
 * the Free plan. `spendingLimitUsd` is the budget the operator set; the honest
 * state is `unknown` when usage could not be read — never `ok`. */
function budgetState(usage, opts = {}) {
  const allowanceMinutes = Number(opts.allowanceMinutes) || FREE_MINUTES.free;
  const warnAtPct = Number(opts.warnAtPct) || 80;
  if (!usage || !Number.isFinite(Number(usage.minutes))) return { status: 'unknown', reason: 'usage unreadable' };
  const minutes = Number(usage.minutes);
  const pct = allowanceMinutes > 0 ? (minutes / allowanceMinutes) * 100 : 0;
  let status = 'ok';
  if (pct >= 100) status = 'fail';
  else if (pct >= warnAtPct) status = 'warn';
  return {
    status,
    minutes,
    allowanceMinutes,
    pct: Math.round(pct),
    usd: Number(usage.usd || 0),
    remainingMinutes: Math.max(0, allowanceMinutes - minutes),
  };
}

module.exports = {
  RATES,
  FREE_MINUTES,
  jobsPerMonth,
  rateForLabel,
  billableMinutes,
  isBlockedJob,
  classifyRun,
  estimateUsage,
  budgetState,
};
