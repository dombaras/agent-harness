"use strict";
/*
 * Feature doc-chain visibility in orient (F-063).
 *
 * A cleared session otherwise globs for `.agents/features/<dir>/{intent,scope,
 * plan,tests}.md` after orient. The session-start surfaces name the chain and
 * mark each doc present/missing, so the next step is a read, not a hunt.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const orient = require("../templates/scripts/orient.js");

function fixture(dirs = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orient-feature-docs-"));
  for (const [name, files] of Object.entries(dirs)) {
    const dir = path.join(root, ".agents", "features", name);
    fs.mkdirSync(dir, { recursive: true });
    for (const [file, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, file), content);
    }
  }
  return root;
}

function collect(root, feature = "F-063") {
  return orient.collectOrient({
    root,
    feature,
    git: () => null,
    readCheckpoint: () => null,
    query: () => [],
  });
}

/* The rendered path is relative and uses the host separator; tests compare the
 * logical form so they hold on any checkout root. */
function logical(p) {
  return String(p).split(path.sep).join("/");
}

test("locates the feature dir by name and reports the doc chain", () => {
  const root = fixture({ "f-063": { "intent.md": "# intent\n", "plan.md": "# plan\n" } });
  const docs = orient.featureDocs(root, "F-063");
  assert.equal(logical(docs.dir), ".agents/features/f-063");
  assert.equal(docs.none, false);
  assert.deepEqual(docs.present, ["intent", "plan"]);
  assert.deepEqual(docs.missing, ["scope", "tests"]);

  const o = collect(root);
  assert.deepEqual(o.featureDocs, docs);
  assert.match(orient.printHuman(o), /docs: {4}\.agents\/features\/f-063 · present intent,plan · missing scope,tests/);
  assert.match(orient.printBrief(o), /docs: {4}\.agents\/features\/f-063 · present intent,plan · missing scope,tests/);
});

test("locates the feature dir by the id in meta.json", () => {
  const root = fixture({
    "session-brief-docs": {
      "meta.json": JSON.stringify({ id: "F-200", kind: "feature" }),
      "scope.md": "# scope\n",
      "tests.md": "# tests\n",
    },
  });
  const docs = orient.featureDocs(root, "F-200");
  assert.equal(logical(docs.dir), ".agents/features/session-brief-docs");
  assert.deepEqual(docs.present, ["scope", "tests"]);
  assert.deepEqual(docs.missing, ["intent", "plan"]);
});

test("a prefixed dir name matches, but a longer numeric id does not", () => {
  const prefixed = fixture({ "f-063-session-brief-docs": { "intent.md": "# intent\n" } });
  assert.equal(logical(orient.featureDocs(prefixed, "F-063").dir), ".agents/features/f-063-session-brief-docs");

  const longer = fixture({ "f-0630": { "intent.md": "# intent\n" } });
  const docs = orient.featureDocs(longer, "F-063");
  assert.equal(docs.none, true);
  assert.equal(docs.dir, null);
});

test("reports none when no feature dir exists, in both renderers", () => {
  const root = fixture({ "f-051": { "intent.md": "# intent\n" } });
  const docs = orient.featureDocs(root, "F-063");
  assert.equal(docs.none, true);
  assert.deepEqual(docs.present, []);
  assert.deepEqual(docs.missing, ["intent", "scope", "plan", "tests"]);

  const o = collect(root);
  assert.match(orient.printHuman(o), /docs: {4}none \(no \.agents\/features dir for F-063\)/);
  assert.match(orient.printBrief(o), /docs: {4}none \(no \.agents\/features dir for F-063\)/);
});

test("says missing none when the whole chain is present", () => {
  const root = fixture({
    "f-063": { "intent.md": "x", "scope.md": "x", "plan.md": "x", "tests.md": "x" },
  });
  const docs = orient.featureDocs(root, "F-063");
  assert.deepEqual(docs.present, ["intent", "scope", "plan", "tests"]);
  assert.deepEqual(docs.missing, []);
  assert.match(orient.renderFeatureDocs(docs)[0], /present intent,scope,plan,tests · missing none/);
});

test("no active feature renders no doc line", () => {
  const root = fixture({ "f-063": { "intent.md": "# intent\n" } });
  assert.equal(orient.featureDocs(root, null), null);
  const o = orient.collectOrient({ root, git: () => null, readCheckpoint: () => null, query: () => [] });
  assert.equal(o.feature, null);
  assert.equal(o.featureDocs, null);
  assert.doesNotMatch(orient.printHuman(o), /^docs:/m);
  assert.doesNotMatch(orient.printBrief(o), /^docs:/m);
});
