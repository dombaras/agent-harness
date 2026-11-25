#!/usr/bin/env node
"use strict";
/*
 * dispatch-tier — the T0-T3 execution tier (F-025 S4).
 *
 * The decision that costs the most is made before any prompt is written: does
 * this change need a persona at all, one, or several? Judging that from the
 * objective in the moment is how a one-line fix gets four dispatches and a
 * schema migration gets none. This module derives the tier from shape and risk
 * (files, surfaces, contracts) so the policy is a lookup, not a mood:
 *
 *   T0  direct, no plan       one file, no behaviour change (typo/rename/config)
 *   T1  direct, verified      one surface, <=3 files, no contract/risk
 *   T2  one dispatch          multi-file on one surface, or one API/contract change
 *   T3  several dispatches    2+ surfaces, or schema/auth/security/public API
 *
 * An unknown-cause objective ("unknown cause", "root cause", "investigate",
 * "intermittent", "regression", "why", "diagnose") is at least T2 and pays
 * `test:diagnosis`: a patch before a proven cause is a guess, not a fix.
 *
 * It is pure: no git, no filesystem, no store. The plugin/doctor/agent passes
 * the facts; every branch is unit-testable and the CLI is a thin wrapper.
 *
 * Usage:
 *   node scripts/qa/dispatch-tier.js --objective "..." --files a.js,b.js [--json]
 *   node scripts/qa/dispatch-tier.js --objective "..." --files a.js --surfaces web
 */

const TIER_NAMES = {
  0: "direct (mechanical)",
  1: "direct (verified)",
  2: "single dispatch",
  3: "multi dispatch",
};

/* Risk keywords, strongest first. A match is a fact about the objective, not a
 * guess about difficulty: these are the changes that can break production. */
const RISK_TAGS = [
  { tag: "schema", re: /\b(schema|migration|migrate|prisma|database table|column|backfill)\b/i },
  { tag: "auth", re: /\b(auth|authentication|authori[sz]ation|login|session token|credential|secret|password)\b/i },
  { tag: "security", re: /\b(security|vulnerab|injection|xss|csrf|permission escalation|tenant isolation)\b/i },
  { tag: "api-contract", re: /\b(api contract|breaking change|public api|endpoint contract|webhook|openapi|graphql schema)\b/i },
  { tag: "concurrency", re: /\b(concurrency|race condition|deadlock|transaction|idempoten|locking|sync conflict)\b/i },
  { tag: "sync", re: /\b(offline sync|sync protocol|replication|conflict resolution)\b/i },
  { tag: "data", re: /\b(ingest|import job|entity resolution|dedup|etl)\b/i },
  { tag: "infra", re: /\b(deploy|ci\/cd|workflow|docker|release|pipeline|cron|systemd)\b/i },
  { tag: "api", re: /\b(api|route|endpoint|handler|controller|service layer)\b/i },
  { tag: "ui", re: /\b(ui|screen|component|layout|style|css|design token|rtl)\b/i },
  { tag: "docs", re: /\b(docs?|readme|changelog|adr|documentation)\b/i },
];

const HIGH_RISK = new Set(["schema", "auth", "security", "api-contract", "concurrency", "sync"]);

/* Unknown-cause signals. These objectives are investigations before they are
 * changes: the cause is not proven, so a patch would be a guess. Keep the
 * vocabulary narrow — "look into" and "flaky" are deliberately absent because
 * they appear in ordinary small-change objectives. */
const UNKNOWN_CAUSE =
  /\b(unknown[\s-]+cause|root[\s-]+cause|investigat(?:e|es|ed|ing|ion)|intermittent(?:ly)?|regression|why|diagnos(?:e|es|ed|ing|is|tic|tics))\b/i;

function hasUnknownCause(objective) {
  return UNKNOWN_CAUSE.test(String(objective || ""));
}

/* A surface is the unit a different gate/persona owns. Map the first path
 * segment (and a few repo conventions) instead of trusting a caller label. */
const SURFACE_RULES = [
  { surface: "mobile", re: /^(mobile|android|ios|expo)\// },
  { surface: "web", re: /^(app|components|pages|src\/components)\// },
  { surface: "api", re: /^(api|server|services)\// },
  { surface: "db", re: /^(prisma|db|migrations|schema)\// },
  { surface: "docs", re: /^(docs|README|CHANGELOG)/i },
  { surface: "rules", re: /^(\.agents\/rules|\.agents\/AGENTS|AGENTS\.md)/ },
  { surface: "skills", re: /^(\.agents\/skills|\.opencode\/agents)\// },
  { surface: "gates", re: /^(scripts\/qa|tests)\// },
  { surface: "infra", re: /^(\.github|Dockerfile|docker|scripts\/(deploy|serve|nightly))/ },
  { surface: "harness", re: /^scripts\// },
];

function normalizeRel(p) {
  return String(p || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .trim();
}

function surfaceOf(file) {
  let rel = normalizeRel(file);
  // `templates/` mirrors the deployed tree; classify the inner path so harness
  // source is not mistaken for documentation just because of the prefix.
  if (rel.startsWith("templates/")) rel = rel.slice("templates/".length);
  for (const rule of SURFACE_RULES) if (rule.re.test(rel)) return rule.surface;
  const first = rel.split("/")[0];
  return first || "repo";
}

function deriveSurfaces(files, declared) {
  const explicit = (declared || []).map((s) => String(s || "").trim()).filter(Boolean);
  if (explicit.length) return [...new Set(explicit)].sort();
  return [...new Set((files || []).map(surfaceOf))].sort();
}

function riskTags(objective, declared) {
  const tags = new Set((declared || []).map((t) => String(t || "").trim().toLowerCase()).filter(Boolean));
  const text = String(objective || "");
  for (const r of RISK_TAGS) if (r.re.test(text)) tags.add(r.tag);
  return [...tags].sort();
}

function isCodeChange(files, opts = {}) {
  if (opts.code === false) return false;
  if (opts.code === true) return true;
  const rels = (files || []).map(normalizeRel);
  if (!rels.length) return true; // unknown scope: assume a code path (safer)
  const docsOnly = rels.every((f) => /^(docs\/|README|CHANGELOG|LICENSE|.*\.md$)/i.test(f));
  return !docsOnly;
}

/* Persona hints by surface. `general` is the engineering lane that has no
 * domain persona; the classifier says so instead of inventing one. */
const PERSONA_BY_SURFACE = {
  mobile: "mobile-engineer",
  web: "frontend-engineer",
  api: "general",
  db: "system-architect",
  docs: "docs",
  rules: "docs",
  skills: "docs",
  gates: "qa-architect",
  infra: "devops-engineer",
  harness: "general",
  repo: "general",
};

function personasFor(surfaces, risk, tier) {
  if (tier < 2) return [];
  const out = [];
  for (const s of surfaces) {
    const p = PERSONA_BY_SURFACE[s];
    if (p && !out.includes(p)) out.push(p);
  }
  if (risk.includes("schema") && !out.includes("system-architect")) out.push("system-architect");
  if ((risk.includes("auth") || risk.includes("security")) && !out.includes("security-engineer")) out.push("security-engineer");
  if (tier === 3 && !out.includes("qa-architect")) out.push("qa-architect");
  return out;
}

/* The gate set is derived from the touched paths, so a T3 that never touches
 * the prefix files does not pay `test:prefix`. */
function gatesFor(files, surfaces, risk, code, unknownCause = false) {
  const rels = (files || []).map(normalizeRel);
  const gates = [];
  const add = (g) => { if (!gates.includes(g)) gates.push(g); };
  if (code) {
    add("test:quick");
    add("test:qa-plan");
    add("test:wiring");
  }
  if (unknownCause) add("test:diagnosis");
  if (rels.some((f) => /^(templates\/)?AGENTS\.md$|^(templates\/)?\.agents\/(AGENTS\.md|rules\/)/.test(f)))
    add("test:prefix");
  if (rels.some((f) => /^(templates\/)?\.opencode\/agents\/|^(templates\/)?\.opencode\/plugins\/|model-routing\.md$/.test(f)))
    add("test:dispatch");
  if (surfaces.includes("docs") || rels.some((f) => /^(docs\/|CHANGELOG|README)/i.test(f))) add("test:docs");
  if (surfaces.includes("rules") || surfaces.includes("skills") || surfaces.includes("gates"))
    add("test:governance");
  if (risk.includes("auth") || risk.includes("security")) add("test:security");
  return gates;
}

function classify(input = {}) {
  const objective = String(input.objective || "").trim();
  const files = (input.files || []).map(normalizeRel).filter(Boolean);
  const surfaces = deriveSurfaces(files, input.surfaces);
  const risk = riskTags(objective, input.risk);
  const code = isCodeChange(files, input);
  const unknownCause = code && hasUnknownCause(objective);
  const highRisk = risk.some((t) => HIGH_RISK.has(t));
  const mediumRisk = risk.length > 0;
  const multiScope = Boolean(input.parallel) || surfaces.length >= 3;
  const reasons = [];

  let tier;
  if (!code && !highRisk && surfaces.length <= 1) {
    tier = 0;
    reasons.push("docs/copy only, one surface");
  } else if (!files.length && !highRisk) {
    tier = 1;
    reasons.push("scope not declared — verify before dispatch");
  } else if (highRisk || multiScope) {
    tier = 3;
    if (highRisk) reasons.push(`high-risk contract: ${risk.filter((t) => HIGH_RISK.has(t)).join(", ")}`);
    if (multiScope) reasons.push(`${surfaces.length || "multiple"} surfaces${input.parallel ? " across parallel scopes" : ""}`);
  } else if (surfaces.length >= 2 || files.length > 3 || mediumRisk) {
    tier = 2;
    if (surfaces.length >= 2) reasons.push(`${surfaces.length} surfaces: ${surfaces.join(", ")}`);
    if (files.length > 3) reasons.push(`${files.length} files on one surface`);
    if (mediumRisk) reasons.push(`contract-adjacent: ${risk.join(", ")}`);
  } else if (files.length <= 1) {
    tier = 0;
    reasons.push("single file, no behaviour change");
  } else {
    tier = 1;
    reasons.push(`${files.length} files on one surface, no contract risk`);
  }

  if (unknownCause) {
    if (tier < 2) tier = 2;
    reasons.push("unknown cause: diagnosis + falsifier before implementation (min T2)");
  }

  const personas = personasFor(surfaces, risk, tier);
  const gates = gatesFor(files, surfaces, risk, code, unknownCause);
  return {
    schema: "dispatch-tier/1",
    tier,
    label: `T${tier}`,
    name: TIER_NAMES[tier],
    objective,
    files,
    surfaces,
    risk,
    code,
    unknownCause,
    qaPlan: code,
    security: risk.includes("auth") || risk.includes("security"),
    execution: tier >= 2 ? "dispatch" : "direct",
    personas,
    gates,
    reasons,
  };
}

function renderTier(result) {
  const lines = [`dispatch tier: ${result.label} (${result.name})`];
  if (result.reasons.length) lines.push(`shape:    ${result.reasons.join("; ")}`);
  if (result.surfaces.length) lines.push(`surfaces: ${result.surfaces.join(", ")}`);
  if (result.risk.length) lines.push(`risk:     ${result.risk.join(", ")}`);
  lines.push(`execute:  ${result.execution}${result.personas.length ? ` via ${result.personas.join(" -> ")}` : " on the main model"}`);
  if (result.qaPlan) lines.push("qa plan:  required (code change)");
  if (result.gates.length) lines.push(`gates:    ${result.gates.join(", ")}`);
  return lines.join("\n");
}

function parseArgs(argv) {
  const out = { objective: "", files: [], surfaces: [], risk: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--objective") out.objective = argv[++i] || "";
    else if (a === "--files") out.files = String(argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--surfaces") out.surfaces = String(argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--risk") out.risk = String(argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--json") out.json = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = classify(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderTier(result));
}

module.exports = {
  TIER_NAMES,
  HIGH_RISK,
  UNKNOWN_CAUSE,
  normalizeRel,
  surfaceOf,
  deriveSurfaces,
  riskTags,
  hasUnknownCause,
  isCodeChange,
  personasFor,
  gatesFor,
  classify,
  renderTier,
};

if (require.main === module) main();
