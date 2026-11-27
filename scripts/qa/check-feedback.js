#!/usr/bin/env node
"use strict";
/*
 * test:feedback — the Phase 0 contract gate for the feedback loop.
 *
 * It validates, offline and deterministically:
 *   1. the feedback-policy/1 document (`templates/.agents/feedback.json` or the
 *      project's `.agents/feedback.json`) and its safety floor;
 *   2. the classification truth table in `feedback-fixtures.json`, including the
 *      frozen signature/marker drift guards;
 *   3. signature stability under volatile log noise, secret redaction and
 *      bounded evidence;
 *   4. dedupe/merge/reopen semantics, the state machine, budgets and metrics;
 *   5. the local ledger shape, when one exists (a missing ledger is a warning:
 *      a clean project has not captured a signal yet).
 *
 * Exit 0 = contract holds (warnings allowed), 1 = contract violation,
 * 2 = invalid invocation. No network, no clock dependence (all `now` values
 * are fixed), no writes.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const lib = require("./feedback-lib.js");
const adapters = require("./feedback-adapters.js");
const loop = require("./run-loop.js");

const FIXTURES = path.join(__dirname, "feedback-fixtures.json");
const NOW = "2026-11-25T12:00:00.000Z";
const failures = [];
const warnings = [];
const notes = [];

function fail(message) {
  failures.push(message);
}

function warn(message) {
  warnings.push(message);
}

function loadJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    fail(`${label} is not valid JSON (${file}): ${e.message}`);
    return null;
  }
}

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") flags.json = true;
    else if (a === "--help" || a === "-h") flags.help = true;
    else if (a === "--policy") flags.policy = argv[++i];
    else if (a === "--ledger") flags.ledger = argv[++i];
    else {
      fail(`unknown argument: ${a}`);
      flags.invalid = true;
    }
  }
  return flags;
}

/* Same resolution the CLI uses, minus the write side. */
function ledgerDir(root, flags) {
  if (flags.ledger) return path.resolve(flags.ledger);
  if (process.env.AGENT_HARNESS_FEEDBACK_DIR) return path.resolve(process.env.AGENT_HARNESS_FEEDBACK_DIR);
  const r = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  let base = root;
  if (r.status === 0) {
    const clean = String(r.stdout || "").trim().replace(/[\\/]+$/, "");
    base = path.basename(clean) === ".git" ? path.dirname(clean) : clean;
  }
  return path.join(base, ".agents", "qa-runs", "feedback");
}

function policyFile(root, flags) {
  const candidates = [];
  if (flags.policy) candidates.push(path.resolve(flags.policy));
  if (process.env.AGENT_HARNESS_FEEDBACK_POLICY) candidates.push(path.resolve(process.env.AGENT_HARNESS_FEEDBACK_POLICY));
  candidates.push(path.join(root, ".agents", "feedback.json"));
  candidates.push(path.join(root, "templates", ".agents", "feedback.json"));
  return candidates.find((f) => fs.existsSync(f)) || null;
}

/* ------------------------------------------------------------ policy checks */

function checkPolicy(policy, file) {
  if (policy.mode === "auto") {
    const unsafe = (policy.auto_fix_classes || []).filter((c) => c !== "product");
    if (unsafe.length) {
      fail(`policy ${file}: auto mode may only auto-fix the product class (found: ${unsafe.join(", ")})`);
    }
    if (!policy.high_risk_paths.length) {
      fail(`policy ${file}: auto mode requires a non-empty high_risk_paths list`);
    }
  }
  if (policy.max_attempts_per_signature > 5) {
    warn(`policy ${file}: ${policy.max_attempts_per_signature} attempts per signature exceeds the reviewed ceiling of 5`);
  }
  if (policy.cooldown_min < 5) {
    warn(`policy ${file}: cooldown_min ${policy.cooldown_min} is below the recommended 5 minutes`);
  }
  if (!lib.loopEnabled(policy) && policy.mode !== "off") {
    fail(`policy ${file}: loop disabled but mode is ${policy.mode} (kill_switch must be explicit)`);
  }
}

/* ---------------------------------------------------------- fixtures checks */

function checkFixtures(doc) {
  if (!doc || !Array.isArray(doc.fixtures)) {
    fail("fixtures: missing `fixtures` array");
    return;
  }
  if (doc.fixtures.length !== 8) fail(`fixtures: expected 8 fixtures, found ${doc.fixtures.length}`);
  const fixturePolicy = lib.defaultPolicy(doc.policy || { mode: "auto" });
  if (fixturePolicy.mode !== "auto") {
    fail("fixtures: the truth table must be evaluated with an explicit mode:auto policy");
  }
  const ids = new Set();
  const signatures = new Set();
  const markers = new Set();
  const classes = new Set();
  const routes = new Set();

  for (const fixture of doc.fixtures) {
    if (!fixture.id || ids.has(fixture.id)) fail(`fixtures: duplicate or missing id: ${fixture.id}`);
    ids.add(fixture.id);
    if (!fixture.signal || typeof fixture.signal !== "object") {
      fail(`fixtures[${fixture.id}]: missing signal`);
      continue;
    }
    let normalized;
    try {
      normalized = lib.normalizeSignal(fixture.signal, { now: NOW });
    } catch (e) {
      fail(`fixtures[${fixture.id}]: normalize threw: ${e.message}`);
      continue;
    }
    const actual = lib.applyClassification(normalized, fixturePolicy);
    const expect = fixture.expect || {};
    for (const key of ["class", "risk", "route", "state", "signature", "marker"]) {
      const want = key === "marker" ? expect.marker : expect[key];
      const got = key === "marker" ? lib.boardMarker(actual) : actual[key];
      if (want == null) fail(`fixtures[${fixture.id}]: expect.${key} is missing`);
      else if (want !== got) fail(`fixtures[${fixture.id}]: ${key} expected ${want}, got ${got}`);
    }
    if (signatures.has(normalized.signature)) fail(`fixtures: signature collision ${normalized.signature} (${fixture.id})`);
    signatures.add(normalized.signature);
    if (markers.has(lib.boardMarker(normalized))) fail(`fixtures: board marker collision ${lib.boardMarker(normalized)}`);
    markers.add(lib.boardMarker(normalized));
    classes.add(actual.class);
    routes.add(actual.route);
  }

  for (const cls of lib.CLASSES) {
    if (!classes.has(cls)) fail(`fixtures: no case covers the "${cls}" class`);
  }
  for (const route of ["auto-fix", "assist", "ops", "quarantine", "security-engineer", "human"]) {
    if (!routes.has(route)) fail(`fixtures: no case covers the "${route}" route`);
  }
}

/* ---------------------------------------------------- normalized signatures */

function checkSignatureStability(doc) {
  const base = doc.fixtures.find((f) => f.id === "ci-failed");
  if (!base) {
    fail("signature: the ci-failed fixture is required for the stability check");
    return;
  }
  const first = lib.normalizeSignal(base.signal, { now: NOW }).signature;
  const noisy = JSON.parse(JSON.stringify(base.signal));
  noisy.sha = "ffffffffffffffffffffffffffffffffffffffff";
  noisy.run = "19999999999";
  noisy.url = "https://github.com/example/repo/actions/runs/19999999999";
  noisy.error = "AssertionError: expected 200 but got 500\n    at tests/api.test.js:42:17\n    after 1250ms (pid 4242, port 3000)";
  noisy.observed_at = "2030-01-01T00:00:00.000Z";
  const second = lib.normalizeSignal(noisy, { now: NOW }).signature;
  if (first !== second) {
    fail(`signature: volatile log noise changed the signature (${first} -> ${second})`);
  } else {
    notes.push(`signature stable under sha/run/line/duration/pid/port noise (${first.slice(0, 8)})`);
  }

  const different = JSON.parse(JSON.stringify(base.signal));
  different.error = "TypeError: cannot read properties of undefined (reading 'id')";
  const third = lib.normalizeSignal(different, { now: NOW }).signature;
  if (third === first) fail("signature: two different failures collapsed to the same signature");
}

/* --------------------------------------------------------- safety / redaction */

function checkRedaction() {
  const githubToken = "ghp_" + "a".repeat(36);
  const orgToken = "github_pat_" + "b".repeat(30);
  const apiKey = "sk-" + "c".repeat(24);
  const raw = [
    `shell: exporting ${githubToken}`,
    `also ${orgToken}`,
    `export SK=${apiKey}`,
    "password=hunter2",
    "Authorization: Bearer top-secret-ticket",
    "\u001b[31mERROR\u001b[0m boom",
  ].join("\n");
  const out = lib.sanitizeEvidence(raw, 4000);
  for (const secret of [githubToken, orgToken, apiKey, "hunter2", "Bearer top-secret-ticket"]) {
    if (out.text.includes(secret)) fail(`redaction: raw secret survived evidence sanitization (${secret.slice(0, 8)}…)`);
  }
  if (!out.text.includes("[REDACTED:github-token]")) fail("redaction: github token was not replaced with the standard marker");
  if (!out.text.includes("[REDACTED:credential]")) fail("redaction: password/API-key assignment was not redacted");
  if (!out.text.includes("[REDACTED:api-key]")) fail("redaction: sk- API key was not redacted");
  if (/\u001b\[/.test(out.text)) fail("redaction: ANSI escape survived control-character stripping");

  const bounded = lib.sanitizeEvidence("x".repeat(5000), 100);
  if (!bounded.truncated) fail("evidence: oversized evidence was not marked truncated");
  if (!bounded.text.includes("[truncated]")) fail("evidence: truncation marker missing");
  if (bounded.text.length > 140) fail(`evidence: truncation exceeded its budget (${bounded.text.length} chars)`);
}

/* ------------------------------------------------------- dedupe + lifecycle */

function checkDedupeAndLifecycle(fixtureDoc) {
  const fixturePolicy = lib.defaultPolicy(fixtureDoc.policy || { mode: "auto" });
  const base = fixtureDoc.fixtures.find((f) => f.id === "ci-failed");
  if (!base) return;
  const first = lib.applyClassification(lib.normalizeSignal(base.signal, { now: NOW }), fixturePolicy);
  const later = JSON.parse(JSON.stringify(base.signal));
  later.sha = "1111111111111111111111111111111111111111";
  const second = lib.normalizeSignal(later, { now: "2026-11-25T13:00:00.000Z" });

  if (!lib.findDuplicate([first], second)) fail("dedupe: re-observation of the same signature was not found");
  if (lib.findDuplicate([first], { ...second, environment: "uat" })) fail("dedupe: a different environment must not dedupe");

  const merged = lib.mergeObservation(first, second);
  if (merged.occurrences !== 2) fail(`dedupe: occurrences expected 2, got ${merged.occurrences}`);
  if (merged.last_seen !== second.last_seen) fail("dedupe: last_seen was not advanced");
  if (merged.state !== "queued") fail(`dedupe: a fresh duplicate must stay queued, got ${merged.state}`);

  const resolved = { ...first, state: "resolved", severity: "P3", resolution: { at: NOW }, reopened: 0 };
  const reopened = lib.mergeObservation(resolved, second);
  if (reopened.state !== "queued") fail(`recurrence: a resolved item must reopen as queued, got ${reopened.state}`);
  if (reopened.severity !== "P1") fail(`recurrence: a reopened item must escalate to P1, got ${reopened.severity}`);
  if (reopened.reopened !== 1) fail(`recurrence: reopened counter expected 1, got ${reopened.reopened}`);

  if (lib.canTransition("observed", "resolved")) fail("state machine: observed -> resolved must be rejected");
  if (!lib.canTransition("verifying", "resolved")) fail("state machine: verifying -> resolved must be allowed");
  if (!lib.canTransition("classified", "quarantined")) fail("state machine: a classified flake must be able to quarantine");
  let threw = false;
  try {
    lib.transition({ ...first, state: "observed" }, "resolved", { at: NOW });
  } catch {
    threw = true;
  }
  if (!threw) fail("state machine: transition() accepted observed -> resolved");

  const verified = lib.transition({ ...first, state: "verifying" }, "resolved", { at: NOW, by: "qa-runner" });
  if (verified.state !== "resolved" || !verified.history.length) fail("state machine: a valid transition did not record history");
}

function checkBudgetsAndMetrics(fixtureDoc) {
  const fixturePolicy = lib.defaultPolicy(fixtureDoc.policy || { mode: "auto" });
  const base = fixtureDoc.fixtures.find((f) => f.id === "ci-failed");
  if (!base) return;
  const item = lib.applyClassification(lib.normalizeSignal(base.signal, { now: NOW }), fixturePolicy);

  const ok = lib.attemptDecision(item, fixturePolicy, [item], NOW);
  if (!ok.allowed) fail(`budgets: a fresh queued item must be eligible, rule=${ok.rule}`);

  const lockedItem = { ...item, attempts: [{ signature: item.signature, started_at: NOW, outcome: null }] };
  const locked = lib.attemptDecision(lockedItem, fixturePolicy, [lockedItem], NOW);
  if (locked.allowed || locked.rule !== "active-attempt-lock") fail(`budgets: an active attempt must lock the loop (rule=${locked.rule})`);

  const used = [1, 2].map((n) => ({
    signature: item.signature,
    started_at: "2026-11-24T00:00:00.000Z",
    ended_at: "2026-11-24T00:10:00.000Z",
    outcome: "fail-same",
    strategy_hash: `hash-${n}`,
  }));
  const exhausted = lib.attemptDecision({ ...item, attempts: used }, fixturePolicy, [{ ...item, attempts: used }], NOW);
  if (exhausted.allowed || exhausted.rule !== "signature-budget") fail(`budgets: 2/2 attempts must exhaust the signature (rule=${exhausted.rule})`);

  const cooling = lib.attemptDecision(
    { ...item, attempts: [{ signature: item.signature, started_at: "2026-11-25T11:50:00.000Z", ended_at: "2026-11-25T11:50:00.000Z", outcome: "fail-same" }] },
    fixturePolicy,
    [item],
    NOW
  );
  if (cooling.allowed || cooling.rule !== "cooldown") fail(`budgets: a 10-minute-old attempt must be in cooldown (rule=${cooling.rule})`);

  const killed = lib.attemptDecision(item, { ...fixturePolicy, kill_switch: true }, [item], NOW);
  if (killed.allowed || killed.rule !== "kill-switch") fail(`budgets: kill_switch must stop every attempt (rule=${killed.rule})`);

  if (lib.sameStrategy({ ...item, attempts: [{ strategy_hash: lib.shortHash("bump timeout"), outcome: "fail-same" }] }, "bump timeout")) {
    notes.push("retry guard: an identical failed strategy is refused");
  } else {
    fail("retry guard: sameStrategy() did not recognise an identical failed strategy");
  }

  const p1 = { ...item, id: "fb-ci-p1", severity: "P1", state: "queued", last_seen: NOW };
  const next = lib.nextEligible([item, p1], fixturePolicy, NOW);
  if (!next || next.item.id !== "fb-ci-p1") fail("priority: nextEligible() must pick the P1 item first");

  const closed = {
    ...item,
    state: "resolved",
    first_seen: "2026-11-25T10:00:00.000Z",
    resolution: { at: "2026-11-25T12:00:00.000Z" },
    attempts: [{ signature: item.signature, started_at: "2026-11-25T11:00:00.000Z", ended_at: "2026-11-25T11:30:00.000Z", outcome: "pass", cost_usd: 1.5 }],
  };
  const m = lib.metrics([closed, p1], NOW);
  if (m.resolved !== 1) fail(`metrics: resolved expected 1, got ${m.resolved}`);
  if (m.mttr_hours !== 2) fail(`metrics: mttr_hours expected 2, got ${m.mttr_hours}`);
  if (m.cost_usd !== 1.5) fail(`metrics: cost_usd expected 1.5, got ${m.cost_usd}`);
  if (m.first_attempt_success !== 100) fail(`metrics: first_attempt_success expected 100, got ${m.first_attempt_success}`);
}

/* ------------------------------------------------------- capture adapters */

/* Phase 1 contract: every red artifact maps to exactly one signal, and the
 * board planner never files a second row for a signature it already owns. */
function checkCaptureAdapters() {
  const policy = lib.defaultPolicy({ mode: "auto" });
  const signals = adapters.ciSignals([
    {
      id: 7,
      name: "CI",
      sha: "a".repeat(40),
      url: "https://example/run/7",
      verdict: "failed",
      reason: "ran and failed: tests",
      failedJobs: ["tests"],
      fix: "gh run view 7 --log-failed",
    },
    {
      id: 8,
      name: "CI",
      sha: "b".repeat(40),
      verdict: "infra-block",
      reason: "no runner was provisioned (0 steps, no runner_name) — NOT a test failure",
      fix: "repair the payment method",
    },
    { id: 9, name: "CI", verdict: "green" },
  ]);
  if (signals.length !== 2) fail(`adapters: expected 2 signals from 3 runs, got ${signals.length}`);
  const [product, infra] = signals.map((s) => lib.applyClassification(lib.normalizeSignal(s, { now: NOW }), policy));
  if (product.class !== "product") fail(`adapters: a failed CI run must classify as product, got ${product.class}`);
  if (infra.class !== "infra" || infra.route !== "ops") {
    fail(`adapters: an infra-block run must be infra/ops, got ${infra.class}/${infra.route}`);
  }
  const marker = lib.boardMarker(product);
  if (adapters.boardActionFor(product, []).action !== "add") fail("adapters: a new signature must add a row");
  if (adapters.boardActionFor(product, [{ id: "F-1", section: "open", task: marker }]).action !== "link") {
    fail("adapters: an existing marker must link, not add");
  }
  if (adapters.boardActionFor(product, [{ id: "F-2", section: "archive", task: marker }]).action !== "reopen") {
    fail("adapters: an archived marker must reopen, not add");
  }

  const journeys = adapters
    .nightlySignals({
      failures: [
        { flow: "checkout", phase: "e2e", reason: "AssertionError: expected 200 but got 500" },
        { flow: "checkout", phase: "harness", reason: "missing tool: adb", side: "harness" },
      ],
    })
    .map((s) => lib.applyClassification(lib.normalizeSignal(s, { now: NOW }), policy));
  const rows = [{ id: "F-3", section: "open", task: "[nightly:flow=checkout] checkout e2e failed" }];
  if (adapters.boardActionFor(journeys[0], rows).action !== "link") {
    fail("adapters: a product nightly journey must link to the reconcile row");
  }
  if (adapters.boardActionFor(journeys[1], rows).action !== "add") {
    fail("adapters: a harness-side nightly failure must get its own ops row");
  }
  if (journeys[1].class !== "infra") fail(`adapters: harness-side failure must be infra, got ${journeys[1].class}`);

  if (lib.metrics([product], NOW).open !== 1) fail("metrics: open must count a queued item");
  notes.push("adapters: CI/nightly capture + one-row board plan hold");
}

/* ---------------------------------------------------- Phase 2 triage + assist */

/* Phase 2 contract: one clean rerun can quarantine a flake with an owner and an
 * expiry; infra/security are never rerun; high-risk work cannot resolve without
 * an approval artifact; the attempt prompt is bounded and deterministic; and
 * the runner stops at the approval boundary instead of landing. */
function checkTriageAssist(doc) {
  const policy = lib.defaultPolicy({ mode: "auto" });
  const base = doc && Array.isArray(doc.fixtures) ? doc.fixtures.find((f) => f.id === "ci-failed") : null;
  if (!base) {
    fail("triage: the ci-failed fixture is required");
    return;
  }
  const product = lib.applyClassification(lib.normalizeSignal(base.signal, { now: NOW }), policy);
  const rerun = lib.rerunDecision(product, policy);
  if (!rerun.allowed || rerun.rule !== "ok") fail(`triage: a fresh product item must allow one rerun (rule=${rerun.rule})`);

  const flake = lib.rerunRecord(product, "pass", { at: NOW, by: "gate", evidence: "clean rerun" });
  if (flake.class !== "flake" || flake.route !== "quarantine" || flake.state !== "quarantined") {
    fail(`triage: a clean rerun must classify flake/quarantine/quarantined, got ${flake.class}/${flake.route}/${flake.state}`);
  }
  const plan = lib.quarantinePlan(flake, policy, { owner: "qa-runner", at: NOW });
  if (!plan.owner || !plan.expires_at || Date.parse(plan.expires_at) <= Date.parse(NOW)) {
    fail("triage: quarantine must carry an owner and a future expiry");
  }
  if (!plan.marker.includes("hardening")) fail("triage: quarantine must plan a distinct hardening row");

  const again = lib.rerunDecision({ ...flake, class: "product", route: "assist", state: "queued" }, policy);
  if (again.allowed || again.rule !== "rerun-budget") fail(`triage: a second clean rerun must be refused (rule=${again.rule})`);
  const infra = lib.applyClassification(
    lib.normalizeSignal({ source: "ci", verdict: "infra-block", title: "no runner", error: "no runner was provisioned" }, { now: NOW }),
    policy
  );
  if (lib.rerunDecision(infra, policy).rule !== "class") fail("triage: infra failures must never be rerun");
  const security = lib.applyClassification(
    lib.normalizeSignal({ source: "gate", title: "CVE-2026-0001", error: "vulnerable dependency" }, { now: NOW }),
    policy
  );
  if (lib.rerunDecision(security, policy).rule !== "class") fail("triage: security findings must never be rerun");

  const promptA = lib.triagePrompt(product, policy, { stats: { bySignature: 0 } });
  const promptB = lib.triagePrompt(product, policy, { stats: { bySignature: 0 } });
  if (promptA !== promptB) fail("triage: the attempt prompt must be deterministic");
  for (const needle of ["Reproduce first", "untrusted", "Evidence", "Stop condition"]) {
    if (!promptA.includes(needle)) fail(`triage: the attempt prompt is missing "${needle}"`);
  }

  const high = { ...product, risk: "high", state: "verifying" };
  if (lib.approvalSatisfied(high)) fail("triage: a high-risk item must not be approved implicitly");
  const approval = lib.approvalRecord(high, { by: "human", diff: "diff --git a/auth/x b/auth/x", at: NOW });
  if (!lib.approvalSatisfied({ ...high, approval })) fail("triage: a recorded approval must satisfy the gate");

  const escalation = lib.escalationTemplate(product, policy);
  if (!escalation.includes("Decision needed")) fail("triage: the escalation template must name the decision needed");
  const scaffold = lib.diagnosisScaffold(product);
  for (const needle of ["Candidate A", "Candidate B", "Falsification", "Outcome oracle", "Guard"]) {
    if (!scaffold.includes(needle)) fail(`triage: the diagnosis scaffold is missing "${needle}"`);
  }

  const resume = loop.decideFeedbackRun({ item: { ...product, state: "queued" }, phasesRun: 0, maxPhases: 4 });
  if (resume.action !== "resume" || !resume.prompt.includes(product.id)) fail("triage: the runner must resume a queued item with its prompt");
  const boundary = loop.decideFeedbackRun({ item: high, phasesRun: 1, maxPhases: 4 });
  if (boundary.action !== "stop" || !/approval/i.test(boundary.reason)) {
    fail(`triage: the runner must stop at the high-risk approval boundary (action=${boundary.action})`);
  }
  const done = loop.decideFeedbackRun({ item: { ...product, state: "resolved" }, phasesRun: 1, maxPhases: 4 });
  if (done.action !== "done") fail("triage: a resolved item must end the runner");
  notes.push("triage: rerun/quarantine, approval gate, bounded prompt, escalation + runner boundary hold");
}

/* ------------------------------------------------------------ ledger peeking */

function checkLedger(dir) {
  if (!fs.existsSync(dir)) {
    warn(`ledger ${dir} does not exist yet — fine before the first captured signal`);
    return;
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("."))
    .slice(0, 50);
  let checked = 0;
  for (const file of files) {
    const doc = loadJson(path.join(dir, file), `ledger ${file}`);
    if (!doc) continue;
    if (doc.schema !== lib.SCHEMA) fail(`ledger ${file}: schema must be ${lib.SCHEMA}`);
    for (const key of ["id", "source", "environment", "signature", "state", "route", "class", "risk", "occurrences"]) {
      if (doc[key] == null) fail(`ledger ${file}: missing required field "${key}"`);
    }
    if (!lib.STATES.includes(doc.state)) fail(`ledger ${file}: unknown state "${doc.state}"`);
    if (doc.route && lib.stateForRoute(doc.route) !== doc.state && !["resolved", "queued"].includes(doc.state)) {
      // resolved/queued are reached transitively after routing; everything else must match.
      fail(`ledger ${file}: state "${doc.state}" does not match route "${doc.route}"`);
    }
    checked += 1;
  }
  notes.push(`ledger shape checked (${checked}/${files.length} item file(s), bounded)`);
}

/* ---------------------------------------------------------------------- main */

function main(argv) {
  const flags = parseArgs(argv);
  if (flags.help) {
    console.log("Usage: node scripts/qa/check-feedback.js [--policy <path>] [--ledger <dir>] [--json]");
    return 0;
  }
  if (flags.invalid) return 2;

  const root = process.cwd();
  const file = policyFile(root, flags);
  let policy;
  if (!file) {
    policy = lib.defaultPolicy();
    warn("no .agents/feedback.json found — safety defaults (observe) will be used");
  } else {
    const doc = loadJson(file, "feedback policy");
    if (doc) {
      const checked = lib.validatePolicy(doc);
      if (!checked.ok) for (const e of checked.errors) fail(`policy ${file}: ${e}`);
      policy = checked.policy;
      checkPolicy(policy, file);
      notes.push(`policy: ${policy.mode} · ${policy.max_attempts_per_signature}/${policy.max_attempts_per_day}/${policy.max_active_attempts}/${policy.cooldown_min} · kill_switch=${policy.kill_switch}`);
    }
  }

  const fixtures = loadJson(FIXTURES, "feedback fixtures");
  if (fixtures) {
    checkFixtures(fixtures);
    checkSignatureStability(fixtures);
    checkDedupeAndLifecycle(fixtures);
    checkBudgetsAndMetrics(fixtures);
    notes.push(`fixtures: ${fixtures.fixtures.length} cases classify + route as expected`);
  }

  checkRedaction();
  checkCaptureAdapters();
  checkTriageAssist(fixtures);
  checkLedger(ledgerDir(root, flags));

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          schema: "feedback-gate/1",
          ok: failures.length === 0,
          policy: file || null,
          mode: policy ? policy.mode : null,
          failures,
          warnings,
          notes,
        },
        null,
        2
      )
    );
  } else {
    for (const note of notes) console.log(`  ok   ${note}`);
    for (const warning of warnings) console.log(`  warn ${warning}`);
    for (const failure of failures) console.log(`  FAIL ${failure}`);
    if (failures.length) console.log(`test:feedback — ${failures.length} failure(s), ${warnings.length} warning(s)`);
    else console.log(`test:feedback — contract holds${warnings.length ? ` (${warnings.length} warning(s))` : ""}`);
  }
  return failures.length === 0 ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
