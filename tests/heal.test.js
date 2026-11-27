#!/usr/bin/env node
"use strict";
/*
 * F-076 — self-healing loop, Phase 0 contract tests.
 *
 * Three truths are pinned:
 *   1. the pure decision core (templates/scripts/qa/heal-lib.js) is
 *      deterministic: same input → same tier/decision, no clock, no model;
 *   2. the KPI/HHI math is reproducible and a safety violation zeroes it;
 *   3. the store and CLI are hermetic: observe mode records samples only, never
 *      a repair item, a board row, or a product-code write.
 *
 * Offline, temp dirs only. No network, no provider store, no live CI.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const LIB = require("../templates/scripts/qa/heal-lib.js");
const KPI = require("../templates/scripts/qa/kpi-lib.js");
const STORE = require("../templates/scripts/qa/heal-store.js");

const ROOT = path.join(__dirname, "..");
const CLI = path.join(ROOT, "templates", "scripts", "heal.js");
const NOW = Date.parse("2026-11-27T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function tempProject(policy = { mode: "observe" }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "heal-test-"));
  fs.mkdirSync(path.join(root, ".agents"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".agents", "heal.json"),
    JSON.stringify({ schema: LIB.POLICY_SCHEMA, ...policy }, null, 2)
  );
  return { root, store: path.join(root, "store"), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function runCli(ctx, args) {
  return spawnSync(process.execPath, [CLI, ...args, "--root", ctx.root, "--heal-dir", ctx.store], {
    cwd: ctx.root,
    encoding: "utf8",
    env: { ...process.env, AGENT_HARNESS_HEAL_DIR: "" },
  });
}

function sample(ctx, name, value, at, source = "gate") {
  return STORE.recordSample(ctx.root, { name, value, at, source, unit: "ratio" }, { healDir: ctx.store, dedupe: false });
}

test("policy validation: defaults merge, unknown enums refuse, auto_merge ⊆ auto_tiers", () => {
  const p = LIB.validatePolicy({ mode: "assist" });
  assert.equal(p.mode, "assist");
  assert.deepEqual(p.risk.auto_tiers, ["T0"]);
  assert.equal(p.landing.require_ci, true);

  assert.throws(() => LIB.validatePolicy({ mode: "yolo" }), /mode must be one of/);
  assert.throws(() => LIB.validatePolicy({ landing: { auto_merge_tiers: ["T1"] } }), /subset of risk\.auto_tiers/);
  assert.throws(() => LIB.validatePolicy({ telemetry: { publish: "git", opt_in: false } }), /opt_in/);
  assert.throws(() => LIB.validatePolicy({ telemetry: { include_paths: true } }), /include_paths/);
  assert.throws(() => LIB.validatePolicy({ error_budget: { burn_rate_freeze: 0.5 } }), /burn_rate_freeze/);
});

test("risk tiers are deterministic and ordered by danger", () => {
  const p = LIB.DEFAULT_POLICY;
  assert.equal(LIB.riskTier({ class: "security", source: "gate" }, p), "T3");
  assert.equal(LIB.riskTier({ class: "product", source: "ci", files: ["auth/token.js"] }, p), "T3");
  assert.equal(LIB.riskTier({ class: "product", source: "ci", files: [".agents/heal.json"] }, p), "T3");
  assert.equal(LIB.riskTier({ class: "product", source: "gate", files: ["scripts/qa/check-qa-plan.js"] }, p), "T3");
  assert.equal(LIB.riskTier({ class: "product", source: "ci", files: ["src/a.js"], test_covered: true }, p), "T1");
  assert.equal(LIB.riskTier({ class: "product", source: "ci", files: Array.from({ length: 6 }, (_, i) => `src/${i}.js`) }, p), "T2");
  assert.equal(LIB.riskTier({ class: "product", source: "ci", files: ["src/a.js"], new_dependency: true }, p), "T2");
  assert.equal(LIB.riskTier({ class: "infra", source: "ci", action: "rerun" }, p), "T0");
  assert.equal(LIB.riskTier({ class: "infra", source: "drift", kind: "drift" }, p), "T0");
  const inputs = { class: "product", source: "ci", files: ["src/a.js"], test_covered: true };
  assert.equal(LIB.riskTier(inputs, p), LIB.riskTier({ ...inputs }, p));
});

test("eligibility refuses observe/kill/tier/budget and allows a promoted T0 only", () => {
  const item = { signature: "s1", tier: "T0", cost_usd: 0 };
  const auto = LIB.validatePolicy({ mode: "auto" });
  assert.equal(LIB.eligible(item, LIB.validatePolicy({ mode: "observe" }), { items: [] }, NOW).ok, false);
  assert.equal(LIB.eligible(item, { ...auto, kill_switch: true }, { items: [] }, NOW).ok, false);
  assert.equal(LIB.eligible({ ...item, tier: "T2" }, auto, { items: [] }, NOW).ok, false);
  assert.equal(LIB.eligible(item, auto, { items: [] }, NOW).ok, true);

  const started = { started_at: new Date(NOW - DAY / 2).toISOString() };
  const two = { items: [{ signature: "s1", state: "closed", attempts: [started, started] }] };
  assert.equal(LIB.eligible(item, auto, two, NOW).ok, false);
  const cooldown = { items: [{ signature: "s1", state: "closed", attempts: [{ started_at: new Date(NOW - 60 * 1000).toISOString() }] }] };
  assert.match(LIB.eligible(item, auto, cooldown, NOW).reason, /cooldown/);
  assert.equal(LIB.eligible(item, auto, { items: [], red_main: true }, NOW).ok, false);
  assert.equal(LIB.eligible(item, auto, { items: [], error_budget_frozen: true }, NOW).ok, false);
});

test("state machine is total and rejects unknown/illegal transitions", () => {
  assert.equal(LIB.transition("detected", "classified"), "classified");
  assert.equal(LIB.transition("observing", "closed"), "closed");
  assert.equal(LIB.transition("reverted", "reopened"), "reopened");
  assert.throws(() => LIB.transition("detected", "landed"), /illegal transition/);
  assert.throws(() => LIB.transition("nope", "classified"), /unknown state/);
  assert.throws(() => LIB.transition("detected", "nope"), /unknown next state/);
});

test("KPI math: burn, pass^k, HHI safety gate, top driver", () => {
  assert.equal(KPI.ratio(1, 0), null);
  assert.equal(KPI.burnRate(0.2, 0.1), 2);
  assert.equal(KPI.burnRate(0.1, 0), Infinity);
  assert.equal(KPI.passK([[true, true, true], [true, false, true], [true, true]], 3), 1 / 3);
  assert.ok(Math.abs(KPI.normalizeSubscore(0.9, { baseline: 0.8, target: 0.95, direction: "up" }) - 2 / 3) < 1e-12);

  const report = KPI.summarize(
    { gate_pass_rate: 0.9, mttr_min: 20 },
    { gate_pass_rate: 0.8, mttr_min: 40 },
    { windowDays: 14 }
  );
  assert.equal(report.top_driver.id, "gate_pass_rate");
  assert.ok(report.hhi > 0 && report.hhi <= 100);
  assert.equal(KPI.summarize({ gate_pass_rate: 0.5 }, {}, { safetyViolation: true }).hhi, 0);
});

test("store: item dedupe, corrupt-line quarantine, redaction, retention", () => {
  const ctx = tempProject();
  try {
    const item = LIB.normalizeSignal({ source: "gate", environment: "local", test: "quick", error: "boom" }, { now: NOW });
    const first = STORE.recordItem(ctx.root, item, { healDir: ctx.store, now: NOW });
    assert.equal(first.created, true);
    const second = STORE.recordItem(ctx.root, item, { healDir: ctx.store, now: NOW + 1000 });
    assert.equal(second.created, false);
    assert.equal(second.item.occurrences, 2);
    const state = STORE.readState(ctx.root, { healDir: ctx.store });
    assert.equal(state.items.length, 1);
    assert.equal(state.items[0].occurrences, 2);

    fs.appendFileSync(STORE.storePaths(ctx.root, { healDir: ctx.store }).ledger, "{not json}\n");
    const read = STORE.readJsonl(STORE.storePaths(ctx.root, { healDir: ctx.store }).ledger, {
      corruptPath: STORE.storePaths(ctx.root, { healDir: ctx.store }).corrupt,
    });
    assert.equal(read.corrupt.length, 1);
    assert.ok(fs.existsSync(STORE.storePaths(ctx.root, { healDir: ctx.store }).corrupt));

    const redacted = STORE.redact("token ghp_aaaaaaaaaaaaaaaaaaaaaaaa and /home/me/secret.js x@y.com");
    assert.ok(!redacted.includes("ghp_aaaaaaaaaaaaaaaaaaaaaaaa"));
    assert.match(redacted, /\[REDACTED|\[redacted-token\]/);
    assert.match(redacted, /\[redacted-path\]/);
    assert.match(redacted, /\[redacted-email\]/);

    const old = STORE.recordSample(ctx.root, { name: "gate_pass_rate", value: 1, source: "gate", at: new Date(NOW - 100 * DAY).toISOString() }, { healDir: ctx.store, dedupe: false });
    assert.ok(old);
    const pruned = STORE.prune(ctx.root, { retention: { days: 90, keep_reports: 0 } }, { healDir: ctx.store, now: NOW });
    assert.equal(pruned.dropped_events, 1);
  } finally {
    ctx.cleanup();
  }
});

test("observe mode records samples only; report computes HHI + top driver", () => {
  const ctx = tempProject();
  try {
    fs.mkdirSync(path.join(ctx.root, ".agents", "qa-runs", "nightly"), { recursive: true });
    fs.writeFileSync(
      path.join(ctx.root, ".agents", "qa-runs", "nightly", "latest.json"),
      JSON.stringify({ stamp: new Date(NOW - 1000).toISOString(), ok: true })
    );
    sample(ctx, "gate_pass_rate", 0.8, new Date(NOW - 15 * DAY).toISOString());
    sample(ctx, "gate_pass_rate", 0.9, new Date(NOW - 1000).toISOString());
    sample(ctx, "drift_count", 1, new Date(NOW - 15 * DAY).toISOString(), "doctor");
    sample(ctx, "drift_count", 0, new Date(NOW - 1000).toISOString(), "doctor");

    const run = runCli(ctx, ["run", "--json"]);
    assert.equal(run.status, 0, run.stderr);
    const runOut = JSON.parse(run.stdout);
    assert.equal(runOut.mode, "observe");
    assert.ok(runOut.samples_written >= 1);
    assert.equal(runOut.items_open, 0);
    assert.ok(!fs.existsSync(path.join(ctx.root, "BACKLOG.md")));

    const report = runCli(ctx, ["report", "--json", "--no-write"]);
    assert.equal(report.status, 0, report.stderr);
    const out = JSON.parse(report.stdout);
    assert.ok(out.hhi > 0, JSON.stringify(out.subscores));
    assert.equal(out.top_driver.id, "gate_pass_rate");
    assert.equal(out.items.total, 0);
  } finally {
    ctx.cleanup();
  }
});

test("pause/resume write the kill switch; status reflects it; watch/improve refuse", () => {
  const ctx = tempProject();
  try {
    const pause = runCli(ctx, ["pause"]);
    assert.equal(pause.status, 0, pause.stderr);
    const policy = JSON.parse(fs.readFileSync(path.join(ctx.root, ".agents", "heal.json"), "utf8"));
    assert.equal(policy.kill_switch, true);
    const status = runCli(ctx, ["status", "--json"]);
    const out = JSON.parse(status.stdout);
    assert.equal(out.kill_switch, true);
    assert.match(out.line, /KILL SWITCH/);
    assert.equal(runCli(ctx, ["resume"]).status, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.root, ".agents", "heal.json"), "utf8")).kill_switch, false);

    assert.equal(runCli(ctx, ["watch"]).status, 2);
    assert.equal(runCli(ctx, ["improve"]).status, 2);
    assert.equal(runCli(ctx, ["nope"]).status, 2);
  } finally {
    ctx.cleanup();
  }
});

test("missing policy means off; invalid policy refuses with exit 2", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "heal-off-"));
  try {
    const status = spawnSync(process.execPath, [CLI, "status", "--root", root, "--heal-dir", path.join(root, "s"), "--json"], { encoding: "utf8" });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).mode, "off");

    fs.mkdirSync(path.join(root, ".agents"), { recursive: true });
    fs.writeFileSync(path.join(root, ".agents", "heal.json"), "{nope");
    const bad = spawnSync(process.execPath, [CLI, "status", "--root", root, "--heal-dir", path.join(root, "s")], { encoding: "utf8" });
    assert.equal(bad.status, 2);
    assert.match(bad.stdout, /refused/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
