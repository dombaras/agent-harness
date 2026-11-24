"use strict";
/*
 * Dispatch tier classifier (F-025 S4).
 *
 * The policy only pays off if the tier is a fact about the change, not a mood:
 * a one-file rename must not spawn four personas, and a schema migration must
 * never be a direct edit. Each tier gets a positive case and a negative one
 * (the risk tag that lifts it, the docs-only case that must not pay code gates).
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classify,
  renderTier,
  surfaceOf,
  riskTags,
  deriveSurfaces,
} = require("../templates/scripts/qa/dispatch-tier.js");

test("T0: one-file mechanical change runs direct with no persona", () => {
  const r = classify({ objective: "rename the timeout constant", files: ["app/config.ts"] });
  assert.equal(r.tier, 0);
  assert.equal(r.label, "T0");
  assert.equal(r.execution, "direct");
  assert.deepEqual(r.personas, []);
  assert.equal(r.qaPlan, true, "a code path still needs a QA plan/waiver");
});

test("T0: a docs-only change is not code and never pays the code gates", () => {
  const r = classify({ objective: "clarify the install steps", files: ["CHANGELOG.md"] });
  assert.equal(r.tier, 0);
  assert.equal(r.code, false);
  assert.equal(r.qaPlan, false);
  assert.ok(r.gates.includes("test:docs"));
  assert.ok(!r.gates.includes("test:quick"));
});

test("T1: two files on one surface run direct but verified", () => {
  const r = classify({ objective: "tighten the empty state copy", files: ["app/a.tsx", "app/b.tsx"] });
  assert.equal(r.tier, 1);
  assert.equal(r.execution, "direct");
  assert.deepEqual(r.surfaces, ["web"]);
  assert.ok(r.gates.includes("test:quick"));
  assert.ok(r.gates.includes("test:qa-plan"));
});

test("T2: four files on one surface need one dispatch", () => {
  const r = classify({
    objective: "add the invoice row actions",
    files: ["app/a.tsx", "app/b.tsx", "components/c.tsx", "components/d.tsx"],
  });
  assert.equal(r.tier, 2);
  assert.equal(r.execution, "dispatch");
  assert.deepEqual(r.personas, ["frontend-engineer"]);
});

test("T2: two surfaces need one dispatch even with few files", () => {
  const r = classify({ objective: "return the row total", files: ["app/row.tsx", "api/row.js"] });
  assert.equal(r.tier, 2);
  assert.deepEqual(r.personas, ["general", "frontend-engineer"]);
});

test("T3: schema + tenant isolation is high risk and gets architect + security", () => {
  const r = classify({
    objective: "migrate the prisma schema for tenant isolation",
    files: ["prisma/schema.prisma", "app/tenant.ts"],
  });
  assert.equal(r.tier, 3);
  assert.ok(r.risk.includes("schema"));
  assert.ok(r.risk.includes("security"));
  assert.equal(r.security, true);
  assert.ok(r.personas.includes("system-architect"));
  assert.ok(r.personas.includes("security-engineer"));
  assert.ok(r.personas.includes("qa-architect"));
  assert.ok(r.gates.includes("test:security"));
});

test("T3: three surfaces lift even an unremarkable objective", () => {
  const r = classify({
    objective: "wire the profile card",
    files: ["app/profile.tsx", "mobile/profile.tsx", "api/profile.js"],
  });
  assert.equal(r.tier, 3);
  assert.deepEqual(r.surfaces, ["api", "mobile", "web"]);
  assert.ok(r.personas.includes("qa-architect"));
});

test("an explicit risk tag lifts the tier without a keyword in the objective", () => {
  const r = classify({ objective: "tidy the helper", files: ["app/a.ts"], risk: ["auth"] });
  assert.equal(r.tier, 3);
  assert.equal(r.security, true);
  assert.ok(r.personas.includes("security-engineer"));
});

test("an undeclared scope is T1: verify before dispatching", () => {
  const r = classify({ objective: "look into the flaky test" });
  assert.equal(r.tier, 1);
  assert.ok(r.reasons.join(" ").includes("scope not declared"));
});

test("gates are path-derived: prefix only when a prefix file moves", () => {
  const prefix = classify({ objective: "tighten the dispatch rule", files: ["templates/AGENTS.md"] });
  assert.ok(prefix.gates.includes("test:prefix"));
  assert.ok(prefix.gates.includes("test:governance"));
  const plain = classify({ objective: "add a route", files: ["app/a.tsx", "api/a.js"] });
  assert.ok(!plain.gates.includes("test:prefix"));
  assert.ok(!plain.gates.includes("test:security"));
});

test("dispatch and governance gates fire from persona/config paths", () => {
  const r = classify({ objective: "retune a pin", files: ["templates/.opencode/agents/planner.md"] });
  assert.equal(r.code, false);
  assert.ok(r.gates.includes("test:dispatch"));
  assert.ok(r.gates.includes("test:governance"));
});

test("surfaceOf strips the templates prefix so source is not read as docs", () => {
  assert.equal(surfaceOf("templates/scripts/qa/dispatch-tier.js"), "gates");
  assert.equal(surfaceOf("scripts/qa/dispatch-tier.js"), "gates");
  assert.equal(surfaceOf("mobile/screens/Home.tsx"), "mobile");
  assert.equal(surfaceOf("README.md"), "docs");
});

test("deriveSurfaces uses declared surfaces and de-duplicates", () => {
  assert.deepEqual(deriveSurfaces(["app/a.tsx", "app/b.tsx"], []), ["web"]);
  assert.deepEqual(deriveSurfaces(["app/a.tsx"], ["mobile", "mobile"]), ["mobile"]);
});

test("riskTags is a small, explicit vocabulary", () => {
  assert.deepEqual(riskTags("add a login token"), ["auth"]);
  assert.deepEqual(riskTags("nothing risky", ["security"]), ["security"]);
});

test("renderTier names the tier, the executor and the gates", () => {
  const out = renderTier(
    classify({ objective: "migrate the schema", files: ["prisma/schema.prisma"] })
  );
  assert.match(out, /T3/);
  assert.match(out, /system-architect/);
  assert.match(out, /test:quick/);
});
