#!/usr/bin/env node
"use strict";
/*
 * check-worktrees — fail the gate battery when a landing left the repo open.
 *
 * This is the enforcement half of worktree-hygiene. `finalize`/`ship` now
 * converge the main checkout and print the close-out, but a session can still
 * end without those (hand-run ship, interrupted finalize, a crashed agent).
 * The leftovers were invisible until a human read the session summary:
 *
 *   - the main checkout drifts N commits behind origin/main and accumulates
 *     unrelated uncommitted work, so the next feature lands on top of it and
 *     two sessions collide in CHANGELOG.md / package.json / AGENTS.md;
 *   - merged, clean feature worktrees stay on disk forever ("prune later").
 *
 * Policy (local only — CI has no developer worktrees):
 *   FAIL  main checkout behind origin/<base>
 *   FAIL  merged + clean linked worktree left on disk
 *   FAIL  merged worktree with uncommitted work (cannot be pruned safely)
 *   WARN  main checkout dirty (unrelated WIP still present)
 *
 * Usage:
 *   node scripts/qa/check-worktrees.js [--root <dir>] [--base main] [--json]
 */
const path = require("path");
const hygiene = require("./worktree-hygiene.js");

function main() {
  const argv = process.argv.slice(2);
  const args = { root: process.cwd(), base: "main", json: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") args.root = path.resolve(argv[++i]);
    else if (a === "--base") args.base = argv[++i];
    else if (a === "--json") args.json = true;
    else if (a === "--force") args.force = true;
    else if (a === "--help" || a === "-h") {
      console.log("check-worktrees — fail when main is stale or a merged worktree is left behind\n\n  node scripts/qa/check-worktrees.js [--root <dir>] [--base main] [--json]");
      return;
    }
  }

  // CI runners are fresh clones with no developer worktrees or local drift.
  if (process.env.CI && !args.force) {
    console.log("check-worktrees: skipped in CI (no developer worktrees)");
    return;
  }

  const h = hygiene.hygiene(args.root, args.base);
  if (!h) {
    console.log("check-worktrees: not a git repository — skipped");
    return;
  }
  if (!h.hasBase) {
    console.log(`check-worktrees: no ${h.baseRef} — skipped (nothing to compare)`);
    return;
  }

  if (args.json) console.log(JSON.stringify(h, null, 2));

  const failures = [];
  if (h.main.behind > 0) {
    failures.push(
      `main checkout is ${h.main.behind} commit(s) behind ${h.baseRef} — converge it: git -C ${h.main.path} merge --ff-only ${h.baseRef}`
    );
  }
  for (const w of h.stale) {
    failures.push(`merged worktree left behind: ${w.path} (${w.branch || "detached"}) — node scripts/backlog.js worktree-prune`);
  }
  for (const w of h.mergedDirty) {
    failures.push(
      `merged worktree still dirty (${w.dirty} entr${w.dirty === 1 ? "y" : "ies"}): ${w.path} (${w.branch || "detached"}) — commit or discard, then prune`
    );
  }

  console.log(`check-worktrees: ${hygiene.describe(h)}`);
  if (h.main.dirty) {
    console.warn(`\ncheck-worktrees: WARN — main checkout has ${h.main.dirty} uncommitted entr${h.main.dirty === 1 ? "y" : "ies"}:`);
    for (const l of h.main.dirtyEntries) console.warn(`  ${l}`);
    console.warn("  Land features from their worktree; keep main clean so it can fast-forward.");
  }
  if (failures.length) {
    console.error("\ncheck-worktrees: FAIL");
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log("check-worktrees: OK — main is current and no merged worktree remains");
}

if (require.main === module) main();

module.exports = { main };
