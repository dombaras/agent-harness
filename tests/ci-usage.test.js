#!/usr/bin/env node
'use strict';
/*
 * Drift-guard tests for the CI cost model + billing-block classifier
 * (`templates/scripts/qa/ci-usage-lib.js`) and the blocked-run path in
 * `ci-wait-lib.js`. The signature is the 2026-10 nine-day account-wide outage:
 * a red run that provisions NO runner (steps: 0, runner_name empty) must be
 * named `infra-block`, never reported as a test failure, and never billed.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const h = require("../bin/agent-harness.js");
const lib = require(path.join(h.TEMPLATES_DIR, "scripts", "qa", "ci-usage-lib.js"));
const ciWait = require(path.join(h.TEMPLATES_DIR, "scripts", "qa", "ci-wait-lib.js"));

const blockedJob = () => ({ runner_name: "", started_at: "2026-10-17T05:31:13Z", completed_at: "2026-10-17T05:31:19Z", steps: [] });
const realJob = (over = {}) => ({
  runner_name: "GitHub Actions 1000001674",
  labels: ["ubuntu-latest"],
  started_at: "2026-10-08T18:34:00Z",
  completed_at: "2026-10-08T18:44:06Z",
  steps: [{ name: "a" }, { name: "b" }],
  ...over,
});

test("rateForLabel: standard labels map to the vendor rate keys", () => {
  assert.strictEqual(lib.rateForLabel("ubuntu-latest").key, "linux");
  assert.strictEqual(lib.rateForLabel("macos-26").key, "macos");
  assert.strictEqual(lib.rateForLabel("windows-latest").key, "windows");
  assert.strictEqual(lib.rateForLabel("macos-26").rate, 0.062);
  assert.strictEqual(lib.rateForLabel("ubuntu-latest").isLarger, false);
});

test("billableMinutes: rounds UP per job; a blocked job costs nothing", () => {
  assert.strictEqual(lib.billableMinutes(realJob()), 11); // 10m06s -> 11
  assert.strictEqual(lib.billableMinutes(realJob({ completed_at: "2026-10-08T18:34:06Z" })), 1); // 6s -> 1
  assert.strictEqual(lib.billableMinutes(blockedJob()), 0);
  assert.strictEqual(lib.billableMinutes(null), 0);
});

test("isBlockedJob: only the zero-step/empty-runner signature", () => {
  assert.strictEqual(lib.isBlockedJob(blockedJob()), true);
  assert.strictEqual(lib.isBlockedJob(realJob()), false);
  assert.strictEqual(lib.isBlockedJob({ runner_name: "", steps: [{ name: "x" }] }), false);
});

test("classifyRun: infra-block vs real failure vs green", () => {
  assert.strictEqual(lib.classifyRun({ conclusion: "success" }, [blockedJob()]), "green");
  assert.strictEqual(lib.classifyRun({ conclusion: "failure" }, [blockedJob()]), "infra-block");
  assert.strictEqual(lib.classifyRun({ conclusion: "failure" }, [realJob()]), "failed");
  // Mixed: one job ran, one blocked -> a real failure, not an infra block.
  assert.strictEqual(lib.classifyRun({ conclusion: "failure" }, [realJob(), blockedJob()]), "failed");
  // No job detail: a red run that completed in 4s never provisioned a runner.
  assert.strictEqual(
    lib.classifyRun({ conclusion: "failure", createdAt: "2026-10-17T05:31:13Z", updatedAt: "2026-10-17T05:31:19Z" }),
    "infra-block"
  );
  assert.strictEqual(lib.classifyRun({ conclusion: null }), "incomplete");
});

test("estimateUsage: prices real jobs and skips blocked ones", () => {
  const u = lib.estimateUsage([{ jobs: [realJob()] }, { jobs: [blockedJob()] }]);
  assert.strictEqual(u.minutes, 11);
  assert.strictEqual(u.blockedJobs, 1);
  assert.strictEqual(u.billedJobs, 1);
  assert.ok(Math.abs(u.usd - 11 * 0.006) < 1e-9);
  const m = lib.estimateUsage([{ jobs: [realJob({ labels: ["macos-26"] })] }]);
  assert.ok(Math.abs(m.usd - 11 * 0.062) < 1e-9);
});

test("budgetState: warn at the threshold, fail at the allowance, unknown stays unknown", () => {
  assert.strictEqual(lib.budgetState({ minutes: 100 }).status, "ok");
  assert.strictEqual(lib.budgetState({ minutes: 1700 }).status, "warn");
  assert.strictEqual(lib.budgetState({ minutes: 2100 }).status, "fail");
  assert.strictEqual(lib.budgetState(null).status, "unknown");
  assert.strictEqual(lib.budgetState({ minutes: 2100 }).remainingMinutes, 0);
});

test("jobsPerMonth: exposes the cron frequency trap", () => {
  assert.strictEqual(lib.jobsPerMonth(30), 1440);
  assert.strictEqual(lib.jobsPerMonth(120), 360);
});

test("ci-wait: a billing-blocked run is named infra-block, not a test failure", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-block-"));
  const gh = path.join(dir, "gh");
  fs.writeFileSync(
    gh,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "auth" || args.includes("--version")) { process.exit(0); }
if (args[0] === "run" && args[1] === "list") {
  process.stdout.write(JSON.stringify([{ databaseId: 7, status: "completed", conclusion: "failure", url: "u", headSha: "${"a".repeat(40)}" }]));
  process.exit(0);
}
if (args[0] === "api") {
  process.stdout.write(JSON.stringify([{ runner_name: "", steps: [] }]));
  process.exit(0);
}
process.exit(0);
`,
    { mode: 0o755 }
  );
  const prevBin = process.env.HARNESS_SHIP_GH_BIN;
  const prevSleep = process.env.HARNESS_SHIP_CI_NO_SLEEP;
  process.env.HARNESS_SHIP_GH_BIN = gh;
  process.env.HARNESS_SHIP_CI_NO_SLEEP = "1";
  try {
    const code = ciWait.waitCi(dir, "a".repeat(40), { workflow: "CI", cwd: dir, timeoutMs: 5000, pollMs: 1, quiet: true });
    assert.strictEqual(code, 1);
  } finally {
    if (prevBin === undefined) delete process.env.HARNESS_SHIP_GH_BIN;
    else process.env.HARNESS_SHIP_GH_BIN = prevBin;
    if (prevSleep === undefined) delete process.env.HARNESS_SHIP_CI_NO_SLEEP;
    else process.env.HARNESS_SHIP_CI_NO_SLEEP = prevSleep;
    spawnSync("rm", ["-rf", dir]);
  }
});
