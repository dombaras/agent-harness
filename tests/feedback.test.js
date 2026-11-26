#!/usr/bin/env node
"use strict";
/*
 * F-050 — feedback loop contract tests.
 *
 * Two truths are pinned here:
 *   1. the pure control plane (templates/scripts/qa/feedback-lib.js) makes every
 *      decision from explicit inputs — nothing depends on the clock, the repo,
 *      or an LLM;
 *   2. the CLI adapter persists exactly that decision to a hermetic ledger and
 *      cannot skip a state, a budget, or a verification.
 *
 * Everything runs offline with temp ledgers. No network, no emulator, no live CI.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const LIB = require("../templates/scripts/qa/feedback-lib.js");

const ROOT = path.join(__dirname, "..");
const CLI = path.join(ROOT, "templates", "scripts", "feedback.js");
const GATE = path.join(ROOT, "templates", "scripts", "qa", "check-feedback.js");
const FIXTURES = path.join(ROOT, "templates", "scripts", "qa", "feedback-fixtures.json");
const POLICY_SCAFFOLD = path.join(ROOT, "templates", ".agents", "feedback.json");
const NOW = "2026-11-25T12:00:00.000Z";

function autoPolicy(overrides = {}) {
  return LIB.defaultPolicy({ mode: "auto", ...overrides });
}

function fixtureDoc() {
  return JSON.parse(fs.readFileSync(FIXTURES, "utf8"));
}

function tempProject(policy = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-test-"));
  fs.mkdirSync(path.join(root, ".agents"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".agents", "feedback.json"),
    JSON.stringify({ schema: LIB.POLICY_SCHEMA, mode: "auto", ...policy }, null, 2)
  );
  return {
    root,
    ledger: path.join(root, "ledger"),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function runCli(ctx, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ctx.root,
    encoding: "utf8",
    env: { ...process.env, AGENT_HARNESS_FEEDBACK_DIR: ctx.ledger, AGENT_HARNESS_FEEDBACK: "" },
  });
}

function parseCli(result) {
  assert.equal(result.stderr, "", `CLI wrote to stderr: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

/* ------------------------------------------------------------ truth table */

test("fixtures classify and route exactly as the truth table declares", () => {
  const doc = fixtureDoc();
  const policy = autoPolicy(doc.policy);
  assert.equal(doc.fixtures.length, 8);
  for (const fixture of doc.fixtures) {
    const normalized = LIB.normalizeSignal(fixture.signal, { now: NOW });
    const classified = LIB.applyClassification(normalized, policy);
    assert.equal(classified.class, fixture.expect.class, `${fixture.id}: class`);
    assert.equal(classified.risk, fixture.expect.risk, `${fixture.id}: risk`);
    assert.equal(classified.route, fixture.expect.route, `${fixture.id}: route`);
    assert.equal(classified.state, fixture.expect.state, `${fixture.id}: state`);
    assert.equal(normalized.signature, fixture.expect.signature, `${fixture.id}: frozen signature`);
    assert.equal(LIB.boardMarker(normalized), fixture.expect.marker, `${fixture.id}: board marker`);
  }
});

test("a signature is stable under volatile log noise but splits on a new failure", () => {
  const base = fixtureDoc().fixtures.find((f) => f.id === "ci-failed").signal;
  const first = LIB.normalizeSignal(base, { now: NOW }).signature;

  const noisy = {
    ...base,
    sha: "f".repeat(40),
    run: "19999999999",
    url: "https://github.com/example/repo/actions/runs/19999999999",
    observed_at: "2030-01-01T00:00:00.000Z",
    error: "AssertionError: expected 200 but got 500\n    at tests/api.test.js:42:17\n    after 1250ms (pid 4242, port 3000)",
  };
  assert.equal(LIB.normalizeSignal(noisy, { now: NOW }).signature, first);

  const different = { ...base, error: "TypeError: cannot read properties of undefined (reading 'id')" };
  assert.notEqual(LIB.normalizeSignal(different, { now: NOW }).signature, first);
});

/* ---------------------------------------------------------------- safety */

test("secrets and control characters never become durable evidence", () => {
  const github = "ghp_" + "a".repeat(36);
  const org = "github_pat_" + "b".repeat(30);
  const key = "sk-" + "c".repeat(24);
  const sanitized = LIB.sanitizeEvidence(
    [`token ${github}`, `also ${org}`, `export SK=${key}`, "password=hunter2", "Authorization: Bearer ticket-123", "\u001b[31mERROR\u001b[0m"].join("\n")
  );
  for (const secret of [github, org, key, "hunter2", "Bearer ticket-123"]) {
    assert.ok(!sanitized.text.includes(secret), `raw secret survived: ${secret.slice(0, 8)}`);
  }
  assert.ok(sanitized.text.includes("[REDACTED:github-token]"));
  assert.ok(sanitized.text.includes("[REDACTED:api-key]"));
  assert.ok(sanitized.text.includes("[REDACTED:credential]"));
  assert.ok(!/\u001b\[/.test(sanitized.text));

  const bounded = LIB.sanitizeEvidence("x".repeat(5000), 100);
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.text.includes("[truncated]"));
  assert.ok(bounded.text.length < 150);
});

test("the shipped policy scaffold is valid and within the approved budgets", () => {
  const doc = JSON.parse(fs.readFileSync(POLICY_SCAFFOLD, "utf8"));
  const checked = LIB.validatePolicy(doc);
  assert.deepEqual(checked.errors, []);
  assert.equal(checked.policy.mode, "auto");
  assert.equal(checked.policy.max_attempts_per_signature, 2);
  assert.equal(checked.policy.max_attempts_per_day, 4);
  assert.equal(checked.policy.max_active_attempts, 1);
  assert.equal(checked.policy.cooldown_min, 30);
  assert.deepEqual(checked.policy.auto_fix_classes, ["product"]);
  assert.equal(checked.policy.kill_switch, false);
});

test("policy validation rejects unknown keys and unsafe autonomy values", () => {
  const unknown = LIB.validatePolicy({ schema: LIB.POLICY_SCHEMA, mode: "auto", auto_launch: true });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.errors.some((e) => e.includes("unknown policy key")));

  const badMode = LIB.validatePolicy({ schema: LIB.POLICY_SCHEMA, mode: "yolo" });
  assert.equal(badMode.ok, false);
  assert.ok(badMode.errors.some((e) => e.includes("mode must be")));

  const badClass = LIB.validatePolicy({ schema: LIB.POLICY_SCHEMA, auto_fix_classes: ["security"] });
  assert.equal(badClass.ok, true, "membership is valid; the gate enforces the auto/product safety floor");
});

test("test:feedback gate fails an unsafe auto policy", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-gate-"));
  try {
    const unsafe = path.join(root, "feedback.json");
    fs.writeFileSync(unsafe, JSON.stringify({ schema: LIB.POLICY_SCHEMA, mode: "auto", auto_fix_classes: ["security"] }));
    const result = spawnSync(process.execPath, [GATE, "--policy", unsafe], { cwd: ROOT, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /auto mode may only auto-fix the product class/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("wiring: package.json, HARNESS_SCRIPTS and the gates phase expose the feedback loop", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts.feedback, "node scripts/feedback.js");
  assert.equal(pkg.scripts["test:feedback"], "node scripts/qa/check-feedback.js");
  assert.match(pkg.scripts.test, /tests\/feedback\.test\.js/);
  assert.match(pkg.scripts.lint, /templates\/scripts\/feedback\.js/);

  const harness = require("../bin/agent-harness.js");
  assert.equal(harness.HARNESS_SCRIPTS.feedback, "node scripts/feedback.js");
  assert.equal(harness.HARNESS_SCRIPTS["test:feedback"], "node scripts/qa/check-feedback.js");

  const gates = require("../templates/scripts/qa/run-gates.js");
  assert.ok(gates.PHASES.process.some((gate) => gate[0] === "test:feedback"));
});

/* --------------------------------------------------------- dedupe/state */

test("a repeated observation merges into the same item; a recurrence reopens P1", () => {
  const base = fixtureDoc().fixtures.find((f) => f.id === "ci-failed").signal;
  const first = LIB.applyClassification(LIB.normalizeSignal(base, { now: NOW }), autoPolicy());
  const second = LIB.normalizeSignal({ ...base, sha: "1".repeat(40) }, { now: "2026-11-25T13:00:00.000Z" });

  assert.ok(LIB.findDuplicate([first], second));
  assert.equal(LIB.findDuplicate([first], { ...second, environment: "uat" }), null);

  const merged = LIB.mergeObservation(first, second);
  assert.equal(merged.occurrences, 2);
  assert.equal(merged.last_seen, second.last_seen);
  assert.equal(merged.state, "queued");

  const reopened = LIB.mergeObservation({ ...first, state: "resolved", severity: "P3", reopened: 0 }, second);
  assert.equal(reopened.state, "queued");
  assert.equal(reopened.severity, "P1");
  assert.equal(reopened.reopened, 1);
});

test("the state machine rejects shortcuts and permits a verified close only", () => {
  const base = fixtureDoc().fixtures.find((f) => f.id === "ci-failed").signal;
  const item = LIB.applyClassification(LIB.normalizeSignal(base, { now: NOW }), autoPolicy());

  assert.equal(LIB.canTransition("observed", "resolved"), false);
  assert.equal(LIB.canTransition("reproducing", "verifying"), false);
  assert.equal(LIB.canTransition("verifying", "resolved"), true);
  assert.throws(() => LIB.transition({ ...item, state: "observed" }, "resolved", { at: NOW }));

  const verifying = { ...item, state: "verifying" };
  const resolved = LIB.transition(verifying, "resolved", { at: NOW, by: "qa-runner" });
  assert.equal(resolved.state, "resolved");
  assert.equal(resolved.history.at(-1).by, "qa-runner");
});

/* --------------------------------------------------------------- budgets */

test("budgets stop the loop at the exact declared limit", () => {
  const base = fixtureDoc().fixtures.find((f) => f.id === "ci-failed").signal;
  const policy = autoPolicy();
  const item = LIB.applyClassification(LIB.normalizeSignal(base, { now: NOW }), policy);

  assert.equal(LIB.attemptDecision(item, policy, [item], NOW).allowed, true);

  const active = { ...item, attempts: [{ signature: item.signature, started_at: NOW, outcome: null }] };
  assert.equal(LIB.attemptDecision(active, policy, [active], NOW).rule, "active-attempt-lock");

  const spent = [1, 2].map((n) => ({
    signature: item.signature,
    started_at: "2026-11-24T00:00:00.000Z",
    ended_at: "2026-11-24T00:10:00.000Z",
    outcome: "fail-same",
    strategy_hash: `h${n}`,
  }));
  assert.equal(LIB.attemptDecision({ ...item, attempts: spent }, policy, [{ ...item, attempts: spent }], NOW).rule, "signature-budget");

  const cooling = { ...item, attempts: [{ signature: item.signature, started_at: "2026-11-25T11:50:00.000Z", ended_at: "2026-11-25T11:50:00.000Z", outcome: "fail-same" }] };
  assert.equal(LIB.attemptDecision(cooling, policy, [cooling], NOW).rule, "cooldown");

  assert.equal(LIB.attemptDecision(item, { ...policy, kill_switch: true }, [item], NOW).rule, "kill-switch");
  assert.equal(LIB.sameStrategy({ ...item, attempts: [{ strategy_hash: LIB.shortHash("bump timeout"), outcome: "fail-same" }] }, "bump timeout"), true);
  assert.equal(LIB.nextEligible([item, { ...item, id: "fb-ci-p1", severity: "P1" }], policy, NOW).item.id, "fb-ci-p1");
});

/* ------------------------------------------------------------------ CLI */

test("CLI: capture -> next -> attempt -> verify closes the loop with a diagnosis path", () => {
  const ctx = tempProject();
  try {
    const added = runCli(ctx, [
      "add", "--source", "ci", "--title", "API tests failed",
      "--test", "tests/api.test.js > GET /health",
      "--error", "AssertionError: expected 200 but got 500",
      "--repro", "npm run test:api", "--json",
    ]);
    assert.equal(added.status, 1, "a queued item needs work (exit 1)");
    const item = parseCli(added).item;
    assert.equal(item.state, "queued");
    assert.equal(item.route, "auto-fix");

    const next = runCli(ctx, ["next", "--json"]);
    assert.equal(next.status, 1);
    assert.equal(parseCli(next).item.id, item.id);

    const started = runCli(ctx, ["attempt", item.id, "--start", "--strategy", "guard the health handler", "--feature", "F-050", "--json"]);
    assert.equal(started.status, 0);
    assert.equal(parseCli(started).item.state, "reproducing");

    const ended = runCli(ctx, ["attempt", item.id, "--end", "--outcome", "pass", "--json"]);
    assert.equal(ended.status, 0, ended.stderr);
    const endedItem = parseCli(ended).item;
    assert.equal(endedItem.state, "verifying");
    assert.deepEqual(
      endedItem.history.map((h) => h.to).slice(-4),
      ["reproducing", "diagnosing", "fixing", "verifying"],
      "a pass outcome must walk the declared diagnosis path, not shortcut to verifying"
    );

    const verified = runCli(ctx, ["verify", item.id, "--signal", "ci", "--result", "pass", "--evidence", "CI run 123 green", "--json"]);
    assert.equal(verified.status, 0);
    assert.equal(parseCli(verified).item.state, "resolved");

    const listed = runCli(ctx, ["list", "--json"]);
    assert.equal(parseCli(listed).items.length, 1);
    assert.equal(parseCli(listed).items[0].state, "resolved");
  } finally {
    ctx.cleanup();
  }
});

test("CLI: a duplicate ingest updates one item and never creates a second row", () => {
  const ctx = tempProject();
  try {
    const args = ["add", "--source", "ci", "--title", "API tests failed", "--test", "tests/api.test.js", "--error", "AssertionError: expected 200 but got 500", "--json"];
    const first = parseCli(runCli(ctx, args)).item;
    const second = parseCli(runCli(ctx, [...args, "--sha", "1".repeat(40)])).item;
    assert.equal(second.id, first.id);
    assert.equal(second.occurrences, 2);
    const files = fs.readdirSync(ctx.ledger).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 1);
  } finally {
    ctx.cleanup();
  }
});

test("CLI: verify is refused before a fix reaches the verifying state", () => {
  const ctx = tempProject();
  try {
    const item = parseCli(
      runCli(ctx, ["add", "--source", "ci", "--title", "API tests failed", "--test", "tests/api.test.js", "--error", "AssertionError: expected 200 but got 500", "--json"])
    ).item;
    const verified = runCli(ctx, ["verify", item.id, "--result", "pass"]);
    assert.equal(verified.status, 2);
    assert.match(verified.stderr, /not verifying/);
  } finally {
    ctx.cleanup();
  }
});

test("CLI: an identical failed strategy is refused and an active attempt blocks next", () => {
  const ctx = tempProject();
  try {
    const item = parseCli(
      runCli(ctx, ["add", "--source", "ci", "--title", "API tests failed", "--test", "tests/api.test.js", "--error", "AssertionError: expected 200 but got 500", "--json"])
    ).item;
    assert.equal(runCli(ctx, ["attempt", item.id, "--start", "--strategy", "bump the timeout", "--json"]).status, 0);

    const blocked = runCli(ctx, ["next", "--json"]);
    assert.equal(blocked.status, 0, "no eligible item is a clean exit");
    assert.equal(parseCli(blocked).eligible, false);

    assert.equal(runCli(ctx, ["attempt", item.id, "--end", "--outcome", "fail-same", "--json"]).status, 0);
    const repeat = runCli(ctx, ["attempt", item.id, "--start", "--strategy", "bump the timeout", "--json"]);
    assert.equal(repeat.status, 2);
    assert.match(repeat.stderr, /identical strategy/);
  } finally {
    ctx.cleanup();
  }
});

test("CLI: the kill switch captures nothing and exits cleanly", () => {
  const ctx = tempProject({ kill_switch: true });
  try {
    const added = runCli(ctx, ["add", "--source", "ci", "--title", "should not capture", "--json"]);
    assert.equal(added.status, 0);
    assert.equal(parseCli(added).enabled, false);
    assert.equal(fs.existsSync(ctx.ledger), false);
  } finally {
    ctx.cleanup();
  }
});

test("CLI: report counts observations and cost", () => {
  const ctx = tempProject();
  try {
    const item = parseCli(
      runCli(ctx, ["add", "--source", "ci", "--title", "API tests failed", "--test", "tests/api.test.js", "--error", "AssertionError: expected 200 but got 500", "--json"])
    ).item;
    runCli(ctx, ["attempt", item.id, "--start", "--strategy", "guard the handler", "--json"]);
    runCli(ctx, ["attempt", item.id, "--end", "--outcome", "pass", "--cost", "1.5", "--json"]);
    runCli(ctx, ["verify", item.id, "--result", "pass", "--json"]);
    const report = parseCli(runCli(ctx, ["report", "--json"]));
    assert.equal(report.total, 1);
    assert.equal(report.resolved, 1);
    assert.equal(report.attempts, 1);
    assert.equal(report.cost_usd, 1.5);
  } finally {
    ctx.cleanup();
  }
});
