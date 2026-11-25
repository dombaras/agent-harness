#!/usr/bin/env node
"use strict";
/*
 * check-qa-scripts — verify the QA-tier npm scripts the rulebook's Definition of
 * Done references actually exist in the target project's package.json.
 *
 * The harness ships only `test:dispatch` and `test:governance`; the runtime QA
 * tiers (test:quick / test:routes / test:api / test:verify / test:security) are
 * PROJECT-PROVIDED. This gate emits warnings for missing ones so a fresh deploy
 * doesn't silently claim a QA tier that isn't wired up.
 *
 *   node scripts/qa/check-qa-scripts.js            # warnings only, exit 0
 *   node scripts/qa/check-qa-scripts.js --strict   # fail (exit 1) on missing
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "..");
const strict = process.argv.includes("--strict");

// npm scripts referenced by the DoD / QA tier matrix.
const EXPECTED = {
  "test:dispatch": "harness — persona model-pin preflight (shipped)",
  "test:governance": "harness — session-governance gate (shipped)",
  "test:qa-plan": "harness — diff-coverage + flow-closure gate (changed code paths covered; touched flows' sibling surfaces/variants audited)",
  "test:diagnosis": "harness — inquiry-loop gate (declared bug/incident/fix features carry a falsified diagnosis + outcome oracle)",
  "test:backlog": "harness — canonical single-file backlog gate (board schema + depends-on references valid)",
  "test:concurrency": "harness — cross-session working-tree guard (a concurrent session's uncommitted work must not leak into your push)",
  "test:integrate": "harness — pre-push rebase check (rebase onto main before push, so conflicts surface early)",
  "test:quality": "harness — mechanical code-quality gate on new/changed code (dead exports + oversized files; rubric in .agents/memory/quality-parameters.md)",
  "test:wiring": "harness — orphan-test gate (every *.test.* file is executed by a package script; test-design param T7)",
  "test:linger": "harness — exit-contract gate (process wall-clock vs runner-reported test duration on a tier; wraps test:quick by default; test-design params T1/T6/T9)",
  "test:quick": "Tier 1 — types + translations + mobile smoke",
  "test:routes": "Tier 2 — route/page render",
  "test:api": "Tier 3 — API/ORM edge cases",
  "test:verify": "Tier 5 — full regression",
  "test:security": "Tier 6 — npm audit + security checks",
  "deploy:uat": "deploy to the User Acceptance environment (build + migrate deploy + idempotent seed)",
  "deploy:prod": "deploy to production (human-gated)",
  "test:data-hygiene": "forward-boundary check — fail when test-data markers exist in uat/prod",
};

const pkgPath = path.join(root, "package.json");
if (!fs.existsSync(pkgPath)) {
  console.error("FATAL: no package.json in project root");
  process.exit(2);
}

let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
} catch (e) {
  console.error(`FATAL: unparseable package.json: ${e.message}`);
  process.exit(2);
}

const scripts = pkg.scripts || {};
const missing = [];
const present = [];

console.log("QA script wiring check — DoD-referenced npm scripts");
for (const [name, desc] of Object.entries(EXPECTED)) {
  if (scripts[name]) {
    present.push(name);
    console.log(`  \u2713 ${name} (${desc})`);
  } else {
    missing.push(name);
    console.log(`  \u26a0 ${name} MISSING (${desc})`);
  }
}

if (missing.length) {
  const verb = strict ? "FAILURE" : "WARNING";
  console.log(
    `\nRESULT: ${present.length}/${Object.keys(EXPECTED).length} wired. ` +
      `${missing.length} missing: ${missing.join(", ")}.`
  );
  console.log(
    `These are project-provided scripts — add them to package.json or narrow the QA tiers you use. ` +
      `(Run with --strict to treat this as a failure.)`
  );
  process.exit(strict ? 1 : 0);
}

console.log("\nRESULT: all DoD-referenced QA scripts wired.");
process.exit(0);
