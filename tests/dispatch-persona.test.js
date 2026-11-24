"use strict";
/*
 * dispatch_persona preflight + spec assembly (F-025 S2).
 *
 * The plugin is a thin wrapper; the failure classes it must catch live here:
 * unknown persona, dead model pin, an objective that writes into a persona that
 * cannot write, and a tree/branch mismatch. A false green here would recreate
 * the F-074/F-095 "shipped dispatch with no write tool" class, so each branch
 * gets an explicit negative fixture.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dispatch = require("../templates/scripts/qa/dispatch-persona.js");

function fixture(agents) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-persona-"));
  fs.mkdirSync(path.join(root, ".opencode", "agents"), { recursive: true });
  for (const [name, body] of Object.entries(agents)) {
    fs.writeFileSync(path.join(root, ".opencode", "agents", `${name}.md`), body);
  }
  return root;
}

const WRITER = `---
description: "Use when app code changes — returns the patch. Writes: \`app/**\`, \`lib/**\`."
model: opencode-go/demo-writer
permissions:
  - action: edit
    resource: "*"
    effect: allow
  - action: edit
    resource: ".agents/**"
    effect: deny
---
body
`;

const READER = `---
description: "Use when a plan is needed — returns plan.md. Reads only."
model: opencode-go/demo-reader
permissions:
  - action: edit
    resource: "*"
    effect: deny
  - action: edit
    resource: ".agents/features/*/plan.md"
    effect: allow
---
body
`;

test("parses the persona contract and its declared writes", () => {
  const p = dispatch.parsePersona(WRITER);
  assert.equal(p.model, "opencode-go/demo-writer");
  assert.deepEqual(p.writes, ["app/**", "lib/**"]);
  assert.deepEqual(dispatch.writesFromDescription(READER), []);
});

test("glob + permission decisions honour last-match-wins", () => {
  assert.equal(dispatch.globToRegExp("app/**").test("app/x/y.ts"), true);
  assert.equal(dispatch.globToRegExp("app/**").test("apps/x.ts"), false);
  assert.equal(dispatch.globToRegExp("**/plan.md").test("plan.md"), true);
  const p = dispatch.parsePersona(WRITER);
  assert.equal(dispatch.decide(p.permissions, "edit", "app/page.tsx"), "allow");
  assert.equal(dispatch.decide(p.permissions, "edit", ".agents/x.md"), "deny");
});

test("preflight accepts a writing persona on a clean feature tree", () => {
  const root = fixture({ writer: WRITER });
  const pf = dispatch.preflight({
    root,
    persona: "writer",
    objective: "Implement the settings page",
    files: ["app/settings/page.tsx"],
    models: ["opencode-go/demo-writer"],
    tree: { path: root, branch: "f-001", dirty: 0 },
  });
  assert.deepEqual(pf.errors, []);
  assert.equal(pf.ok, true);
});

test("preflight rejects an unknown persona with the available list", () => {
  const root = fixture({ writer: WRITER });
  const pf = dispatch.preflight({ root, persona: "qa-architec", objective: "plan", models: [] });
  assert.equal(pf.ok, false);
  assert.match(pf.errors[0].message, /unknown persona "qa-architec"/);
  assert.match(pf.errors[0].message, /writer/);
});

test("preflight rejects a dead model pin (F-081 class)", () => {
  const root = fixture({ writer: WRITER });
  const pf = dispatch.preflight({
    root,
    persona: "writer",
    objective: "Implement it",
    models: ["opencode-go/some-other-model"],
  });
  assert.equal(pf.ok, false);
  assert.match(pf.errors[0].message, /does not resolve/);
  assert.match(pf.errors[0].message, /\.opencode\/agents\/writer\.md/);
});

test("preflight rejects a write objective on a read-only persona (F-074/F-095 class)", () => {
  const root = fixture({ reader: READER });
  const pf = dispatch.preflight({
    root,
    persona: "reader",
    objective: "Fix the failing checkout test",
    models: ["opencode-go/demo-reader"],
  });
  assert.equal(pf.ok, false);
  assert.match(pf.errors[0].message, /cannot write/);
});

test("preflight rejects a file outside the persona's write scope", () => {
  const root = fixture({ writer: WRITER });
  const pf = dispatch.preflight({
    root,
    persona: "writer",
    objective: "Update agent memory",
    files: [".agents/memory/locations.md"],
    models: ["opencode-go/demo-writer"],
  });
  assert.equal(pf.ok, false);
  assert.match(pf.errors[0].message, /may not edit \.agents\/memory\/locations\.md/);
});

test("preflight rejects a missing tree and a branch mismatch, warns on dirt", () => {
  const root = fixture({ writer: WRITER });
  const missing = dispatch.preflight({
    root,
    persona: "writer",
    objective: "Implement it",
    models: ["opencode-go/demo-writer"],
    tree: { path: "/nope", exists: false },
  });
  assert.equal(missing.ok, false);
  assert.match(missing.errors[0].message, /backlog worktree/);

  const branch = dispatch.preflight({
    root,
    persona: "writer",
    objective: "Implement it",
    models: ["opencode-go/demo-writer"],
    tree: { path: root, branch: "main", expectedBranch: "f-025" },
  });
  assert.equal(branch.ok, false);
  assert.match(branch.errors[0].message, /on main, expected f-025/);

  const dirty = dispatch.preflight({
    root,
    persona: "writer",
    objective: "Implement it",
    models: ["opencode-go/demo-writer"],
    tree: { path: root, branch: "f-025", dirty: 3 },
  });
  assert.equal(dirty.ok, true, "dirt is reported, never blocking");
  assert.equal(dirty.warnings[0].code, "tree-dirty");
});

test("unverified models warn, never block (store/CLI unavailable)", () => {
  const root = fixture({ writer: WRITER });
  const pf = dispatch.preflight({
    root,
    persona: "writer",
    objective: "Implement it",
    models: null,
  });
  assert.equal(pf.ok, true);
  assert.equal(pf.warnings[0].code, "model-unverified");
});

test("the prompt carries all six fields and a stable hash", () => {
  const root = fixture({ writer: WRITER });
  const p = dispatch.parsePersona(WRITER);
  const args = {
    persona: "writer",
    objective: "Implement the settings page",
    root,
    description: p.description,
    writes: p.writes,
    owned: ["app/settings/page.tsx"],
    tree: { path: root, branch: "f-025", dirty: 0 },
    contracts: [".agents/features/F-025/plan.md"],
  };
  const a = dispatch.buildPrompt(args);
  const b = dispatch.buildPrompt(args);
  for (const heading of [
    "## Objective",
    "## Working tree",
    "## Owned files",
    "## Read-only files",
    "## Shared contracts",
    "## Done =",
    "## Out of scope",
    "## Output contract",
  ]) {
    assert.ok(a.prompt.includes(heading), `missing ${heading}`);
  }
  assert.equal(a.hash, b.hash);
  assert.match(a.hash, /^[0-9a-f]{12}$/);
  const changed = dispatch.buildPrompt({ ...args, objective: "Implement the billing page" });
  assert.notEqual(a.hash, changed.hash);
});
