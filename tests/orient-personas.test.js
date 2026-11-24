"use strict";
/*
 * orient persona economics (F-025 S3).
 *
 * The main agent decides whether to delegate in the first seconds of a task; a
 * bounded price list (tier · observed mean input tokens/call · declared writes ·
 * last used) makes that a costed decision, not a habit. The formatter is pure so
 * the fixture rows are exact; the store path degrades to tier/writes only when
 * the store is unreachable (never an estimate from characters).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const orient = require("../templates/scripts/orient.js");

test("persona tier maps the model families the harness pins", () => {
  assert.equal(orient.personaTier("opencode-go/deepseek-v4-pro#high"), "reasoning");
  assert.equal(orient.personaTier("opencode-go/deepseek-v4.1-flash#high"), "engineering");
  assert.equal(orient.personaTier("opencode-go/some-generalist"), "content");
  assert.equal(orient.personaTier(""), "unpinned");
});

test("the block renders fixture rows deterministically, most recent first", () => {
  const rows = [
    { name: "qa-architect", tier: "reasoning", writes: [".agents/qa-plans/**", "scripts/qa/tests/**"], meanInput: 64000, last: Date.UTC(2026, 10, 21), outcome: "succeeded" },
    { name: "docs", tier: "content", writes: [], meanInput: 15000, last: Date.UTC(2026, 10, 20), outcome: null },
  ];
  const lines = orient.renderPersonasBlock(rows);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^personas:/);
  assert.match(lines[0], /qa-architect/);
  assert.match(lines[0], /reasoning/);
  assert.match(lines[0], /~64K in\/call/);
  assert.match(lines[0], /writes \.agents\/qa-plans\/\*\*/);
  assert.match(lines[1], /^\s+docs/);
  assert.match(lines[1], /reads only/);
  assert.match(lines[1], /last: 11-20/);
});

test("the block is bounded and omits cleanly with no rows", () => {
  assert.deepEqual(orient.renderPersonasBlock([]), []);
  assert.deepEqual(orient.renderPersonasBlock(null), []);
  const many = Array.from({ length: 10 }, (_, i) => ({
    name: `p${i}`,
    tier: "general",
    writes: [],
    meanInput: 0,
    last: 0,
  }));
  assert.equal(orient.renderPersonasBlock(many, orient.PERSONA_BRIEF_MAX).length, orient.PERSONA_BRIEF_MAX);
  assert.equal(orient.renderPersonasBlock(many).length, orient.PERSONA_MAX);
});

test("personaRows joins agent contracts with observed store rows", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orient-personas-"));
  fs.mkdirSync(path.join(root, ".opencode", "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".opencode", "agents", "qa-architect.md"),
    `---\ndescription: "Use when a coverage map is needed — returns the plan. Writes: \`.agents/qa-plans/**\`."\nmodel: opencode-go/deepseek-v4-pro#high\n---\nbody\n`
  );
  const rows = orient.personaRows(root, {
    query: () => [{ agent: "qa-architect", runs: 2, mean_input: 64000, last: 1000, outcome: "succeeded" }],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tier, "reasoning");
  assert.deepEqual(rows[0].writes, [".agents/qa-plans/**"]);
  assert.equal(rows[0].meanInput, 64000);
  assert.equal(rows[0].runs, 2);
});

test("personaRows degrades to tier + writes when the store query throws", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orient-personas-nostore-"));
  fs.mkdirSync(path.join(root, ".opencode", "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".opencode", "agents", "docs.md"),
    `---\ndescription: "Use when docs change — returns the edited docs. Writes: \`CHANGELOG.md\`."\nmodel: opencode-go/deepseek-v4.1-flash#high\n---\nbody\n`
  );
  const rows = orient.personaRows(root, {
    query: () => {
      throw new Error("store unreachable");
    },
  });
  assert.equal(rows[0].tier, "engineering");
  assert.equal(rows[0].meanInput, 0);
  assert.match(orient.renderPersonasBlock(rows)[0], /last: never/);
});
