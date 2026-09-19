#!/usr/bin/env node
"use strict";
/*
 * finalize — the deterministic finalization tail in ONE command.
 *
 * The problem it solves: a full dev cycle (pick → plan → implement → QA → gates →
 * docs → archive → commit → ship → watch) needs more context than one bounded
 * orchestrator transcript can hold. The context guard therefore stops the
 * session before the finalization steps, and every prior fix only made `ship`
 * better *once it was reached* — it could not create context to reach it.
 *
 * `finalize` collapses the whole tail into a single blocking command:
 *
 *   1. resolve root + feature (id arg, else the `f-<n>` branch);
 *   2. archive the row (idempotent — an already-archived row is a no-op);
 *   3. commit the tail (board + CHANGELOG + handoff + any remaining change);
 *   4. shell out to `scripts/ship.js`, which rebases, gates, pushes, opens the
 *      PR, applies the landing label, and WATCHES to landed + CI + UAT deploy.
 *
 * Because step 4 is one running tool call, the context guard's "let the current
 * step finish" rule covers the entire tail even at the hard turn ceiling: the
 * orchestrator only has to invoke this once. It is safe to re-run — an
 * already-landed feature exits 0, an enqueued-but-unlanded one resumes with
 * `npm run finalize -- --watch-only`.
 *
 * Usage:
 *   node scripts/finalize.js --feature <id> [--closed "<note>"]
 *        [--base main] [--root <dir>] [--dry-run]
 *        [--no-watch] [--watch-only] [--no-rebase] [--no-gate]
 *        [--allow-no-deploy]
 *
 * The one non-deterministic bit — the CHANGELOG prose — is authored by the
 * `/finish` command's single `docs` dispatch BEFORE this runs; `finalize`
 * commits whatever is in the tree.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

/* Run a command, streaming its output. Returns the exit status (0 = ok). */
function run(cmd, args, opts) {
  console.log(`\n$ ${[cmd, ...args].join(" ")}`);
  const result = spawnSync(cmd, args, { stdio: "inherit", ...(opts || {}) });
  return result.status === 0;
}

/* Run a command and capture trimmed stdout (empty string on failure). */
function out(cmd, args, opts) {
  const result = spawnSync(cmd, args, { encoding: "utf8", ...(opts || {}) });
  return result.status === 0 ? String(result.stdout || "").trim() : "";
}

function has(cmd) {
  return spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;
}

/* Walk up from `startDir` to the repo root (the first `.git` entry). */
function findRoot(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readIf(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/* The feature id from a branch name (`f-257` -> `F-257`, `feat/F-12-x` -> `F-12`). */
function featureFromBranch(branch) {
  const m = String(branch || "").match(/(?:^|\/)[fF]-?([0-9]+)/);
  return m ? `F-${m[1]}` : null;
}

/* The handoff's recorded outcome, if any (`## Session metadata` -> `- outcome:`). */
function handoffOutcome(feature) {
  let src = readIf(path.join(root, ".agents", "handoffs", feature + ".md"));
  if (!src) {
    const res = spawnSync("git", ["-C", root, "worktree", "list", "--porcelain"], { encoding: "utf8" });
    for (const line of String(res.stdout || "").split(/\r?\n/)) {
      if (!line.startsWith("worktree ")) continue;
      const dir = line.slice("worktree ".length).trim();
      const candidate = readIf(path.join(dir, ".agents", "handoffs", feature + ".md"));
      if (candidate) {
        src = candidate;
        break;
      }
    }
  }
  const m = src.match(/^[-*]\s*outcome\s*:\s*(.+)$/im);
  return m ? m[1].trim().toLowerCase() : null;
}

/* Whether the row is already archived on the board. Reuses the run-loop parser
 * (same module the auto-resume runner trusts). */
function isArchived(feature) {
  try {
    const loop = require(path.join(root, "scripts", "qa", "run-loop.js"));
    return loop.isArchived(readIf(path.join(root, "BACKLOG.md")), feature);
  } catch {
    return false;
  }
}

/* The state of the branch's newest PR (MERGED/OPEN/CLOSED/CLOSED), or null when
 * gh is unavailable or there is no PR. Used only for idempotence. */
function prState(branch) {
  if (!has("gh")) return null;
  const raw = out("gh", ["pr", "list", "--head", branch, "--state", "all", "--json", "state", "--limit", "1"], {
    cwd: root,
  });
  try {
    const parsed = JSON.parse(raw || "[]");
    return parsed.length ? String(parsed[0].state || "").toUpperCase() : null;
  } catch {
    return null;
  }
}

function dirtyEntries() {
  return out("git", ["status", "--porcelain"], { cwd: root })
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("!!"));
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--feature") args.feature = argv[++i];
    else if (a === "--closed") args.closed = argv[++i];
    else if (a === "--base") args.base = argv[++i];
    else if (a === "--root") args.root = argv[++i];
    else if (a === "--dry-run") args["dry-run"] = true;
    else if (a === "--no-watch") args["no-watch"] = true;
    else if (a === "--watch-only") args["watch-only"] = true;
    else if (a === "--no-rebase") args["no-rebase"] = true;
    else if (a === "--no-gate") args["no-gate"] = true;
    else if (a === "--allow-no-deploy") args["allow-no-deploy"] = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else args._.push(a);
  }
  return args;
}

function usage() {
  console.log(
    "finalize — archive + commit + ship + watch in one deterministic step (no LLM)\n\n" +
      '  node scripts/finalize.js --feature <id> [--closed "<note>"] [--base main]\n' +
      "                           [--root <dir>] [--dry-run] [--no-watch]\n" +
      "                           [--watch-only] [--no-rebase] [--no-gate]\n" +
      "                           [--allow-no-deploy]\n\n" +
      "Collapses the finalization tail into one blocking command so it can never\n" +
      "be starved by the orchestrator's context budget: archive the row, commit the\n" +
      "board + CHANGELOG + handoff, then `ship` (rebase, gates, push, PR, landing\n" +
      "label, and watch to landed + CI + UAT deploy). Safe to re-run."
  );
}

let root = process.cwd();

function shipArgs(args) {
  const passthrough = [];
  if (args.base) passthrough.push("--base", args.base);
  if (args["no-watch"]) passthrough.push("--no-watch");
  if (args["no-rebase"]) passthrough.push("--no-rebase");
  if (args["no-gate"]) passthrough.push("--no-gate");
  if (args["allow-no-deploy"]) passthrough.push("--allow-no-deploy");
  return passthrough;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();

  const found = args.root ? path.resolve(args.root) : findRoot(process.cwd());
  if (!found) return fail("finalize: no git repository found (no .git in this tree or its parents).");
  root = found;

  const branch = out("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root });
  if (!branch) return fail("finalize: could not resolve the current branch.");
  if (branch === "main" || branch === "master") {
    return fail(
      `finalize: refusing to finalize "${branch}" — that is the integration branch.\n` +
        "      Run finalize from the feature worktree."
    );
  }

  const feature = args.feature || featureFromBranch(branch);
  if (!feature) {
    return fail(
      `finalize: could not derive a feature id from branch "${branch}".\n` +
        "      Pass --feature <id> explicitly."
    );
  }

  const shipScript = path.join(root, "scripts", "ship.js");
  if (!fs.existsSync(shipScript)) {
    return fail(`finalize: ${path.relative(root, shipScript)} not found — is the harness deployed in this project?`);
  }

  const closed = args.closed || handoffOutcome(feature) || "shipped";
  const archived = isArchived(feature);

  if (args["dry-run"]) {
    console.log("finalize (dry run)\n");
    console.log(`  root:     ${root}`);
    console.log(`  feature:  ${feature}`);
    console.log(`  branch:   ${branch}`);
    console.log(`  closed:   ${closed}`);
    console.log(`  archived: ${archived ? "yes" : "no"}`);
    console.log(`  plan:     archive -> commit -> ship${args["watch-only"] ? " --watch-only" : ""}`);
    return;
  }

  // Resume a paused watch: the row/PR already exist; just finish observing.
  if (args["watch-only"]) {
    if (!has("gh")) return fail("finalize: `--watch-only` needs `gh` on PATH.");
    if (!run(process.execPath, [shipScript, "--watch-only", ...shipArgs(args)], { cwd: root })) {
      return fail("finalize: the watch did not reach landed + deployed — see the blocker above.");
    }
    console.log(`\n[finalize] ${feature} landed + deployed.`);
    return;
  }

  // Idempotence: an already-archived row whose PR is merged is done.
  if (archived) {
    const state = prState(branch);
    if (state === "MERGED") {
      console.log(`[finalize] ${feature} is already archived and its PR is merged — nothing to do.`);
      return;
    }
    if (state === "OPEN") {
      console.log(`[finalize] ${feature} is archived with an open PR — resuming the watch.`);
      if (!run(process.execPath, [shipScript, "--watch-only", ...shipArgs(args)], { cwd: root })) {
        return fail("finalize: the watch did not reach landed + deployed — see the blocker above.");
      }
      console.log(`\n[finalize] ${feature} landed + deployed.`);
      return;
    }
  }

  const backlogScript = path.join(root, "scripts", "backlog.js");

  // 1. Archive the row (idempotent). The archive runs from inside the worktree,
  //    so it moves the row in THIS board and skips removing this checkout.
  if (!archived) {
    if (!fs.existsSync(backlogScript)) return fail(`finalize: ${path.relative(root, backlogScript)} not found.`);
    if (!run(process.execPath, [backlogScript, "archive", feature, "--closed", closed], { cwd: root })) {
      return fail(`finalize: could not archive ${feature} — fix the board error above, then re-run.`);
    }
  } else {
    console.log(`[finalize] ${feature} is already archived — skipping the board write.`);
  }

  // 2. Commit the tail (board + CHANGELOG + handoff + any remaining change) so
  //    `ship`'s dirty-tree guard cannot abort the documented one-command close.
  const dirty = dirtyEntries();
  if (dirty.length) {
    console.log(
      `\n[finalize] committing the finalization tail:\n` +
        dirty.map((l) => `      ${l}`).join("\n")
    );
    if (!run("git", ["add", "-A"], { cwd: root })) return fail("finalize: `git add -A` failed.");
    if (!run("git", ["commit", "-m", `chore(${feature}): finalize — board + changelog`], { cwd: root })) {
      return fail("finalize: the finalization commit failed.");
    }
  } else {
    console.log("\n[finalize] tree already clean — nothing to commit.");
  }

  // 3. Ship + watch to landed + deployed. ship fails closed on a real blocker
  //    and writes the pending-landing ledger on a deliberate `--no-watch` pause.
  if (!run(process.execPath, [shipScript, ...shipArgs(args)], { cwd: root })) {
    return fail(
      "finalize: ship did not complete. If it enqueued the PR, resume the watch with:\n" +
        `      npm run finalize -- --feature ${feature} --watch-only`
    );
  }

  console.log(`\n[finalize] ${feature} landed + deployed.`);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error("finalize: " + (e && e.message ? e.message : e));
    process.exit(1);
  }
}

module.exports = { featureFromBranch, handoffOutcome };
