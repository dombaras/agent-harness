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
  return process.env.HARNESS_SHIP_GH_BIN || "gh";
}

/* Synchronous sleep — a poll loop must not need async/await. `Atomics.wait` is
 * a real blocking wait (setTimeout would not block the event loop). The test
 * seam skips it so the watch tests run instantly. */
function sleepSync(ms) {
  if (process.env.HARNESS_SHIP_CI_NO_SLEEP) return;
  if (!(ms > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/* Run a `gh` command and parse its JSON stdout. Returns null on any failure
 * (non-zero exit, no gh, malformed JSON) — the caller decides whether that is
 * fatal. Never prints, so poll loops stay quiet. */
function ghJson(root, args) {
  const res = spawnSync(ghBin(), args, { cwd: root, encoding: "utf8" });
  if (res.status !== 0) return null;
  try {
    return JSON.parse(String(res.stdout || "null"));
  } catch {
    return null;
  }
}

/* Read the `name:` of each workflow file under `.github/workflows`. Used to
 * find the CI workflow whose green run confirms the landing. Best-effort:
 * a file without a `name:` is skipped. */
function workflowNames(root) {
  const dir = path.join(root, ".github", "workflows");
  const names = [];
  if (!fs.existsSync(dir)) return names;
  for (const file of fs.readdirSync(dir)) {
    if (!/\.ya?ml$/i.test(file)) continue;
    const src = fs.readFileSync(path.join(dir, file), "utf8");
    const m = src.match(/^name:\s*(.+)$/m);
    if (m) names.push(m[1].trim().replace(/^["']|["']$/g, ""));
  }
  return names;
}

/* The CI workflow whose green run on the landed SHA is the completion signal:
 * `.harness.json` `shipCiWorkflow` when set, else the workflow named `CI`. */
function ciWorkflow(root) {
  const config = readJson(path.join(root, ".harness.json"));
  if (config && config.shipCiWorkflow) return String(config.shipCiWorkflow);
  return workflowNames(root).find((n) => /^ci$/i.test(n)) || null;
}

function ciConfig(root, args) {
  const config = readJson(path.join(root, ".harness.json")) || {};
  // Precedence: CLI flag > test-seam env > .harness.json > default.
  const envTimeout = Number(process.env.HARNESS_SHIP_CI_TIMEOUT_MS);
  const envPoll = Number(process.env.HARNESS_SHIP_CI_POLL_MS);
  const timeoutMinutes =
    args["ci-timeout"] !== undefined
      ? Number(args["ci-timeout"])
      : Number.isFinite(envTimeout) && envTimeout > 0
        ? envTimeout / 60000
        : Number(config.shipCiTimeoutMinutes) || 20;
  const pollSeconds =
    args["ci-poll"] !== undefined
      ? Number(args["ci-poll"])
      : Number.isFinite(envPoll) && envPoll > 0
        ? envPoll / 1000
        : Number(config.shipCiPollSeconds) || 15;
  return {
    timeoutMs: Math.max(1, Math.round(timeoutMinutes * 60 * 1000)),
    pollMs: Math.max(1, Math.round(pollSeconds * 1000)),
  };
}

/* Wait for the CI workflow's run on the landed SHA to complete. Returns 0 when
 * green (success/skipped/neutral), 1 otherwise (failed or timeout — an
 * unobserved gate is not a passed gate). */
function waitCi(root, sha, opts) {
  const name = opts.workflow;
  if (!name) {
    console.warn(
      "ship: no CI workflow detected — landed, but cannot confirm CI. Add a `.github/workflows/ci.yml` (name: CI)."
    );
    return 0;
  }
  if (!has(ghBin())) {
    fail(
      `ship: landed ${sha.slice(0, 7)}, but \`gh\` is unavailable — CI was NOT confirmed.\n` +
        `      Confirm manually: gh run list --workflow "${name}" --commit ${sha}`
    );
    return 1;
  }
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const runs = ghJson(root, [
      "run",
      "list",
      "--workflow",
      name,
      "--commit",
      sha,
      "--limit",
      "10",
      "--json",
      "databaseId,status,conclusion,url,headSha,name",
    ]);
    const run =
      (runs || []).find((r) => !r.headSha || r.headSha === sha) || (runs || [])[0] || null;
    if (run && run.status === "completed") {
      if (["success", "skipped", "neutral"].includes(run.conclusion)) {
        console.log(`[ci] ${name} green on ${sha.slice(0, 7)}${run.url ? " — " + run.url : ""}`);
        return 0;
      }
      fail(
        `ship: ${name} concluded "${run.conclusion}" on ${sha.slice(0, 7)}` +
          (run.url ? " — " + run.url : "") +
          (run.databaseId ? `\n      Failing logs: gh run view ${run.databaseId} --log-failed` : "") +
          "\n      The change landed but CI is red — fix forward on a new branch.\n" +
          "      Emergency rollback: re-deploy the previous good SHA\n" +
          "        gh workflow run deploy-uat.yml --ref main -f ref=<previous-good-sha>"
      );
      return 1;
    }
    if (Date.now() >= deadline) {
      fail(
        `ship: timed out after ${Math.round(opts.timeoutMs / 60000)}m waiting for ${name} on ${sha.slice(0, 7)}.\n` +
          "      The change LANDED; CI is not confirmed. Check:\n" +
          `        gh run list --workflow "${name}" --commit ${sha}`
      );
      return 1;
    }
    process.stdout.write(`[ci] waiting for ${name} on ${sha.slice(0, 7)}... \r`);
    sleepSync(opts.pollMs);
  }
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

/* After a confirmed landing, fast-forward the MAIN checkout to origin/<base> so
 * its BACKLOG.md/CHANGELOG.md reflect the archived row. A board made dirty by
 * the routine `backlog worktree` take is reconciled row-aware first
 * (`reconcileDirtyBoard`); any OTHER dirty/detached/diverged main or an
 * untracked-file collision (the stray-handoff shape) is reported with the exact
 * manual fix, never force-resolved. */
function convergeMainCheckout(root, base) {
  const main = mainWorktreeRoot(root);
  if (!main) return;
  const upstream = `origin/${base}`;
  spawnSync("git", ["-C", main, "fetch", "--quiet", "origin"], { stdio: "ignore", timeout: 10000 });
  const counts = out("git", ["rev-list", "--left-right", "--count", `HEAD...${upstream}`], { cwd: main });
  if (!counts) return; // no upstream ref to compare against (offline / no remote)
  const [ahead, behind] = counts.trim().split(/\s+/).map((n) => parseInt(n, 10) || 0);
  if (!behind) return; // main already current (or ahead-only)
  if (ahead) {
    console.warn(
      `[ship] main checkout is ${behind} behind and ${ahead} ahead of ${upstream} — not fast-forwarding; reconcile it manually: git -C ${main} pull --rebase`
    );
    return;
  }
  const dirty = out("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: main });
  if (dirty) {
    const dirtyPaths = dirty
      .split(/\r?\n/)
      .filter(Boolean)
      .map(porcelainPath);
    if (dirtyPaths.every((p) => p === "BACKLOG.md") && reconcileDirtyBoard(main, upstream, behind)) return;
    console.warn(
      `[ship] main checkout has uncommitted tracked changes — not fast-forwarding; resolve them, then: git -C ${main} merge --ff-only ${upstream}`
    );
    return;
  }
  const ff = spawnSync("git", ["-C", main, "merge", "--ff-only", upstream], { encoding: "utf8" });
  if (ff.status === 0) {
    console.log(
      `\n[ship] fast-forwarded the main checkout (${behind} commit(s)) — its board now reflects the landed row.`
    );
  } else {
    console.warn(
      `[ship] landed, but the main checkout could not fast-forward to ${upstream}:\n` +
        `       ${(ff.stderr || ff.stdout || "").trim()}\n` +
        `       If this is an untracked-file collision, remove the stray file, then: git -C ${main} merge --ff-only ${upstream}`
    );
  }
}

/* A landed feature leaves the main checkout's board dirty BY CONSTRUCTION: the
 * `backlog worktree` take moved the row to In progress in the working copy while
 * the landed commit archived it upstream. Refusing to fast-forward on that
 * routine take is what left rows "stuck In progress" and forced a manual
 * reconcile. When the ONLY dirty tracked file is BACKLOG.md, reconcile it
 * row-aware against the landed board (an archived row wins over the stale local
 * take; local-only rows survive), then fast-forward. Returns true on success. */
function reconcileDirtyBoard(main, upstream, behind) {
  const boardPath = path.join(main, "BACKLOG.md");
  let localSrc;
  try {
    localSrc = fs.readFileSync(boardPath, "utf8");
  } catch {
    return false;
  }
  const baseSrc = out("git", ["show", `HEAD:BACKLOG.md`], { cwd: main });
  const theirsSrc = out("git", ["show", `${upstream}:BACKLOG.md`], { cwd: main });
  if (!baseSrc || !theirsSrc) return false;
  let reconcile;
  try {
    reconcile = require("./qa/merge-backlog.js").reconcileBoard(baseSrc, localSrc, theirsSrc);
  } catch {
    return false; // merge-backlog not deployed / refactor — fall back to the warning
  }
  if (!reconcile.ok) {
    console.warn(
      `[ship] main checkout board has conflicting rows (${reconcile.conflicts.join(", ")}) — not fast-forwarding; reconcile it manually: git -C ${main} pull --rebase`
    );
    return false;
  }
  if (spawnSync("git", ["-C", main, "checkout", "--", "BACKLOG.md"], { encoding: "utf8" }).status !== 0) {
    return false;
  }
  const ff = spawnSync("git", ["-C", main, "merge", "--ff-only", upstream], { encoding: "utf8" });
  if (ff.status !== 0) {
    fs.writeFileSync(boardPath, localSrc, "utf8"); // fast-forward failed — restore the edits we moved aside
    return false;
  }
  fs.writeFileSync(boardPath, reconcile.board, "utf8");
  console.log(
    `\n[ship] fast-forwarded the main checkout (${behind} commit(s)) and reconciled its board — ` +
      `kept local-only rows` +
      (reconcile.dropped.length ? `; dropped the landed take (${reconcile.dropped.join(", ")})` : "") +
      "."
  );
  return true;
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
    convergeMainCheckout(root, base);
    return;
  }

  const { timeoutMs, pollMs } = ciConfig(root, args);
  const code = waitCi(root, sha, { timeoutMs, pollMs, workflow: ciWorkflow(root) });
  if (code !== 0) {
    process.exitCode = code;
    return;
  }
  convergeMainCheckout(root, base);
  console.log(
    "\n[ship] landed + CI green. Clean up the feature worktree when the session ends:\n" +
      "       node scripts/backlog.js worktree-prune"
  );
}

main();
