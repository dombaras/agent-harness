#!/usr/bin/env node
"use strict";
/*
 * feature-scaffold — create the per-feature doc-tree skeletons in one call.
 *
 * The 2026-10 LibraryOS recon measured the "doc chain" (intent/scope/plan/tests)
 * being re-authored from scratch by four sequential persona dispatches for many
 * features. This writes the section skeletons the `test:product` / `test:qa-plan`
 * gates require (so the personas FILL a known shape instead of inventing one),
 * and the matching per-change QA-plan stub. It authors NO content: the
 * product-manager/planner/system-architect/qa-architect personas still write
 * every section — this only removes the blank-page + gate-shape tax.
 *
 * Write-if-missing: an existing doc is never overwritten (the personas own it).
 *
 * Usage:
 *   node scripts/qa/feature-scaffold.js --id F-302 --slug f-302-cover-sync \
 *        [--title "..."] [--risk low|high] [--root <dir>] [--json]
 */

const fs = require("fs");
const path = require("path");
const { KINDS, needsDiagnosis } = require("./diagnosis-lib.js");

function intentDoc(id, title) {
  return `# ${id} — ${title || "intent"}

status: proposed

## Actor(s)

(Who has the need — the personas fill this.)

## Need

(The problem/desire in the user's words.)

## Outcome

(What success looks like for the user.)

## Acceptance criteria

- (A user-facing, testable criterion.)

## Boundaries

- In scope:
- Out of scope:

## Open questions

- ?
`;
}

function scopeDoc(id, title) {
  return `# ${id} — scope

status: scoped

## Technical constraints

(Constraints, dependencies, versions — see stack-versions.md.)

## Blast radius

(Files/subsystems touched; cross-surface siblings from flow-map.md.)

## Data-model / API impact

(Schema/migration, routes, contracts — or "none".)
`;
}

function planDoc(id, title) {
  return `# ${id} — plan

status: planned

## Value-first sequence

1. (Smallest slice first — cite the actor + outcome each step serves.)

## Product concepts applied

(Name the concepts/heuristics from product-principles.md this plan honors.)
`;
}

function testsDoc(id) {
  return `# ${id} — tests

status: planned

Intent-level acceptance tests + the minimal tier. Points to
\`.agents/qa-plans/${id}.md\` (the per-change coverage plan) — never duplicate it.
`;
}

function metaDoc(id, opts) {
  const meta = {
    id,
    kind: opts.kind || "feature",
    risk: opts.risk || "low",
    requiresDiagnosis: needsDiagnosis({ kind: opts.kind || "feature" }),
    createdAt: new Date().toISOString(),
  };
  if (opts.symptom) meta.symptom = String(opts.symptom);
  return JSON.stringify(meta, null, 2) + "\n";
}

/* A diagnosis the gate will reject until an investigator fills it: two empty
 * candidates, an empty evidence pointer and the falsifier block. The stub exists
 * so /diagnose has a known shape, not so it can pass. */
function diagnosisDoc(id, opts) {
  return `# ${id} — diagnosis

status: open
symptom: ${opts.symptom || "?"}
confidence: low
owner: unknown
falsifier: unknown

## Observed vs expected

- Observed:
- Expected:
- Reported by / evidence pointer:

## Evidence

| # | Evidence | Source (file:line / command / log) | Supports |
|---|---|---|---|
| 1 |  |  |  |

## Candidate causes

| # | Cause | Likelihood | Discriminating test | Result |
|---|---|---|---|---|
| 1 |  |  |  | pending |
| 2 |  |  |  | pending |

## Ruled out

| Cause | Why ruled out | Evidence |
|---|---|---|

## Falsification

- Reviewer:
- Strongest alternative:
- Test that separates it:
- Outcome:
- Residual uncertainty:

## Outcome oracle

- Before (red):
- After (green):
- Command / observation:
- Environment / surface:
- Independent owner:

## Open questions

- ?
`;
}

function qaPlanDoc(id) {
  return `# QA plan — ${id}

## Coverage map

| Changed path | Covering assertion / waiver |
|---|---|
| ? | ? |

## Parallel-surface & variant audit

- ?

## Test budget

- wall-clock:
- teardown:
- tier:

## Oracle & owner

- independent oracle:
- single owner:

## Test-design self-check

- [ ] T1–T10 (test-design-parameters.md)
`;
}

/* The doc set for a right-sized feature. `risk=high` adds scope.md. Returns a
 * map of repo-relative path -> content. Pure. */
function skeletons(id, opts = {}) {
  const title = opts.title || "";
  const slug = opts.slug;
  const base = path.posix.join(".agents", "features", slug);
  const out = {};
  out[path.posix.join(base, "intent.md")] = intentDoc(id, title);
  out[path.posix.join(base, "plan.md")] = planDoc(id, title);
  out[path.posix.join(base, "tests.md")] = testsDoc(id);
  out[path.posix.join(".agents", "qa-plans", `${id}.md`)] = qaPlanDoc(id);
  if (opts.risk === "high") out[path.posix.join(base, "scope.md")] = scopeDoc(id, title);
  if (opts.kind) {
    out[path.posix.join(base, "meta.json")] = metaDoc(id, opts);
    if (needsDiagnosis({ kind: opts.kind })) {
      out[path.posix.join(base, "diagnosis.md")] = diagnosisDoc(id, opts);
    }
  }
  return out;
}

/* Write every skeleton that does not already exist. Returns { written, skipped }. */
function scaffold(root, opts) {
  const files = skeletons(opts.id, opts);
  const written = [];
  const skipped = [];
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    if (fs.existsSync(abs)) {
      skipped.push(rel);
      continue;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
    written.push(rel);
  }
  return { written, skipped, dispatchOrder: dispatchOrder(opts.risk) };
}

/* Which author personas the orchestrator dispatches (never a script). Pure. */
function dispatchOrder(risk) {
  const chain = ["product-manager (intent)"];
  if (risk === "high") chain.push("system-architect (scope)");
  chain.push("planner (plan)", "qa-architect (qa-plans/<id>.md)");
  return chain;
}

function parseArgs(argv) {
  const out = {
    id: null,
    slug: null,
    title: "",
    risk: "low",
    kind: null,
    symptom: "",
    root: null,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--id") out.id = argv[++i];
    else if (a.startsWith("--id=")) out.id = a.slice(5);
    else if (a === "--slug") out.slug = argv[++i];
    else if (a.startsWith("--slug=")) out.slug = a.slice(7);
    else if (a === "--title") out.title = argv[++i];
    else if (a.startsWith("--title=")) out.title = a.slice(8);
    else if (a === "--risk") out.risk = argv[++i];
    else if (a.startsWith("--risk=")) out.risk = a.slice(7);
    else if (a === "--kind") out.kind = argv[++i];
    else if (a.startsWith("--kind=")) out.kind = a.slice(7);
    else if (a === "--symptom") out.symptom = argv[++i];
    else if (a.startsWith("--symptom=")) out.symptom = a.slice(10);
    else if (a === "--root") out.root = argv[++i];
    else if (a.startsWith("--root=")) out.root = a.slice(7);
    else if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.id || !args.slug) {
    console.log(
      "Usage: node scripts/qa/feature-scaffold.js --id <F-n> --slug <slug> [--title ...]\n" +
        "       [--risk low|high] [--kind <kind>] [--symptom <key>] [--root <dir>] [--json]\n" +
        "       --kind writes meta.json; bug|incident|fix also write a diagnosis.md stub"
    );
    process.exit(args.help ? 0 : 2);
  }
  if (args.kind && !KINDS.includes(String(args.kind).toLowerCase())) {
    console.error(`feature-scaffold: --kind must be one of ${KINDS.join("|")} (got "${args.kind}")`);
    process.exit(2);
  }
  if (!/^F-\d+$/i.test(args.id)) {
    console.error(`feature-scaffold: --id must be an F-<n> backlog id (got "${args.id}")`);
    process.exit(2);
  }
  const root = path.resolve(args.root || process.cwd());
  const res = scaffold(root, args);
  if (args.json) console.log(JSON.stringify({ schema: "feature-scaffold/1", id: args.id, ...res }, null, 2));
  else {
    console.log(`feature-scaffold: ${args.id} (${args.slug})`);
    for (const f of res.written) console.log(`  + ${f}`);
    for (const f of res.skipped) console.log(`  = ${f} (exists — left alone)`);
    console.log(`  dispatch: ${res.dispatchOrder.join(" -> ")}`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error("feature-scaffold: " + (e && e.message ? e.message : e));
    process.exit(1);
  }
}

module.exports = { skeletons, scaffold, dispatchOrder, parseArgs };
