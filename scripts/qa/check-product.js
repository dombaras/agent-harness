#!/usr/bin/env node
"use strict";
/*
 * test:product — product/UX-first gate (harness-shipped).
 *
 * Enforces "product & UX first" at the PLANNING phase, the same way test:qa-plan
 * enforces coverage at the VERIFY phase. A feature that reaches the planning or
 * implementation stage must have defined its user (actor), their need, the
 * outcome, and the acceptance criteria — and a plan (plan.md) must sequence the
 * work value-first and name the product concepts it honors. Tech-first features
 * (a plan with no intent, or an intent that never names a user/need/outcome) fail.
 *
 * Checked against `.agents/features/<slug>/` (project-authored; see
 * .agents/skills/features/SKILL.md and .agents/skills/planner/SKILL.md):
 *
 *   1. A feature with a `plan.md` MUST also have an `intent.md` (never plan an
 *      implementation around an undefined user need).
 *   2. Every `intent.md` must carry the four product sections, each non-empty:
 *        ## Actor(s)/Who  ·  ## Need/Why  ·  ## Outcome  ·  ## Acceptance criteria
 *   3. Every `plan.md` must carry the two value-led sections, each non-empty:
 *        ## Value-first sequence  ·  ## Product concepts applied
 *
 * Backward compatible: with no feature docs (or no `.agents/features/` tree) the
 * gate warns and passes — projects opt in by authoring feature docs. A missing
 * `.agents/memory/product-principles.md` is a warning, not a failure.
 *
 *   node scripts/qa/check-product.js
 *
 * Exit 0 on: no feature docs, or every feature doc satisfying its contract.
 * Exit 1 on: any feature doc missing a required product section.
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "..");
const FEATURES_DIR = path.join(root, ".agents", "features");

const failures = [];
const pass = (m) => console.log("  \u2713 " + m);
const fail = (m) => {
  failures.push(m);
  console.log("  \u2717 " + m);
};
const warn = (m) => console.log("  \u26a0 " + m);

console.log("product gate \u2014 planning is product/UX-first (intent \u2192 value-led plan)");

// ---- heading contracts ------------------------------------------------------
const H = {
  actor: /^#{1,6}\s*(Actors?|Who)\b/i,
  need: /^#{1,6}\s*(Need|Why)\b/i,
  outcome: /^#{1,6}\s*Outcome\b/i,
  acceptance: /^#{1,6}\s*Acceptance\s+criteria\b/i,
  sequence: /^#{1,6}\s*(Value[ -]first\s+(sequence|order)|Sequence)\b/i,
  concepts: /^#{1,6}\s*Product\s+concepts\s+applied\b/i,
};

/* Lines that count as "content" in a section: skip blanks, HTML comments, and
 * unfilled `_TODO:` placeholders. */
function isFilled(line) {
  if (!line) return false;
  if (/^<!--/.test(line) || /-->$/.test(line)) return false;
  if (/_TODO:/.test(line)) return false;
  return true;
}

/* Return the filled body lines of the first section matching `re` (from the
 * heading up to the next heading). [] when the heading is absent or empty. */
function section(src, re) {
  const lines = src.split(/\r?\n/);
  let inSec = false;
  const body = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!inSec) {
      if (re.test(line)) inSec = true;
      continue;
    }
    if (/^#{1,6}\s/.test(line)) break;
    if (isFilled(line)) body.push(line);
  }
  return body;
}

function hasSection(src, re) {
  return section(src, re).length > 0;
}

/* Acceptance criteria must be an actual list of criteria (bullets/numbers). */
function hasAcceptance(src) {
  const body = section(src, H.acceptance);
  return body.some((l) => /^[-*+]\s+\S/.test(l) || /^\d+[.)]\s+\S/.test(l));
}

function readMd(p) {
  return fs.readFileSync(p, "utf8");
}

function checkIntent(slug, src) {
  const missing = [];
  if (!hasSection(src, H.actor)) missing.push("## Actor(s)/Who");
  if (!hasSection(src, H.need)) missing.push("## Need/Why");
  if (!hasSection(src, H.outcome)) missing.push("## Outcome");
  if (!hasAcceptance(src)) missing.push("## Acceptance criteria (list)");
  if (missing.length) {
    fail(`${slug}/intent.md: missing product section(s) \u2014 ${missing.join(", ")}`);
  } else {
    pass(`${slug}/intent.md: actor \u2192 need \u2192 outcome \u2192 acceptance criteria present`);
  }
}

function checkPlan(slug, src) {
  const missing = [];
  if (!hasSection(src, H.sequence)) missing.push("## Value-first sequence");
  if (!hasSection(src, H.concepts)) missing.push("## Product concepts applied");
  if (missing.length) {
    fail(`${slug}/plan.md: missing value-led section(s) \u2014 ${missing.join(", ")}`);
  } else {
    pass(`${slug}/plan.md: value-first sequence + product concepts applied present`);
  }
}

// ---- feature tree -----------------------------------------------------------
if (!fs.existsSync(FEATURES_DIR)) {
  warn("no .agents/features/ tree \u2014 nothing to enforce");
  console.log("\nRESULT: green (no feature docs)");
  process.exit(0);
}

const dirs = fs
  .readdirSync(FEATURES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== "archive" && !d.name.startsWith("."))
  .map((d) => d.name)
  .sort();

if (dirs.length === 0) {
  warn("no live feature docs \u2014 nothing to enforce");
  console.log("\nRESULT: green (no feature docs)");
  process.exit(0);
}

for (const slug of dirs) {
  const dir = path.join(FEATURES_DIR, slug);
  const intentPath = path.join(dir, "intent.md");
  const planPath = path.join(dir, "plan.md");
  const hasIntent = fs.existsSync(intentPath);
  const hasPlan = fs.existsSync(planPath);

  if (!hasIntent && !hasPlan) {
    pass(`${slug}: no intent.md/plan.md yet \u2014 not at the planning stage`);
    continue;
  }

  // 1. plan without intent = tech-first
  if (hasPlan && !hasIntent) {
    fail(`${slug}: has plan.md but no intent.md \u2014 never plan around an undefined user need`);
    continue;
  }

  if (hasIntent) checkIntent(slug, readMd(intentPath));
  if (hasPlan) checkPlan(slug, readMd(planPath));
}

const principlesPath = path.join(root, ".agents", "memory", "product-principles.md");
if (!fs.existsSync(principlesPath)) {
  warn(
    "no .agents/memory/product-principles.md \u2014 fill it in so plans are led by the project's product concepts"
  );
}

console.log(
  "\nRESULT: " +
    (failures.length
      ? `${failures.length} FAILURE(S) \u2014 every feature doc must define its user (actor/need/outcome/acceptance) and plan value-first`
      : "green \u2014 planning is product/UX-first")
);
process.exit(failures.length ? 1 : 0);
