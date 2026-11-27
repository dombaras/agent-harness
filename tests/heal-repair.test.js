#!/usr/bin/env node
"use strict";
/*
 * F-078 — Phase 2 bounded repair contract tests.
 *
 * Pins the safety envelope, not the happy path alone:
 *   1. a T0 flake resolves through an allowlisted playbook with audit;
 *   2. a failing attempt escalates and opens the breaker (no third attempt);
 *   3. T2/T3 never run a command, even in auto;
 *   4. assist prepares an isolated worktree + handoff without touching product
 *      files, while observe executes nothing;
 *   5. pause kills an in-flight attempt well under 60 s.
 *
 * Offline, temp dirs only. No network, no provider store, no live CI.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, spawn } = require("node:child_process");

const LIB = require("../templates/scripts/qa/heal-lib.js");
const STORE = require("../templates/scripts/qa/heal-store.js");
const ACT = require("../templates/scripts/qa/heal-act.js");

const ROOT = path.join(__dirname, "..");
const CLI = path.join(ROOT, "templates", "scripts", "heal.js");
const NOW = Date.parse("2026-11-27T12:00:00.000Z");

function tempProject(policy = { mode: "auto" }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "heal-repair-"));
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

function playbook(ctx, action, command, extra = "") {
  const dir = path.join(ctx.root, ".agents", "playbooks");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${action}.md`),
    `---\naction: ${action}\ncommand: ${JSON.stringify(command)}\ntimeout_sec: 30\nverify: exit_code\ndescription: test ${action}\n---\n\n# ${action}\n${extra}\n`
  );
}

function seedItem(ctx, overrides = {}) {
  const base = LIB.normalizeSignal(
    { source: "gate", environment: "local", test: "quick", error: "flaky check" },
    { now: NOW }
  );
  const item = {
    ...base,
    id: "heal-gate-resolve",
    signature: "sig-resolve",
    sig8: "resolve1",
    class: "flake",
    tier: "T0",
    state: "classified",
    playbook: "rerun",
    repro: "heal reproduce first\nSymptom: flaky check\nSteps: re-run the named check with no cache.",
    ...overrides,
  };
  return STORE.recordItem(ctx.root, item, { healDir: ctx.store, now: NOW }).item;
}

function readAudit(ctx) {
  return STORE.readJsonl(path.join(ctx.store, "audit.jsonl")).events;
}

test("playbook parser: argv only, metacharacters refused, duplicates reported", () => {
  const pb = LIB.parsePlaybook(`---\naction: rerun\ncommand: npm run test:quick\ntimeout_sec: 60\n---\n`, { name: "rerun" });
  assert.deepEqual(pb.command, ["npm", "run", "test:quick"]);
  assert.equal(pb.enabled, true);
  assert.match(pb.sha256, /^[a-f0-9]{64}$/);
  assert.equal(LIB.parsePlaybook(`---\naction: rerun\ncommand: npm run x ; rm -rf /\n---\n`).enabled, false);
  assert.throws(() => LIB.parsePlaybook(`---\naction: nope\n---\n`), /action must be one of/);
  assert.throws(() => LIB.parsePlaybook(`---\naction: rerun\ntimeout_sec: 0\n---\n`), /timeout_sec/);
  assert.throws(() => LIB.parsePlaybook(`not frontmatter`), /frontmatter/);

  const ctx = tempProject();
  try {
    playbook(ctx, "rerun", ["node", "-e", "process.exit(0)"]);
    playbook(ctx, "retry", ["node", "-e", "process.exit(0)"]);
    fs.writeFileSync(path.join(ctx.root, ".agents", "playbooks", "rerun-dup.md"), `---\naction: rerun\n---\n`);
    const loaded = ACT.loadPlaybooks(ctx.root, { repair: {} });
    assert.equal(loaded.byAction.rerun.action, "rerun");
    assert.equal(loaded.errors.length, 1);
  } finally {
    ctx.cleanup();
  }
});

test("auto T0 resolves through a playbook and writes a complete audit", () => {
  const ctx = tempProject({ mode: "auto", risk: { auto_tiers: ["T0"] }, budgets: { cooldown_min: 0, max_attempts_per_signature: 5 } });
  try {
    playbook(ctx, "rerun", ["node", "-e", "process.exit(0)"]);
    seedItem(ctx);
    const res = runCli(ctx, ["run", "--json", "--no-board", "--no-write"]);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const out = JSON.parse(res.stdout);
    assert.equal(out.repair.status, "attempted", JSON.stringify(out.repair));
    assert.equal(out.repair.outcome, "resolved");
    assert.equal(out.repair.exit_code, 0);

    const state = STORE.readState(ctx.root, { healDir: ctx.store });
    assert.equal(state.items[0].state, "closed");
    assert.equal(state.items[0].outcome, "resolved");
    assert.equal(state.items[0].attempts.length, 1);
    assert.equal(state.items[0].attempts[0].ok, true);

    const audit = readAudit(ctx);
    assert.ok(audit.some((e) => e.kind === "attempt_start" && e.playbook_sha256));
    assert.ok(audit.some((e) => e.kind === "attempt_end" && e.outcome === "resolved" && e.output_sha256));
  } finally {
    ctx.cleanup();
  }
});

test("a failing attempt escalates and the breaker blocks the third attempt", () => {
  const ctx = tempProject({
    mode: "auto",
    risk: { auto_tiers: ["T0"] },
    budgets: { cooldown_min: 0, max_attempts_per_signature: 5, max_attempts_per_day: 10 },
    breaker: { consecutive_failures: 2, cooldown_min: 120 },
  });
  try {
    playbook(ctx, "rerun", ["node", "-e", "process.exit(1)"]);
    seedItem(ctx);
    const first = runCli(ctx, ["run", "--json", "--no-board"]);
    assert.equal(first.status, 1, first.stdout);
    assert.equal(JSON.parse(first.stdout).repair.outcome, "failed");
    const second = runCli(ctx, ["run", "--json", "--no-board"]);
    assert.equal(second.status, 1, second.stdout);
    const state = STORE.readState(ctx.root, { healDir: ctx.store });
    assert.equal(state.items[0].state, "escalated");
    assert.equal(state.consecutive_failures, 2);
    assert.ok(state.breaker_until);

    const third = runCli(ctx, ["run", "--json", "--no-board"]);
    assert.equal(third.status, 0, third.stdout);
    const blocked = JSON.parse(third.stdout).repair;
    assert.equal(blocked.status, "blocked");
    assert.match(blocked.reason, /breaker/);
    assert.equal(readAudit(ctx).filter((e) => e.kind === "attempt_start").length, 2);
  } finally {
    ctx.cleanup();
  }
});

test("T2 never runs a command in auto; observe executes nothing", () => {
  const auto = tempProject({ mode: "auto", risk: { auto_tiers: ["T0"] } });
  const observe = tempProject({ mode: "observe" });
  try {
    for (const ctx of [auto, observe]) {
      playbook(ctx, "patch", ["node", "-e", `require("fs").writeFileSync("PWNED","x")`]);
      seedItem(ctx, {
        id: "heal-gate-t2",
        signature: "sig-t2",
        sig8: "t2t2t2t2",
        class: "product",
        tier: "T2",
        playbook: "patch",
        files: ["src/a.js"],
      });
    }
    const autoRes = runCli(auto, ["run", "--json", "--no-board"]);
    assert.equal(autoRes.status, 0, autoRes.stdout);
    assert.equal(JSON.parse(autoRes.stdout).repair.status, "blocked");
    assert.equal(fs.existsSync(path.join(auto.root, "PWNED")), false);
    assert.equal(STORE.readState(auto.root, { healDir: auto.store }).items[0].state, "classified");
    assert.equal(readAudit(auto).length, 0);

    const observeRes = runCli(observe, ["run", "--json", "--no-board"]);
    assert.equal(observeRes.status, 0);
    assert.equal(JSON.parse(observeRes.stdout).repair.status, "read-only");
    assert.equal(fs.existsSync(path.join(observe.root, "PWNED")), false);
    assert.equal(readAudit(observe).length, 0);
  } finally {
    auto.cleanup();
    observe.cleanup();
  }
});

test("assist prepares an isolated T1 worktree + handoff, never product code", () => {
  const ctx = tempProject({ mode: "assist" });
  try {
    const git = (args) => spawnSync("git", args, { cwd: ctx.root, encoding: "utf8" });
    assert.equal(git(["init"]).status, 0);
    git(["config", "user.email", "heal@example.com"]);
    git(["config", "user.name", "heal test"]);
    fs.writeFileSync(path.join(ctx.root, "README.md"), "product\n");
    assert.equal(git(["add", "README.md"]).status, 0);
    assert.equal(git(["commit", "-m", "seed"]).status, 0);

    seedItem(ctx, {
      id: "heal-gate-t1",
      signature: "sig-t1",
      sig8: "t1t1t1t1",
      class: "product",
      tier: "T1",
      playbook: "patch",
      files: ["src/a.js"],
    });
    const res = runCli(ctx, ["run", "--json", "--no-board"]);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const out = JSON.parse(res.stdout);
    assert.equal(out.repair.status, "prepared", JSON.stringify(out.repair));
    assert.ok(fs.existsSync(path.join(out.repair.worktree, ".git")));
    const handoff = fs.readFileSync(out.repair.handoff, "utf8");
    assert.match(handoff, /Reproduce first/);
    assert.match(handoff, /never edit/i);

    const state = STORE.readState(ctx.root, { healDir: ctx.store });
    assert.equal(state.items[0].state, "escalated");
    assert.equal(state.items[0].outcome, "handoff");
    assert.equal(readAudit(ctx).filter((e) => e.kind === "assist_prepare").length, 1);
    assert.equal(git(["diff", "--quiet"]).status, 0, "product files unchanged");
    assert.equal(git(["diff", "--cached", "--quiet"]).status, 0, "nothing staged");
  } finally {
    ctx.cleanup();
  }
});

test("pause kills an in-flight attempt well under 60 s", async () => {
  const ctx = tempProject({
    mode: "auto",
    risk: { auto_tiers: ["T0"] },
    budgets: { cooldown_min: 0 },
    repair: { kill_poll_sec: 1 },
  });
  try {
    playbook(ctx, "rerun", [
      "node",
      "-e",
      'setTimeout(function(){require("fs").writeFileSync("late.txt","x")},5000)',
    ]);
    seedItem(ctx);
    const child = spawn(process.execPath, [CLI, "run", "--json", "--no-board", "--root", ctx.root, "--heal-dir", ctx.store], {
      cwd: ctx.root,
      encoding: "utf8",
      env: { ...process.env, AGENT_HARNESS_HEAL_DIR: "" },
    });
    let stdout = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    /* Attach the close listener immediately: a fast/refused pass may exit before
     * the pause below, and a late listener would hang the suite forever. */
    const closed = new Promise((resolve, reject) => {
      const guard = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`heal run did not exit; stdout=${stdout.slice(-500)}`));
      }, 20000);
      child.on("close", (code) => {
        clearTimeout(guard);
        resolve(code);
      });
    });
    const started = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(runCli(ctx, ["pause"]).status, 0);
    const code = await closed;
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 15000, `kill took ${elapsed}ms`);
    assert.equal(code, 1, stdout);
    const out = JSON.parse(stdout);
    assert.equal(out.repair.status, "attempted");
    assert.equal(out.repair.outcome, "aborted");
    assert.equal(fs.existsSync(path.join(ctx.root, "late.txt")), false);
    assert.equal(readAudit(ctx).some((e) => e.kind === "attempt_end" && e.aborted === true), true);
  } finally {
    ctx.cleanup();
  }
});
