"use strict";
/* Pure scheduler rules for the parallel feature orchestrator (F-068). */
const test = require("node:test");
const assert = require("node:assert/strict");
const lib = require("../templates/scripts/qa/orchestrator-lib");

const NOW = 1_700_000_000_000;
function job(over = {}) {
  return {
    id: "F-1:implement",
    feature: "F-1",
    phase: "implement",
    state: "queued",
    priority: "P3",
    enqueuedAt: NOW,
    readyAt: NOW,
    owned: [],
    contracts: [],
    ...over,
  };
}
function ctx(over = {}) {
  return {
    jobs: [],
    limits: {},
    capacity: { ok: true, reasons: [] },
    heavyLock: { held: false, holder: null },
    pause: null,
    now: NOW,
    ...over,
  };
}

test("state machine allows legal transitions and names illegal ones", () => {
  assert.equal(lib.canTransition("queued", "admitted"), true);
  assert.equal(lib.canTransition("running", "ready"), true);
  assert.equal(lib.canTransition("ready", "landing"), true);
  assert.equal(lib.canTransition("done", "queued"), false);
  const bad = lib.checkTransition("landed", "running");
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /landed -> running/);
});

test("queue is FIFO by ready time, with a priority jump", () => {
  const a = job({ id: "A", readyAt: NOW + 20 });
  const b = job({ id: "B", readyAt: NOW + 10 });
  const hot = job({ id: "HOT", readyAt: NOW + 30, priority: "P1" });
  assert.deepEqual(
    lib.queueOrder([a, b, hot]).map((j) => j.id),
    ["HOT", "B", "A"]
  );
});

test("owned paths conflict on exact, nested and glob overlaps", () => {
  assert.equal(lib.overlapsOwned("src/a.js", "src/a.js"), true);
  assert.equal(lib.overlapsOwned("src/components", "src/components/button.tsx"), true);
  assert.equal(lib.overlapsOwned("src/**/*.ts", "src/lib/x.ts"), true);
  assert.equal(lib.overlapsOwned("src/a.js", "src/b.js"), false);
  assert.equal(lib.overlapsOwned("docs/**", "src/app.ts"), false);
});

test("conflicts report owned files and shared contracts", () => {
  const a = job({ owned: ["src/a.js"], contracts: ["UserSchema"] });
  const b = job({ owned: ["src/a.js"], contracts: ["userschema"] });
  const hit = lib.conflicts(a, b);
  assert.equal(hit.owned.length, 1);
  assert.deepEqual(hit.contracts, ["UserSchema"]);
  assert.deepEqual(lib.conflicts(a, job({ owned: ["src/b.js"], contracts: [] })), {
    owned: [],
    contracts: [],
  });
});

test("admission enforces one builder, one lander and disjoint owned files", () => {
  const running = job({ id: "A:implement", feature: "A", state: "running", owned: ["src/a.js"] });
  const waiting = job({ id: "B:implement", feature: "B", owned: ["src/b.js"] });
  const decision = lib.admission([running, waiting], ctx());
  assert.deepEqual(decision.admitted, []);
  assert.equal(decision.blocked.find((b) => b.id === "B:implement").code, "max_builders");

  const disjoint = job({ id: "C:implement", feature: "C", owned: ["src/c.js"] });
  const overlap = job({ id: "D:implement", feature: "D", owned: ["src/c.js"] });
  const free = lib.admission([disjoint, overlap], ctx({ limits: { maxBuilders: 2 } }));
  assert.deepEqual(free.admitted, [{ id: "C:implement", resource: "code" }]);
  assert.equal(free.blocked.find((b) => b.id === "D:implement").code, "conflict_owned");
});

test("admission allows light prep beside a builder and blocks heavy on the lock", () => {
  const running = job({ id: "A:implement", state: "running" });
  const prep = job({ id: "B:prep", feature: "B", phase: "prep", state: "queued" });
  const heavy = job({ id: "C:verify", feature: "C", phase: "verify", state: "queued" });
  const decision = lib.admission([running, prep, heavy], ctx({ heavyLock: { held: true, holder: "x" } }));
  assert.ok(decision.admitted.some((a) => a.id === "B:prep"));
  assert.equal(decision.blocked.find((b) => b.id === "C:verify").code, "heavy_lock");
});

test("provider funds pause stops every admission; red main stops landings only", () => {
  const queued = job({ id: "A:implement" });
  const ready = job({ id: "B:ready", feature: "B", phase: "ready", state: "ready" });
  const funds = lib.admission([queued, ready], ctx({ pause: { reason: "provider_funds" } }));
  assert.equal(funds.admitted.length, 0);
  assert.ok(funds.blocked.every((b) => b.code === "provider_funds"));

  const red = lib.admission([queued, ready], ctx({ pause: { reason: "red_main", detail: "sha" } }));
  assert.ok(red.admitted.some((a) => a.id === "A:implement"));
  assert.equal(red.blocked.find((b) => b.id === "B:ready").code, "red_main");
});

test("AIMD decreases on pressure, cools down, then increases after two healthy ticks", () => {
  const down = lib.aimd({ limit: 2 }, { now: NOW, swapUsedPct: 70 });
  assert.equal(down.action, "decrease");
  assert.equal(down.limit, 1);
  assert.equal(down.cooldownUntil, NOW + lib.DEFAULT_AIMD.cooldownMs);

  const cooled = lib.aimd({ limit: 1, cooldownUntil: NOW + 1000, healthyTicks: 0 }, { now: NOW });
  assert.equal(cooled.action, "hold");
  assert.equal(cooled.healthyTicks, 0);

  const one = lib.aimd({ limit: 1, cooldownUntil: 0, healthyTicks: 0 }, { now: NOW });
  assert.equal(one.action, "hold");
  const two = lib.aimd({ limit: 1, cooldownUntil: 0, healthyTicks: one.healthyTicks }, { now: NOW + 1 });
  assert.equal(two.action, "increase");
  assert.equal(two.limit, 2);
});

test("retry requires a changed hypothesis and quarantines at budget", () => {
  assert.equal(lib.retryDecision(job(), { attempts: 0, hypothesisChanged: false }).action, "refuse");
  const retry = lib.retryDecision(job(), { attempts: 0, hypothesisChanged: true });
  assert.equal(retry.action, "retry");
  assert.equal(retry.delayMs, 30000);
  assert.equal(lib.retryDecision(job(), { attempts: 2, hypothesisChanged: true }).action, "quarantine");
});

test("blockingReason names the exact blocker", () => {
  const ready = job({ id: "F-1:ready", phase: "ready", state: "ready" });
  assert.equal(
    lib.blockingReason(ready, ctx({ pause: { reason: "red_main" } })).code,
    "red_main"
  );
  const dep = job({ id: "F-2:implement", feature: "F-2", dependsOn: ["F-1"] });
  assert.equal(
    lib.blockingReason(dep, ctx({ jobs: [dep], limits: {}, now: NOW })).code,
    "waiting_for_dependency"
  );
});

test("dry-run planner is bounded and emits the phase pipeline", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ id: `F-${i}`, status: "todo", priority: "P3" }));
  const plan = lib.dryRunPlan(rows, { limit: 5 });
  assert.equal(plan.length, 5);
  assert.deepEqual(
    plan[0].phases.map((p) => p.phase),
    ["prep", "implement", "verify", "ready", "land", "deploy", "done"]
  );
  assert.equal(lib.dryRunPlan([{ id: "F-9", status: "archived" }]).length, 0);
});
