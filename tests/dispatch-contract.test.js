"use strict";
/*
 * Dispatch-contract drift guard (F-024 S1).
 *
 * The `description:` line of every persona is what the main agent sees in the
 * `subagent` tool schema at the moment it chooses whether to delegate, so it is
 * a decision contract, not a label:
 *
 *   Use when <concrete trigger> — returns <artifact>. Skip for <anti-trigger>.
 *   Writes: <path globs>.            (or: Reads only; runs tiers.)
 *
 * This guard fails when a persona loses one of the three decision fields, grows
 * past the schema-cost budget, drops the output-contract marker from its body,
 * or drifts between `templates/.opencode/agents/` (source) and
 * `.opencode/agents/` (the harness repo's deployed copy).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const templateDir = path.join(root, "templates", ".opencode", "agents");
const deployedDir = path.join(root, ".opencode", "agents");

// Keep the schema cost bounded: 16 descriptions are billed on every main request.
const MAX_DESCRIPTION_CHARS = 240;
/* The falsifier's contract names four mandatory fields plus the trigger, skip and
 * reads-only clause; its sanctioned description is 260 chars. Every other
 * persona stays inside the default budget. */
const DESCRIPTION_BUDGET = { falsifier: 280 };
const OUTPUT_CONTRACT =
  /return your final message in this exact order[\s\S]*Deferred & risks/i;
/* A read-only reviewer's whole output is its artifact block (the falsifier's
 * `## Falsification`), which the orchestrator appends verbatim. */
const ARTIFACT_CONTRACT = /Return ONLY the `## [A-Z][^`\n]+` block/;

function frontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match ? match[1] : "";
}

function descriptionOf(text) {
  const raw = frontmatter(text).match(/^description:[ \t]*(.+)$/m);
  if (!raw) return null;
  const value = raw[1].trim();
  const quoted =
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"));
  return quoted ? value.slice(1, -1) : value;
}

function contractErrors(description, max = MAX_DESCRIPTION_CHARS) {
  const errors = [];
  if (!description) return ["missing description"];
  if (!/^Use when /i.test(description))
    errors.push("must start with 'Use when'");
  if (!/Writes:|Reads only/.test(description))
    errors.push("must declare 'Writes:' or 'Reads only'");
  if (description.length > max)
    errors.push(
      `too long (${description.length} > ${max} chars)`
    );
  if (/\r?\n/.test(description)) errors.push("must be a single line");
  return errors;
}

function personas(dir) {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort();
}

test("every persona description is a decision contract", () => {
  const names = personas(templateDir);
  assert.ok(names.length > 0, "no persona files found");
  const failures = [];
  for (const name of names) {
    const text = fs.readFileSync(path.join(templateDir, name), "utf8");
    const errors = contractErrors(
      descriptionOf(text),
      DESCRIPTION_BUDGET[name.replace(/\.md$/, "")] || MAX_DESCRIPTION_CHARS
    );
    if (errors.length) failures.push(`${name}: ${errors.join("; ")}`);
  }
  assert.deepEqual(failures, []);
});

test("the persona set is complete and matches the deployed copy", () => {
  assert.equal(personas(templateDir).length, 16);
  assert.deepEqual(personas(deployedDir), personas(templateDir));
});

test("deployed descriptions never drift from the template", () => {
  const drifted = [];
  for (const name of personas(templateDir)) {
    const template = descriptionOf(
      fs.readFileSync(path.join(templateDir, name), "utf8")
    );
    const deployed = descriptionOf(
      fs.readFileSync(path.join(deployedDir, name), "utf8")
    );
    if (deployed !== template) drifted.push(name);
  }
  assert.deepEqual(drifted, []);
});

test("every persona body keeps an output contract (standard recap or declared artifact block)", () => {
  const missing = personas(templateDir).filter((name) => {
    const body = fs.readFileSync(path.join(templateDir, name), "utf8");
    return !OUTPUT_CONTRACT.test(body) && !ARTIFACT_CONTRACT.test(body);
  });
  assert.deepEqual(missing, []);
});

test("the artifact output contract is accepted but an undeclared body is not (negative fixture)", () => {
  assert.ok(ARTIFACT_CONTRACT.test("Return ONLY the `## Falsification` block (at most 15 lines):"));
  assert.ok(!ARTIFACT_CONTRACT.test("Your final message can be a summary."));
  assert.ok(!OUTPUT_CONTRACT.test("Your final message can be a summary."));
});

test("the validator rejects a non-contract description (negative fixture)", () => {
  assert.deepEqual(
    contractErrors(
      "Use when X changes — returns Y. Skip for Z. Writes: `a/**`."
    ),
    []
  );
  assert.notDeepEqual(contractErrors("Use to help with things."), []);
  assert.notDeepEqual(contractErrors("Use when X changes — returns Y."), []);
  assert.notDeepEqual(
    contractErrors(`Use when X — returns Y. Writes: a. ${"x".repeat(300)}`),
    []
  );
});
