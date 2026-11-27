"use strict";
/* Durable journal, land lock and reconciliation for F-068. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const store = require("../templates/scripts/qa/orchestrator-store");

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orch-store-"));
}
function input(over = {}) {
  return {
    feature: "F-1",
    phase: "ready",
    priority: "P3",
    branch: "f-1",
    worktree: "/tmp/f-1",
    owned: ["src/a.js"],
    contracts: ["UserSchema"],
    ...over,
  };
}

test("createJob is idempotent and persists one journal entry", () => {
  const root = tmpRoot();
  const first = store.createJob(root, input(), { now: 1000 });
  assert.equal(first.created, true);
  assert.equal(first.job.state, "ready");
  const again = store.createJob(root, input(), { now: 2000 });
  assert.equal(again.created, false);
  assert.equal(again.job.enqueuedAt, 1000);
  const state = store.readState(root);
  assert.equal(Object.keys(state.jobs).length, 1);
  assert.ok(fs.existsSync(store.eventsPath(root)));
});

test("transitionJob enforces the state machine and appends an event", () => {
  const root = tmpRoot();
  store.createJob(root, input(), { now: 1000 });
  const ok = store.transitionJob(root, "F-1:ready", "landing", { code: "land" }, { now: 1100 });
  assert.equal(ok.ok, true);
  const bad = store.transitionJob(root, "F-1:ready", "running", {}, { now: 1200 });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "illegal_transition");
  const events = store.readEvents(root);
  assert.ok(events.some((e) => e.type === "transition" && e.from === "ready" && e.to === "landing"));
});

test("land lock is single-flight, names the holder, and releases only its holder", () => {
  const root = tmpRoot();
  const first = store.acquireLandLock(root, { holder: "one", feature: "F-1" }, { now: 1000 });
  assert.equal(first.acquired, true);
  const second = store.acquireLandLock(root, { holder: "two" }, { now: 1000 });
  assert.equal(second.acquired, false);
  assert.match(second.reason, /one/);
  assert.equal(store.releaseLandLock(root, "two").ok, false);
  assert.equal(store.releaseLandLock(root, "one").ok, true);
  assert.equal(store.readLandLock(root), null);
});

test("a dead-pid land lock is reclaimed exactly once", () => {
  const root = tmpRoot();
  fs.mkdirSync(store.landLockDir(root), { recursive: true });
  fs.writeFileSync(
    path.join(store.landLockDir(root), "holder.json"),
    JSON.stringify({
      holder: "ghost",
      pid: 999999,
      bootId: "other-boot",
      startedAt: 1,
      heartbeatAt: 1,
      ttlMs: 1000,
    })
  );
  const lock = store.acquireLandLock(root, { holder: "real" }, { now: 5000 });
  assert.equal(lock.acquired, true);
  assert.equal(store.readLandLock(root).holder, "real");
});

test("pause/resume is durable", () => {
  const root = tmpRoot();
  store.setPause(root, "provider_funds", "insufficient balance", { now: 1000 });
  assert.equal(store.readState(root).paused.reason, "provider_funds");
  store.setPause(root, null, null, { now: 2000 });
  assert.equal(store.readState(root).paused, null);
});

test("reconcile classifies landed, unknown push and retry against remote truth", () => {
  const root = tmpRoot();
  const base = { feature: "F-1", phase: "ready", state: "landing", branch: "f-1", baseSha: "base" };
  const landed = store.reconcileJob(root, base, { remoteSha: "head", branchSha: "head" });
  assert.equal(landed.state, "landed");
  const unknown = store.reconcileJob(root, base, { remoteSha: "other", branchSha: "head" });
  assert.equal(unknown.state, "unknown_push");
  const retry = store.reconcileJob(
    root,
    { ...base, baseSha: "remote-prev" },
    { remoteSha: "remote-prev", branchSha: "head" }
  );
  assert.equal(retry.state, "retry");
  assert.equal(store.reconcileJob(root, { ...base, state: "ready" }).state, "untouched");
});
