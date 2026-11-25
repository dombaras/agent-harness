"use strict";
/*
 * Falsifier contract (F-040 WP3).
 *
 * The falsifier is the harness's independent attack on a diagnosis: a
 * read-only, architect-tier reviewer whose only output is the `## Falsification`
 * block the orchestrator appends. Its description is the decision contract the
 * main agent sees before choosing a subagent, so drift here means the reviewer is
 * never dispatched — or is dispatched to edit a diagnosis it was meant to attack.
 *
 * This guard pins the four description fields (trigger -> return -> skip ->
 * reads-only), the model pin, the deny-by-permission read-only scope, the skill's
 * input/output contract, and the unknown-cause routing that must pay
 * `test:diagnosis`.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  parsePersona,
  decide,
} = require("../templates/scripts/qa/dispatch-persona.js");
const { classify } = require("../templates/scripts/qa/dispatch-tier.js");

const root = path.resolve(__dirname, "..");
const personaPath = path.join(root, "templates", ".opencode", "agents", "falsifier.md");
const deployedPersonaPath = path.join(root, ".opencode", "agents", "falsifier.md");
const skillPath = path.join(root, "templates", ".agents", "skills", "falsifier", "SKILL.md");
const deployedSkillPath = path.join(root, ".agents", "skills", "falsifier", "SKILL.md");

const personaText = fs.readFileSync(personaPath, "utf8");
const persona = parsePersona(personaText);

test("falsifier persona parses with the architect-tier model pin", () => {
  assert.equal(persona.model, "opencode-go/deepseek-v4-pro#high");
  assert.equal(persona.mode, "subagent");
  assert.deepEqual(persona.writes, [], "Reads only means no declared write globs");
});

test("falsifier is read-only: reads allowed, edit and shell denied", () => {
  assert.equal(decide(persona.permissions, "read", "any/file.md"), "allow");
  assert.equal(decide(persona.permissions, "edit", "any/file.md"), "deny");
  assert.equal(decide(persona.permissions, "shell", "npm test"), "deny");
  assert.ok(
    !persona.permissions.some((p) => p.action === "edit" && p.effect === "allow"),
    "no edit allow rule may exist"
  );
});

test("description carries trigger -> return -> skip -> reads-only", () => {
  const d = persona.description;
  assert.match(d, /^Use when a diagnosis or high-risk belief must be challenged before code changes/i);
  assert.match(d, /returns a ## Falsification block/i);
  assert.match(d, /strongest alternative/i);
  assert.match(d, /discriminating test/i);
  assert.match(d, /outcome/i);
  assert.match(d, /residual uncertainty/i);
  assert.match(d, /Skip when the cause is already proven by a failing test/i);
  assert.match(d, /Reads only\.$/);
});

test("the persona returns only the Falsification block and never edits the diagnosis", () => {
  assert.match(personaText, /Return ONLY the `## Falsification` block/);
  assert.match(personaText, /Never edit the diagnosis/);
  assert.match(personaText, /at least one alternative cause/i);
  assert.match(personaText, /refute/i);
});

test("falsifier skill documents the input contract, the <=15-line output contract, and the no-alternative rule", () => {
  assert.ok(fs.existsSync(skillPath), `${skillPath} exists`);
  const skill = fs.readFileSync(skillPath, "utf8");
  assert.match(skill, /^---\r?\nname: falsifier/m);
  assert.match(skill, /## Input contract/);
  assert.match(skill, /Diagnosis path/i);
  assert.match(skill, /Evidence pointers/i);
  assert.match(skill, /Proposed fix/i);
  assert.match(skill, /Write scope/i);
  assert.match(skill, /## Output contract/);
  assert.match(skill, /at most 15 lines/i);
  assert.match(skill, /no\s+alternative/i);
  assert.match(skill, /mark confidence/i);
});

test("the deployed copies match the templates (no hand-edited drift)", () => {
  assert.equal(fs.readFileSync(deployedPersonaPath, "utf8"), personaText);
  assert.equal(fs.readFileSync(deployedSkillPath, "utf8"), fs.readFileSync(skillPath, "utf8"));
});

test("unknown-cause work is at least T2 and pays test:diagnosis", () => {
  const r = classify({ objective: "unknown cause: X", files: ["app/x.ts"] });
  assert.equal(r.tier, 2);
  assert.equal(r.label, "T2");
  assert.equal(r.unknownCause, true);
  assert.equal(r.execution, "dispatch");
  assert.ok(r.gates.includes("test:diagnosis"), "the diagnosis gate must be in the gate list");
});

test("the unknown-cause vocabulary routes investigate/why/regression/diagnose", () => {
  for (const objective of [
    "investigate the empty export",
    "why does the widget vanish",
    "root cause of the regression",
    "diagnose the intermittent failure",
  ]) {
    const r = classify({ objective, files: ["app/x.ts"] });
    assert.equal(r.tier, 2, objective);
    assert.ok(r.gates.includes("test:diagnosis"), objective);
  }
});

test("a known single-file change keeps its classification and pays no diagnosis gate", () => {
  const r = classify({ objective: "rename the timeout constant", files: ["app/config.ts"] });
  assert.equal(r.tier, 0);
  assert.equal(r.unknownCause, false);
  assert.ok(!r.gates.includes("test:diagnosis"));
});
