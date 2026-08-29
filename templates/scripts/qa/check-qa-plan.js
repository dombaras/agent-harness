#!/usr/bin/env node
"use strict";
/*
 * test:qa-plan — diff-coverage gate (harness-shipped).
 *
 * The anti-verification-from-unrelated-suites gate. A tier label never proves
 * coverage; this gate forces a change's QA plan to actually cover the code it
 * modified — otherwise "verified" is meaningless.
 *
 * It inspects the live git diff and requires every changed CODE path to appear
 * in the QA plan's `## Coverage map` (persisted by qa-architect, or by the main
 * orchestrator as the qa-architect fallback) BEFORE a change may be declared
 * verified. Trivial diffs (copy/docs/non-code) and waivered paths are exempt.
 *
 *   node scripts/qa/check-qa-plan.js                 # diff vs HEAD
 *   node scripts/qa/check-qa-plan.js --base main     # diff vs a ref
 *   node scripts/qa/check-qa-plan.js --strict        # non-code changes too
 *
 * Exit 0 on: no code-path changes, full coverage, or valid per-path waivers.
 * Exit 1 on: a changed code path with no covering assertion and no waiver.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..", "..");

const argv = process.argv.slice(2);
const base = (argv.find((a) => a.startsWith("--base=")) || "").split("=")[1] || "HEAD";
const strict = argv.includes("--strict");

// Paths that are tooling/harness, not application code under test. A change
// that only touches these needs no runtime QA plan (they are guarded by
// test:dispatch / test:governance themselves).
const TOOLING = [
  "opencode.json",
  ".harness.json",
  ".opencode/",
  ".agents/",
  "scripts/qa/",
  ".github/",
  "package.json",
];
// Non-code files never need a runtime path (copy/docs/styling/data-flat).
const NON_CODE = /\.(md|mdx|png|jpg|jpeg|gif|svg|webp|ico|json|lock|txt|env|yml|yaml|toml|csv)$/i;

const CODE = /\.(ts|tsx|js|jsx|css|scss|sass|prisma|sql)$/i;

function norm(p) {
  return p.replace(/\\/g, "/");
}

function gitChangedFiles() {
  let files = [];
  try {
    const out = execFileSync("git", ["diff", "--name-only", base, "--"], {
      cwd: root,
      encoding: "utf8",
    });
    files = out.split(/\r?\n/).filter(Boolean);
  } catch (e) {
    // 128 = not a git repo / bad ref / no base history (e.g. empty repo).
    if (e.status === 128) return null;
    throw e;
  }
  // include untracked files so brand-new sources can't silently skip the gate
  try {
    const untracked = execFileSync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "--", root],
      { cwd: root, encoding: "utf8" }
    )
      .split(/\r?\n/)
      .filter(Boolean);
    files = [...new Set([...files, ...untracked])];
  } catch (_) {
    /* ls-files is best-effort */
  }
  return files.map(norm);
}

function isTooling(p) {
  const n = norm(p);
  return TOOLING.some((t) => n === t || n.startsWith(t));
}

/* Parse the QA plan file into { covered:Set, waivers:Set } of normalized paths.
 * Coverage map format (one entry per changed path, under `## Coverage map`):
 *   - components/return/ReturnConfirmDrawer.tsx -> test:quick::progression (click-through)
 * Waivers live anywhere and carry a reason on the same line:
 *   waived: components/nav.tsx reason: pure-copy change, no runtime path
 */
function parsePlan(file) {
  const out = { covered: new Set(), waivers: new Set() };
  if (!fs.existsSync(file)) return out;
  const src = fs.readFileSync(file, "utf8");
  const lines = src.split(/\r?\n/);

  // Coverage map section only
  let inMap = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || /^[#;/]/.test(line)) continue;
    if (/^#{1,6}\s*Coverage map\s*$/i.test(line)) {
      inMap = true;
      continue;
    }
    if (inMap && /^#{1,6}\s/.test(line)) inMap = false;
    if (!inMap) continue;

    const m = line.match(/^[-*]\s*["']?([^\s"'>]+)/);
    if (m) out.covered.add(norm(m[1]));
  }

  // Waivers (anywhere) — path then reason
  for (const raw of lines) {
    const line = raw.trim();
    if (!/\bwaived:\s*\S/i.test(line)) continue;
    const p = (line.match(/\bwaived:\s*["']?([^\s"',]+)/i) || [])[1];
    if (p && /\breason:\s*\S/i.test(line)) out.waivers.add(norm(p));
  }
  return out;
}

function isCovered(pathi, covered, waivers) {
  if (covered.has(pathi) || waivers.has(pathi)) return true;
  // directory-prefix coverage (a plan may cover a whole folder)
  for (const c of covered) if (pathi.startsWith(c.replace(/\/?$/, "/"))) return true;
  for (const w of waivers) if (pathi.startsWith(w.replace(/\/?$/, "/"))) return true;
  return false;
}

const failures = [];
const pass = (m) => console.log("  \u2713 " + m);
const fail = (m) => {
  failures.push(m);
  console.log("  \u2717 " + m);
};

console.log("diff-coverage gate \u2014 QA plan covers every changed code path");

const changed = gitChangedFiles();
if (changed == null) {
  console.log("  \u26a0 not a git repo or no base history \u2014 coverage gate skipped");
  console.log("\nRESULT: skipped (0 failures)");
  process.exit(0);
}
if (changed.length === 0) {
  console.log("  \u2713 no diff vs " + base + " \u2014 nothing to cover");
  console.log("\nRESULT: green");
  process.exit(0);
}

const plan = path.join(root, ".agents", "memory", "qa-plan.md");
const { covered, waivers } = parsePlan(plan);

console.log(`  checked against: ${path.relative(root, plan)}`);

let codeTouched = false;
for (const f of changed) {
  if (isTooling(f)) {
    pass(`${f} (harness/tooling \u2014 self-guarded)`);
    continue;
  }
  if (NON_CODE.test(f) && !strict) {
    pass(`${f} (non-code \u2014 no runtime path required)`);
    continue;
  }
  if (!CODE.test(f)) {
    pass(`${f} (not a code path)`);
    continue;
  }
  codeTouched = true;
  if (isCovered(f, covered, waivers)) pass(`${f} covered by QA plan`);
  else
    fail(
      `${f} NOT covered \u2014 add it to the \`## Coverage map\` in qa-plan.md (or a waivered entry with a reason)`
    );
}

if (!codeTouched) {
  console.log("  \u2713 no application code paths changed");
}
console.log(
  "\nRESULT: " +
    (failures.length
      ? `${failures.length} FAILURE(S) \u2014 every changed code path needs a covering assertion or a waivered reason`
      : "green \u2014 all changed code paths have a covering QA plan")
);
process.exit(failures.length ? 1 : 0);
