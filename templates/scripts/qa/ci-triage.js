#!/usr/bin/env node
"use strict";
/*
 * ci-triage — name a red GitHub Actions run for what it is, and price a
 * dispatch before it runs.
 *
 * The 2026-10 incident: the account had no payment method, exhausted its
 * included Actions minutes, and GitHub answered every dispatch with a job that
 * provisioned NO runner (`runner_name` empty, `steps: 0`, ~4-6s) and a generic
 * `failure`. Every automated reader called that "tests failed" — so a nine-day
 * account-wide outage looked like a product regression and blocked landing.
 *
 * `ci-usage-lib.js` owns the cost model; `ci-wait-lib.js` owns the in-watch
 * detection. This is the on-demand reader an operator/agent calls to ask
 * "why is CI red?" and get one of three named verdicts:
 *
 *   green       — the run succeeded (or was skipped/neutral)
 *   infra-block — no runner was ever provisioned: NOT a test failure
 *   failed      — a runner ran and the code/tests failed
 *
 * It also has a `--preflight` mode: before you dispatch an expensive workflow,
 * print the runner rates it uses, what recent runs actually cost, and the
 * budget impact — so the burn is visible before the dispatch, not after.
 *
 * Usage:
 *   node scripts/qa/ci-triage.js [--limit 10] [--workflow <name>] [--repo <dir>]
 *   node scripts/qa/ci-triage.js --run <databaseId>
 *   node scripts/qa/ci-triage.js --preflight .github/workflows/ci.yml
 *   node scripts/qa/ci-triage.js ... --json
 *
 * Exit: 0 = green/ok, 1 = a real failure, 2 = infra-block (or a budget overrun
 * on preflight). A distinct code lets a caller/script branch without parsing the
 * prose. Dependency-light: `gh` is the only spawn, and every path is
 * overridable so the classification is unit-testable offline.
 */

const fs = require("fs");
const path = require("path");

const usage = require("./ci-usage-lib.js");
const { ghJson } = require("./ci-wait-lib.js");

/* ---------------------------------------------------------------- verdicts */

/* Classify ONE run (with its jobs when available) into a named verdict plus a
 * short reason and the fix hint. Never says "tests failed" for a blocked run. */
function triageRun(run, jobs, opts = {}) {
  if (!run) return { verdict: "unknown", reason: "no run", fix: null };
  const id = run.databaseId || run.id || null;
  const name = run.name || run.workflowName || null;
  const sha = run.headSha || run.head_sha || null;
  const url = run.url || null;
  const base = { id, name, sha, url };
  const verdict = usage.classifyRun(run, jobs);
  if (verdict === "green") {
    return { ...base, verdict: "green", reason: `concluded ${run.conclusion || "success"}`, fix: null };
  }
  if (verdict === "incomplete") {
    return { ...base, verdict: "incomplete", reason: `still ${run.status || "running"}`, fix: null };
  }
  if (verdict === "infra-block") {
    return {
      ...base,
      verdict: "infra-block",
      reason: "no runner was provisioned (0 steps, no runner_name) — NOT a test failure",
      fix: "add/repair the account payment method or raise the spending limit, then re-dispatch",
      hint: "gh auth refresh -h github.com -s user   # makes the billing state readable",
    };
  }
  const failedJobs = (Array.isArray(jobs) ? jobs : [])
    .filter((j) => j && !["success", "skipped", "neutral"].includes(String(j.conclusion || "")))
    .map((j) => j.name)
    .filter(Boolean);
  const allowance = Number(opts.marginMinutes) || 0;
  return {
    ...base,
    verdict: "failed",
    reason: failedJobs.length ? `ran and failed: ${failedJobs.join(", ")}` : "ran and failed",
    failedJobs,
    fix: id ? `gh run view ${id} --log-failed` : null,
    allowance,
  };
}

/* Triage a list of runs. `jobsByRun` maps run id -> jobs[]. */
function triageRuns(runs, jobsByRun) {
  const jobs = jobsByRun || {};
  return (runs || []).map((run) => {
    const id = run && (run.databaseId || run.id);
    return triageRun(run, id && jobs[id] ? jobs[id] : run && run.jobs ? run.jobs : null);
  });
}

/* The worst verdict in a triage, in the order a caller should care:
 * infra-block (a blind account) > failed (real work) > incomplete > green. */
function worstVerdict(rows) {
  const rank = { "infra-block": 3, failed: 2, incomplete: 1, unknown: 1, green: 0 };
  let worst = "green";
  for (const r of rows || []) {
    if ((rank[r.verdict] ?? 0) > (rank[worst] ?? 0)) worst = r.verdict;
  }
  return worst;
}

/* Exit code for a verdict: green/ok -> 0, failed -> 1, infra-block -> 2. */
function exitCodeFor(verdict) {
  if (verdict === "failed") return 1;
  if (verdict === "infra-block") return 2;
  return 0;
}

/* --------------------------------------------------------------- preflight */

/* Parse the runner labels a workflow file asks for. Handles scalar
 * `runs-on: ubuntu-latest`, block scalars, and matrix values
 * (`runs-on: ${{ matrix.os }}` + `os: [ubuntu-latest, macos-14]`). Best-effort
 * text scan — a workflow is not a full YAML parse here, only a cost signal. */
function workflowRunnerLabels(src) {
  const labels = new Set();
  const text = String(src || "");
  for (const m of text.matchAll(/runs-on:\s*(.+)$/gm)) {
    const raw = m[1].trim();
    if (raw.startsWith("${{")) continue; // resolved from a matrix below
    for (const part of raw.replace(/[\[\]"]/g, "").split(",")) {
      const v = part.trim();
      if (v) labels.add(v);
    }
  }
  // matrix os/runner lists: `os: [ubuntu-latest, macos-14]`
  for (const m of text.matchAll(/^\s{2,}(?:os|runner|runs-on):\s*\[([^\]]+)\]/gm)) {
    for (const part of m[1].split(",")) {
      const v = part.trim().replace(/["']/g, "");
      if (v) labels.add(v);
    }
  }
  return [...labels];
}

/* The schedule intervals a workflow declares (a `cron:` of every 30 minutes
 * yields 30). Feeds `jobsPerMonth` so a sub-minute probe on a tight cron is
 * visible as a monthly burn instead of "a free minute". */
function scheduleMinutes(src) {
  const out = [];
  for (const m of String(src || "").matchAll(/cron:\s*["']?([^"'\n]+)["']?/g)) {
    const step = m[1].trim().split(/\s+/)[0];
    const everyN = /^\*\/(\d+)$/.exec(step);
    if (everyN) out.push(Number(everyN[1]));
    else if (step === "*") out.push(1);
    else if (/^\d+$/.test(step)) out.push(Number(step));
  }
  return out;
}

/* Price a dispatch of one workflow: the rates it can hit, what its recent runs
 * cost (median billable minutes), and the budget impact of one more run. */
function preflightWorkflow(src, recentRuns, opts = {}) {
  const labels = workflowRunnerLabels(src);
  const rates = labels.map((l) => ({ label: l, ...usage.rateForLabel(l) }));
  const larger = rates.filter((r) => r.isLarger).map((r) => r.label);
  const history = usage.estimateUsage(recentRuns || []);
  const perRunMinutes = (recentRuns || []).length
    ? Math.round((history.minutes / recentRuns.length) * 10) / 10
    : null;
  const dominant = rates.find((r) => !r.isLarger) || rates[0] || usage.rateForLabel("");
  const estMinutes = perRunMinutes == null ? 1 : perRunMinutes;
  const estUsd = Math.round(estMinutes * dominant.rate * 10000) / 10000;
  const extraMinutes = scheduleMinutes(src).reduce((acc, n) => acc + usage.jobsPerMonth(n), 0);
  const budget = usage.budgetState(
    { minutes: (Number(opts.usedMinutes) || 0) + estMinutes, usd: (Number(opts.usedUsd) || 0) + estUsd },
    opts
  );
  return {
    labels,
    rates,
    largerRunners: larger,
    samples: (recentRuns || []).length,
    perRunMinutes,
    estMinutes,
    estUsd,
    scheduledJobsPerMonth: extraMinutes,
    budget,
    risky: larger.length > 0 || extraMinutes > Number(opts.scheduledJobsPerMonthMax || 200),
  };
}

/* --------------------------------------------------------------------- CLI */

function parseArgs(argv) {
  const out = { limit: 10, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--run") out.run = argv[++i];
    else if (a.startsWith("--run=")) out.run = a.slice("--run=".length);
    else if (a === "--workflow") out.workflow = argv[++i];
    else if (a.startsWith("--workflow=")) out.workflow = a.slice("--workflow=".length);
    else if (a === "--sha") out.sha = argv[++i];
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a.startsWith("--limit=")) out.limit = Number(a.slice("--limit=".length));
    else if (a === "--repo" || a === "--root") out.repo = argv[++i];
    else if (a.startsWith("--repo=")) out.repo = a.slice("--repo=".length);
    else if (a === "--preflight") out.preflight = argv[++i];
    else if (a.startsWith("--preflight=")) out.preflight = a.slice("--preflight=".length);
    else if (a === "--runs-json") out.runsJson = argv[++i];
    else if (a === "--jobs-json") out.jobsJson = argv[++i];
    else if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

/* Recent runs for a repo (optionally a workflow), via `gh`. Returns
 * { ok, runs, error }. */
function fetchRuns(cwd, limit, workflow) {
  const args = [
    "run",
    "list",
    "--limit",
    String(limit || 10),
    "--json",
    "databaseId,name,status,conclusion,headSha,url,createdAt,updatedAt",
  ];
  if (workflow) args.splice(1, 0, "--workflow", workflow);
  const res = ghJson(cwd, args);
  return res.ok ? { ok: true, runs: res.data || [], error: null } : { ok: false, runs: [], error: res.error };
}

/* Jobs for one run, via `gh api`. */
function fetchJobs(cwd, runId) {
  const res = ghJson(cwd, ["api", `/repos/{owner}/{repo}/actions/runs/${runId}/jobs`]);
  return res.ok ? { ok: true, jobs: (res.data && res.data.jobs) || [], error: null } : { ok: false, jobs: [], error: res.error };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function printRows(rows) {
  for (const r of rows) {
    const tag = r.verdict === "green" ? "OK  " : r.verdict === "infra-block" ? "BLOCK" : r.verdict === "failed" ? "FAIL" : "…";
    console.log(`  [${tag}] ${r.name || "?"}${r.sha ? " @ " + String(r.sha).slice(0, 7) : ""} — ${r.reason}`);
    if (r.verdict !== "green" && r.fix) console.log(`         fix: ${r.fix}`);
    if (r.hint && r.verdict === "infra-block" && process.env.CI_TRIAGE_VERBOSE) console.log(`         ${r.hint}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "Usage: node scripts/qa/ci-triage.js [--limit N] [--workflow <name>] [--repo <dir>] [--sha <sha>]\n" +
        "       node scripts/qa/ci-triage.js --run <databaseId>\n" +
        "       node scripts/qa/ci-triage.js --preflight .github/workflows/<file>.yml\n" +
        "       [--runs-json <file>] [--jobs-json <file>] [--json]"
    );
    return;
  }
  const root = path.resolve(args.repo || process.cwd());

  if (args.preflight) {
    const file = path.resolve(root, args.preflight);
    const src = fs.readFileSync(file, "utf8");
    let recent = [];
    if (args.runsJson) recent = readJson(args.runsJson);
    else {
      const got = fetchRuns(root, args.limit, args.workflow);
      if (got.ok) recent = got.runs;
    }
    const pf = preflightWorkflow(src, recent);
    if (args.json) {
      console.log(JSON.stringify({ schema: "ci-preflight/1", workflow: args.preflight, ...pf }, null, 2));
    } else {
      console.log(`ci preflight — ${args.preflight}`);
      console.log(`  runners: ${pf.labels.join(", ") || "(none detected)"}`);
      for (const r of pf.rates) {
        console.log(`    ${r.label}: $${r.rate}/min${r.isLarger ? "  (LARGER runner — not covered by included minutes)" : ""}`);
      }
      if (pf.largerRunners.length) {
        console.log(`  ! larger runners present (${pf.largerRunners.join(", ")}) — always billed, never free-tier`);
      }
      console.log(
        `  history: ${pf.samples} run(s)${pf.perRunMinutes != null ? `, ~${pf.perRunMinutes} min each` : " (no history — assuming 1 min)"}`
      );
      console.log(`  one dispatch ≈ ${pf.estMinutes} min ≈ $${pf.estUsd}`);
      if (pf.scheduledJobsPerMonth) console.log(`  schedule burn ≈ ${pf.scheduledJobsPerMonth} jobs/mo from this file`);
      console.log(
        `  budget: ${pf.budget.status} — ${pf.budget.minutes}/${pf.budget.allowanceMinutes} min (${pf.budget.pct}%)`
      );
    }
    const bad = pf.budget.status === "fail" || pf.budget.status === "warn";
    process.exit(bad ? 2 : 0);
  }

  let rows;
  if (args.runsJson) {
    const runs = readJson(args.runsJson);
    const jobsById = args.jobsJson ? readJson(args.jobsJson) : {};
    rows = triageRuns(runs, jobsById);
  } else if (args.run) {
    const got = fetchJobs(root, args.run);
    const run = {
      databaseId: args.run,
      name: args.workflow || null,
      conclusion: got.ok ? "failure" : null,
    };
    rows = [triageRun(run, got.ok ? got.jobs : null)];
  } else {
    const got = fetchRuns(root, args.limit, args.workflow);
    if (!got.ok) {
      console.error(`ci-triage: could not read runs (${got.error})`);
      process.exit(2);
    }
    rows = triageRuns(
      got.runs.map((r) => (args.sha ? r : r)),
      {}
    );
    if (args.sha) rows = rows.filter((r) => String(r.sha || "").startsWith(args.sha));
  }

  if (args.json) {
    console.log(JSON.stringify({ schema: "ci-triage/1", rows, worst: worstVerdict(rows) }, null, 2));
  } else {
    printRows(rows);
    console.log(`\nverdict: ${worstVerdict(rows)}`);
  }
  process.exit(exitCodeFor(worstVerdict(rows)));
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error("ci-triage: " + (e && e.message ? e.message : e));
    process.exit(1);
  }
}

module.exports = {
  triageRun,
  triageRuns,
  worstVerdict,
  exitCodeFor,
  workflowRunnerLabels,
  scheduleMinutes,
  preflightWorkflow,
  parseArgs,
};
