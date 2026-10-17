#!/usr/bin/env node
'use strict';
/*
 * Drift-guard tests for the CI triage CLI (`templates/scripts/qa/ci-triage.js`)
 * and the cost-policy gate (`templates/scripts/qa/check-ci-policy.js`).
 *
 * The signature they guard is the 2026-10 nine-day account-wide outage: a red run
 * that provisioned NO runner must be named `infra-block` (not "tests failed"),
 * and the workflow shapes that caused the burn (a sub-hourly cron, a macOS runner on
 * every unfiltered push) must fail the policy gate before they can land.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const h = require("../bin/agent-harness.js");
const triage = require(path.join(h.TEMPLATES_DIR, "scripts", "qa", "ci-triage.js"));
const policy = require(path.join(h.TEMPLATES_DIR, "scripts", "qa", "check-ci-policy.js"));

const blockedJob = () => ({ runner_name: "", steps: [] });
const realJob = (name = "unit") => ({
  name,
  runner_name: "runner",
  labels: ["ubuntu-latest"],
  conclusion: "failure",
  started_at: "2026-10-08T18:34:00Z",
  completed_at: "2026-10-08T18:44:06Z",
  steps: [{ name: "a" }],
});
const run = (over = {}) => ({
  databaseId: 7,
  name: "CI",
  status: "completed",
  conclusion: "failure",
  headSha: "a".repeat(40),
  ...over,
});

/* ------------------------------------------------------------- ci-triage */

test("triageRun: names the three states and never calls a blocked run a failure", () => {
  assert.strictEqual(triage.triageRun(run({ conclusion: "success" }), [realJob()]).verdict, "green");
  const blocked = triage.triageRun(run(), [blockedJob()]);
  assert.strictEqual(blocked.verdict, "infra-block");
  assert.match(blocked.reason, /NOT a test failure/);
  assert.match(blocked.fix, /payment method|spending limit/);
  const failed = triage.triageRun(run(), [realJob("e2e")]);
  assert.strictEqual(failed.verdict, "failed");
  assert.deepStrictEqual(failed.failedJobs, ["e2e"]);
  assert.match(failed.fix, /gh run view 7 --log-failed/);
  assert.strictEqual(triage.triageRun(run({ conclusion: null, status: "in_progress" }), null).verdict, "incomplete");
});

test("triageRuns / worstVerdict / exitCodeFor: one blocked run dominates, with a distinct exit code", () => {
  const rows = triage.triageRuns([run({ databaseId: 1, conclusion: "success" }), run({ databaseId: 2 })], { 2: [blockedJob()] });
  assert.strictEqual(triage.worstVerdict(rows), "infra-block");
  assert.strictEqual(triage.exitCodeFor("infra-block"), 2);
  assert.strictEqual(triage.exitCodeFor("failed"), 1);
  assert.strictEqual(triage.exitCodeFor("green"), 0);
  assert.strictEqual(triage.worstVerdict([{ verdict: "green" }, { verdict: "failed" }]), "failed");
});

test("workflowRunnerLabels / scheduleMinutes: read cheap-default workflow shapes", () => {
  const src = [
    "on:",
    "  schedule:",
    '    - cron: "*/30 * * * *"',
    "jobs:",
    "  a:",
    "    runs-on: ubuntu-latest",
    "  b:",
    "    strategy:",
    "      matrix:",
    "        os: [ubuntu-latest, macos-14]",
    "    runs-on: ${{ matrix.os }}",
  ].join("\n");
  const labels = triage.workflowRunnerLabels(src);
  assert.ok(labels.includes("ubuntu-latest"));
  assert.ok(labels.includes("macos-14"));
  assert.deepStrictEqual(triage.scheduleMinutes(src), [30]);
});

test("preflightWorkflow: prices a dispatch, flags larger runners and a hot schedule", () => {
  const src = ["on:", "  schedule:", '    - cron: "*/30 * * * *"', "jobs:", "  a:", "    runs-on: macos-14-xlarge"].join("\n");
  const pf = triage.preflightWorkflow(src, [{ jobs: [realJob()] }]);
  assert.ok(pf.largerRunners.includes("macos-14-xlarge"));
  assert.strictEqual(pf.scheduledJobsPerMonth, 1440);
  assert.ok(pf.estUsd > 0);
  assert.ok(["ok", "warn", "fail"].includes(pf.budget.status));
  assert.strictEqual(pf.risky, true);
});

test("ci-triage CLI: --runs-json/--jobs-json classifies offline and exits 2 on a block", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-triage-"));
  const runsFile = path.join(dir, "runs.json");
  const jobsFile = path.join(dir, "jobs.json");
  fs.writeFileSync(runsFile, JSON.stringify([run()]));
  fs.writeFileSync(jobsFile, JSON.stringify({ 7: [blockedJob()] }));
  try {
    const res = spawnSync("node", [path.join(h.TEMPLATES_DIR, "scripts", "qa", "ci-triage.js"), "--runs-json", runsFile, "--jobs-json", jobsFile, "--json"], {
      encoding: "utf8",
    });
    assert.strictEqual(res.status, 2);
    const out = JSON.parse(res.stdout);
    assert.strictEqual(out.schema, "ci-triage/1");
    assert.strictEqual(out.worst, "infra-block");
  } finally {
    spawnSync("rm", ["-rf", dir]);
  }
});

/* --------------------------------------------------------- check-ci-policy */

test("pushTrigger: detects an unfiltered push vs a path-filtered one", () => {
  assert.deepStrictEqual(policy.pushTrigger(["on:", "  push:", "    branches: [main]"].join("\n")), { push: true, paths: false });
  assert.deepStrictEqual(policy.pushTrigger(["on:", "  push:", "    paths:", '      - "mobile/**"'].join("\n")), { push: true, paths: true });
  assert.strictEqual(policy.pushTrigger(["on:", "  schedule:", '    - cron: "0 3 * * *"'].join("\n")).push, false);
});

test("auditWorkflows: fails the burn shapes, passes a cheap default", () => {
  const bad = policy.auditWorkflows([
    { name: "uat-health.yml", src: ["on:", "  schedule:", '    - cron: "*/30 * * * *"', "jobs:", "  p:", "    runs-on: ubuntu-latest"].join("\n") },
    { name: "mobile-validate.yml", src: ["on:", "  push:", "    branches: [main]", "jobs:", "  m:", "    runs-on: macos-14"].join("\n") },
  ]);
  assert.ok(bad.some((f) => f.rule === "scheduled-too-frequent" && f.level === "fail"));
  assert.ok(bad.some((f) => f.rule === "expensive-every-push" && f.level === "fail"));

  const good = policy.auditWorkflows([
    {
      name: "uat-health.yml",
      src: ["on:", "  schedule:", '    - cron: "0 */2 * * *"', "jobs:", "  p:", "    runs-on: ubuntu-latest"].join("\n"),
    },
    {
      name: "mobile-validate.yml",
      src: ["on:", "  push:", "    branches: [main]", "    paths:", '      - "mobile/**"', "jobs:", "  m:", "    runs-on: macos-14"].join("\n"),
    },
  ]);
  assert.deepStrictEqual(good.filter((f) => f.level === "fail"), []);
});

test("ci-policy CLI: the shipped templates pass and a */30 cron fails", () => {
  // The repo's own templates/ must be a cheap default.
  const res = spawnSync("node", [path.join(h.TEMPLATES_DIR, "scripts", "qa", "check-ci-policy.js"), "--root", h.TEMPLATES_DIR], { encoding: "utf8" });
  assert.strictEqual(res.status, 0, res.stdout + res.stderr);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-policy-"));
  fs.mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".github", "workflows", "probe.yml"),
    ["name: probe", "on:", "  schedule:", '    - cron: "*/15 * * * *"', "jobs:", "  p:", "    runs-on: ubuntu-latest"].join("\n")
  );
  try {
    const bad = spawnSync("node", [path.join(h.TEMPLATES_DIR, "scripts", "qa", "check-ci-policy.js"), "--root", dir], { encoding: "utf8" });
    assert.strictEqual(bad.status, 1);
    assert.match(bad.stdout, /scheduled-too-frequent/);
  } finally {
    spawnSync("rm", ["-rf", dir]);
  }
});

test("the CI-policy gate is wired into the process phase and package.json scripts", () => {
  const gates = require(path.join(h.TEMPLATES_DIR, "scripts", "qa", "run-gates.js"));
  const flat = Object.values(gates.PHASES).flat().map((g) => g[0]);
  assert.ok(flat.includes("test:ci-policy"));
});
