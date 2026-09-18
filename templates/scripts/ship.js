#!/usr/bin/env node
"use strict";
/*
 * ship — deterministic branch finalizer (no LLM).
 *
 * The worker/integrator split makes a session end at "pushed branch + open PR",
 * not at the merge. That finalization was manual, so a session could stop at
 * "gates green on my branch" and the PR was never enqueued into the landing
 * queue (the F-235 field incident: PR #17 opened, never labeled `merge-train`,
 * so the train never saw it). `ship` makes the enqueue mechanical:
 *
 *   1. refuse `main` on a dirty tree (never ship WIP or the integration branch);
 *   2. integrate early — `git fetch origin` + `git rebase origin/<base>`;
 *   3. run the branch gates (default: `test:integrate`, else `test:backlog` +
 *      `test:concurrency` when the project defines them);
 *   4. `git push` the branch (force-with-lease only when the remote branch
 *      already exists, i.e. the rebase rewrote a previously-pushed branch);
 *   5. open the PR if none is open, or reuse the existing one (`gh`);
 *   6. apply the landing label so the merge train can pick it up.
 *
 * Landing remains the merge train's job and CI owns the UAT deploy; `ship`
 * only guarantees the PR is *queued*. If `gh` is unavailable it stops after the
 * push and exits non-zero with the exact PR/label commands to run — a silent
 * "pushed, done" is never possible.
 *
 * Usage:
 *   node scripts/ship.js [--base main] [--label merge-train] [--gate "cmd"]...
 *                        [--no-rebase] [--no-gate] [--no-label] [--root dir]
 *
 * Default label resolution: `--label` > $HARNESS_SHIP_LABEL > `.harness.json`
 * `shipLabel` > `merge-train` when `.github/workflows/merge-train.yml` exists >
 * none (push + PR only).
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

function projectScripts(root) {
  const pkg = readJson(path.join(root, "package.json"));
  return (pkg && pkg.scripts) || {};
}

/* Default gate commands: the integration gate is the one-shot; fall back to the
 * board + concurrency pair when the project has no `test:integrate`. */
function defaultGates(root) {
  const scripts = projectScripts(root);
  if (scripts["test:integrate"]) return ["npm run test:integrate"];
  const gates = [];
  if (scripts["test:backlog"]) gates.push("npm run test:backlog");
  if (scripts["test:concurrency"]) gates.push("npm run test:concurrency");
  return gates;
}

/* Resolve the landing label: explicit > env > .harness.json > merge-train (when
 * the project has a merge-train workflow) > none. */
function resolveLabel(root, explicit) {
  if (explicit) return explicit;
  if (process.env.HARNESS_SHIP_LABEL) return process.env.HARNESS_SHIP_LABEL;
  const config = readJson(path.join(root, ".harness.json"));
  if (config && config.shipLabel) return String(config.shipLabel);
  if (fs.existsSync(path.join(root, ".github", "workflows", "merge-train.yml"))) return "merge-train";
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
    "ship — integrate, gate, push, and enqueue the feature branch (no LLM)\n\n" +
      "  node scripts/ship.js [--base main] [--label <name>] [--gate \"<cmd>\"]... \n" +
      "                       [--no-rebase] [--no-gate] [--no-label] [--root <dir>]\n\n" +
      "Never runs on main. Rebases on origin/<base>, runs the branch gates, pushes,\n" +
      "opens the PR if needed, and applies the landing label so the merge train\n" +
      "picks it up. Landing + the UAT deploy remain the merge train's / CI's job."
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
    spawnSync("gh", ["api", `repos/${slug}/labels/${encodeURIComponent(label)}`], {
      cwd: root,
      stdio: "ignore",
    }).status === 0;
  if (!exists) {
    console.log(`\n[label] "${label}" does not exist — creating it.`);
    if (!run("gh", ["label", "create", label, "--color", "FBCA04", "--description", "Serialized landing queue (agent-harness ship)"], { cwd: root })) {
      return false;
    }
  }
  if (!run("gh", ["api", `repos/${slug}/issues/${pr.number}/labels`, "-f", `labels[]=${label}`], { cwd: root })) {
    return false;
  }
  const labels = out("gh", ["api", `repos/${slug}/issues/${pr.number}/labels`, "--jq", ".[].name"], { cwd: root });
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
    const gates = args.gates.length ? args.gates : defaultGates(root);
    if (gates.length === 0) {
      console.warn("ship: no branch gates found (set --gate or define test:integrate) — skipping.");
    }
    for (const gate of gates) {
      if (!run(gate, [], { cwd: root, shell: true })) return fail(`ship: gate failed: ${gate}`);
    }
  }

  // Force-with-lease only when the remote branch already exists (a rebase
  // rewrote an already-pushed branch); otherwise establish tracking.
  const remoteExists = spawnSync("git", ["ls-remote", "--exit-code", "--heads", "origin", branch], { cwd: root, stdio: "ignore" }).status === 0;
  const pushArgs = remoteExists
    ? ["push", "--force-with-lease", "origin", branch]
    : ["push", "-u", "origin", branch];
  if (!run("git", pushArgs, { cwd: root })) return fail("ship: `git push` failed.");

  if (!has("gh")) {
    return fail(
      "ship: pushed, but `gh` is unavailable — the PR was NOT opened and the landing\n" +
        "      label was NOT applied. Run manually, then re-run `npm run ship`:\n" +
        `        gh pr create --base ${base} --head ${branch} --fill\n` +
        "        gh pr edit <number> --add-label <landing-label>"
    );
  }

  let pr = null;
  const list = out("gh", ["pr", "list", "--head", branch, "--state", "open", "--json", "number,url", "--limit", "1"], { cwd: root });
  try {
    const parsed = list ? JSON.parse(list) : [];
    if (parsed.length) pr = parsed[0];
  } catch {
    pr = null;
  }
  if (!pr) {
    const url = out("gh", ["pr", "create", "--base", base, "--head", branch, "--fill"], { cwd: root });
    if (!url || !/https?:\/\/\S+/.test(url)) return fail("ship: `gh pr create` did not return a PR URL.");
    const number = (url.match(/\/pull\/(\d+)/) || [])[1] || "";
    pr = { number: number ? Number(number) : url, url: (url.match(/https?:\/\/\S+/) || [])[0] };
    console.log(`\n[pr] opened #${pr.number}: ${pr.url}`);
  } else {
    console.log(`\n[pr] reusing open PR #${pr.number}: ${pr.url}`);
  }

  const label = resolveLabel(root, args.label);
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
    console.warn("ship: no landing label configured — PR opened but not enqueued (use --label to set one).");
  }

  console.log(
    `\nshipped ${branch} -> ${pr.url}` +
      (label && !args["no-label"] ? ` (label: ${label})` : "") +
      "\n  Landing is the merge train's job; CI deploys the merged SHA to UAT.\n" +
      "  Confirm with: gh pr view " +
      (pr.number || "<number>") +
      " --json state,mergedAt,labels"
  );
}

main();
