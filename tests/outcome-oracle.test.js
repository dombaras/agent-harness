"use strict";
/*
 * Outcome-oracle gate (F-040 / WP4).
 *
 * A declared bug/incident/fix may not be "done" on a unit assertion alone: its
 * QA plan must record the reported symptom, the before-red and after-green
 * observation on the real surface, the command, the environment and an owner.
 * The gate runs even with a clean diff, so an empty push cannot bypass it.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SOURCE = path.join(__dirname, "..", "templates", "scripts", "qa");

function fixture({ kind, oracle, plan = true }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "outcome-oracle-"));
  fs.mkdirSync(path.join(root, "scripts", "qa"), { recursive: true });
  fs.copyFileSync(path.join(SOURCE, "check-qa-plan.js"), path.join(root, "scripts/qa/check-qa-plan.js"));
  fs.copyFileSync(path.join(SOURCE, "diagnosis-lib.js"), path.join(root, "scripts/qa/diagnosis-lib.js"));
  fs.mkdirSync(path.join(root, ".agents", "features", "f-100-x"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agents/features/f-100-x/meta.json"), JSON.stringify({ id: "F-100", kind }));
  fs.mkdirSync(path.join(root, ".agents", "qa-plans"), { recursive: true });
  if (plan) {
    fs.writeFileSync(
      path.join(root, ".agents/qa-plans/F-100.md"),
      "# QA plan — F-100\n\n## Coverage map\n\n| a | b |\n|--|--|\n" + (oracle || "")
    );
  }
  spawnSync("git", ["init", "-q", "."], { cwd: root });
  spawnSync("git", ["add", "-A"], { cwd: root });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: root });
  return root;
}

function run(root) {
  return spawnSync(process.execPath, ["scripts/qa/check-qa-plan.js", "--base", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
}

const FULL = `\n## Outcome oracle\n\n- Reported symptom: stale badge\n- Before (red): old build shown\n- After (green): new build shown\n- Command / observation: node scripts/orient.js\n- Environment / surface: CLI\n- Independent owner: qa\n`;

test("bug feature with no oracle fails even with a clean diff", () => {
  const res = run(fixture({ kind: "bug" }));
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stdout, /Outcome oracle/);
  assert.match(res.stdout, /F-100 QA plan/);
});

test("bug feature with every oracle label passes", () => {
  const res = run(fixture({ kind: "bug", oracle: FULL }));
  assert.equal(res.status, 0, res.stdout + res.stderr);
});

test("a partially filled oracle names the missing label", () => {
  const partial = FULL.replace("- After (green): new build shown\n", "");
  const res = run(fixture({ kind: "bug", oracle: partial }));
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stdout, /After \(green\)/);
});

test("feature kind is exempt from the oracle requirement", () => {
  const res = run(fixture({ kind: "feature" }));
  assert.equal(res.status, 0, res.stdout + res.stderr);
});

test("a missing QA plan is named explicitly for a bug", () => {
  const res = run(fixture({ kind: "incident", plan: false }));
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stdout, /missing \.agents\/qa-plans\/F-100\.md/);
});
