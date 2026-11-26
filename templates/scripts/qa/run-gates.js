#!/usr/bin/env node
"use strict";
/*
 * gates — run the harness gate battery as ONE call.
 *
 * The 2026-10 LibraryOS recon measured ~700 individual gate invocations in 14
 * days (`tsc` 125, `test:quick` 120, `test:qa-plan` 50, …): each is a separate
 * shell round-trip that re-enters the tool, re-reads nothing, and prints its
 * own banner. This runs a coherent phase in order, stops at the first failure,
 * and returns a compact per-gate PASS/FAIL summary, so an agent spends one tool
 * call instead of a dozen.
 *
 * Semantics match the pre-push hook: a gate the project has not wired
 * (`package.json` scripts) is SKIPPED, never failed — `--if-present`. The
 * pre-push hook calls `npm run gates -- --phase=pre-push` so the gate list has
 * one owner (this file) and the hook can never drift from it.
 *
 * Usage:
 *   node scripts/qa/run-gates.js [--phase=pre-push|process|quick|all]
 *                                [--base=<ref>] [--continue] [--json] [--root <dir>]
 *                                [--list]
 *
 * Dependency-free and injectable (`opts.runner`) so phase selection, skipping,
 * stop-at-first-failure, and arg forwarding are unit-testable.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

/* Gate phases. `process` = the harness process gates that need only the board/
 * repo; `quick` = the project's own stack gates (lint/typecheck/tests). An
 * entry is `[script, ...extraArgs]`; `{base}` is replaced from --base. */
const PHASES = {
  process: [
    ["test:dispatch"],
    ["test:governance"],
    ["test:concurrency"],
    ["test:capacity"],
    ["test:worktrees"],
    ["test:ci-policy"],
    ["test:opencode-compat"],
    ["test:backlog"],
    ["test:wiring"],
    ["test:integrate"],
    ["test:qa-plan", "--base={base}"],
    ["test:diagnosis"],
    ["test:product"],
    ["test:docs"],
    ["test:feedback"],
    ["test:prefix"],
    ["test:quality"],
  ],
  quick: [["lint:hooks"], ["test:schema"], ["test:quick"]],
};
PHASES["pre-push"] = [...PHASES.process, ...PHASES.quick];

function readScripts(root) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    return pkg && typeof pkg.scripts === "object" && pkg.scripts ? pkg.scripts : {};
  } catch (_) {
    return {};
  }
}

/* Resolve a phase name to the concrete gate list, expanding `{base}`. `all`
 * de-duplicates every gate across phases (first occurrence wins). Pure given
 * the phase table; no IO. */
function resolveGates(phase, base) {
  if (phase === "all") {
    const seen = new Set();
    const out = [];
    for (const key of ["process", "quick"]) {
      for (const gate of PHASES[key]) {
        if (!seen.has(gate[0])) {
          seen.add(gate[0]);
          out.push(gate.slice());
        }
      }
    }
    return out;
  }
  const list = PHASES[phase];
  if (!list) return null;
  return list.map((gate) => gate.map((a) => a.replace("{base}", base)));
}

function parseArgs(argv) {
  const out = {
    phase: "pre-push",
    base: "origin/main",
    cont: false,
    json: false,
    list: false,
    root: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--phase") out.phase = argv[++i];
    else if (a.startsWith("--phase=")) out.phase = a.slice("--phase=".length);
    else if (a === "--base") out.base = argv[++i];
    else if (a.startsWith("--base=")) out.base = a.slice("--base=".length);
    else if (a === "--continue") out.cont = true;
    else if (a === "--json") out.json = true;
    else if (a === "--list") out.list = true;
    else if (a === "--root") out.root = argv[++i];
    else if (a.startsWith("--root=")) out.root = a.slice("--root=".length);
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function npmBin() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

/* Run one gate via `npm run <script> -- <args>`. Injectable runner returns
 * { code, stdout, stderr }. */
function defaultRunner(root, script, args) {
  const r = spawnSync(npmBin(), ["run", script, "--", ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  return { code: r.status == null ? 1 : r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

/* Execute a resolved gate list. Returns { results, failed, skipped, ok }. */
function runGates(root, gates, opts = {}) {
  const scripts = opts.scripts || readScripts(root);
  const run = opts.runner || defaultRunner;
  const results = [];
  let failed = false;
  for (const [script, ...args] of gates) {
    if (!(script in scripts)) {
      results.push({ script, status: "skipped", reason: "not wired in package.json" });
      continue;
    }
    if (failed && !opts.cont) {
      results.push({ script, status: "pending", reason: "skipped after an earlier failure" });
      continue;
    }
    const started = Date.now();
    const res = run(root, script, args);
    const ms = Date.now() - started;
    if (res.code === 0) {
      results.push({ script, status: "pass", ms });
    } else {
      failed = true;
      results.push({ script, status: "fail", ms, code: res.code, output: (res.stdout || "") + (res.stderr || "") });
    }
  }
  return {
    results,
    failed,
    skipped: results.filter((r) => r.status === "skipped").length,
    passed: results.filter((r) => r.status === "pass").length,
  };
}

const MARKS = { pass: "\u2713", fail: "\u2717", skipped: "-", pending: "\u00b7" };

function printHuman(phase, base, outcome) {
  console.log(`gates — phase ${phase}${phase === "all" ? "" : ""} (base ${base})`);
  for (const r of outcome.results) {
    const tail = r.status === "pass" || r.status === "fail" ? ` (${(r.ms / 1000).toFixed(1)}s)` : "";
    console.log(`  ${MARKS[r.status] || "?"} ${r.script}${tail}${r.status === "skipped" ? " — skipped (not wired)" : ""}`);
    if (r.status === "fail") {
      const out = String(r.output || "").trim();
      if (out) console.log(out.split(/\r?\n/).slice(-15).map((l) => "      " + l).join("\n"));
    }
  }
  const verdict = outcome.failed ? "FAIL" : "PASS";
  console.log(`\nRESULT: ${verdict} — ${outcome.passed} passed, ${outcome.results.filter((r) => r.status === "fail").length} failed, ${outcome.skipped} skipped`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "Usage: node scripts/qa/run-gates.js [--phase=pre-push|process|quick|all] [--base=<ref>]\n" +
        "       [--continue] [--json] [--list] [--root <dir>]"
    );
    return;
  }
  const root = path.resolve(args.root || process.cwd());
  const gates = resolveGates(args.phase, args.base);
  if (!gates) {
    console.error(`gates: unknown phase "${args.phase}" (expected: ${Object.keys(PHASES).join(", ")}, all)`);
    process.exit(2);
  }
  if (args.list) {
    for (const g of gates) console.log(g.join(" "));
    return;
  }
  const outcome = runGates(root, gates, { cont: args.cont });
  if (args.json) {
    console.log(JSON.stringify({ schema: "gates/1", phase: args.phase, base: args.base, ...outcome }, null, 2));
  } else {
    printHuman(args.phase, args.base, outcome);
  }
  process.exit(outcome.failed ? 1 : 0);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error("gates: " + (e && e.message ? e.message : e));
    process.exit(1);
  }
}

module.exports = { PHASES, resolveGates, parseArgs, readScripts, runGates, defaultRunner };
