#!/usr/bin/env node
"use strict";
/*
 * test:quality — mechanical code-quality gate on NEW/CHANGED code (harness-shipped).
 *
 * The gate side of the canonical rubric in `.agents/memory/quality-parameters.md`
 * (P1 dead-code-free, P3 right-sized units, P4 one home per fact). It runs on the
 * code a change ADDS or GROWS, so debt cannot be *introduced* — legacy debt is
 * cleared by review rows, not blocked here:
 *
 *   1. P3 right-sized units — a changed file that is NEW or GREW past
 *      `--max-lines` (default 1000) is flagged. Touching an already-oversized
 *      legacy file without growing it does NOT flag (that is legacy debt, tracked
 *      as a review row, not a blocker on an unrelated one-line fix).
 *   2. P1 dead-code-free — an exported identifier declared in a changed file that
 *      has ZERO other references in the whole repo (its own declaration is the
 *      only occurrence) is dead. Word-boundary scan, so a reference in any other
 *      file clears it; files that re-export via `export *` are skipped (their
 *      names are not provable by this scanner).
 *
 * Scope resolution (in priority order):
 *   - explicit `--paths a.ts,b.ts` — scan exactly these files;
 *   - else `git diff --name-only <base>...HEAD` — the change's files, where base
 *     defaults to `origin/main`, falling back to `main`, then `HEAD~1`;
 *   - else nothing changed -> green (nothing new to gate).
 *
 *   node scripts/qa/check-quality.js [--base <ref>] [--max-lines N] [--paths a,b] [--strict]
 *
 * Exit 1 on any finding. `--strict` additionally surfaces warnings as failures
 * (use it in CI on the diff; leave it off for the human loop).
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..", "..");

const CODE_EXT = /\.(?:[cm]?[jt]sx?|js)$/;
const IGNORE_DIRS = new Set(["node_modules", ".next", ".git", ".worktrees", ".harness-backup", "dist", "build", ".turbo", ".expo"]);

/* Convention-loaded entrypoints: their exports are consumed by a framework
 * runtime (opencode discovers `.opencode/plugins|tools` by convention; Next.js
 * discovers `route|page|layout|...` and `middleware|instrumentation`), so the
 * zero-consumer scan cannot see an importer and would flag them as dead. Skip
 * P1 for these; P3 (size) still applies. */
const CONVENTION_ENTRY =
  /(?:^|\/)(?:\.opencode\/(?:plugins|tools)\/|app\/(?:.*\/)?(?:route|page|layout|loading|error|not-found|template|default)\.(?:[cm]?[jt]sx?)$|middleware\.[cm]?[jt]sx?$|instrumentation\.[cm]?[jt]sx?$)/;
function isConventionEntry(rel) {
  return CONVENTION_ENTRY.test(String(rel).replace(/\\/g, "/"));
}

const args = process.argv.slice(2);
function flag(name, def) {
  const i = args.indexOf("--" + name);
  return i === -1 ? def : args[i + 1];
}
const maxLines = parseInt(flag("max-lines", "1000"), 10) || 1000;
const base = flag("base", "");
const pathsArg = flag("paths", "");
const strict = args.includes("--strict");

const findings = [];
const warnings = [];
const fail = (m) => {
  findings.push(m);
  console.log("  \u2717 " + m);
};
const warn = (m) => {
  warnings.push(m);
  console.log("  \u26a0 " + m);
};
const pass = (m) => console.log("  \u2713 " + m);

console.log("quality gate \u2014 mechanical quality on NEW/CHANGED code (rubric: .agents/memory/quality-parameters.md)");

function git(a) {
  try {
    return execFileSync("git", a, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (_) {
    return null;
  }
}

function inGitRepo() {
  const r = git(["rev-parse", "--is-inside-work-tree"]);
  return !!r && r.trim() === "true";
}

/* Files to scan: explicit --paths, else the change's files vs a base ref. */
function changedFiles() {
  const candidates = [];
  if (pathsArg) {
    for (const p of pathsArg.split(",")) {
      const f = p.trim();
      if (f) candidates.push(f);
    }
    return candidates;
  }
  if (!inGitRepo()) return [];
  let ref = base || "origin/main";
  const has = (r) => git(["rev-parse", "--verify", "-q", r]) !== null;
  if (!has(ref)) {
    if (has("main")) ref = "main";
    else if (has("HEAD~1")) ref = "HEAD~1";
    else return [];
  }
  const changed = git(["diff", "--name-only", "--diff-filter=ACMR", ref, "--"]);
  if (changed == null) return [];
  const tracked = changed.split(/\r?\n/).filter(Boolean);
  // Untracked new files are not in `git diff` — add them so a brand-new file with
  // a dead export or an oversized body is gated before its first commit.
  const porcelain = git(["status", "--porcelain"]) || "";
  const untracked = porcelain
    .split(/\r?\n/)
    .filter((l) => l.startsWith("??"))
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
  return [...new Set([...tracked, ...untracked])];
}

function walk(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(e.name) || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (CODE_EXT.test(e.name)) out.push(p);
  }
}

function fileList() {
  const out = [];
  walk(root, out);
  return out.map((p) => path.relative(root, p).split(path.sep).join("/"));
}

function baseLineCount(rel) {
  if (!inGitRepo()) return 0;
  const blob = git(["show", `${base || "HEAD~1"}:${rel}`]);
  return blob == null ? 0 : blob.split(/\r?\n/).length;
}

function countLines(rel) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) return 0;
  return fs.readFileSync(p, "utf8").split(/\r?\n/).length;
}

/* Exported top-level identifiers in a JS/TS file (function/const/let/var/class + explicit `export {a, b}`). */
function exportedNames(src) {
  const names = new Set();
  const reDecl =
    /\bexport\s+(?:async\s+)?(?:function\s+|const\s+|let\s+|var\s+|class\s+|interface\s+|type\s+)([A-Za-z_$][\w$]*)/g;
  const reList = /\bexport\s*\{([^}]+)\}/g;
  let m;
  while ((m = reDecl.exec(src))) names.add(m[1]);
  while ((m = reList.exec(src))) {
    for (const part of m[1].split(",")) {
      const n = part.trim().split(/\s+as\s+/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n);
    }
  }
  return [...names];
}

/* Count word-boundary occurrences of `name` across all repo code files. */
function repoOccurrences(name, rels) {
  const re = new RegExp("\\b" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "g");
  let total = 0;
  for (const rel of rels) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, "utf8");
    const hits = src.match(re);
    if (hits) total += hits.length;
  }
  return total;
}

function lineCount(rel) {
  return countLines(rel);
}

// ---- scope ------------------------------------------------------------------
const changed = changedFiles();
const rels = fileList();
const codeChanged = changed.filter((f) => CODE_EXT.test(f));
if (pathsArg && codeChanged.length === 0) {
  fail(`--paths given but none matched code files (${pathsArg})`);
}

if (codeChanged.length === 0) {
  console.log("  \u2713 no NEW/GROWN code files in scope \u2014 nothing to gate");
} else {
  pass(`${codeChanged.length} changed code file(s) in scope`);
}

// ---- P3: right-sized units --------------------------------------------------
for (const rel of codeChanged) {
  const n = lineCount(rel);
  const baseN = baseLineCount(rel);
  const isNew = baseN === 0;
  const grew = n > baseN && n > maxLines && baseN <= maxLines;
  if (n > maxLines && (isNew || grew)) {
    fail(
      `${rel} is ${n} lines (limit ${maxLines}) \u2014 right-size it: extract components/modules (quality parameter P3).`
    );
  } else if (n > maxLines) {
    warn(
      `${rel} is ${n} lines (already oversized; not grown by this change) \u2014 legacy debt, file a review row, don't grow it further.`
    );
  }
}

// ---- P1: zero-consumer exports ----------------------------------------------
for (const rel of codeChanged) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) continue;
  if (isConventionEntry(rel)) {
    warnings.push(`${rel}: convention-loaded entrypoint — zero-consumer scan skipped`);
    console.log("  \u26a0 " + warnings[warnings.length - 1]);
    continue;
  }
  const src = fs.readFileSync(p, "utf8");
  if (/\bexport\s*\*\s*from\b/.test(src)) {
    warnings.push(`${rel}: re-exports via \`export *\` \u2014 zero-consumer scan skipped for it`);
    console.log("  \u26a0 " + warnings[warnings.length - 1]);
    continue;
  }
  for (const name of exportedNames(src)) {
    const occ = repoOccurrences(name, rels);
    if (occ <= 1) {
      const declLine =
        src
          .split(/\r?\n/)
          .findIndex((l) => new RegExp("\\b" + name + "\\b").test(l) && /export/.test(l)) + 1;
      fail(`${rel}: export \`${name}\` has no consumer anywhere (${occ} occurrence(s) \u2014 its own declaration, line ${declLine}). Dead code (quality parameter P1).`);
    }
  }
}

// ---- result ---------------------------------------------------------------
console.log(
  "\nRESULT: " +
    (findings.length
      ? `${findings.length} FAILURE(S) \u2014 new/changed code must not introduce dead exports or oversized files`
      : "green \u2014 changed code is free of dead exports and oversized files")
);
process.exit(findings.length ? 1 : 0);
