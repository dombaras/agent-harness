"use strict";
/*
 * Diagnosis visibility in orient/checkpoint (F-040/WP5).
 *
 * A gate that only fails at finalize is discovered too late: the session-start
 * surfaces must show the active feature's diagnosis state, the exact next
 * action, and a staleness verdict when HEAD moved. Both tools are read-only on
 * the artifact — a stale conclusion is reported, never rewritten.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const orient = require("../templates/scripts/orient.js");

const CHECKPOINT = path.join(__dirname, "..", "templates", "scripts", "checkpoint.js");

const DIAGNOSIS = `# F-100 — diagnosis

status: confirmed
symptom: stale-badge
confidence: high
owner: main
falsifier: falsifier
head: bbb2222

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

const META = { id: "F-100", kind: "bug", risk: "high", requiresDiagnosis: true };

function fixture({ diagnosis = DIAGNOSIS, meta = META } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orient-diagnosis-"));
  const dir = path.join(root, ".agents", "features", "f-100-bug");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta));
  if (diagnosis != null) fs.writeFileSync(path.join(dir, "diagnosis.md"), diagnosis);
  return { root, dir, diagnosisPath: path.join(dir, "diagnosis.md") };
}

function gitStub(head = "bbb2222") {
  const map = {
    "rev-parse --abbrev-ref HEAD": "f-100-bug",
    "rev-parse --short HEAD": head,
    "status --porcelain": "",
  };
  return (args) => {
    const key = args.join(" ");
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
  };
}

function collect(root, head) {
  return orient.collectOrient({
    root,
    feature: "F-100",
    git: gitStub(head),
    readCheckpoint: () => {
      throw new Error("no checkpoint in the fixture");
    },
    query: () => [],
  });
}

test("orient reports a valid required diagnosis with status, confidence, falsifier and oracle", () => {
  const { root } = fixture();
  const o = collect(root);
  assert.equal(o.feature, "F-100");
  assert.ok(o.diagnosis, "diagnosis block present");
  assert.equal(o.diagnosis.id, "F-100");
  assert.equal(o.diagnosis.kind, "bug");
  assert.equal(o.diagnosis.required, true);
  assert.equal(o.diagnosis.ok, true);
  assert.equal(o.diagnosis.status, "confirmed");
  assert.equal(o.diagnosis.confidence, "high");
  assert.equal(o.diagnosis.stale, null);
  assert.equal(o.diagnosis.action, null);
  assert.deepEqual(o.diagnosis.errors, []);

  const human = orient.printHuman(o);
  assert.match(human, /ckpt:.*\n.*diagnosis: confirmed \(high\) · falsifier: yes · oracle: recorded/);
  assert.match(orient.printBrief(o), /diagnosis: confirmed \(high\) · falsifier: yes · oracle: recorded/);
});

test("orient reports a missing required diagnosis as a blocker with the /diagnose action", () => {
  const { root } = fixture({ diagnosis: null });
  const o = collect(root);
  assert.equal(o.diagnosis.required, true);
  assert.equal(o.diagnosis.ok, false);
  assert.equal(o.diagnosis.status, null);
  assert.match(o.diagnosis.action, /\/diagnose/);
  assert.match(o.diagnosis.errors[0].message, /no diagnosis\.md/);
  assert.match(orient.printHuman(o), /diagnosis: MISSING \(kind=bug\) — run \/diagnose before editing/);
});

test("orient surfaces the first concrete defect for an invalid diagnosis", () => {
  const { root } = fixture({ diagnosis: DIAGNOSIS.replace("| 2 | clock skew | low | compare timestamps | refuted |", "| 2 | clock skew | low |  | refuted |") });
  const o = collect(root);
  assert.equal(o.diagnosis.required, true);
  assert.equal(o.diagnosis.ok, false);
  assert.match(o.diagnosis.action, /candidate #2 has no discriminating test/);
  assert.match(orient.printHuman(o), /diagnosis: INVALID \(kind=bug\) — .*candidate #2 has no discriminating test/);
});

test("orient marks a diagnosis stale when the recorded HEAD differs from the current one", () => {
  const { root } = fixture();
  const o = collect(root, "ccc3333");
  assert.match(o.diagnosis.stale, /HEAD bbb2222/);
  assert.match(o.diagnosis.stale, /now ccc3333/);
  assert.match(
    orient.printHuman(o),
    /diagnosis: confirmed \(high\) · falsifier: yes · oracle: recorded · STALE: diagnosis was proven at HEAD bbb2222, now ccc3333/
  );
});

test("orient says a feature-kind diagnosis is not required", () => {
  const { root } = fixture({ meta: { id: "F-100", kind: "feature", risk: "low" }, diagnosis: null });
  const o = collect(root);
  assert.equal(o.diagnosis.required, false);
  assert.equal(o.diagnosis.ok, true);
  assert.match(orient.printHuman(o), /diagnosis: not required \(kind=feature\)/);
});

test("orient leaves diagnosis null when no feature is active", () => {
  const { root } = fixture();
  const o = orient.collectOrient({ root, git: () => null, run: () => null, readCheckpoint: () => null });
  assert.equal(o.feature, null);
  assert.equal(o.diagnosis, null);
});

test("orient never mutates the diagnosis artifact", () => {
  const { root, diagnosisPath } = fixture();
  const before = fs.readFileSync(diagnosisPath, "utf8");
  collect(root, "ccc3333");
  assert.equal(fs.readFileSync(diagnosisPath, "utf8"), before);
});

function git(root, args) {
  return spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

function commitFixture(root) {
  const init = git(root, ["init", "-q"]);
  assert.equal(init.status, 0, init.stderr);
  const add = git(root, ["add", "-A"]);
  assert.equal(add.status, 0, add.stderr);
  const commit = git(root, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "-q",
    "-m",
    "fixture",
  ]);
  assert.equal(commit.status, 0, commit.stderr);
  const head = git(root, ["rev-parse", "--short", "HEAD"]);
  assert.equal(head.status, 0, head.stderr);
  return head.stdout.trim();
}

function resume(root, json = true) {
  const args = [CHECKPOINT, "resume", "--feature", "F-100", "--root", root];
  if (json) args.push("--json");
  return spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
}

test("checkpoint resume carries diagnosis status, staleness and up to 3 open questions", () => {
  const { root, diagnosisPath } = fixture({ diagnosis: null });
  const head = commitFixture(root);

  const diagnosis = DIAGNOSIS.replace("head: bbb2222", `head: ${head}`).replace(
    "- none",
    [
      "- is the badge cached in the pid file?",
      "- does a cold start reuse the old build?",
      "- is the system clock skewed?",
      "- a fourth question that must stay out of the brief",
    ].join("\n")
  );
  fs.writeFileSync(diagnosisPath, diagnosis);

  const write = spawnSync(
    process.execPath,
    [
      CHECKPOINT,
      "write",
      "--feature",
      "F-100",
      "--root",
      root,
      "--objective",
      "fixture",
      "--phase",
      "test",
      "--next-action",
      "continue",
    ],
    { cwd: root, encoding: "utf8" }
  );
  assert.equal(write.status, 0, write.stderr);

  const fresh = resume(root);
  assert.equal(fresh.status, 0, fresh.stderr);
  const freshDoc = JSON.parse(fresh.stdout);
  assert.equal(freshDoc.diagnosis.status, "confirmed");
  assert.equal(freshDoc.diagnosis.confidence, "high");
  assert.equal(freshDoc.diagnosis.stale, null);
  assert.deepEqual(freshDoc.diagnosis.questions, [
    "is the badge cached in the pid file?",
    "does a cold start reuse the old build?",
    "is the system clock skewed?",
  ]);

  // A moved HEAD makes the recorded conclusion stale — resume says so.
  const other = head === "0000000" ? "1111111" : "0000000";
  fs.writeFileSync(diagnosisPath, diagnosis.replace(`head: ${head}`, `head: ${other}`));
  const moved = resume(root);
  assert.equal(moved.status, 0, moved.stderr);
  const movedDoc = JSON.parse(moved.stdout);
  assert.match(movedDoc.diagnosis.stale, new RegExp(`HEAD ${other}`));
  assert.match(movedDoc.diagnosis.stale, new RegExp(`now ${head}`));

  const brief = resume(root, false);
  assert.equal(brief.status, 0, brief.stderr);
  assert.match(brief.stdout, /diagnosis: confirmed \(high\)/);
  assert.match(brief.stdout, /stale: diagnosis was proven at HEAD/);
  assert.match(brief.stdout, /open question: is the badge cached in the pid file\?/);
  assert.doesNotMatch(brief.stdout, /fourth question/);

  // Resume is read-only on the artifact, like orient.
  assert.equal(fs.readFileSync(diagnosisPath, "utf8"), diagnosis.replace(`head: ${head}`, `head: ${other}`));
});
