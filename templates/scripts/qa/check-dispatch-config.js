#!/usr/bin/env node
"use strict";
/*
 * test:dispatch — opencode dispatch-config preflight (repo guard gate).
 *
 * Verifies every persona dispatch target is mechanically sound BEFORE work
 * starts, so a broken subagent config can never ship silently:
 *   1. Every `.opencode/agents/<name>.md` pins a `model:` that is a REAL
 *      provider model (frozen allowlist seeded from `opencode models`).
 *   2. Personas are 1:1: every `.agents/skills/<name>/SKILL.md` has a matching
 *      `.opencode/agents/<name>.md` and vice-versa (no path/skill drift).
 *   3. Every agent body carries the output-contract marker (Result / Evidence /
 *      Deferred & risks) so subagents return a consistent report shape.
 *   4. `opencode.json` main `model` + `small_model` are also real provider IDs.
 *   5. `.agents/memory/model-routing.md` does not name a concrete model that is
 *      no longer pinned by any agent or opencode.json (doc↔config drift).
 *
 * Allowlist refresh (only when the provider adds/removes models):
 *   npx opencode models > scripts/qa/models.allowlist.txt
 * Never edit agent `model:` without re-running this check.
 */
const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "..", "..");
const agentsDir = path.join(root, ".opencode", "agents");
const skillsDir = path.join(root, ".agents", "skills");
const allowlistFile = path.join(__dirname, "models.allowlist.txt");
const opencodeJson = path.join(root, "opencode.json");

const failures = [];
const warnings = [];
const pass = (m) => console.log("  \u2713 " + m);
const fail = (m) => {
  failures.push(m);
  console.log("  \u2717 " + m);
};
const warn = (m) => {
  warnings.push(m);
  console.log("  \u26a0 " + m);
};

if (!fs.existsSync(allowlistFile)) {
  console.error(
    "FATAL: missing allowlist. Generate it: `npx opencode models > scripts/qa/models.allowlist.txt`"
  );
  process.exit(2);
}
const allowlist = new Set(
  fs
    .readFileSync(allowlistFile, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
);

console.log("dispatch preflight \u2014 persona model pins vs provider allowlist");

function frontmatterModel(file) {
  const src = fs.readFileSync(file, "utf8");
  const m = src.match(/^---\r?\n([\s\S]*?)(?:\r?\n)?---\r?\n/m);
  if (!m) return null;
  const modelLine = m[1].split(/\r?\n/).find((l) => /^model:/i.test(l.trim()));
  if (!modelLine) return null;
  return modelLine.replace(/^model:\s*/i, "").trim();
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 1. every agent file exists, pins a real model, references a real skill
const agentModels = new Set();
const agentNames = fs
  .readdirSync(agentsDir)
  .filter((f) => f.endsWith(".md"))
  .sort();
if (agentNames.length === 0) fail(`no agents found in ${agentsDir}`);
for (const f of agentNames) {
  const name = f.replace(/\.md$/, "");
  const file = path.join(agentsDir, f);
  const model = frontmatterModel(file);
  if (model) agentModels.add(model);
  const body = fs.readFileSync(file, "utf8");
  const skillMd = path.join(skillsDir, name, "SKILL.md");
  if (!model) fail(`agent ${f}: missing frontmatter model: (all agents must pin a model)`);
  else if (!allowlist.has(model)) fail(`agent ${f}: model \`${model}\` NOT in provider allowlist`);
  else pass(`agent ${name}: model \`${model}\` is a real provider model`);
  if (!fs.existsSync(skillMd)) fail(`agent ${name}: referenced skill missing \`${path.relative(root, skillMd)}\``);
  if (!/return your final message in this exact order[\s\S]*Deferred & risks/i.test(body))
    fail(`agent ${name}: missing output-contract marker (Result -> Evidence -> Deferred & risks)`);
}

// 2. bidirectional parity: every skill dir has a matching agent file
const skillNames = fs
  .readdirSync(skillsDir)
  .filter((f) => fs.statSync(path.join(skillsDir, f)).isDirectory())
  .sort();
const agentSet = new Set(agentNames.map((f) => f.replace(/\.md$/, "")));
const skillSet = new Set(skillNames);
for (const s of skillNames) if (!agentSet.has(s)) fail(`skill ${s}: no matching .opencode/agents/${s}.md`);
for (const a of agentSet) if (!skillSet.has(a)) fail(`agent ${a}: no matching .agents/skills/${a}/SKILL.md`);
if (skillNames.join("|") === [...agentNames].map((f) => f.replace(/\.md$/, "")).sort().join("|"))
  pass(`persona parity: ${agentNames.length} agents == ${skillNames.length} skills`);

// 3. opencode.json main + small model are real provider IDs
const configModels = new Set();
if (fs.existsSync(opencodeJson)) {
  const cfg = JSON.parse(fs.readFileSync(opencodeJson, "utf8"));
  for (const key of ["model", "small_model"]) {
    const v = cfg[key];
    if (v) configModels.add(v);
    if (!v) warn(`opencode.json: no \`${key}\` set`);
    else if (allowlist.has(v)) pass(`opencode.json ${key} \`${v}\` is a real provider model`);
    else fail(`opencode.json ${key} \`${v}\` NOT in provider allowlist`);
  }
} else warn("opencode.json not found (skip)");

// 4. model-routing.md ↔ model: pin consistency (doc↔config drift)
const usedModels = new Set([...agentModels, ...configModels]);
const modelRoutingFile = path.join(root, ".agents", "memory", "model-routing.md");
if (fs.existsSync(modelRoutingFile)) {
  const doc = fs.readFileSync(modelRoutingFile, "utf8");
  const modelPattern = [...allowlist].map(escapeRe).join("|");
  const mentioned = new Set();
  const re = new RegExp(modelPattern, "g");
  let m;
  while ((m = re.exec(doc)) !== null) mentioned.add(m[0]);
  if (mentioned.size === 0) {
    pass("model-routing.md names no concrete model IDs (tier policy only) — nothing to cross-check");
  } else {
    for (const mid of mentioned) {
      if (usedModels.has(mid)) pass(`model-routing.md \`${mid}\` matches an actual pin`);
      else fail(`model-routing.md references \`${mid}\` but no agent/config pins it (doc↔config drift)`);
    }
  }
} else {
  warn("model-routing.md not found (skip doc↔config drift check)");
}

console.log(
  `\nRESULT: ${agentNames.length} agents checked \u2014 ` +
    (failures.length ? `${failures.length} FAILURE(S)` : "0 failures") +
    (warnings.length ? `, ${warnings.length} warning(s)` : "")
);
process.exit(failures.length ? 1 : 0);