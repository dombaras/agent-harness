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
 *   3. Every agent body carries an output contract: the standard recap
 *      (Result / Evidence / Deferred & risks), or a declared artifact block for a
 *      read-only reviewer (`Return ONLY the `## <Block>` block`, e.g. the
 *      falsifier's `## Falsification`), so subagents return a consistent shape.
 *   4. `opencode.json` main `model` + `agents.title.model` (the small-model pin)
 *      and every `agents.<name>.model` override (e.g. the opportunistic
 *      `explore` pin) are real provider IDs.
 *   5. `.agents/memory/model-routing.md` does not name a concrete model that is
 *      no longer pinned by any agent or opencode.json (doc↔config drift) —
 *      except IDs declared on a machine-readable `opportunistic_models:` /
 *      `escalation_models:` / `fallback_models:` line (legal targets,
 *      deliberately unpinned).
 *   6. Every bash-enabled editor carries the working-tree gate (verify
 *      `git rev-parse --show-toplevel` + branch before editing) so a subagent
 *      can never silently edit the wrong checkout/worktree.
 *
 * Allowlist refresh (only when the provider adds/removes models):
 *   npx opencode models > scripts/qa/models.allowlist.txt
 * then DELETE every `opencode/*` (Zen pay-as-you-go) line — the routing policy
 * is OpenCode Go (`opencode-go/*`) + DeepSeek direct (`deepseek/*`) only, and
 * this gate fails if a Zen line is present. Never edit agent `model:` without
 * re-running this check.
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

// 0. no Zen pay-as-you-go targets: the policy is OpenCode Go + DeepSeek direct
// only, so `opencode/*` must never be an allowed pin (a regenerated allowlist
// re-adds it — delete those lines, don't relax the policy).
const zenLines = [...allowlist].filter((m) => /^opencode\//.test(m));
if (zenLines.length) {
  fail(
    `allowlist has ${zenLines.length} Zen pay-as-you-go model(s) (${zenLines.slice(0, 3).join(", ")}${zenLines.length > 3 ? ", ..." : ""}) — ` +
      "policy is opencode-go/* + deepseek/* only; remove them"
  );
}

/* Most personas close with the standard receipt. A read-only reviewer instead
 * returns its artifact: the falsifier's whole output is the block the
 * orchestrator appends, so "Return ONLY the `## Falsification` block" is its
 * contract (F-040). Both are accepted; a body with neither still fails. */
const OUTPUT_CONTRACT = /return your final message in this exact order[\s\S]*Deferred & risks/i;
const ARTIFACT_CONTRACT = /Return ONLY the `## [A-Z][^`\n]+` block/;

function frontmatterModelRaw(file) {
  const src = fs.readFileSync(file, "utf8");
  const m = src.match(/^---\r?\n([\s\S]*?)(?:\r?\n)?---\r?\n/m);
  if (!m) return null;
  const modelLine = m[1].split(/\r?\n/).find((l) => /^model:/i.test(l.trim()));
  return modelLine ? modelLine.replace(/^model:\s*/i, "").trim() : null;
}

function frontmatterModel(file) {
  const raw = frontmatterModelRaw(file);
  // Native V2 pins join the variant to the model (`provider/model#variant`); the
  // provider allowlist holds base IDs, so strip any `#variant` before matching.
  return raw ? raw.replace(/#.*$/, "") : null;
}

/* The agent's `mode:` frontmatter (primary | subagent | all). A new custom agent
 * defaults to `primary`; every harness persona is `subagent`. */
function frontmatterMode(file) {
  const src = fs.readFileSync(file, "utf8");
  const m = src.match(/^---\r?\n([\s\S]*?)(?:\r?\n)?---\r?\n/m);
  if (!m) return null;
  const line = m[1].split(/\r?\n/).find((l) => /^mode:/i.test(l.trim()));
  return line ? line.replace(/^mode:\s*/i, "").trim().toLowerCase() : null;
}

/* Does a `provider/model#variant` pin actually take effect? Only on a
 * `mode: subagent` agent's `model:` (frontmatter). A `#variant` on the PRIMARY
 * session — the root `model` or `agents.<primary>.model` (`build`/`plan`) — is
 * inert (opencode 2.0.31, verified 2026-10-17 by live probe: root `…#high` and
 * `agents.build.model=…#high` both recorded `variant:"default"`, while an
 * explicit session model — `-m provider/model#variant`/the TUI picker — and a
 * subagent's `…#low` were preserved). So a `#variant` on a non-subagent is
 * inert config that reads like enforcement. */
function variantApplies(mode) {
  return mode === "subagent";
}

/* Parse the agent's native V2 `permissions:` list from the frontmatter into
 * `{ action, resource, effect }` entries (order preserved). */
function frontmatterPermissions(file) {
  const src = fs.readFileSync(file, "utf8");
  const m = src.match(/^---\r?\n([\s\S]*?)(?:\r?\n)?---\r?\n/m);
  if (!m) return [];
  const lines = m[1].split(/\r?\n/);
  const perms = [];
  let inPerm = false;
  let cur = null;
  for (const raw of lines) {
    const indent = raw.length - raw.trimStart().length;
    const t = raw.trim();
    if (/^permissions:\s*$/.test(t)) {
      inPerm = true;
      continue;
    }
    if (!inPerm) continue;
    if (indent === 0 && t) break;
    if (/^-\s+action:/.test(t)) {
      cur = { action: t.replace(/^-\s+action:\s*/, "").trim(), resource: "", effect: "" };
      perms.push(cur);
      continue;
    }
    if (!cur) continue;
    let mm;
    if ((mm = t.match(/^resource:\s*(.+)$/))) cur.resource = mm[1].trim();
    else if ((mm = t.match(/^effect:\s*(.+)$/))) cur.effect = mm[1].trim();
  }
  return perms;
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
  if (!OUTPUT_CONTRACT.test(body) && !ARTIFACT_CONTRACT.test(body))
    fail(`agent ${name}: missing output contract (Result -> Evidence -> Deferred & risks, or a declared "Return ONLY the \`## <Block>\` block")`);
  const canBash = frontmatterPermissions(file).some((p) => p.action === "shell" && p.effect === "allow");
  if (canBash && !/git rev-parse --show-toplevel/.test(body))
    fail(`agent ${name}: shell-enabled editor missing the working-tree gate (verify \`git rev-parse --show-toplevel\` + branch before editing)`);
  // A `#variant` on a NON-subagent (primary) agent is inert in V2: the session
  // stores its own model and drops the agent variant (verified 2026-10-17).
  const rawModel = frontmatterModelRaw(file);
  const mode = frontmatterMode(file);
  if (rawModel && rawModel.includes("#") && !variantApplies(mode))
    fail(
      `agent ${name}: model variant \`${rawModel}\` does NOT apply — mode is \`${mode || "primary"}\`, ` +
        "and opencode V2 ignores a variant on a primary agent's model (the session model is separate). " +
        "Pin variants on `mode: subagent` agents only, or drop the variant."
    );
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

// 3. opencode.json main model + every `agents.<name>.model` override (the V2
// small-model pin lives on the built-in `title` agent; `explore` is the
// opportunistic pin) are real provider IDs.
const configModels = new Set();
if (fs.existsSync(opencodeJson)) {
  const cfg = JSON.parse(fs.readFileSync(opencodeJson, "utf8"));
  const checkModel = (label, raw) => {
    // Strip any `#variant` so the base ID is checked against the allowlist.
    const v = raw ? String(raw).replace(/#.*$/, "") : raw;
    if (!v) {
      warn(`opencode.json: no \`${label}\` set`);
      return;
    }
    configModels.add(v);
    if (allowlist.has(v)) pass(`opencode.json ${label} \`${v}\` is a real provider model`);
    else fail(`opencode.json ${label} \`${v}\` NOT in provider allowlist`);
  };
  checkModel("model", cfg.model);
  // A `#variant` on the root `model` is inert too: opencode drops it for the
  // primary session (verified 2026-10-17 — `model: …#high` recorded `default`).
  // Effort for the main session can only be set per-session (`-m`/the TUI pick).
  if (String(cfg.model || "").includes("#"))
    fail(
      `opencode.json model \`${cfg.model}\` carries a \`#variant\` that does NOT apply — ` +
        "opencode V2 drops a variant on the root `model` for the primary session. Pin variants on " +
        "`mode: subagent` agents only, or drop it (the orchestrator effort is a per-session choice)."
    );
  const cfgAgents = cfg.agents && typeof cfg.agents === "object" ? cfg.agents : {};
  if (!cfgAgents.title || !cfgAgents.title.model)
    warn("opencode.json: no `agents.title.model` (V2 small-model) set");
  for (const [name, agentCfg] of Object.entries(cfgAgents)) {
    const v = agentCfg && typeof agentCfg === "object" ? agentCfg.model : null;
    if (!v) continue;
    checkModel(`agents.${name}.model`, v);
    // An opencode.json `agents.<name>.model` with `#variant` is inert for a
    // PRIMARY session: V2 keeps the session model separate and the root `model`
    // drops the variant (built-ins `build`/`plan` are primary; `title`/`explore`
    // are hidden/subagent). Express the effort as a subagent frontmatter pin.
    if (String(v).includes("#")) {
      const mode = agentCfg && typeof agentCfg === "object" ? agentCfg.mode : null;
      if (!variantApplies(mode))
        fail(
          `opencode.json agents.${name}.model \`${v}\` carries a \`#variant\` that does NOT apply — ` +
            "opencode V2 ignores a variant on an opencode.json agent model; the primary session model is " +
            "the root `model` (which drops `#variant`). Move the effort to a `mode: subagent` agent's " +
            "frontmatter `model:`, or drop the variant."
        );
    }
  }
} else warn("opencode.json not found (skip)");

// 4. model-routing.md ↔ model: pin consistency (doc↔config drift).
// Concrete IDs on a machine-readable `opportunistic_models:` / `escalation_models:`
// / `fallback_models:` line are DECLARED TARGETS (legal tiers, deliberately not
// pinned) — they pass the drift check without a matching pin; every other concrete
// ID must be pinned.
const declaredTargets = new Set();
const targetTiers = new Map();
const usedModels = new Set([...agentModels, ...configModels]);
const modelRoutingFile = path.join(root, ".agents", "memory", "model-routing.md");
if (fs.existsSync(modelRoutingFile)) {
  const doc = fs.readFileSync(modelRoutingFile, "utf8");
  for (const m of doc.matchAll(/^(opportunistic|escalation|fallback)_models:\s*(.+)$/gim)) {
    const tier = m[1].toLowerCase();
    for (const id of m[2].split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)) {
      if (/^`?(opportunistic|escalation|fallback)_models:`?$/i.test(id)) continue;
      declaredTargets.add(id);
      targetTiers.set(id, tier);
    }
  }
  // Longest-first alternation so a declared `...-contributor-free` ID is never
  // clipped to a shorter allowlist entry that shares its prefix.
  const modelPattern = [...allowlist].sort((a, b) => b.length - a.length).map(escapeRe).join("|");
  const mentioned = new Set();
  const re = new RegExp(modelPattern, "g");
  let m;
  while ((m = re.exec(doc)) !== null) mentioned.add(m[0]);
  if (mentioned.size === 0) {
    pass("model-routing.md names no concrete model IDs (tier policy only) — nothing to cross-check");
  } else {
    for (const mid of mentioned) {
      if (usedModels.has(mid)) pass(`model-routing.md \`${mid}\` matches an actual pin`);
      else if (declaredTargets.has(mid))
        pass(`model-routing.md \`${mid}\` is a declared ${targetTiers.get(mid)} target (not a pin)`);
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