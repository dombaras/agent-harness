#!/usr/bin/env node
"use strict";
/*
 * test:integrate — pre-push rebase check (harness-shipped).
 *
 * Integrate-early gate: fails when the current branch is behind its upstream
 * (`origin/main`), so board/code conflicts surface before push instead of at the
 * merge. Runs a best-effort `git fetch`, then compares HEAD to the upstream
 * tracking branch. On "behind", it fails with the exact rebase + re-gate
 * sequence; on a dirty tree it warns that rebasing needs a clean tree.
 *
 * Exit 0 unless the branch is provably behind its upstream. Skipped outside a
 * git repo / with no upstream configured.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..", "..");

function git(args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (_) {
    return null;
  }
}

function insideGitRepo() {
  const r = git(["rev-parse", "--is-inside-work-tree"]);
  return !!r && r.trim() === "true";
}

function dirtyFiles() {
  const out = git(["status", "--porcelain"]) || "";
  return out.split(/\r?\n/).filter(Boolean);
}

console.log("integrate gate \u2014 rebase onto main before pushing, so conflicts surface early");

if (!insideGitRepo()) {
  console.log("  \u26a0 not a git repo \u2014 integrate gate skipped");
  console.log("\nRESULT: skipped (0 failures)");
  process.exit(0);
}

// Best-effort fetch (never blocks the gate on network/auth failure).
try {
  git(["fetch", "--quiet", "origin"]);
} catch (_) {
  /* offline — rely on the local remote refs */
}

/* The integration TARGET is the canonical branch (`origin/main`), NOT the
 * branch's own upstream (`@{u}` = `origin/<feature>`). Comparing HEAD to the
 * branch's own remote falsely fails every legitimate post-rebase force-push:
 * after `git rebase origin/main`, HEAD is ahead of the stale `origin/<feature>`
 * and the gate demanded a rebase that had just been done, blocking the push.
 * Fall back to `@{u}` only when the canonical branch cannot be determined. */
function integrationTarget() {
  const sym = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (sym) return sym.trim();
  for (const name of ["origin/main", "origin/master"]) {
    if (git(["rev-parse", "--verify", "--quiet", name])) return name;
  }
  return (git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]) || "").trim();
}

const upstream = integrationTarget();
if (!upstream) {
  console.log("  \u26a0 no canonical branch / upstream configured \u2014 integrate gate skipped");
  console.log("\nRESULT: skipped (0 failures)");
  process.exit(0);
}

const counts = (git(["rev-list", "--left-right", "--count", `HEAD...${upstream}`]) || "").trim();
const parts = counts.split(/\s+/);
// `--left-right --count A...B` prints `<A-only>\t<B-only>`; here A=HEAD, B=upstream,
// so A-only = ahead, B-only = behind.
const ahead = parts.length === 2 ? parseInt(parts[0], 10) || 0 : 0;
const behind = parts.length === 2 ? parseInt(parts[1], 10) || 0 : 0;

const dirty = dirtyFiles().length;

if (behind > 0) {
  console.log(`  \u2717 behind ${upstream} by ${behind} commit(s) (ahead ${ahead})`);
  console.log(
    `    rebase first:  git rebase ${upstream}   then re-run: npm run test:backlog && npm run test:concurrency`
  );
  if (dirty) console.log("    \u26a0 working tree is dirty \u2014 commit or stash before rebasing");
  console.log(`\nRESULT: 1 FAILURE \u2014 rebase ${upstream} before push`);
  process.exit(1);
}

console.log(`  \u2713 up to date with ${upstream} (ahead ${ahead})`);
if (dirty) console.log(`  \u26a0 working tree is dirty (${dirty} change(s)) \u2014 commit before push`);
console.log("\nRESULT: green");
process.exit(0);
