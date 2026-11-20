#!/usr/bin/env node
"use strict";
/*
 * finalize — the deterministic finalization tail in ONE command.
 *
 * The problem it solves: a full dev cycle (pick → plan → implement → QA → gates →
 * docs → archive → commit → land → confirm CI) needs more context than one
 * bounded orchestrator transcript can hold. `finalize` collapses the whole tail
 * into a single blocking command:
 *
 *   1. resolve root + feature (id arg, else the `f-<n>` branch);
 *   2. archive the row (idempotent — an already-archived row is a no-op);
 *   3. commit the tail (board + CHANGELOG + handoff + any remaining change);
 *   4. shell out to `scripts/ship.js`, which rebases onto `origin/main`, runs the
 *      branch gates, lands `HEAD:main` with a direct fast-forward push (retrying
 *      after a concurrent landing), and waits (bounded) for CI to go green on the
 *      landed SHA. The deploy runs after CI; there is no PR, label, merge train,
 *      or deploy watch.
 *
 * The one non-deterministic bit — the CHANGELOG prose — is authored by the
 * `/finish` command's single `docs` dispatch BEFORE this runs; `finalize`
 * commits whatever is in the tree.
 *
 * Usage:
 *   node scripts/finalize.js --feature <id> [--closed "<note>"]
 *        [--base main] [--root <dir>] [--dry-run]
 *        [--no-rebase] [--no-gate] [--no-ci-wait]
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

/* Whether the row is already archived on the board. When the board service is
 * the backend (ADR 0001) the board lives in the service, so ask it; otherwise
 * reuse the run-loop parser (same module the auto-resume runner trusts). */
function isArchived(feature) {
  try {
    const client = require(path.join(root, "scripts", "qa", "board-client.js"));
    if (client.enabled(root)) {
      const board = client.getBoard(root);
      return (board.archive || []).some((r) => r.id === feature);
    }
  } catch {
    /* fall back to the file parser below */
  }
  try {
    const loop = require(path.join(root, "scripts", "qa", "run-loop.js"));
    return loop.isArchived(readIf(path.join(root, "BACKLOG.md")), feature);
  } catch {
    return false;
  }
}

/* Whether HEAD is already an ancestor of `origin/<base>` — i.e. the change is
 * already landed, so a re-run is a no-op. Best-effort fetch; offline returns
 * false (a re-run then re-lands idempotently). */
function landedAlready(base) {
  spawnSync("git", ["fetch", "--quiet", "origin"], { cwd: root, stdio: "ignore", timeout: 10000 });
  const res = spawnSync("git", ["merge-base", "--is-ancestor", "HEAD", `origin/${base}`], {
    cwd: root,
    stdio: "ignore",
  });
  return res.status === 0;
}

function dirtyEntries() {
  return out("git", ["status", "--porcelain"], { cwd: root })
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("!!"));
}

/* Generated / machine-local paths that must never ride into a feature commit.
 * `git add -A` used to sweep these up (a worktree's `prisma/generated` symlink
 * broke CI on a fresh checkout), so they are blocked explicitly. */
const BLOCKED_PATTERNS = [
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)\.next(\/|$)/,
  /(^|\/)\.turbo(\/|$)/,
  /(^|\/)dist(\/|$)/,
  /(^|\/)build(\/|$)/,
  /(^|\/)coverage(\/|$)/,
  /(^|\/)prisma\/generated(\/|$)/,
  /(^|\/)\.env(\..*)?$/,
  /\.(log|tsbuildinfo)$/,
];

function isBlockedPath(rel) {
  return BLOCKED_PATTERNS.some((re) => re.test(rel.replace(/\\/g, "/")));
}

/* `git ls-files --others --exclude-standard` -> repo-relative untracked paths. */
function untrackedFiles() {
  return out("git", ["ls-files", "--others", "--exclude-standard"], { cwd: root })
    .split(/\r?\n/)
    .filter(Boolean);
}

function isSymlink(rel) {
  try {
    return fs.lstatSync(path.join(root, rel)).isSymbolicLink();
  } catch {
    return false;
  }
}

/* Stage the finalization tail without `git add -A`.
 *
 * - tracked changes (`git add -u`) are the feature's own edits;
 * - untracked tail files (handoff, feature docs, QA plan, memory, docs) are added;
 * - untracked generated/symlinked/machine-local paths are refused, never staged;
 * - a stray `BACKLOG.md` diff is refused when the board service owns the board
 *   (a worktree-local row is a duplicate that would collide on merge).
 *
 * Returns { ok, blocked } — blocked lists the paths that need a human decision.
 */
function stageTail(feature, opts = {}) {
  const includeBlocked = Boolean(opts.includeBlocked);
  if (!run("git", ["add", "-u"], { cwd: root })) return { ok: false, blocked: [] };

  const blocked = [];
  const boardService = boardServiceEnabled();
  for (const rel of untrackedFiles()) {
    if (rel === "BACKLOG.md" && boardService) {
      blocked.push(`${rel} (board service owns the board — worktree copy is a duplicate)`);
      continue;
    }
    if (isBlockedPath(rel) || isSymlink(rel)) {
      blocked.push(rel);
      continue;
    }
    // Another feature's handoff is never part of this landing; it is either a
    // stale copy from a shared checkout or work that belongs to that session.
    if (rel.startsWith(".agents/handoffs/") && rel !== `.agents/handoffs/${feature}.md`) {
      blocked.push(`${rel} (another feature's handoff)`);
      continue;
    }
    if (!run("git", ["add", "--", rel], { cwd: root })) return { ok: false, blocked };
  }

  // A tracked BACKLOG.md diff with the board service enabled is the same
  // duplicate row, just already tracked. Never let it into the landing commit.
  if (boardService) {
    const blockedBoard = dirtyEntries().filter((l) => /(^|\s)BACKLOG\.md$/.test(l) || l.endsWith(" BACKLOG.md"));
    if (blockedBoard.length) {
      blocked.push("BACKLOG.md (board service owns the board — restore or move the row to the service)");
    }
  }

  if (blocked.length && !includeBlocked) {
    console.error(
      "\n[finalize] refusing to commit these non-tail paths:\n" +
        [...new Set(blocked)].map((l) => `      ${l}`).join("\n") +
        "\n      Move/commit/delete them first, or re-run with --include-blocked to stage them deliberately."
    );
    return { ok: false, blocked };
  }
  if (blocked.length && includeBlocked) {
    console.log("\n[finalize] --include-blocked: staging the paths above.");
    if (!run("git", ["add", "-A"], { cwd: root })) return { ok: false, blocked };
  }
  return { ok: true, blocked: [] };
}

function boardServiceEnabled() {
  try {
    return require(path.join(root, "scripts", "qa", "board-client.js")).enabled(root);
  } catch {
    return false;
  }
}

/* After a landing: converge the main checkout (ff-only, only when clean) and
 * print the close-out steps that used to appear as a session-ending remark. */
function closeOut(base, feature) {
  let hygiene;
  try {
    hygiene = require(path.join(root, "scripts", "qa", "worktree-hygiene.js"));
  } catch {
    return;
  }
  spawnSync("git", ["fetch", "--quiet", "origin"], { cwd: root, stdio: "ignore", timeout: 10000 });
  const h = hygiene.hygiene(root, base, process.cwd());
  if (!h) return;
  console.log(`\n[finalize] close-out: ${hygiene.describe(h)}`);

  if (h.main.behind > 0 && h.main.dirty === 0) {
    console.log(`[finalize] converging the main checkout: git -C ${h.main.path} merge --ff-only ${h.baseRef}`);
    const merged = spawnSync("git", ["-C", h.main.path, "merge", "--ff-only", h.baseRef], { encoding: "utf8" });
    if (merged.status === 0) console.log(`[finalize] main checkout is now up to date.`);
    else console.log(`[finalize] could not fast-forward the main checkout:\n${String(merged.stderr || merged.stdout || "").trim()}`);
  }

  const advice = hygiene.closeOutAdvice(hygiene.hygiene(root, base, process.cwd()));
  if (advice.length) {
    console.log("[finalize] close-out actions still open:");
    for (const a of advice) console.log(`      - ${a}`);
    console.log(`      (the next session's orient auto-prunes merged, clean worktrees; ${feature} cannot be removed from inside it)`);
  } else {
    console.log("[finalize] no leftovers: main is in sync and no merged worktree remains.");
  }
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
    else if (a === "--no-rebase") args["no-rebase"] = true;
    else if (a === "--no-gate") args["no-gate"] = true;
    else if (a === "--no-ci-wait") args["no-ci-wait"] = true;
    else if (a === "--include-blocked") args["include-blocked"] = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else args._.push(a);
  }
  return args;
}

function usage() {
  console.log(
    "finalize — archive + commit + land + confirm CI in one deterministic step (no LLM)\n\n" +
      '  node scripts/finalize.js --feature <id> [--closed "<note>"] [--base main]\n' +
      "                           [--root <dir>] [--dry-run]\n" +
      "                           [--no-rebase] [--no-gate] [--no-ci-wait]\n\n" +
      "Collapses the finalization tail into one blocking command: archive the row,\n" +
      "commit the board + CHANGELOG + handoff, then `ship` (rebase, gates, direct\n" +
      "land on the integration branch, and a bounded wait for green CI). The deploy\n" +
      "runs after CI. Safe to re-run."
  );
}

let root = process.cwd();

function shipArgs(args) {
  const passthrough = [];
  if (args.base) passthrough.push("--base", args.base);
  if (args["no-rebase"]) passthrough.push("--no-rebase");
  if (args["no-gate"]) passthrough.push("--no-gate");
  if (args["no-ci-wait"]) passthrough.push("--no-ci-wait");
  return passthrough;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();

  const found = args.root ? path.resolve(args.root) : findRoot(process.cwd());
  if (!found) return fail("finalize: no git repository found (no .git in this tree or its parents).");
  root = found;

  const base = args.base || "main";
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
    console.log(`  landed:   ${landedAlready(base) ? "yes" : "no"}`);
    console.log("  plan:     archive -> commit -> ship (rebase, gates, land, confirm CI)");
    return;
  }

  // Idempotence: an already-archived row whose branch is contained in
  // `origin/<base>` is done.
  if (archived && landedAlready(base)) {
    console.log(`[finalize] ${feature} is already archived and its branch is landed on ${base} — nothing to do.`);
    return;
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

  // 2. Commit the tail (board + CHANGELOG + handoff + remaining feature work)
  //    so `ship`'s dirty-tree guard cannot abort the documented one-command
  //    close. Staging is scoped: generated artifacts, symlinks and a stray
  //    worktree BACKLOG.md are refused instead of being swept in by `-A`.
  const dirty = dirtyEntries();
  if (dirty.length) {
    console.log(
      `\n[finalize] committing the finalization tail:\n` + dirty.map((l) => `      ${l}`).join("\n")
    );
    const staged = stageTail(feature, { includeBlocked: args["include-blocked"] });
    if (!staged.ok) return fail("finalize: the finalization tail is not safe to stage — see above.");
    if (!run("git", ["commit", "-m", `chore(${feature}): finalize — board + changelog`], { cwd: root })) {
      return fail("finalize: the finalization commit failed.");
    }
  } else {
    console.log("\n[finalize] tree already clean — nothing to commit.");
  }

  // 3. Ship: rebase, gates, direct land, and a bounded CI-green wait.
  if (!run(process.execPath, [shipScript, ...shipArgs(args)], { cwd: root })) {
    return fail(
      "finalize: ship did not complete. If the push landed but CI is unconfirmed, re-run:\n" +
        `      npm run finalize -- --feature ${feature}`
    );
  }

  // 4. Close the loop that used to be a session-ending remark: converge the
  //    main checkout and name every leftover worktree explicitly.
  closeOut(base, feature);

  console.log(`\n[finalize] ${feature} landed + CI green.`);
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
