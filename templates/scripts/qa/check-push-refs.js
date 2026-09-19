#!/usr/bin/env node
"use strict";
/*
 * test:push-refs — the local "never push the integration branch" guard.
 *
 * Branch protection is the real control, but it is unavailable on private repos
 * without a paid plan, and the merge train only works if nobody bypasses it. This
 * gate is the portable floor: wired into the project's `pre-push` hook, it reads
 * the refs git is about to update and refuses a direct push to `main`/`master`.
 *
 * This is the counterpart to `ship` (which refuses to *run* on main). Without it
 * `git push origin HEAD:main` from any session lands a change with no PR, no CI
 * gate, and no merge-train re-validation.
 *
 * Git invokes a pre-push hook with lines on stdin:
 *   <local ref> <local sha> <remote ref> <remote sha>
 * A deletion has remote sha 0000...; it is still a main update and is refused.
 *
 * Escape hatch (harness maintenance / bootstrapping only): HARNESS_ALLOW_MAIN_PUSH=1.
 * `agent-harness update` pushes its own `chore(harness)` commit with --no-verify,
 * so harness maintenance is never blocked by this guard.
 *
 * Usage (from the hook):
 *   node scripts/qa/check-push-refs.js
 *
 * Exit 0 when no integration branch is being pushed; exit 1 otherwise.
 */
const fs = require("fs");

const INTEGRATION = /^refs\/heads\/(main|master)$/;

let input = "";
try {
  input = fs.readFileSync(0, "utf8");
} catch (_) {
  /* no stdin (run outside a hook) — nothing to guard */
}

const lines = input
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean);

console.log("push-refs gate \u2014 never push the integration branch directly");

if (process.env.HARNESS_ALLOW_MAIN_PUSH === "1") {
  console.log("  \u26a0 HARNESS_ALLOW_MAIN_PUSH=1 \u2014 main/master push guard disabled");
  console.log("\nRESULT: skipped (0 failures)");
  process.exit(0);
}

const blocked = [];
for (const line of lines) {
  // <local ref> <local sha> <remote ref> <remote sha>
  const parts = line.split(/\s+/);
  const localRef = parts[0] || "";
  const remoteRef = parts[2] || localRef;
  if (INTEGRATION.test(remoteRef) || INTEGRATION.test(localRef)) {
    blocked.push(remoteRef || localRef);
  }
}

if (blocked.length > 0) {
  console.log(`  \u2717 refusing to push ${[...new Set(blocked)].join(", ")}`);
  console.log(
    "    Landing is the merge train's job. Ship the branch instead:\n" +
      "      npm run ship\n" +
      "    (Integration-branch maintenance via `agent-harness update` uses --no-verify.)"
  );
  console.log("\nRESULT: 1 FAILURE \u2014 direct push to the integration branch refused");
  process.exit(1);
}

console.log("  \u2713 no integration-branch ref in this push");
console.log("\nRESULT: green");
process.exit(0);
