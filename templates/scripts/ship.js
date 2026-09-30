#!/usr/bin/env node
"use strict";
/*
 * ship — deterministic branch lander (no LLM).
 *
 * Direct-land flow (the bootstrap-simple cycle for a one-person shop): a session
 * ends by rebasing its gated branch onto the integration branch and pushing it
 * straight to `main`, then waiting only for CI to go green on the landed SHA.
 * There is no PR, no landing label, no merge train, and no deploy watch — the
 * deploy workflow is triggered by CI success on `main` (workflow_run), so the
 * session never has to babysit a 10–20 minute asynchronous tail.
 *
 *   1. refuse `main` (never ship the integration branch) or a dirty tree;
 *      a `.agents/handoffs/*` checkpoint left by a budget pause is the one
 *      exception — it is auto-committed so the documented resume can run;
 *   2. integrate early — `git fetch origin` + `git rebase origin/<base>`;
 *   3. run the branch gates (default: `test:integrate`, else `test:backlog` +
 *      `test:concurrency` when the project defines them);
 *   4. land: `git push origin HEAD:<base>` (a fast-forward). If another session
 *      landed first, the push is rejected non-fast-forward — re-fetch + rebase
 *      and retry, up to `maxLandAttempts`;
 *   5. wait (bounded) for CI to go green on the landed SHA. The deploy runs
 *      after CI, so an unconfirmed CI is the only blocker ship reports.
 *
 * Usage:
 *   node scripts/ship.js [--base main] [--gate "cmd"]... [--root dir]
 *                        [--no-rebase] [--no-gate] [--no-ci-wait]
 *                        [--ci-timeout <min>] [--ci-poll <sec>]
 *
 * CI watch is on by default. `--no-ci-wait` stops after landing (a deliberate
 * pause — verify with `gh run list`), it is NOT a completion. `.harness.json`
 * overrides: `shipCiWorkflow` (default: the workflow named `CI`),
 * `shipCiTimeoutMinutes` (default 20), `shipCiPollSeconds` (default 15).
 *
 * Test seams (never set in normal use): `HARNESS_SHIP_GH_BIN` (alternate `gh`),
 * `HARNESS_SHIP_CI_NO_SLEEP=1` (skip the poll sleeps),
 * `HARNESS_SHIP_CI_TIMEOUT_MS` / `HARNESS_SHIP_CI_POLL_MS` (timings).
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const boardSync = require("./qa/board-sync.js");
const { withLock } = require("./backlog.js");
const ciWait = require("./qa/ci-wait-lib.js");

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
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    ...(opts || {}),
  });
  return result.status === 0 ? String(result.stdout || "").trim() : "";
}

function has(cmd) {
  return spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;
}

/* The path in a `git status --porcelain` line (`XY <path>`). Robust to the
 * leading space `out()` trims off the FIRST line of a captured status: match the
 * status code(s) + separator rather than assuming a fixed column. */
function porcelainPath(line) {
  const m = line.match(/^\s*[A-Z?!]{1,2}\s+(.*)$/);
  return (m ? m[1] : line).trim().replace(/^"|"$/g, "");
}

/* The machine-written session handoff a budget-paused checkpoint leaves
 * uncommitted. It is the one path `ship` auto-commits: leaving it dirty makes
 * the documented resume (`npm run ship`) abort at the dirty-tree guard before it
 * can land — the re-engagement loop (code committed, checkpoint dirty, ship
 * refuses). Any other dirty tracked file still fails. */
function isHandoffPath(p) {
  return /^\.agents\/handoffs\//.test(p);
}

/* Stage + commit handoff-only dirt so the branch lands clean. */
function commitSessionHandoffs(root, entries, branch) {
  const paths = entries.map(porcelainPath);
  console.log(
    `\n[handoff] committing the session handoff checkpoint so the branch is clean: ${paths.join(", ")}`
  );
  if (!run("git", ["add", "--", ...paths], { cwd: root })) return false;
  return run("git", ["commit", "-m", `docs(${branch}): session checkpoint`], { cwd: root });
}

/* The `gh` binary (overridable for tests). */
function ghBin() {
  return ciWait.ghBin();
}

/* Synchronous sleep — a poll loop must not need async/await. `Atomics.wait` is
 * a real blocking wait (setTimeout would not block the event loop). The test
 * seam skips it so the watch tests run instantly. */
function sleepSync(ms) {
  return ciWait.sleepSync(ms);
}

/* Run a `gh` command and parse its JSON stdout. Returns `{ ok, data, error }`:
 * `ok: false` on any failure (dead cwd, non-zero exit, no gh, malformed JSON)
 * with `error` carrying the real reason — the caller decides whether that is
 * fatal. Never prints, so poll loops stay quiet. The cwd is checked explicitly
 * because a deleted working directory (a feature worktree pruned mid-watch)
 * makes `spawnSync` fail with an opaque error and every poll silently return
 * nothing — the F-252 phantom CI timeout. */
function ghJson(cwd, args) {
  return ciWait.ghJson(cwd, args);
}

/* Read the `name:` of each workflow file under `.github/workflows`. Used to
 * find the CI workflow whose green run confirms the landing. Best-effort:
 * a file without a `name:` is skipped. */
function workflowNames(root) {
  return ciWait.workflowNames(root);
}

/* The CI workflow whose green run on the landed SHA is the completion signal:
 * `.harness.json` `shipCiWorkflow` when set, else the workflow named `CI`. */
function ciWorkflow(root) {
  const config = readJson(path.join(root, ".harness.json"));
  if (config && config.shipCiWorkflow) return String(config.shipCiWorkflow);
  return workflowNames(root).find((n) => /^ci$/i.test(n)) || null;
}

function ciConfig(root, args) {
  return ciWait.ciConfig(root, args);
}

/* Consecutive `gh` failures tolerated before the watch says why it is stuck.
 * `gh` can hiccup transiently, so a single failed poll is not news; a run of
 * them means the watch is blind and the operator should know. */
const CI_GH_FAILURE_WARN = ciWait.CI_GH_FAILURE_WARN;

/* Wait for the CI workflow's run on the landed SHA to complete. Returns 0 when
 * green (success/skipped/neutral), 1 otherwise (failed, timeout, or a watch
 * that went blind — an unobserved gate is not a passed gate).
 *
 * Delegates to the shared `scripts/qa/ci-wait-lib.js` (one implementation for
 * ship and `wait-for.js`); kept as a named `function waitCi` so the ship
 * behavior contract — and the drift guard that asserts it — stay in this file. */
function waitCi(root, sha, opts) {
  return ciWait.waitCi(root, sha, opts);
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

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/* The MAIN worktree's path (first entry of `git worktree list --porcelain`), or
 * null. `ship` runs in the feature worktree, so converging the board means
 * acting on the main checkout's working tree. */
function mainWorktreeRoot(root) {
  const res = spawnSync("git", ["-C", root, "worktree", "list", "--porcelain"], { encoding: "utf8" });
  if (res.status !== 0) return null;
  const first = String(res.stdout || "").split(/\r?\n/).find((l) => l.startsWith("worktree "));
  return first ? first.slice("worktree ".length).trim() : null;
}

/* After a confirmed landing, bring the MAIN checkout level with origin/<base> so
 * its BACKLOG.md reflects the archived row. The shared board-sync module owns
 * the logic — reconcile the board row-aware (an archived-upstream row wins over
 * a stale local take; local-only rows survive), clear redundant non-board dirt,
 * fast-forward, and publish local-only rows so a later `git checkout --` cannot
 * wipe them (the F-147 incident). The short read-modify-write is serialized with
 * the board lock so it cannot race a concurrent `backlog` command. Any OTHER
 * dirty/detached/diverged main is reported with the exact manual fix, never
 * force-resolved. */
function convergeMainCheckout(root, base, cachedMain) {
  // Accept the main path resolved before landing: if the feature worktree was
  // pruned mid-watch, walking it again here would fail and lose the reconcile.
  const main = cachedMain || mainWorktreeRoot(root);
  if (!main) return;
  const upstream = `origin/${base}`;
  try {
    withLock(main, () => {
      const conv = boardSync.convergeCanonical(main, upstream, { fetch: true });
      for (const note of conv.notes) console.log(`[ship] ${note}`);
      if (!conv.ok) {
        console.warn(
          `[ship] landed, but the main checkout could not be converged — resolve it, then: git -C ${main} merge --ff-only ${upstream}`
        );
        return;
      }
      if (conv.canPublish === false) {
        console.warn(`[ship] main checkout board reconciled but main is diverged — not publishing`);
        return;
      }
      const pub = boardSync.publishBoard(
        main,
        upstream,
        "chore(board): publish local-only rows reconciled from the main checkout"
      );
      if (pub.published && pub.committed) {
        console.log(`\n[ship] fast-forwarded the main checkout and published its local-only board rows.`);
      } else if (!pub.published) {
        console.warn(
          `[ship] the main checkout board carries local-only rows that could not be pushed — publish them when the remote is reachable: git -C ${main} push origin HEAD:${base}`
        );
      } else {
        console.log(`\n[ship] fast-forwarded the main checkout — its board now reflects the landed row.`);
      }
    });
  } catch (e) {
    console.warn(`[ship] could not lock the main checkout to converge its board: ${e.message}`);
  }
}

function projectScripts(root) {
  const pkg = readJson(path.join(root, "package.json"));
  return (pkg && pkg.scripts) || {};
}

/* Process gates that must run on every ship regardless of whether the project's
 * pre-push hook is installed. A missing hook (fresh worktree, `--no-verify`)
 * must never silently drop the board/QA/docs gates — `ship` is the deterministic
 * finalizer, so it owns them itself. */
const PROCESS_GATES = [
  "test:dispatch",
  "test:governance",
  "test:concurrency",
  "test:capacity",
  "test:backlog",
  "test:wiring",
  "test:product",
  "test:docs",
  "test:quality",
];

/* Default gate commands. `test:integrate` is the harness one-shot. The process
 * gates are run by `ship` ONLY when no pre-push hook is installed: when a hook
 * exists, `git push` runs the project's own battery (which may deliberately
 * exclude a gate that is red pending another fix), and duplicating it would both
 * double the cost and impose a gate the project chose not to enforce yet. With no
 * hook, `ship` owns the process gates so a missing hook cannot silently drop
 * them. `test:qa-plan` is diff-scoped and must compare against the integration
 * base — `--base=HEAD` would be a trivially empty diff. */
function defaultGates(root, base) {
  const scripts = projectScripts(root);
  const gates = [];
  if (scripts["test:integrate"]) gates.push("npm run test:integrate");
  if (!prePushInstalled(root)) {
    for (const name of PROCESS_GATES) {
      if (scripts[name]) gates.push(`npm run ${name}`);
    }
    if (scripts["test:qa-plan"]) gates.push(`npm run test:qa-plan -- --base=origin/${base}`);
  }
  return gates;
}

/* Whether a pre-push hook is installed (husky via core.hooksPath, or the
 * default hooks dir). Only used for an advisory: project test gates stay in the
 * hook/CI, while the process gates above never depend on it. */
function prePushInstalled(root) {
  if (fs.existsSync(path.join(root, ".husky", "_", "pre-push"))) return true;
  if (fs.existsSync(path.join(root, ".husky", "pre-push"))) return true;
  const hooksPath = out("git", ["config", "core.hooksPath"], { cwd: root });
  if (hooksPath) return true;
  const p = out("git", ["rev-parse", "--git-path", "hooks/pre-push"], { cwd: root });
  return !!(p && fs.existsSync(path.resolve(root, p)));
}

/* How many times to re-fetch/rebase-and-retry a non-fast-forward land when a
 * concurrent session pushed to the integration branch first. */
const MAX_LAND_ATTEMPTS = 3;

/* Land HEAD on `origin/<base>` by fast-forward push. Re-fetches + rebases on a
 * non-fast-forward rejection (another session landed first) and retries.
 * Returns the landed SHA, or null on failure. */
function landOnMain(root, base, args) {
  for (let attempt = 1; attempt <= MAX_LAND_ATTEMPTS; attempt++) {
    if (!args["no-rebase"] && attempt > 1) {
      if (!run("git", ["fetch", "origin"], { cwd: root })) return null;
      const counts = out("git", ["rev-list", "--left-right", "--count", `HEAD...origin/${base}`], { cwd: root });
      const behind = counts ? parseInt(counts.trim().split(/\s+/)[1], 10) || 0 : 0;
      if (behind > 0) {
        if (!run("git", ["rebase", `origin/${base}`], { cwd: root })) {
          return fail(
            `ship: rebase onto origin/${base} failed (conflicts) after a concurrent landing.\n` +
              "      Resolve them, `git rebase --continue`, then re-run `npm run ship`."
          );
        }
      }
    }
    const res = spawnSync("git", ["push", "origin", `HEAD:${base}`], {
      cwd: root,
      encoding: "utf8",
    });
    if (res.status === 0) {
      if (res.stdout) process.stdout.write(String(res.stdout));
      if (res.stderr) process.stderr.write(String(res.stderr));
      return out("git", ["rev-parse", "HEAD"], { cwd: root });
    }
    const text = `${res.stdout || ""}\n${res.stderr || ""}`;
    const raced = /non-fast-forward|fetch first|tip of your current branch is behind|\[rejected\]/i.test(text);
    if (raced && !args["no-rebase"] && attempt < MAX_LAND_ATTEMPTS) {
      console.log(
        `\n[land] ${base} moved (another session landed first) — re-fetching and retrying (attempt ${attempt + 1}/${MAX_LAND_ATTEMPTS})...`
      );
      continue;
    }
    fail(
      `ship: \`git push origin HEAD:${base}\` failed:\n` +
        text
          .split(/\r?\n/)
          .filter(Boolean)
          .map((l) => `      ${l}`)
          .join("\n")
    );
    return null;
  }
  return null;
}

function parseArgs(argv) {
  const args = { gates: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") args.base = argv[++i];
    else if (a === "--gate") args.gates.push(argv[++i]);
    else if (a === "--root") args.root = argv[++i];
    else if (a === "--no-ci-wait") args["no-ci-wait"] = true;
    else if (a === "--ci-timeout") args["ci-timeout"] = argv[++i];
    else if (a === "--ci-poll") args["ci-poll"] = argv[++i];
    else if (a === "--no-rebase") args["no-rebase"] = true;
    else if (a === "--no-gate") args["no-gate"] = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else args._.push(a);
  }
  return args;
}

function usage() {
  console.log(
    "ship — integrate, gate, and land the feature branch directly on the integration branch (no LLM)\n\n" +
      "  node scripts/ship.js [--base main] [--gate \"<cmd>\"]... [--root <dir>]\n" +
      "                       [--no-rebase] [--no-gate] [--no-ci-wait]\n" +
      "                       [--ci-timeout <min>] [--ci-poll <sec>]\n\n" +
      "Never runs on main. Rebases on origin/<base>, runs the branch gates, then lands\n" +
      "`HEAD:<base>` with a fast-forward push (retrying after a concurrent landing).\n" +
      "Then waits (bounded) for CI to go green on the landed SHA; the deploy runs\n" +
      "after CI succeeds. `--no-ci-wait` stops after landing — a deliberate pause, not\n" +
      "a completed task. Resume by re-running `npm run ship` (it is idempotent)."
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  const root = args.root ? path.resolve(args.root) : findRoot(process.cwd());
  if (!root) return fail("ship: no git repository found (no .git in this tree or its parents).");

  // Resolve the main worktree NOW, while the feature checkout still exists: the
  // CI watch and the board reconcile both run from main, so they survive the
  // feature worktree being pruned mid-watch (the F-252 race).
  const mainRoot = mainWorktreeRoot(root) || root;

  const base = args.base || "main";
  const branch = out("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root });
  if (!branch) return fail("ship: could not resolve the current branch.");

  if (branch === base || branch === "main" || branch === "master") {
    return fail(
      `ship: refusing to ship "${branch}" — that is the integration branch.\n` +
        "      Work and ship a feature branch."
    );
  }

  const entries = out("git", ["status", "--porcelain"], { cwd: root })
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("!!"));
  // A budget pause writes the checkpoint into `.agents/handoffs/<id>.md`; commit
  // that machine-written artifact here so the documented resume path works. Any
  // other dirty tracked file is still a hard stop (never ship WIP).
  const foreignTracked = entries.filter((l) => !l.startsWith("??") && !isHandoffPath(porcelainPath(l)));
  if (foreignTracked.length > 0) {
    return fail(
      "ship: uncommitted tracked changes — commit first (the tests belong in the tree you ship):\n" +
        foreignTracked.map((l) => `      ${l}`).join("\n")
    );
  }
  const handoffs = entries.filter((l) => isHandoffPath(porcelainPath(l)));
  if (handoffs.length > 0 && !commitSessionHandoffs(root, handoffs, branch)) {
    return fail("ship: could not commit the session handoff checkpoint — commit it by hand, then re-run.");
  }

  if (!args["no-rebase"]) {
    if (!run("git", ["fetch", "origin"], { cwd: root })) return fail("ship: `git fetch origin` failed.");
    if (!run("git", ["rebase", `origin/${base}`], { cwd: root })) {
      return fail(
        `ship: rebase onto origin/${base} failed (conflicts).\n` +
          "      Resolve them, `git rebase --continue`, then re-run `npm run ship`."
      );
    }
  }

  if (!args["no-gate"]) {
    const gates = args.gates.length ? args.gates : defaultGates(root, base);
    if (gates.length === 0) {
      console.warn("ship: no branch gates found (set --gate or define test:integrate) — skipping.");
    }
    for (const gate of gates) {
      if (!run(gate, [], { cwd: root, shell: true })) return fail(`ship: gate failed: ${gate}`);
    }
    if (!prePushInstalled(root)) {
      console.warn(
        "ship: no pre-push hook detected — project test gates (e.g. test:quick) will run in CI only.\n" +
          "      Install the hook (husky) or rely on CI as the backstop."
      );
    }
  }

  const sha = landOnMain(root, base, args);
  if (!sha) return; // landOnMain set the process exit code

  console.log(`\n[land] landed ${branch} -> origin/${base} (${sha.slice(0, 7)}).`);

  if (args["no-ci-wait"]) {
    console.log(
      "  CI is NOT confirmed (deliberate --no-ci-wait pause). Verify with:\n" +
        `    gh run list --workflow "${ciWorkflow(root) || "CI"}" --commit ${sha}`
    );
    convergeMainCheckout(root, base, mainRoot);
    return;
  }

  const { timeoutMs, pollMs } = ciConfig(root, args);
  const code = waitCi(root, sha, {
    timeoutMs,
    pollMs,
    workflow: ciWorkflow(root),
    cwd: mainRoot,
  });
  // Converge the main checkout even when CI is red: a failed/flaky run must not
  // strand main's board behind (that is how it silently drifts stale).
  convergeMainCheckout(root, base, mainRoot);
  if (code !== 0) {
    process.exitCode = code;
    return;
  }
  console.log(
    "\n[ship] landed + CI green. Clean up the feature worktree when the session ends:\n" +
      "       node scripts/backlog.js worktree-prune"
  );
}

main();
