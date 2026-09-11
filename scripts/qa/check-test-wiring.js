#!/usr/bin/env node
"use strict";
/*
 * test:wiring — orphan-test detector (harness-shipped).
 *
 * The mechanical side of test-design parameter T7: "a test that is authored but
 * wired into no tier is not coverage". A `*.test.*` / `*.spec.*` file that no
 * package.json script executes is neither regression protection nor a failure
 * signal — it is dead weight that looks like coverage on a plan. F-105/F-117
 * shipped exactly this (authored-then-unreferenced suites a later change had to
 * wire by hand).
 *
 * Wiring rules:
 *   1. Explicit reference — some script names the file directly, by directory
 *      prefix, or via a glob. This is the strong signal.
 *   2. Managed directory — once ANY test file in a directory is explicitly
 *      referenced, every other test file in that directory must be too (or be
 *      waived). This is the F-105/F-117 failure mode: a test authored next to
 *      the wired ones and forgotten.
 *   3. Default-discovery notice — a bare runner script (`vitest run`, bare
 *      `node --test`, `playwright test`, ...) DOES execute its default matches,
 *      but per-file wiring cannot be proven. Files in UNMANAGED directories are
 *      reported as notices and pass; `--strict` upgrades notices to failures for
 *      projects that want provable wiring.
 *
 * A deliberate orphan carries an explicit, auditable waiver comment in the file:
 *   // test-wiring-waived: reason — <why this file intentionally runs nowhere>
 *
 *   node scripts/qa/check-test-wiring.js            # orphan tests fail
 *   node scripts/qa/check-test-wiring.js --strict   # discovery notices fail too
 *
 * Exit 0 when every test file is wired, discovery-covered, or waived; exit 1 on
 * any orphan (or any notice under --strict).
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "..");
const strict = process.argv.includes("--strict");

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".worktrees",
  ".harness-backup",
  ".serve",
  "dist",
  "build",
  "out",
  "coverage",
  ".turbo",
  ".expo",
  ".vercel",
]);

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const RUNNERS = new Set(["vitest", "jest", "mocha", "ava", "tap", "playwright"]);
const RUNNER_NOISE = new Set([
  "npx",
  "npx.cmd",
  "pnpm",
  "pnpm.cmd",
  "yarn",
  "npm",
  "run",
  "dlx",
  "exec",
  "node",
  "node.exe",
  "tsx",
  "tsx.cmd",
  "ts-node",
]);

const pkgPath = path.join(root, "package.json");
if (!fs.existsSync(pkgPath)) {
  console.error("FATAL: no package.json in project root");
  process.exit(2);
}
let scripts = {};
try {
  scripts = JSON.parse(fs.readFileSync(pkgPath, "utf8")).scripts || {};
} catch (e) {
  console.error(`FATAL: unparseable package.json: ${e.message}`);
  process.exit(2);
}

function norm(p) {
  return p.replace(/\\/g, "/");
}

/* Strip shell decoration (quotes, chain operators, list commas) from a token. */
function cleanToken(t) {
  return t
    .replace(/^["']|["']$/g, "")
    .replace(/^(?:&&|\|\||[;&|<>])+/, "")
    .replace(/(?:&&|\|\||[;&|<>])+$/, "")
    .replace(/^,|,$/g, "");
}

function tokens(cmd) {
  return String(cmd)
    .split(/\s+/)
    .map(cleanToken)
    .filter(Boolean);
}

function hasGlobMagic(t) {
  return /[*?]/.test(t);
}

function globToRegExp(glob) {
  const g = norm(glob);
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        re += ".*";
        i++;
        if (g[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp("^" + re + "$");
}

function tokenMatches(token, rel) {
  const t = norm(token).replace(/^\.\//, "").replace(/\/+$/, "");
  if (!t) return false;
  if (hasGlobMagic(t)) return globToRegExp(t).test(rel);
  return rel === t || rel.startsWith(t + "/");
}

/* A bare runner command has no path/glob argument, so it executes its default
 * discovery matches (e.g. `vitest run`, bare `node --test`). Install/init
 * subcommands are not test runs. */
function isDiscoveryCommand(cmd) {
  const ts = tokens(cmd);
  const runnerIdx = ts.findIndex((t) => RUNNERS.has(t));
  const usesNodeTest = ts.includes("--test") || ts.includes("--test-only");
  if (runnerIdx !== -1 && ["install", "init", "--version", "-v"].includes(ts[runnerIdx + 1] || "")) {
    return false;
  }
  if (runnerIdx === -1 && !usesNodeTest) return false;
  const pathArg = ts.some(
    (t) =>
      !t.startsWith("-") &&
      !RUNNERS.has(t) &&
      !RUNNER_NOISE.has(t) &&
      /[\\/]|^\.[\\/]|[*?]/.test(t)
  );
  return !pathArg;
}

function walk(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (TEST_FILE.test(entry.name)) out.push(abs);
  }
}

function dirOf(rel) {
  const i = rel.lastIndexOf("/");
  return i === -1 ? "." : rel.slice(0, i);
}

const commands = Object.values(scripts);
const discoveryCommands = commands.filter(isDiscoveryCommand);
const testFiles = [];
walk(root, testFiles);

console.log("test-wiring gate \u2014 every *.test.* file is executed by a package script (T7)");

const wired = [];
const waived = [];
const notices = [];
const orphans = [];
const managedDirs = new Set();

for (const abs of testFiles.sort()) {
  const rel = norm(path.relative(root, abs));
  const src = fs.readFileSync(abs, "utf8");
  const waiver = src.match(/test-wiring-waived:\s*(\S[^\r\n]*)/i);
  if (waiver) {
    waived.push({ rel, reason: waiver[1].trim() });
    continue;
  }
  let matched = null;
  for (const cmd of commands) {
    const tok = tokens(cmd).find((t) => tokenMatches(t, rel));
    if (tok) {
      matched = { rel, via: tok };
      break;
    }
  }
  if (matched) {
    wired.push(matched);
    managedDirs.add(dirOf(rel));
  }
}

for (const abs of testFiles.sort()) {
  const rel = norm(path.relative(root, abs));
  if (wired.some((w) => w.rel === rel) || waived.some((w) => w.rel === rel)) continue;
  if (!managedDirs.has(dirOf(rel)) && discoveryCommands.length) {
    notices.push({ rel, cmd: discoveryCommands[0] });
    continue;
  }
  orphans.push(rel);
}

function short(cmd) {
  const s = String(cmd);
  return s.length > 90 ? s.slice(0, 87) + "..." : s;
}

for (const w of wired) console.log(`  \u2713 ${w.rel} (wired via \`${w.via}\`)`);
for (const w of waived) console.log(`  \u2713 ${w.rel} (waived: ${w.reason})`);
for (const n of notices) {
  console.log(`  \u26a0 ${n.rel} not referenced by any script \u2014 covered by default-discovery \`${short(n.cmd)}\` (not provable per-file)`);
}

const failures = [...orphans];
for (const n of notices) {
  if (strict) failures.push(n.rel);
}

for (const rel of orphans) {
  console.log(
    `  \u2717 ${rel} is in an explicitly-managed test directory but no package.json script executes it`
  );
}

if (!testFiles.length) console.log("  \u2713 no test files found \u2014 nothing to wire");

console.log(
  "\nRESULT: " +
    (failures.length
      ? `${failures.length} ORPHAN test file(s) \u2014 wire each into its cheapest tier command (or delete it / add \`// test-wiring-waived: reason\`). A test in no script is not coverage (T7).`
      : "green \u2014 every test file is wired or explicitly waived")
);
process.exit(failures.length ? 1 : 0);
