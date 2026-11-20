#!/usr/bin/env node
"use strict";
/*
 * worktree-hygiene — one source of truth for "is this checkout closed out?".
 *
 * The failure this prevents: a session lands its feature worktree, then ends
 * with "main is N commits behind and dirty" and "worktree <id> is still in
 * place — prune it later". Both are invisible to every gate, so they
 * accumulate: merged worktrees pile up, the main checkout drifts, and the next
 * session works on top of unrelated uncommitted edits (which is exactly how
 * two sessions collide in CHANGELOG.md / package.json / AGENTS.md).
 *
 * Everything here is read-only and cheap: `git worktree list --porcelain` plus
 * one `git status` / `git rev-list` per worktree. Callers decide the policy:
 *
 *   - finalize/ship:  warn + converge the main checkout after a landing
 *   - check-worktrees: fail when a merged worktree is left behind or main is stale
 *   - orient:         show the summary at session start
 *
 * Usage:
 *   node scripts/qa/worktree-hygiene.js [--root <dir>] [--base main] [--json]
 */
const { spawnSync } = require("child_process");
const path = require("path");

function git(dir, args) {
  const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  return {
    ok: res.status === 0,
    out: String(res.stdout || "").trim(),
    err: String(res.stderr || "").trim(),
  };
}

/* Parse `git worktree list --porcelain` into records. The first record is the
 * main checkout (the only one without `worktree` pointing under .worktrees). */
function listWorktrees(root) {
  const res = git(root, ["worktree", "list", "--porcelain"]);
  if (!res.ok) return [];
  const records = [];
  let current = null;
  for (const line of res.out.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length).trim(), head: null, branch: null, bare: false, detached: false, locked: false, prunable: false };
      records.push(current);
    } else if (!current) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length).trim();
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      current.branch = ref.replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      current.detached = true;
    } else if (line === "bare") {
      current.bare = true;
    } else if (line.startsWith("locked")) {
      current.locked = true;
    } else if (line.startsWith("prunable")) {
      current.prunable = true;
    }
  }
  return records;
}

/* Dirty entries, excluding ignored files. */
function statusEntries(dir) {
  const res = git(dir, ["status", "--porcelain"]);
  if (!res.ok) return [];
  return res.out.split(/\r?\n/).filter((l) => l && !l.startsWith("!!"));
}

function revListCount(dir, range) {
  const res = git(dir, ["rev-list", "--count", range]);
  const n = Number(res.out);
  return Number.isFinite(n) ? n : 0;
}

/* Is `ref` contained in `baseRef`? Callers fetch beforehand when they want a
 * network-fresh answer; this function never touches the network. */
function isMerged(dir, ref, baseRef) {
  if (!ref || !baseRef) return false;
  return git(dir, ["merge-base", "--is-ancestor", ref, baseRef]).ok;
}

/**
 * Summarise the repo's worktree hygiene.
 *
 * @param {string} root  any path inside the repo (main or linked worktree)
 * @param {string} base  integration branch name (default "main")
 * @param {string} [cwd] the caller's checkout, marked `current: true`
 * @returns {object|null} null when `root` is not a git repo
 */
function hygiene(root, base = "main", cwd = process.cwd()) {
  const worktrees = listWorktrees(root);
  if (!worktrees.length) return null;
  const main = worktrees[0];
  const currentPath = (() => {
    const res = git(cwd, ["rev-parse", "--show-toplevel"]);
    return res.ok ? res.out : path.resolve(cwd);
  })();
  const baseRef = `origin/${base}`;
  const hasBase = git(root, ["rev-parse", "--verify", "--quiet", baseRef]).ok;
  const mainBranch = main.branch || base;
  const mainHead = main.head || git(main.path, ["rev-parse", "HEAD"]).out;

  const records = worktrees.map((wt) => {
    const dirty = statusEntries(wt.path);
    const merged = wt.path === main.path ? false : hasBase && isMerged(wt.path, wt.head, baseRef);
    return {
      ...wt,
      current: path.resolve(wt.path) === path.resolve(currentPath),
      main: wt.path === main.path,
      dirty: dirty.length,
      dirtyEntries: dirty.slice(0, 20),
      merged,
    };
  });

  const linked = records.filter((r) => !r.main);
  const mainDirty = records[0].dirtyEntries;
  const mainAhead = hasBase ? revListCount(main.path, `${baseRef}..${mainHead}`) : 0;
  const mainBehind = hasBase ? revListCount(main.path, `${mainHead}..${baseRef}`) : 0;

  return {
    base,
    baseRef,
    hasBase,
    main: {
      path: main.path,
      branch: mainBranch,
      head: mainHead,
      dirty: mainDirty.length,
      dirtyEntries: mainDirty,
      ahead: mainAhead,
      behind: mainBehind,
      current: records[0].current,
    },
    worktrees: records,
    linked,
    // A linked worktree that is fully merged and clean is pure leftovers.
    stale: linked.filter((w) => w.merged && w.dirty === 0),
    // A merged worktree with uncommitted work cannot be pruned and will
    // collide with whichever session edits the same files next.
    mergedDirty: linked.filter((w) => w.merged && w.dirty > 0),
  };
}

/* One-paragraph human summary, reused by finalize/ship/orient. */
function describe(h) {
  if (!h) return "worktree hygiene: not a git repository";
  const lines = [];
  if (!h.hasBase) lines.push(`(no ${h.baseRef} yet — merge/behind counts skipped)`);
  else if (h.main.behind > 0) lines.push(`main checkout is ${h.main.behind} commit(s) BEHIND ${h.baseRef}`);
  else if (h.main.ahead > 0) lines.push(`main checkout is ${h.main.ahead} commit(s) AHEAD of ${h.baseRef} (unpushed)`);
  else lines.push(`main checkout is in sync with ${h.baseRef}`);
  if (h.main.dirty) lines.push(`main checkout has ${h.main.dirty} uncommitted entr${h.main.dirty === 1 ? "y" : "ies"}`);
  if (h.stale.length) lines.push(`${h.stale.length} merged worktree(s) left on disk: ${h.stale.map((w) => w.branch || w.path).join(", ")}`);
  if (h.mergedDirty.length)
    lines.push(`${h.mergedDirty.length} merged worktree(s) still dirty (cannot prune): ${h.mergedDirty.map((w) => w.branch || w.path).join(", ")}`);
  return lines.join("; ");
}

/* Close-out advice for a session that just landed a feature. */
function closeOutAdvice(h) {
  const advice = [];
  if (!h) return advice;
  if (h.main.behind > 0) {
    advice.push(
      h.main.dirty
        ? `main checkout is ${h.main.behind} behind and has uncommitted work — commit/stash it, then: git -C ${h.main.path} merge --ff-only ${h.baseRef}`
        : `converge the main checkout: git -C ${h.main.path} merge --ff-only ${h.baseRef}`
    );
  }
  if (h.stale.length) {
    advice.push(`remove merged worktrees: node scripts/backlog.js worktree-prune`);
  }
  if (h.mergedDirty.length) {
    advice.push(
      `merged worktree(s) still dirty — commit or discard before pruning: ${h.mergedDirty
        .map((w) => `${w.path} (${w.dirty} entries)`)
        .join(", ")}`
    );
  }
  return advice;
}

function main() {
  const argv = process.argv.slice(2);
  const args = { base: "main", json: false, root: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") args.root = path.resolve(argv[++i]);
    else if (a === "--base") args.base = argv[++i];
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") {
      console.log("worktree-hygiene — report main-checkout drift and leftover merged worktrees\n\n  node scripts/qa/worktree-hygiene.js [--root <dir>] [--base main] [--json]");
      return;
    }
  }
  const h = hygiene(args.root, args.base);
  if (args.json) {
    console.log(JSON.stringify(h, null, 2));
    return;
  }
  console.log(`worktree hygiene (${h ? h.base : "n/a"})\n  ${describe(h)}`);
  for (const w of h ? h.linked : []) {
    const flags = [w.merged ? "merged" : "unmerged", w.dirty ? `${w.dirty} dirty` : "clean", w.current ? "current" : null].filter(Boolean);
    console.log(`  - ${w.branch || "(detached)"}  ${w.path}  [${flags.join(", ")}]`);
  }
  const advice = closeOutAdvice(h);
  if (advice.length) console.log("\nClose-out:\n" + advice.map((a) => `  - ${a}`).join("\n"));
}

if (require.main === module) main();

module.exports = { listWorktrees, statusEntries, isMerged, hygiene, describe, closeOutAdvice };
