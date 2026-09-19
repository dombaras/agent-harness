#!/usr/bin/env node
"use strict";
/*
 * ship — deterministic branch finalizer (no LLM).
 *
 * The worker/integrator split makes a session end at "pushed branch + open PR",
 * not at the merge. That finalization was manual, so a session could stop at
 * "gates green on my branch" and the PR was never enqueued into the landing
 * queue (the F-235 field incident: PR #17 opened, never labeled `merge-train`,
 * so the train never saw it). `ship` makes BOTH the enqueue and the landing
 * mechanical:
 *
 *   1. refuse `main` on a dirty tree (never ship WIP or the integration branch);
 *   2. integrate early — `git fetch origin` + `git rebase origin/<base>`;
 *   3. run the branch gates (default: `test:integrate`, else `test:backlog` +
 *      `test:concurrency` when the project defines them);
 *   4. `git push` the branch (force-with-lease only when the remote branch
 *      already exists, i.e. the rebase rewrote a previously-pushed branch);
 *   5. open the PR if none is open, or reuse the existing one (`gh`);
 *   6. apply the landing label so the merge train can pick it up;
 *   7. **watch the whole loop to completion** — poll the PR until the merge
 *      train lands it, then wait for the CI gates and the UAT deploy on the
 *      merged SHA. A session that ran `ship` no longer has to stop at
 *      "shipped/enqueued": `ship` exits 0 only once the change is landed and
 *      deployed, or non-zero with the concrete blocker + exact next command.
 *
 * Landing remains the merge train's job and CI owns the UAT deploy; `ship`
 * never merges by hand and never pushes to `main`. The watch only *observes*
 * `gh` state (it may nudge the train once — see `--no-nudge`). If `gh` is
 * unavailable it stops after the push and exits non-zero with the exact
 * PR/label commands to run — a silent "pushed, done" is never possible.
 *
 * Usage:
 *   node scripts/ship.js [--base main] [--label merge-train] [--gate "cmd"]...
 *                        [--no-rebase] [--no-gate] [--no-label] [--root dir]
 *                        [--watch|--no-watch] [--watch-only] [--no-nudge]
 *                        [--allow-no-deploy] [--watch-timeout <min>] [--watch-poll <sec>]
 *
 * Default label resolution: `--label` > $HARNESS_SHIP_LABEL > `.harness.json`
 * `shipLabel` > `merge-train` when `.github/workflows/merge-train.yml` exists >
 * none (push + PR only).
 *
 * Watch is on by default whenever a landing label is applied. `--no-watch`
 * stops after enqueue and writes a pending-landing ledger — it is a pause, not
 * a completion (resume with `--watch-only`; `doctor` surfaces the pending
 * record). Project overrides: `.harness.json` `shipWatch` (bool),
 * `shipWatchTimeoutMinutes`, `shipWatchPollSeconds`, `shipWatchWorkflows`
 * (array of workflow names). Workflows default to every `.github/workflows/*`
 * named `CI` or matching /deploy/i. `--watch-only` skips steps 1-6 and just
 * watches the current branch's open PR (resume a session that stopped after
 * enqueue), and fast-forwards the main checkout once the loop is green.
 *
 * Test seams (never set in normal use): `HARNESS_SHIP_GH_BIN` (alternate `gh`),
 * `HARNESS_SHIP_WATCH_NO_SLEEP=1` (skip the poll sleeps).
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

/* The `gh` binary (overridable for tests). */
function ghBin() {
  return process.env.HARNESS_SHIP_GH_BIN || "gh";
}

/* Synchronous sleep — a poll loop must not need async/await. `Atomics.wait` is
 * a real blocking wait (setTimeout would not block the event loop). The test
 * seam skips it so the watch tests run instantly. */
function sleepSync(ms) {
  if (process.env.HARNESS_SHIP_WATCH_NO_SLEEP) return;
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
 * auto-detect which workflows a merge must run (CI + a deploy). Best-effort:
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

/* Which workflows must go green on the merge commit for the loop to be done:
 * `.harness.json` `shipWatchWorkflows` when set, else every workflow named `CI`
 * or matching /deploy/i (e.g. "CI", "Deploy UAT"). Empty = landing is the only
 * observable (no CI/deploy workflow). */
function watchWorkflows(root) {
  const config = readJson(path.join(root, ".harness.json"));
  if (config && Array.isArray(config.shipWatchWorkflows) && config.shipWatchWorkflows.length) {
    return config.shipWatchWorkflows.map((n) => String(n));
  }
  return workflowNames(root).filter((n) => /^ci$/i.test(n) || /deploy/i.test(n));
}

/* A PR check rollup is "green" when at least one check exists and every check
 * concluded SUCCESS/SKIPPED/NEUTRAL. */
function checksGreen(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0) return false;
  return rollup.every((c) => ["SUCCESS", "SKIPPED", "NEUTRAL"].includes(c.conclusion));
}

function watchConfig(root, args) {
  const config = readJson(path.join(root, ".harness.json")) || {};
  // Precedence: CLI flag > test-seam env > .harness.json > default.
  const envTimeout = Number(process.env.HARNESS_SHIP_WATCH_TIMEOUT_MS);
  const envPoll = Number(process.env.HARNESS_SHIP_WATCH_POLL_MS);
  const timeoutMinutes =
    args["watch-timeout"] !== undefined
      ? Number(args["watch-timeout"])
      : Number.isFinite(envTimeout) && envTimeout > 0
        ? envTimeout / 60000
        : Number(config.shipWatchTimeoutMinutes) || 20;
  const pollSeconds =
    args["watch-poll"] !== undefined
      ? Number(args["watch-poll"])
      : Number.isFinite(envPoll) && envPoll > 0
        ? envPoll / 1000
        : Number(config.shipWatchPollSeconds) || 15;
  return {
    timeoutMs: Math.max(1, Math.round(timeoutMinutes * 60 * 1000)),
    pollMs: Math.max(1, Math.round(pollSeconds * 1000)),
  };
}

/* Wait until the merge train lands PR <prNumber>. Returns the merge SHA ("" on
 * timeout/close). Optionally nudges the train once, once checks are green, when
 * the PR is labeled `merge-train` and its workflow exists — the field case this
 * exists for is a project whose train drains only on a slow schedule. */
function waitForMerge(root, prNumber, opts) {
  const deadline = Date.now() + opts.timeoutMs;
  let nudged = false;
  for (;;) {
    const info = ghJson(root, [
      "pr",
      "view",
      String(prNumber),
      "--json",
      "state,mergedAt,mergeCommit,statusCheckRollup",
    ]);
    if (info && info.state === "MERGED") {
      return (info.mergeCommit && info.mergeCommit.oid) || "";
    }
    if (info && info.state === "CLOSED" && !info.mergedAt) {
      fail(`ship: PR #${prNumber} was closed without merging — the change did not land.`);
      return null;
    }
    if (!nudged && opts.nudge && info && checksGreen(info.statusCheckRollup)) {
      console.log("\n[watch] checks are green but the PR has not landed — dispatching the merge train once.");
      run(ghBin(), ["workflow", "run", "merge-train.yml", "--ref", opts.base], { cwd: root });
      nudged = true;
    }
    if (Date.now() >= deadline) {
      fail(
        `ship: timed out after ${Math.round(opts.timeoutMs / 60000)}m waiting for PR #${prNumber} to land.\n` +
          "      The change is ENQUEUED, not landed. Check the train / branch protection, then resume:\n" +
          `        gh pr view ${prNumber} --json state,mergedAt,labels\n` +
          "        npm run ship -- --watch-only"
      );
      return null;
    }
    process.stdout.write(`[watch] waiting for PR #${prNumber} to land... \r`);
    sleepSync(opts.pollMs);
  }
}

/* Wait for one workflow's run on the merge SHA to complete. Returns true when
 * it is green (success/skipped), false (after failing) otherwise. A timeout is
 * a failure — an unobserved deploy is not a deployed change. */
function waitWorkflow(root, name, sha, opts) {
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
        console.log(`[watch] ${name} green on ${sha.slice(0, 7)}${run.url ? " — " + run.url : ""}`);
        return true;
      }
      fail(
        `ship: ${name} concluded "${run.conclusion}" on ${sha.slice(0, 7)}` +
          (run.url ? " — " + run.url : "") +
          (run.databaseId ? `\n      Failing logs: gh run view ${run.databaseId} --log-failed` : "") +
          "\n      The change landed but did not deploy green — fix forward on a new branch.\n" +
          "      Emergency rollback: re-run the deploy workflow on the previous good SHA\n" +
          "        gh workflow run <deploy-workflow>.yml --ref main -f ref=<previous-good-sha>"
      );
      return false;
    }
    if (Date.now() >= deadline) {
      fail(
        `ship: timed out after ${Math.round(opts.timeoutMs / 60000)}m waiting for ${name} on ${sha.slice(0, 7)}.\n` +
          `      The change landed; the deploy is not confirmed. Check:\n        gh run list --workflow "${name}" --commit ${sha}`
      );
      return false;
    }
    process.stdout.write(`[watch] waiting for ${name} on ${sha.slice(0, 7)}... \r`);
    sleepSync(opts.pollMs);
  }
}

/* The full post-enqueue loop: merge -> CI -> deploy. Returns an exit code. */
function watchLanding(root, prNumber, opts) {
  const { timeoutMs, pollMs } = watchConfig(root, opts.args);
  const workflows = opts.workflows;
  console.log(
    `\n[watch] PR #${prNumber}: waiting for merge train` +
      (workflows.length ? " + " + workflows.join(" + ") : "") +
      ` (timeout ${Math.round(timeoutMs / 60000)}m; re-run \`npm run ship -- --watch-only\` to resume after an interrupt).`
  );
  const sha = waitForMerge(root, prNumber, {
    base: opts.base,
    timeoutMs,
    pollMs,
    nudge: opts.nudge,
  });
  if (sha === null) return 1;
  if (!sha) {
    // MERGED but no mergeCommit object returned — resolve from the remote.
    run("git", ["fetch", "origin"], { cwd: root });
    const resolved = out("git", ["rev-parse", `origin/${opts.base}`], { cwd: root });
    if (!resolved) {
      fail(`ship: PR #${prNumber} merged but the merge SHA could not be resolved.`);
      return 1;
    }
    console.log(`[watch] merged (SHA ${resolved.slice(0, 7)} via origin/${opts.base}).`);
    return landAndConverge(root, resolved, workflows, { timeoutMs, pollMs }, opts.base);
  }
  console.log(`[watch] merged (SHA ${sha.slice(0, 7)}).`);
  return landAndConverge(root, sha, workflows, { timeoutMs, pollMs }, opts.base);
}

/* A confirmed landing is also the moment the MAIN checkout's board must
 * converge: the feature landed from a linked worktree, so the main tree still
 * shows the shipped row as active until someone pulls (the "row stuck in
 * progress" report). Fast-forward main after the loop is green. */
function landAndConverge(root, sha, workflows, opts, base) {
  const code = finishWatch(root, sha, workflows, opts);
  if (code === 0) convergeMainCheckout(root, base);
  return code;
}

function finishWatch(root, sha, workflows, opts) {
  for (const name of workflows) {
    if (!waitWorkflow(root, name, sha, opts)) return 1;
  }
  console.log(
    "\n[watch] DONE — landed on the integration branch" +
      (workflows.length ? " with " + workflows.join(" + ") + " green" : "") +
      "."
  );
  return 0;
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

/* Best-effort resume/audit record of a ship attempt, under the gitignored
 * `.serve/`. A later (cheap) session can confirm the outcome without replaying
 * the watch. Never fails the ship. */
function writeShipLedger(root, prNumber, entry) {
  try {
    const dir = path.join(root, ".serve");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `ship-${prNumber}.json`),
      JSON.stringify({ ts: new Date().toISOString(), pr: prNumber, ...entry }, null, 2) + "\n",
      "utf8"
    );
  } catch {
    /* best-effort */
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
 * its BACKLOG.md/CHANGELOG.md reflect the archived row. Best-effort and
 * fail-visible: a dirty/detached/diverged main or an untracked-file collision
 * (the stray-handoff shape) is reported with the exact manual fix, never
 * force-resolved. */
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

/* Resolve the landing label: explicit > env > .harness.json > merge-train (when
 * the project has BOTH a merge-train workflow and a CI workflow) > none.
 *
 * The CI requirement is not cosmetic: the merge train only picks a PR with a
 * non-empty all-green `statusCheckRollup`. Without CI, applying the label would
 * enqueue a PR that can never land, and `ship` would hang until its watch
 * timeout — a fail-loud is better than a silent deadlock. */
function hasCiWorkflow(root) {
  return workflowNames(root).some((n) => /^ci$/i.test(n));
}
function resolveLabel(root, explicit) {
  if (explicit) return explicit;
  if (process.env.HARNESS_SHIP_LABEL) return process.env.HARNESS_SHIP_LABEL;
  const config = readJson(path.join(root, ".harness.json"));
  if (config && config.shipLabel) return String(config.shipLabel);
  if (fs.existsSync(path.join(root, ".github", "workflows", "merge-train.yml"))) {
    if (!hasCiWorkflow(root)) return null;
    return "merge-train";
  }
  return null;
}

function parseArgs(argv) {
  const args = { gates: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") args.base = argv[++i];
    else if (a === "--label") args.label = argv[++i];
    else if (a === "--gate") args.gates.push(argv[++i]);
    else if (a === "--root") args.root = argv[++i];
    else if (a === "--watch") args.watch = true;
    else if (a === "--no-watch") args["no-watch"] = true;
    else if (a === "--watch-only") args["watch-only"] = true;
    else if (a === "--no-nudge") args["no-nudge"] = true;
    else if (a === "--allow-no-deploy") args["allow-no-deploy"] = true;
    else if (a === "--watch-timeout") args["watch-timeout"] = argv[++i];
    else if (a === "--watch-poll") args["watch-poll"] = argv[++i];
    else if (a === "--no-rebase") args["no-rebase"] = true;
    else if (a === "--no-gate") args["no-gate"] = true;
    else if (a === "--no-label") args["no-label"] = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else args._.push(a);
  }
  return args;
}

function usage() {
  console.log(
    "ship — integrate, gate, push, enqueue, and watch the feature branch to landing (no LLM)\n\n" +
      "  node scripts/ship.js [--base main] [--label <name>] [--gate \"<cmd>\"]...\n" +
      "                       [--no-rebase] [--no-gate] [--no-label] [--root <dir>]\n" +
      "                       [--watch|--no-watch] [--watch-only] [--no-nudge]\n" +
      "                       [--allow-no-deploy] [--watch-timeout <min>] [--watch-poll <sec>]\n\n" +
      "Never runs on main. Rebases on origin/<base>, runs the branch gates, pushes,\n" +
      "opens the PR, applies the landing label, then (by default) watches the PR until\n" +
      "the merge train lands it and the CI gates + UAT deploy go green on the merged\n" +
      "SHA. `--no-watch` stops after enqueue — it leaves a pending-landing ledger\n" +
      "(surfaced by `agent-harness doctor`) and is NOT a completed task; resume with\n" +
      "`npm run ship -- --watch-only`. Landing + the deploy remain the merge train's /\n" +
      "CI's job — ship only observes them."
  );
}

/* owner/repo from the origin remote (for REST calls that avoid the deprecated
 * Projects (classic) GraphQL mutation in `gh pr edit --add-label`). */
function repoSlug(root) {
  const url = out("git", ["remote", "get-url", "origin"], { cwd: root });
  const m = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  return m ? m[1] : null;
}

/* Ensure the label exists in the repo (create only if missing, never mutate an
 * existing label), then apply it. Uses the REST API — `gh pr edit --add-label`
 * fails on gh versions whose GraphQL query still asks for Projects (classic). */
function applyLabel(root, pr, label) {
  const slug = repoSlug(root);
  if (!slug) return false;
  const exists =
    spawnSync(ghBin(), ["api", `repos/${slug}/labels/${encodeURIComponent(label)}`], {
      cwd: root,
      stdio: "ignore",
    }).status === 0;
  if (!exists) {
    console.log(`\n[label] "${label}" does not exist — creating it.`);
    if (!run(ghBin(), ["label", "create", label, "--color", "FBCA04", "--description", "Serialized landing queue (agent-harness ship)"], { cwd: root })) {
      return false;
    }
  }
  if (!run(ghBin(), ["api", `repos/${slug}/issues/${pr.number}/labels`, "-f", `labels[]=${label}`], { cwd: root })) {
    return false;
  }
  const labels = out(ghBin(), ["api", `repos/${slug}/issues/${pr.number}/labels`, "--jq", ".[].name"], { cwd: root });
  return labels.split(/\r?\n/).map((s) => s.trim()).includes(label);
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

  // `--watch-only` — resume a session that already pushed + enqueued: skip the
  // rebase/gate/push/PR/label steps and just watch the current branch's PR to
  // landing + deploy. No clean-tree requirement (the tree may hold handoff/docs
  // edits from the paused session).
  if (args["watch-only"]) {
    if (!has(ghBin())) return fail("ship: `--watch-only` needs `gh` on PATH.");
    const prs = ghJson(root, [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "all",
      "--json",
      "number,url,state",
      "--limit",
      "1",
    ]);
    const pr = prs && prs.length ? prs[0] : null;
    if (!pr) {
      return fail(`ship: no PR found for branch "${branch}" — nothing to watch.\n      Run \`npm run ship\` first.`);
    }
    const code = watchLanding(root, pr.number, {
      base,
      args,
      workflows: watchWorkflows(root),
      nudge: !args["no-nudge"],
    });
    writeShipLedger(root, pr.number, {
      branch,
      base,
      landed: code === 0,
      watched: true,
      phase: code === 0 ? "landed" : "pending",
    });
    process.exitCode = code;
    return;
  }

  if (branch === base || branch === "main" || branch === "master") {
    return fail(
      `ship: refusing to ship "${branch}" — that is the integration branch.\n` +
        "      Ship a feature branch; landing on main is the merge train's job."
    );
  }

  const dirty = out("git", ["status", "--porcelain"], { cwd: root })
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("??") && !l.startsWith("!!"));
  if (dirty.length > 0) {
    return fail(
      "ship: uncommitted tracked changes — commit first (the tests belong in the tree you ship):\n" +
        dirty.map((l) => `      ${l}`).join("\n")
    );
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

  // Force-with-lease only when the remote branch already exists (a rebase
  // rewrote an already-pushed branch); otherwise establish tracking.
  const remoteExists = spawnSync("git", ["ls-remote", "--exit-code", "--heads", "origin", branch], { cwd: root, stdio: "ignore" }).status === 0;
  const pushArgs = remoteExists
    ? ["push", "--force-with-lease", "origin", branch]
    : ["push", "-u", "origin", branch];
  if (!run("git", pushArgs, { cwd: root })) return fail("ship: `git push` failed.");

  if (!has(ghBin())) {
    return fail(
      "ship: pushed, but `gh` is unavailable — the PR was NOT opened and the landing\n" +
        "      label was NOT applied. Run manually, then re-run `npm run ship`:\n" +
        `        gh pr create --base ${base} --head ${branch} --fill\n` +
        "        gh pr edit <number> --add-label <landing-label>"
    );
  }

  let pr = null;
  const list = out(ghBin(), ["pr", "list", "--head", branch, "--state", "open", "--json", "number,url", "--limit", "1"], { cwd: root });
  try {
    const parsed = list ? JSON.parse(list) : [];
    if (parsed.length) pr = parsed[0];
  } catch {
    pr = null;
  }
  if (!pr) {
    const url = out(ghBin(), ["pr", "create", "--base", base, "--head", branch, "--fill"], { cwd: root });
    if (!url || !/https?:\/\/\S+/.test(url)) return fail("ship: `gh pr create` did not return a PR URL.");
    const number = (url.match(/\/pull\/(\d+)/) || [])[1] || "";
    pr = { number: number ? Number(number) : url, url: (url.match(/https?:\/\/\S+/) || [])[0] };
    console.log(`\n[pr] opened #${pr.number}: ${pr.url}`);
  } else {
    console.log(`\n[pr] reusing open PR #${pr.number}: ${pr.url}`);
  }

  const label = resolveLabel(root, args.label);
  const workflows = watchWorkflows(root);
  const config = readJson(path.join(root, ".harness.json")) || {};
  if (label && config.shipLabel && label !== "merge-train") {
    console.warn(
      `ship: shipLabel "${label}" is not "merge-train" — the merge-train workflow filters on the\n` +
        '      literal "merge-train" label. Edit the workflow to match, or the PR will never land.'
    );
  }

  // Fail closed: a queued PR with no CI/deploy workflow to watch would report a
  // green "done" without ever verifying a deploy. Refuse rather than mislead —
  // unless the project explicitly opts out with --allow-no-deploy.
  if (label && !args["no-label"] && workflows.length === 0 && !args["allow-no-deploy"]) {
    return fail(
      `ship: PR #${pr.number} would be queued, but no CI/deploy workflow was detected on the merged SHA.\n` +
        `      Detected workflows: [${workflowNames(root).join(", ") || "none"}].\n` +
        "      Set .harness.json shipWatchWorkflows, or pass --allow-no-deploy to land without a deploy check."
    );
  }

  if (label && !args["no-label"]) {
    if (!pr.number) {
      return fail(`ship: could not resolve the PR number for ${pr.url} — apply the label manually.`);
    }
    if (!applyLabel(root, pr, label)) {
      return fail(
        `ship: PR ${pr.url} is open but the label "${label}" could not be applied.\n` +
          `      Apply it manually: gh api repos/<owner>/<repo>/issues/${pr.number}/labels -f "labels[]=${label}"`
      );
    }
    console.log(`\n[label] applied "${label}" — PR #${pr.number} is queued for the merge train.`);
  } else if (!label) {
    console.warn(
      "ship: no landing label configured — PR opened but not enqueued.\n" +
        "      (A merge-train workflow with no CI workflow is intentionally not auto-labeled —\n" +
        "       the train cannot land a PR with no checks. Use --label to override.)"
    );
  }

  // Persist the enqueue record BEFORE any watch. If the watch is skipped (a
  // budget pause) this is the machine-readable "enqueued, not landed" state
  // `agent-harness doctor` surfaces — a session can no longer stop at "pushed"
  // and call it done.
  if (pr.number) {
    writeShipLedger(root, pr.number, {
      branch,
      base,
      landed: false,
      watched: false,
      phase: "enqueued",
    });
  }

  // Watch the whole loop to completion: by default whenever the PR was
  // enqueued; explicitly with `--watch`; skipped with `--no-watch`.
  const shouldWatch =
    !!args.watch || (!args["no-watch"] && !!label && !args["no-label"]);

  if (shouldWatch && pr.number) {
    const code = watchLanding(root, pr.number, {
      base,
      args,
      workflows,
      nudge: !args["no-nudge"],
    });
    writeShipLedger(root, pr.number, {
      branch,
      base,
      landed: code === 0,
      watched: true,
      phase: code === 0 ? "landed" : "pending",
    });
    if (code !== 0) {
      process.exitCode = code;
      return;
    }
    console.log(
      "\n[ship] landed + deployed. Clean up the feature worktree when the session ends:\n" +
        "       node scripts/backlog.js worktree-prune"
    );
    return;
  }

  console.log(
    `\nshipped ${branch} -> ${pr.url}` +
      (label && !args["no-label"] ? ` (label: ${label})` : "") +
      "\n  ENQUEUED — NOT DONE. Landing is the merge train's job; CI deploys the merged SHA to UAT.\n" +
      "  Do not report the task complete until the watch is green. Resume it with:\n" +
      "    npm run ship -- --watch-only"
  );
}

main();
