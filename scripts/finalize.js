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

/* One case/separator-insensitive resolver (F-046), loaded lazily so an older
 * deploy without it still runs the legacy exact-name lookup. */
let resolverMod;
function featureResolver() {
  if (resolverMod === undefined) {
    try {
      resolverMod = require(path.join(root, "scripts", "qa", "feature-resolver.js"));
    } catch {
      resolverMod = null;
    }
  }
  return resolverMod;
}

/* Compare feature ids the way the resolver does (`f-045` === `F-045`). */
function normalizeFeatureId(value) {
  const resolver = featureResolver();
  if (resolver) return resolver.normalizeId(value);
  return String(value == null ? "" : value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/* The feature id from a branch name (`f-257` -> `F-257`, `feat/F-12-x` -> `F-12`). */
function featureFromBranch(branch) {
  const m = String(branch || "").match(/(?:^|\/)[fF]-?([0-9]+)/);
  return m ? `F-${m[1]}` : null;
}

/* Every checkout of this repo: the shared main checkout first, then linked
 * feature worktrees (`git worktree list --porcelain` order). */
function worktreePaths() {
  const res = spawnSync("git", ["-C", root, "worktree", "list", "--porcelain"], { encoding: "utf8" });
  if (res.status !== 0) return [];
  return String(res.stdout || "")
    .split(/\r?\n/)
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length).trim())
    .filter(Boolean);
}

/* The feature's handoff file in this checkout, or in another checkout of the
 * same repo — the shared main checkout is where a checkpoint lands when the
 * session writes it BEFORE moving into its feature worktree. */
function findHandoff(feature) {
  const resolver = featureResolver();
  if (resolver) {
    const res = resolver.resolveFeature(root, feature);
    if (res.file) return { file: path.resolve(res.file), local: path.resolve(res.fileRoot) === path.resolve(root) };
  }
  const local = path.join(root, ".agents", "handoffs", feature + ".md");
  if (fs.existsSync(local)) return { file: local, local: true };
  for (const dir of worktreePaths()) {
    if (path.resolve(dir) === path.resolve(root)) continue;
    const candidate = path.join(dir, ".agents", "handoffs", feature + ".md");
    if (fs.existsSync(candidate)) return { file: candidate, local: false };
  }
  return null;
}

/* Is `rel` untracked in `dir`? (A committed handoff is history, never moved.) */
function isUntracked(dir, rel) {
  const res = spawnSync("git", ["-C", dir, "status", "--porcelain", "--", rel], { encoding: "utf8" });
  if (res.status !== 0) return false;
  return String(res.stdout || "")
    .split(/\r?\n/)
    .some((l) => /^\?\?\s/.test(l));
}

/* Migrate this feature's handoff into the landing checkout when it was written
 * in another checkout (the shared main tree). `finalize` can only commit what is
 * in its own tree, so a copy left in main silently orphaned the handoff — and
 * later blocked main's fast-forward ("untracked working tree files would be
 * overwritten"). An untracked source is moved (copy + unlink); a tracked source
 * is copied and left to its own checkout. Returns the destination path or null. */
function syncHandoff(feature) {
  const dest = path.join(root, ".agents", "handoffs", feature + ".md");
  if (fs.existsSync(dest)) return null;
  const found = findHandoff(feature);
  if (!found) return null;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(found.file, dest);
  const sourceDir = path.dirname(path.dirname(path.dirname(found.file)));
  const rel = path.posix.join(".agents", "handoffs", path.basename(found.file));
  if (isUntracked(sourceDir, rel) && path.resolve(sourceDir) !== path.resolve(root)) {
    fs.unlinkSync(found.file);
    console.log(`\n[finalize] moved ${rel} from ${sourceDir} into the landing checkout (it would otherwise be orphaned).`);
  } else {
    console.log(`\n[finalize] copied ${rel} from ${sourceDir} into the landing checkout.`);
  }
  return dest;
}

/* Fill the handoff's dispatch log from observed child sessions when it is still
 * the checkpoint placeholder. A hand-authored log is kept untouched: it is
 * evidence too, and finalize must not overwrite another session's record. */
function deriveDispatchLog(feature) {
  const file = path.join(root, ".agents", "handoffs", feature + ".md");
  if (!fs.existsSync(file)) return null;
  let dl;
  try {
    dl = require(path.join(root, "scripts", "qa", "dispatch-log.js"));
  } catch {
    return null; // older deployment has no renderer; leave the handoff as-is
  }
  const text = readIf(file);
  if (!text || dl.hasEntries(text)) return { file, changed: false, reason: "existing log kept" };
  let rows = [];
  try {
    const store = require(path.join(root, "scripts", "qa", "store-lib.js"));
    rows = dl.deriveRows({ query: store.openStore().query, feature });
  } catch {
    rows = []; // no store: the honest direct-lane line, never an invented row
  }
  const applied = dl.applyDerivedLog(text, rows, { feature });
  if (applied.changed) fs.writeFileSync(file, applied.text);
  console.log(`[finalize] dispatch log: ${applied.reason}`);
  return { file, ...applied };
}

/* Untracked handoffs OTHER sessions left in the shared main checkout. They are
 * not this landing's work, but they must not stay invisible either. */
function orphanHandoffs(feature) {
  const main = worktreePaths()[0];
  if (!main || path.resolve(main) === path.resolve(root)) return [];
  const res = spawnSync("git", ["-C", main, "status", "--porcelain", "--untracked-files=all", "--", ".agents/handoffs"], {
    encoding: "utf8",
  });
  if (res.status !== 0) return [];
  return String(res.stdout || "")
    .split(/\r?\n/)
    .filter((l) => /^\?\?\s/.test(l))
    .map((l) => l.replace(/^\?\?\s+/, "").trim().replace(/^"|"$/g, ""))
    .filter((rel) => rel.toLowerCase().endsWith(".md") && path.basename(rel).toLowerCase() !== "readme.md")
    .filter((rel) => normalizeFeatureId(path.basename(rel).replace(/\.md$/i, "")) !== normalizeFeatureId(feature));
}

/* The handoff's recorded outcome, if any (`## Session metadata` -> `- outcome:`). */
function handoffOutcome(feature) {
  const found = findHandoff(feature);
  const src = found ? readIf(found.file) : "";
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

/* `git status --porcelain` line -> repo-relative path (rename-aware). */
function statusPath(line) {
  let raw = line.slice(3).trim();
  const arrow = raw.lastIndexOf(" -> ");
  if (arrow !== -1) raw = raw.slice(arrow + 4).trim();
  return raw.replace(/^"|"$/g, "");
}

/* Paths from RAW porcelain output. `dirtyEntries()` trims the whole stdout, which
 * eats the leading space of a ` M <path>` first line — paths must never be
 * sliced from that (F-028: `CHANGELOG.md` became `ACKLOG.md`). */
function dirtyPaths() {
  const res = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  if (res.status !== 0) return [];
  return String(res.stdout || "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map(statusPath)
    .filter(Boolean);
}

/* Minimal glob -> regex (`**` any depth, `*` within a segment, `?` one char),
 * same semantics as `scripts/qa/check-concurrency.js`. */
function globToRegExp(glob) {
  let s = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        s += ".*";
        i++;
      } else {
        s += "[^/]*";
      }
    } else if (c === "?") {
      s += "[^/]";
    } else {
      s += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp("^" + s + "$");
}

function matchesGlob(glob, file) {
  const g = String(glob).replace(/\\/g, "/").replace(/^\.\//, "");
  const f = String(file).replace(/\\/g, "/").replace(/^\.\//, "");
  return globToRegExp(g).test(f);
}

/* Globs this feature declared it owns (`backlog owns <id> --files ...`), read
 * from the board service when enabled, else `.agents/memory/owned-files.md`. */
function ownedGlobs(feature) {
  const id = String(feature).toUpperCase();
  try {
    const client = require(path.join(root, "scripts", "qa", "board-client.js"));
    if (client.enabled(root)) {
      const row = (client.getBoard(root).inprogress || []).find(
        (r) => String(r.id).toUpperCase() === id
      );
      if (row && Array.isArray(row.owned) && row.owned.length) return row.owned;
      return [];
    }
  } catch {
    /* fall through to the file registry */
  }
  const p = path.join(root, ".agents", "memory", "owned-files.md");
  const globs = [];
  for (const line of readIf(p).split(/\r?\n/)) {
    const m = line.match(/^\s*[-*]\s+([A-Za-z]+-\d+)\s*:\s*(.+)$/);
    if (m && m[1].toUpperCase() === id) {
      globs.push(...m[2].split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean));
    }
  }
  return globs;
}

/* The finalization tail this command owns regardless of an ownership
 * declaration: the board + changelog, this feature's handoff / QA plan / QA run
 * / review, and the shared feature-doc tree. */
function isTailPath(rel, feature) {
  const f = String(rel).replace(/\\/g, "/");
  const id = String(feature).toUpperCase();
  if (f === "CHANGELOG.md" || f === "BACKLOG.md") return true;
  if (f === ".agents/handoffs/INDEX.md") return true;
  // The ownership registry is the guard's own escape hatch: `backlog owns`
  // dirties this file, and committing it is part of the tail.
  if (f === ".agents/memory/owned-files.md") return true;
  const matchId = (prefix) => {
    const m = f.match(new RegExp("^" + prefix + "/(.+)$", "i"));
    return !!m && m[1].toUpperCase().startsWith(id);
  };
  if (f.toUpperCase() === `.AGENTS/HANDOFFS/${id}.MD`) return true;
  if (matchId("\\.agents/qa-plans")) return true;
  if (matchId("\\.agents/qa-runs")) return true;
  if (matchId("\\.agents/reviews")) return true;
  if (f.startsWith(".agents/features/")) return true;
  return false;
}

/* Live primary sessions OTHER than this one sharing this checkout
 * (`.serve/sessions/` leases, same liveness rules as the concurrency gate). */
function otherLiveSessions() {
  try {
    const leases = require(path.join(root, "scripts", "qa", "lease-lib.js"));
    const self = process.env.OPENCODE_SESSION_ID || "";
    return leases.readLeases(root).filter((rec) => leases.leaseStatus(rec).live && rec.sessionID !== self);
  } catch {
    return [];
  }
}

/* `{ others, foreign }`: when another live session shares this checkout, every
 * dirty path must be provably this feature's (its tail or a declared glob) or it
 * is foreign WIP that must never enter this landing commit. */
function foreignWip(feature) {
  const others = otherLiveSessions();
  if (!others.length) return { others, foreign: [] };
  const owned = ownedGlobs(feature);
  const foreign = dirtyPaths().filter(
    (rel) => !isTailPath(rel, feature) && !owned.some((g) => matchesGlob(g, rel))
  );
  return { others, foreign };
}

function foreignWipMessage(feature, others, foreign) {
  return (
    "\n[finalize] refusing to stage a shared checkout that holds another live session's WIP:\n" +
    others.map((r) => `      another live session: ${r.sessionID || r.name} (pid ${r.pid})`).join("\n") +
    "\n" +
    foreign.map((rel) => `      not this landing: ${rel}`).join("\n") +
    "\n      This checkout is shared, so finalize cannot tell that work apart from yours.\n" +
    `      Move it into its own worktree, commit/stash it, or declare it with \`backlog owns ${feature} --files ...\`.\n` +
    "      Re-run with --include-blocked only to stage it deliberately."
  );
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
  // A shared checkout is staged by ALLOWLIST, never by `git add -u`: another
  // live session's tracked edits must not ride into this landing. Check and
  // stage explicitly before the untracked sweep below.
  const shared = includeBlocked ? { others: [], foreign: [] } : foreignWip(feature);
  if (shared.foreign.length) {
    console.error(foreignWipMessage(feature, shared.others, shared.foreign));
    return { ok: false, blocked: shared.foreign };
  }

  if (shared.others.length) {
    const owned = ownedGlobs(feature);
    const allowed = dirtyPaths().filter(
      (rel) => isTailPath(rel, feature) || owned.some((g) => matchesGlob(g, rel))
    );
    if (allowed.length && !run("git", ["add", "--", ...allowed], { cwd: root })) {
      return { ok: false, blocked: [] };
    }
  } else if (!run("git", ["add", "-u"], { cwd: root })) {
    return { ok: false, blocked: [] };
  }

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
  // Other sessions' handoffs are not this landing's work, but leaving them
  // untracked in the shared main checkout is how a session handoff gets
  // silently orphaned (and later blocks main's fast-forward). Name them.
  const orphans = orphanHandoffs(feature);
  if (orphans.length) {
    console.log("\n[finalize] untracked session handoffs left in the shared main checkout:");
    for (const rel of orphans) console.log(`      ${rel}`);
    console.log(
      "      Commit each from its own feature worktree (finalize migrates that feature's handoff),\n" +
        "      or delete it if it is stale — main cannot land an unreviewed handoff for another feature."
    );
  }

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
    else if (a === "--defer-archive") args["defer-archive"] = true;
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
      "                           [--no-rebase] [--no-gate] [--no-ci-wait]\n" +
      "                           [--defer-archive]\n\n" +
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

  let feature = args.feature || featureFromBranch(branch);
  if (!feature) {
    return fail(
      `finalize: could not derive a feature id from branch "${branch}".\n` +
        "      Pass --feature <id> explicitly."
    );
  }
  // Canonical spelling, whatever case/separators the caller used (`f-046` -> `F-046`).
  const resolver = featureResolver();
  if (resolver) feature = resolver.resolveFeature(root, feature).id || feature;

  const shipScript = path.join(root, "scripts", "ship.js");
  if (!fs.existsSync(shipScript)) {
    return fail(`finalize: ${path.relative(root, shipScript)} not found — is the harness deployed in this project?`);
  }

  const closed = args.closed || handoffOutcome(feature) || "shipped";
  const archived = isArchived(feature);
  const deferArchive = !!args["defer-archive"];
  // A shared checkout must not stage another live session's WIP. Refuse BEFORE
  // the archive/commit so nothing is written when the tree cannot be separated.
  const preflight = args["include-blocked"] ? { others: [], foreign: [] } : foreignWip(feature);

  if (args["dry-run"]) {
    console.log("finalize (dry run)\n");
    console.log(`  root:     ${root}`);
    console.log(`  feature:  ${feature}`);
    console.log(`  branch:   ${branch}`);
    console.log(`  closed:   ${closed}`);
    console.log(`  archived: ${archived ? "yes" : "no"}`);
    console.log(`  landed:   ${landedAlready(base) ? "yes" : "no"}`);
    if (preflight.others.length) {
      console.log(`  shared:   ${preflight.others.length} other live session(s) — ${preflight.foreign.length} foreign WIP path(s)`);
    }
    console.log(
      "  plan:     " +
        (args["defer-archive"] ? "commit -> ship (rebase, gates, land, confirm CI) -> archive" : "archive -> commit -> ship (rebase, gates, land, confirm CI)")
    );
    return;
  }

  if (preflight.foreign.length) {
    return fail(foreignWipMessage(feature, preflight.others, preflight.foreign));
  }

  // Idempotence: an already-archived row whose branch is contained in
  // `origin/<base>` is done.
  if (archived && landedAlready(base)) {
    console.log(`[finalize] ${feature} is already archived and its branch is landed on ${base} — nothing to do.`);
    return;
  }

  // Inquiry loop: a declared bug/incident/fix must carry a falsified diagnosis
  // BEFORE anything is staged. Legacy features warn only (the gate owns that
  // policy); a malformed diagnosis is a blocker, not a warning.
  const diagnosisScript = path.join(root, "scripts", "qa", "check-diagnosis.js");
  if (fs.existsSync(diagnosisScript)) {
    const ok = run(process.execPath, [diagnosisScript, "--feature", feature], { cwd: root });
    if (!ok) {
      return fail(
        `finalize: ${feature} has an incomplete diagnosis — fill .agents/features/<slug>/diagnosis.md ` +
          "(candidates + discriminating tests + falsifier + outcome oracle), then re-run."
      );
    }
  }

  const backlogScript = path.join(root, "scripts", "backlog.js");

  // 1. Archive the row (idempotent). The archive runs from inside the worktree,
  //    so it moves the row in THIS board and skips removing this checkout.
  //    `--defer-archive` (orchestrator lander) moves the board write AFTER the
  //    CI-green confirmation, so a red landing never closes the row.
  if (!archived && !deferArchive) {
    if (!fs.existsSync(backlogScript)) return fail(`finalize: ${path.relative(root, backlogScript)} not found.`);
    if (!run(process.execPath, [backlogScript, "archive", feature, "--closed", closed], { cwd: root })) {
      return fail(`finalize: could not archive ${feature} — fix the board error above, then re-run.`);
    }
  } else if (deferArchive && !archived) {
    console.log(`[finalize] ${feature}: archive deferred until CI is green.`);
  } else {
    console.log(`[finalize] ${feature} is already archived — skipping the board write.`);
  }

  // 2. Commit the tail (board + CHANGELOG + handoff + remaining feature work)
  //    so `ship`'s dirty-tree guard cannot abort the documented one-command
  //    close. Staging is scoped: generated artifacts, symlinks and a stray
  //    worktree BACKLOG.md are refused instead of being swept in by `-A`.
  //    A handoff written in the shared main checkout before the session moved
  //    here is migrated first — this checkout can only commit what it holds.
  syncHandoff(feature);
  deriveDispatchLog(feature);
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

  // 4. Deferred archive: CI is green, so the row may now close. This is a board
  //    service write (no file commit), which is why it can safely happen after
  //    the landing push.
  if (deferArchive && !archived) {
    if (!fs.existsSync(backlogScript)) return fail(`finalize: ${path.relative(root, backlogScript)} not found.`);
    if (!run(process.execPath, [backlogScript, "archive", feature, "--closed", closed], { cwd: root })) {
      return fail(
        `finalize: landed + CI green, but archiving ${feature} failed — fix the board error and re-run archive.`
      );
    }
    console.log(`[finalize] ${feature} archived after CI green.`);
  }

  // 5. Close the loop that used to be a session-ending remark: converge the
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

module.exports = { featureFromBranch, handoffOutcome, syncHandoff, deriveDispatchLog, orphanHandoffs, worktreePaths };
