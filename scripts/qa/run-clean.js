#!/usr/bin/env node
"use strict";
/*
 * run-clean — run a project gate against the COMMITTED state, not the live tree.
 *
 * The pre-push floor (`npm run test:quick`) verifies the working tree, so a
 * concurrent session's half-done files (e.g. a page referencing translation keys
 * not yet in messages/*.json) fail YOUR push. Wrap the gate with this to verify
 * only what you committed:
 *
 *   node scripts/qa/run-clean.js -- npm run test:quick
 *
 * If the working tree is clean, the command runs in place. If it is dirty, the
 * wrapper stashes every uncommitted + untracked file (gitignored files like
 * node_modules are untouched, so the gate still resolves its deps), runs the
 * command, then restores the stash. It never silently swallows the stash: a
 * failed `stash pop` leaves the work in the stash and prints a recovery hint.
 *
 * Args are passed through the shell, so quote arguments that need quoting
 * (e.g. `-- npm run test:quick -- --grep "a b"`).
 */
const { spawnSync } = require("child_process");
const path = require("path");

const root = path.resolve(__dirname, "..", "..");
const argv = process.argv.slice(2);
if (argv[0] === "--") argv.shift();
if (argv.length === 0) {
  console.error("run-clean: usage: node scripts/qa/run-clean.js -- <command> [args...]");
  process.exit(2);
}

function git(args) {
  return spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runCmd(args) {
  const r = spawnSync(args.join(" "), { cwd: root, stdio: "inherit", shell: true });
  return r.status == null ? 1 : r.status;
}

const inRepo = git(["rev-parse", "--is-inside-work-tree"]).status === 0;
const dirty = inRepo && (git(["status", "--porcelain"]).stdout || "").trim() !== "";

if (!dirty) {
  process.exit(runCmd(argv));
}

console.log(
  "run-clean: working tree is dirty \u2014 stashing to verify the committed state " +
    "(another session's WIP will not leak into this gate):"
);
console.log(git(["status", "--porcelain"]).stdout.trimEnd());

const stamp = new Date().toISOString();
const st = git(["stash", "push", "--include-untracked", "-m", `agent-harness run-clean ${stamp}`]);
if (st.status !== 0) {
  console.error("run-clean: git stash failed \u2014 refusing to run on a dirty tree:\n" + (st.stderr || "").trim());
  process.exit(1);
}

let exit;
try {
  exit = runCmd(argv);
} finally {
  const pop = git(["stash", "pop"]);
  if (pop.status !== 0) {
    console.error(
      "\nrun-clean: WARNING \u2014 `git stash pop` failed. Your changes are still in the stash:\n" +
        (pop.stderr || "").trim()
    );
    console.error(
      "run-clean: recover with `git stash list` then `git stash pop` (or `git stash apply stash@{0}`)."
    );
  } else {
    console.log("\nrun-clean: restored the working tree from the stash.");
  }
}
process.exit(exit);
