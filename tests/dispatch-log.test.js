"use strict";
/*
 * Derived dispatch log (F-025 S5).
 *
 * F-358 is the incident fixture: a handoff still carrying the checkpoint
 * placeholder reached the landing commit, so the governance gate saw a log that
 * said nothing. The renderer must (a) fill an empty/placeholder section from
 * observed child sessions, (b) say "direct" honestly when none were observed,
 * and (c) never overwrite a log a session actually wrote.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const log = require("../templates/scripts/qa/dispatch-log.js");

const FIXTURE = path.join(__dirname, "fixtures", "f358-handoff.md");

test("F-358 fixture: the placeholder is not a dispatch entry", () => {
  const text = fs.readFileSync(FIXTURE, "utf8");
  assert.equal(log.hasEntries(text), false);
  assert.deepEqual(log.parseEntries(text), []);
});

test("F-358 fixture: a derived row replaces the placeholder in place", () => {
  const text = fs.readFileSync(FIXTURE, "utf8");
  const out = log.applyDerivedLog(text, [{ persona: "qa-architect", model: "opencode-go/deepseek-v4-pro", status: "shipped" }]);
  assert.equal(out.changed, true);
  assert.match(out.text, /<!-- dispatch-log:start -->/);
  assert.match(out.text, /- qa-architect -> opencode-go\/deepseek-v4-pro -> shipped/);
  assert.doesNotMatch(out.text, /checkpoint only/);
  assert.match(out.text, /## Checkpoint \(resume\)/);
  assert.equal(log.parseEntries(out.text).length, 1);
});

test("no observed dispatch writes an honest direct-lane line, not an empty log", () => {
  const out = log.applyDerivedLog(fs.readFileSync(FIXTURE, "utf8"), []);
  assert.match(out.text, /- none -> main -> direct/);
  assert.equal(log.parseEntries(out.text).length, 1, "the line is parseable by governance/report");
  assert.match(out.reason, /direct lane/);
});

test("an existing hand-authored log is never overwritten", () => {
  const text = `# Handoff\n\n## Dispatch log\n- docs -> opencode-go/x -> shipped\n\n## Checkpoint\nbody\n`;
  const out = log.applyDerivedLog(text, [{ persona: "qa-architect", model: "m", status: "shipped" }]);
  assert.equal(out.changed, false);
  assert.equal(out.reason, "existing log kept");
  assert.match(out.text, /- docs -> opencode-go\/x -> shipped/);
  assert.doesNotMatch(out.text, /qa-architect/);
});

test("the marker block is idempotent across re-runs", () => {
  const once = log.applyDerivedLog(fs.readFileSync(FIXTURE, "utf8"), [{ persona: "p", model: "m", status: "shipped" }]).text;
  const twice = log.applyDerivedLog(once, [{ persona: "p", model: "m", status: "shipped" }]).text;
  assert.equal(twice, once);
});

test("a section without markers is replaced, and a missing section is inserted", () => {
  const sectioned = "# H\n\n## Dispatch log\n- (checkpoint only)\n\n## Checkpoint\nbody\n";
  const replaced = log.applyDerivedLog(sectioned, [{ persona: "p", model: "m", status: "shipped" }]).text;
  assert.doesNotMatch(replaced, /checkpoint only/);
  assert.match(replaced, /## Checkpoint/);

  const bare = "# H\n\nbody\n";
  const inserted = log.applyDerivedLog(bare, []).text;
  assert.match(inserted, /## Dispatch log/);
  assert.match(inserted, /# H/);
});

test("deriveRows maps child sessions, de-duplicates, and tolerates an old schema", () => {
  const table = ["agent", "model", "idle_outcome", "time_created"].map((name) => ({ name }));
  const rows = [
    { agent: "qa-architect", model: "m1", outcome: "stop" },
    { agent: "qa-architect", model: "m1", outcome: "stop" },
    { agent: "docs", model: "m2", outcome: null },
  ];
  const query = (sql) => (sql.startsWith("PRAGMA") ? table : rows);
  assert.deepEqual(log.deriveRows({ query }), [
    { persona: "qa-architect", model: "m1", status: "completed (stop)" },
    { persona: "docs", model: "m2", status: "completed" },
  ]);
  assert.deepEqual(log.deriveRows({ query: () => { throw new Error("no store"); } }), []);
  assert.deepEqual(log.deriveRows({}), []);
});
