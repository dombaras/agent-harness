#!/usr/bin/env node
"use strict";
/*
 * test:diagnosis — the inquiry-loop gate (harness-shipped).
 *
 * Why it exists: the 2026-11 capability review found the harness execution-strong
 * but inquiry-weak — a symptom could go straight to a plausible cause and a patch,
 * and "done" meant CI green, not "the reported behaviour changed". This gate
 * makes the missing artifact explicit for work that is *declared* diagnostic.
 *
 * Scope is opt-in by feature metadata, never inferred from a diff:
 *   .agents/features/<slug>/meta.json  { kind, risk, requiresDiagnosis?, symptom? }
 *   .agents/features/<slug>/diagnosis.md
 *
 * - kind bug|incident|fix => a diagnosis is required (unless requiresDiagnosis:false);
 * - kind feature|investigate|ops => not required (high-risk may opt in);
 * - no meta.json => legacy feature: WARN only, never fail (backward compatible).
 *
 * With `--feature <id>` only that feature is checked (finalize uses this).
 * `--warn` or AGENT_HARNESS_DIAGNOSIS=warn never fails — the one-release rollout.
 *
 *   node scripts/qa/check-diagnosis.js [--feature F-001] [--warn] [--json] [--root <dir>]
 *
 * Exit 0: every required diagnosis is valid (or warn mode / no features).
 * Exit 1: a required diagnosis is missing or malformed.
 * Exit 2: bad invocation (unknown --feature / unreadable meta).
 */
const fs = require("fs");
const path = require("path");
const lib = require("./diagnosis-lib.js");

function parseArgs(argv) {
  const out = { feature: null, warn: false, json: false, root: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--feature") out.feature = argv[++i];
    else if (a.startsWith("--feature=")) out.feature = a.slice("--feature=".length);
    else if (a === "--warn") out.warn = true;
    else if (a === "--json") out.json = true;
    else if (a === "--root") out.root = argv[++i];
    else if (a.startsWith("--root=")) out.root = a.slice("--root=".length);
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

const USAGE =
  "Usage: node scripts/qa/check-diagnosis.js [--feature <id>] [--warn] [--json] [--root <dir>]";

/* Validate every declared feature. Pure over the filesystem; returns
 * { features, failures, warnings }. */
function check(root, opts = {}) {
  const features = [];
  const warnings = [];
  const only = opts.feature ? lib.normalizeId(opts.feature) : null;
  const dirs = lib.featureDirs(root);

  for (const f of dirs) {
    const meta = lib.readJson(lib.metaPath(f.dir));
    const metaRaw = fs.existsSync(lib.metaPath(f.dir)) ? fs.readFileSync(lib.metaPath(f.dir), "utf8") : "";
    if (metaRaw && !meta) {
      features.push({
        id: f.slug,
        slug: f.slug,
        required: false,
        ok: false,
        errors: [{ code: "meta", message: `${f.slug}/meta.json is not valid JSON` }],
        status: null,
        confidence: null,
        symptom: null,
      });
      continue;
    }
    if (!meta) {
      const rec = { id: f.slug, slug: f.slug, required: false, legacy: true, ok: true, errors: [], status: null, confidence: null, symptom: null };
      if (only && lib.normalizeId(f.slug) !== only) continue;
      features.push(rec);
      if (!opts.quiet) warnings.push(`${f.slug}: legacy feature (no meta.json) — diagnosis not required (warn only)`);
      continue;
    }
    if (only && lib.normalizeId(meta.id || f.slug) !== only && !lib.normalizeId(f.slug).startsWith(only)) continue;

    const text = fs.existsSync(lib.diagnosisPath(f.dir)) ? fs.readFileSync(lib.diagnosisPath(f.dir), "utf8") : "";
    const v = lib.validateDiagnosis({ meta, diagnosisText: text, id: meta.id || f.slug });
    const rec = {
      id: String(meta.id || f.slug).toUpperCase(),
      slug: f.slug,
      kind: meta.kind || null,
      required: v.required,
      legacy: v.legacy,
      ok: v.ok,
      errors: v.errors,
      status: v.status,
      confidence: v.confidence,
      symptom: v.symptom,
      diagnosis: lib.diagnosisPath(f.dir),
    };
    features.push(rec);
    if (!v.required) {
      warnings.push(`${rec.id}: kind=${meta.kind || "?"} does not require a diagnosis`);
    }
  }

  const failures = [];
  for (const r of features) {
    for (const e of r.errors || []) failures.push(e.message);
  }
  return { features, failures, warnings };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const root = path.resolve(args.root || path.join(__dirname, "..", ".."));
  const warnMode = args.warn || String(process.env.AGENT_HARNESS_DIAGNOSIS || "").toLowerCase() === "warn";
  const res = check(root, { feature: args.feature, quiet: args.json });
  const features = res.features.filter((f) => !args.feature || !f.legacy || lib.normalizeId(f.slug).startsWith(lib.normalizeId(args.feature)));

  if (args.feature && !features.length) {
    console.error(`diagnosis gate: no feature matches "${args.feature}" under ${path.join(root, ".agents", "features")}`);
    process.exit(2);
  }

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          schema: "diagnosis/1",
          root,
          mode: warnMode ? "warn" : "enforce",
          features: features.map((f) => ({
            id: f.id,
            slug: f.slug,
            kind: f.kind || null,
            required: Boolean(f.required),
            legacy: Boolean(f.legacy),
            ok: f.ok,
            status: f.status,
            confidence: f.confidence,
            errors: (f.errors || []).map((e) => ({ code: e.code, message: e.message })),
          })),
          failures: res.failures,
          warnings: res.warnings,
        },
        null,
        2
      )
    );
  } else {
    console.log("diagnosis gate \u2014 declared bug/incident/fix work carries a falsified diagnosis");
    if (!features.length) console.log("  \u2713 no feature metadata \u2014 nothing declared diagnostic");
    for (const f of features) {
      if (f.legacy) {
        console.log(`  \u26a0 ${f.slug}: legacy feature (no meta.json) \u2014 diagnosis not required`);
        continue;
      }
      if (!f.required) {
        console.log(`  \u2713 ${f.id}: kind=${f.kind || "?"} \u2014 diagnosis not required`);
        continue;
      }
      if (f.ok) {
        console.log(`  \u2713 ${f.id}: diagnosis ${f.status || "valid"}${f.confidence ? ` (${f.confidence})` : ""} \u2014 falsifier + oracle recorded`);
      } else {
        for (const e of f.errors || []) console.log(`  \u2717 ${e.message}`);
      }
    }
    for (const w of res.warnings) console.log(`  \u26a0 ${w}`);
    const verdict = res.failures.length ? (warnMode ? "WARN (enforce mode would fail)" : "FAIL") : "green";
    console.log(`\nRESULT: ${verdict} \u2014 ${res.failures.length} diagnosis failure(s)${warnMode ? ", warn mode (AGENT_HARNESS_DIAGNOSIS=warn)" : ""}`);
  }
  process.exit(res.failures.length && !warnMode ? 1 : 0);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error("diagnosis gate: " + (e && e.message ? e.message : e));
    process.exit(1);
  }
}

module.exports = { check, parseArgs };
