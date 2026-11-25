"use strict";
/*
 * The inquiry loop's artifact contract (F-040).
 *
 * The gate is only as trustworthy as its rejection matrix: a diagnosis that
 * parses but never compares alternatives would re-create the "ritual file"
 * failure the capability review found. Each malformed fixture below is a class
 * seen in real sessions (one candidate, no discriminating test, no ruled-out
 * cause, a copied diagnosis, placeholder cells).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const lib = require("../templates/scripts/qa/diagnosis-lib.js");
const scaffold = require("../templates/scripts/qa/feature-scaffold.js");

const DIAGNOSIS = `# F-100 — diagnosis

status: confirmed
symptom: stale-badge
confidence: high
owner: main
falsifier: falsifier

## Observed vs expected

- Observed: restart badge shows the old build
- Expected: badge follows the running pid

## Evidence

| # | Evidence | Source (file:line / command / log) | Supports |
|---|---|---|---|
| 1 | pid 535837 runs the Nov-24 build | .serve/badge.log:4 | candidate 1 |

## Candidate causes

| # | Cause | Likelihood | Discriminating test | Result |
|---|---|---|---|---|
| 1 | cache never invalidated | high | restart then read pid | confirmed |
| 2 | clock skew | low | compare timestamps | refuted |

## Ruled out

| Cause | Why ruled out | Evidence |
|---|---|---|
| clock skew | both timestamps agree | .serve/badge.log:9 |

## Falsification

- Reviewer: falsifier
- Strongest alternative: cache invalidation is skipped
- Test that separates it: restart and read the pid
- Outcome: candidate 1 confirmed
- Residual uncertainty: none

## Outcome oracle

- Before (red): badge shows Nov-24
- After (green): badge shows the new pid
- Command / observation: node scripts/orient.js
- Environment / surface: local CLI
- Independent owner: qa

## Open questions

- none
`;

function meta(over = {}) {
  return { id: "F-100", kind: "bug", risk: "high", requiresDiagnosis: true, ...over };
}

function validate(text, over) {
  return lib.validateDiagnosis({ meta: meta(over), diagnosisText: text, id: "F-100" });
}

test("legacy feature (no meta) is not required and never fails", () => {
  const v = lib.validateDiagnosis({ meta: null, diagnosisText: "", id: "F-001" });
  assert.equal(v.ok, true);
  assert.equal(v.required, false);
  assert.equal(v.legacy, true);
});

test("kind feature/investigate/ops does not require a diagnosis", () => {
  for (const kind of ["feature", "investigate", "ops"]) {
    const v = lib.validateDiagnosis({ meta: { id: "F-1", kind }, diagnosisText: "", id: "F-1" });
    assert.equal(v.ok, true, kind);
    assert.equal(v.required, false, kind);
  }
});

test("an explicit requiresDiagnosis:false overrides a bug kind", () => {
  const v = validate("", { requiresDiagnosis: false });
  assert.equal(v.ok, true);
  assert.equal(v.required, false);
});

test("bug with no diagnosis fails with the exact path hint", () => {
  const v = validate("");
  assert.equal(v.ok, false);
  assert.match(v.errors[0].message, /no diagnosis\.md/);
  assert.match(v.errors[0].message, /\.agents\/features\/<slug>\/diagnosis\.md/);
});

test("a complete confirmed diagnosis passes and reports status/confidence", () => {
  const v = validate(DIAGNOSIS);
  assert.deepEqual(v.errors, []);
  assert.equal(v.ok, true);
  assert.equal(v.status, "confirmed");
  assert.equal(v.confidence, "high");
  assert.equal(v.symptom, "stale-badge");
});

test("fewer than two candidates fails", () => {
  const text = DIAGNOSIS.replace(
    "| 2 | clock skew | low | compare timestamps | refuted |\n",
    ""
  );
  const v = validate(text);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /at least 2 candidates/.test(e.message)));
});

test("a candidate with no discriminating test fails", () => {
  const text = DIAGNOSIS.replace("| 2 | clock skew | low | compare timestamps | refuted |", "| 2 | clock skew | low |  | refuted |");
  const v = validate(text);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /candidate #2 has no discriminating test/.test(e.message)));
});

test("a confirmed diagnosis with no ruled-out cause fails", () => {
  const text = DIAGNOSIS.replace("| clock skew | both timestamps agree | .serve/badge.log:9 |\n", "");
  const v = validate(text);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /no ruled-out cause/.test(e.message)));
});

test("status=open needs a written reason when nothing is ruled out", () => {
  const open = DIAGNOSIS.replace("status: confirmed", "status: open")
    .replace("| clock skew | both timestamps agree | .serve/badge.log:9 |", "")
    .replace(/## Ruled out\n\n\| Cause \| Why ruled out \| Evidence \|\n\|---\|---\|---\|\n/, "## Ruled out\n\nNothing ruled out yet — the restart has not run twice.\n");
  const v = validate(open);
  assert.ok(v.errors.some((e) => /status=confirmed/.test(e.message) || /ruled out/.test(e.message)) === false || v.ok === false);
  assert.equal(v.errors.some((e) => e.code === "ruled-out"), false, JSON.stringify(v.errors));
});

test("confirmed without a falsification block fails", () => {
  const text = DIAGNOSIS.replace(/## Falsification[\s\S]*?## Outcome oracle/, "## Outcome oracle");
  const v = validate(text);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /Falsification/.test(e.message)));
});

test("confirmed without before/after/command in the oracle fails", () => {
  const text = DIAGNOSIS.replace("- After (green): badge shows the new pid\n", "");
  const v = validate(text);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /Outcome oracle|after \(green\)/i.test(e.message)));
});

test("confirmed needs exactly one candidate marked confirmed", () => {
  const text = DIAGNOSIS.replace("| 2 | clock skew | low | compare timestamps | refuted |", "| 2 | clock skew | low | compare timestamps | confirmed |");
  const v = validate(text);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /exactly one candidate/.test(e.message)));
});

test("a diagnosis copied from another feature fails on the heading", () => {
  const v = validate(DIAGNOSIS.replace("# F-100 — diagnosis", "# F-099 — diagnosis"));
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === "wrong-feature"));
});

test("a symptom that disagrees with meta.json fails", () => {
  const v = validate(DIAGNOSIS, { symptom: "stale-restart-badge" });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === "symptom-mismatch"));
});

test("placeholder table cells are rejected", () => {
  const text = DIAGNOSIS.replace("| clock skew | both timestamps agree | .serve/badge.log:9 |", "| ? | ? | ? |");
  const v = validate(text);
  assert.equal(v.ok, false);
});

test("scaffold --kind bug writes meta.json + diagnosis.md; feature writes no diagnosis", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "diagnosis-scaffold-"));
  const bug = scaffold.scaffold(root, { id: "F-100", slug: "f-100-bug", title: "Bug", risk: "high", kind: "bug" });
  assert.ok(bug.written.some((f) => f.endsWith("meta.json")));
  assert.ok(bug.written.some((f) => f.endsWith("diagnosis.md")));
  const m = JSON.parse(fs.readFileSync(path.join(root, ".agents/features/f-100-bug/meta.json"), "utf8"));
  assert.equal(m.kind, "bug");
  assert.equal(m.requiresDiagnosis, true);

  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "diagnosis-scaffold-"));
  const feature = scaffold.scaffold(root2, { id: "F-101", slug: "f-101-feature", title: "Feature", risk: "low", kind: "feature" });
  assert.ok(feature.written.some((f) => f.endsWith("meta.json")));
  assert.equal(feature.written.some((f) => f.endsWith("diagnosis.md")), false);
});

test("the scaffolded bug diagnosis is rejected until an investigator fills it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "diagnosis-stub-"));
  scaffold.scaffold(root, { id: "F-102", slug: "f-102-bug", title: "Bug", risk: "high", kind: "bug", symptom: "stale-badge" });
  const text = fs.readFileSync(path.join(root, ".agents/features/f-102-bug/diagnosis.md"), "utf8");
  const metaDoc = JSON.parse(fs.readFileSync(path.join(root, ".agents/features/f-102-bug/meta.json"), "utf8"));
  const v = lib.validateDiagnosis({ meta: metaDoc, diagnosisText: text, id: "F-102" });
  assert.equal(v.ok, false);
});

test("check-diagnosis exits 1 for a missing bug diagnosis and 0 in warn mode", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "diagnosis-gate-"));
  fs.mkdirSync(path.join(root, ".agents/features/f-200-bug"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agents/features/f-200-bug/meta.json"), JSON.stringify({ id: "F-200", kind: "bug" }));
  const script = path.join(__dirname, "..", "templates/scripts/qa/check-diagnosis.js");

  const enforce = spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });
  assert.equal(enforce.status, 1, enforce.stdout + enforce.stderr);
  assert.match(enforce.stdout, /F-200 diagnosis: has no diagnosis\.md/);

  const warn = spawnSync(process.execPath, [script, "--root", root, "--warn"], { encoding: "utf8" });
  assert.equal(warn.status, 0, warn.stdout + warn.stderr);

  const json = spawnSync(process.execPath, [script, "--root", root, "--json"], { encoding: "utf8" });
  const doc = JSON.parse(json.stdout);
  assert.equal(doc.schema, "diagnosis/1");
  assert.equal(doc.features[0].required, true);
  assert.equal(doc.failures.length, 1);
});

test("check-diagnosis passes a complete bug diagnosis and ignores legacy features", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "diagnosis-gate-"));
  const dir = path.join(root, ".agents/features/f-100-badge");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta()));
  fs.writeFileSync(path.join(dir, "diagnosis.md"), DIAGNOSIS);
  fs.mkdirSync(path.join(root, ".agents/features/f-001-legacy"), { recursive: true });
  const script = path.join(__dirname, "..", "templates/scripts/qa/check-diagnosis.js");
  const res = spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /F-100: diagnosis confirmed/);
  assert.match(res.stdout, /f-001-legacy: legacy feature/);
});
