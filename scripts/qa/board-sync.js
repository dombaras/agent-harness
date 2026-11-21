#!/usr/bin/env node
"use strict";
/*
 * board-sync — the single home for bringing the canonical checkout's BACKLOG.md
 * into agreement with `origin/<base>`, and for publishing board edits back.
 *
 * The board is a single markdown file duplicated in every checkout. Feature work
 * lands on `origin/main` from its own worktree, so the main checkout's copy
 * drifts. Two failure modes recur under concurrent work:
 *
 *   1. A board mutation read a stale working copy and "resurrected" a row that
 *      had already been archived upstream (it still showed Open locally).
 *   2. The post-landing fast-forward bailed on ANY tracked dirty file other than
 *      BACKLOG.md — even one whose working content was already identical to
 *      upstream — so main silently drifted further behind every landing.
 *
 * This module provides the primitives both `backlog.js` (mutations) and
 * `ship.js` (post-landing convergence) share, so they can never disagree:
 *
 *   - classifyDirty(): split tracked dirt into board / redundant / genuine.
 *   - reconcileWorkingBoard(): row-aware 3-way merge of the working board
 *     against the upstream board (an archived-upstream row wins; local-only
 *     rows survive). Delegates to merge-backlog.js.
 *   - convergeCanonical(): fetch, clear redundant dirt, reconcile, fast-forward.
 *     Fails closed on genuine local changes rather than skipping silently.
 *   - publishBoard(): commit the reconciled board and fast-forward push it with
 *     a bounded fetch+rebase retry, so the board is never left as working-tree
 *     dirt that a later `git checkout --` could wipe.
 *
 * No locking here: `withLock` lives in backlog.js (the board write path owner);
 * callers wrap convergeCanonical/publishBoard in it.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const MAX_PUBLISH_ATTEMPTS = 3;

// Repo-scoping GIT_* vars can leak in from a parent git hook (husky's pre-push
// exports GIT_DIR); `git -C <root>` must always target `root`, so drop them.
const REPO_SCOPING_GIT_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_PREFIX",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
];

function hermeticGitEnv() {
  const env = { ...process.env };
  for (const k of REPO_SCOPING_GIT_VARS) delete env[k];
  return env;
}

function gitCmd(root, args, opts) {
  return spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    timeout: (opts && opts.timeout) || 0,
    env: hermeticGitEnv(),
  });
}

/* First non-empty line of a git command's error output, for the publish
 * failure note. A bare `reason` code ("add-failed") hid the real cause for
 * weeks (F-004): the operator saw "remote unreachable" for a local `git add`
 * rejection. */
function firstLine(r) {
  return String((r && (r.stderr || r.stdout)) || "")
    .split(/\r?\n/)
    .find((l) => l.trim()) || "";
}

function gitOut(root, args, opts) {
  const r = gitCmd(root, args, opts);
  return r.status === 0 ? String(r.stdout || "").trim() : "";
}

/* The MAIN worktree's path (first entry of `git worktree list --porcelain`), or
 * null. A feature session runs in a linked worktree, so canonical-board logic
 * (`convergeCanonical` / `publishBoard`) applies only to the main checkout. */
function mainWorktreeRoot(root) {
  const r = gitCmd(root, ["worktree", "list", "--porcelain"]);
  if (r.status !== 0) return null;
  const first = String(r.stdout || "").split(/\r?\n/).find((l) => l.startsWith("worktree "));
  return first ? first.slice("worktree ".length).trim() : null;
}

function isCanonicalCheckout(root) {
  const main = mainWorktreeRoot(root);
  return !!main && path.resolve(main) === path.resolve(root);
}

function currentUpstream(root) {
  return gitOut(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
}

/* `<tree-ish>:<path>` as text, or "" when the ref/path does not exist. */
function gitShow(root, spec) {
  const r = gitCmd(root, ["show", spec]);
  return r.status === 0 ? String(r.stdout || "") : "";
}

function readWorkingBoard(root) {
  try {
    return fs.readFileSync(path.join(root, "BACKLOG.md"), "utf8");
  } catch {
    return "";
  }
}

/* A porcelain v2-ish path from a `git status --porcelain` line: strips the XY
 * status, any rename arrow, and surrounding quotes. */
function porcelainPath(line) {
  let p = line.slice(3);
  const arrow = p.indexOf(" -> ");
  if (arrow !== -1) p = p.slice(arrow + 4);
  p = p.trim();
  if (p.startsWith('"') && p.endsWith('"')) {
    p = p
      .slice(1, -1)
      .replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
      .replace(/\\(.)/g, "$1");
  }
  return p;
}

function dirtyTracked(root) {
  const r = gitCmd(root, ["status", "--porcelain", "--untracked-files=no"]);
  if (r.status !== 0) return [];
  return String(r.stdout || "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => ({ line, path: porcelainPath(line) }));
}

/* 3-way reconcile of the working board against the upstream board. `base` is the
 * checkout's committed board, `ours` the working board, `theirs` the landed
 * upstream board. Returns merge-backlog's `{ ok, board, dropped, conflicts }`;
 * when there is no upstream board (or no merge module) it degrades to `ours`. */
function reconcileWorkingBoard(root, upstream) {
  const ours = readWorkingBoard(root);
  const theirs = gitShow(root, `${upstream}:BACKLOG.md`);
  const base = gitShow(root, "HEAD:BACKLOG.md");
  if (!theirs) return { ok: true, board: ours, dropped: [], conflicts: [] };
  let rec;
  try {
    rec = require("./merge-backlog.js").reconcileBoard(base, ours, theirs);
  } catch (e) {
    return { ok: false, board: ours, dropped: [], conflicts: [], error: e.message };
  }
  return rec;
}

/* Split the canonical checkout's tracked dirt: the board, non-board paths whose
 * working content is byte-identical to upstream (safe to discard), and genuine
 * local edits (which must never be force-resolved). */
function classifyDirty(root, upstream) {
  const entries = dirtyTracked(root);
  const board = [];
  const redundant = [];
  const genuine = [];
  for (const e of entries) {
    if (e.path === "BACKLOG.md") {
      board.push(e.path);
      continue;
    }
    const diff = gitCmd(root, ["diff", "--quiet", upstream, "--", e.path]);
    if (diff.status === 0) redundant.push(e.path);
    else genuine.push(e.path);
  }
  return { board, redundant, genuine, entries };
}

function clearRedundant(root, upstream, paths) {
  if (!paths || !paths.length) return true;
  const r = gitCmd(root, ["checkout", upstream, "--", ...paths]);
  return r.status === 0;
}

/* True when every commit HEAD carries over `upstream` touches only BACKLOG.md —
 * i.e. the checkout is ahead solely because of unpublished board commits, which
 * can be replayed onto upstream automatically. Any other commit means genuine
 * divergence and must not be silently rewritten. */
function aheadOnlyBoard(root, upstream) {
  const r = gitCmd(root, ["rev-list", `${upstream}..HEAD`]);
  if (r.status !== 0) return false;
  const commits = String(r.stdout || "").split(/\r?\n/).filter(Boolean);
  for (const c of commits) {
    const files = gitCmd(root, ["show", "--name-only", "--format=", c]);
    if (files.status !== 0) return false;
    const paths = String(files.stdout || "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (paths.some((p) => p !== "BACKLOG.md")) return false;
  }
  return true;
}

/* True when every commit HEAD carries over `upstream` is a local harness deploy
 * commit (`chore(harness): …`). Those are safe to replay onto upstream with a
 * plain rebase — the object was a deploy that committed but never pushed while
 * upstream advanced with feature landings (the F-303/F-304 "not publishing"
 * drift). Arbitrary local work is NOT replayed: it keeps the report-only path. */
function aheadOnlyHarness(root, upstream) {
  const r = gitCmd(root, ["log", "--format=%s", `${upstream}..HEAD`]);
  if (r.status !== 0) return false;
  const subjects = String(r.stdout || "").split(/\r?\n/).filter(Boolean);
  return subjects.length > 0 && subjects.every((s) => /^chore\(harness\)/.test(s));
}

/* Replay local board-only commits onto `upstream` using the same row-aware
 * reconcile as the rest of the module — NOT `git rebase`, which depends on the
 * per-clone merge driver being registered (a fresh clone that never ran
 * `agent-harness update` has no driver, so a textual rebase conflicts on the
 * board). The checkout is advanced with `reset --hard` so HEAD, the index, and
 * the working tree move together: a `reset --soft` left the index/worktree
 * stale, turning every landed upstream non-board commit into a permanent staged
 * reverse-diff that corrupted the canonical checkout. Genuine uncommitted
 * non-board changes fail the replay closed (never silently discarded). Returns
 * `{ ok, changed, blockedBy }`. Idempotent: when HEAD already descends from
 * `upstream` and its board already equals the reconciled board, the local board
 * commits are already replayed, so the reset+recommit is skipped (otherwise it
 * would mint a fresh SHA — same tree, new committer timestamp — on every call,
 * churning a new board commit per mutation). */
function replayBoardOnly(root, upstream) {
  const ours = readWorkingBoard(root);
  const mb = gitCmd(root, ["merge-base", upstream, "HEAD"]);
  const baseRef = mb.status === 0 ? String(mb.stdout || "").trim() : "";
  const base = baseRef ? gitShow(root, `${baseRef}:BACKLOG.md`) : gitShow(root, "HEAD:BACKLOG.md");
  const theirs = gitShow(root, `${upstream}:BACKLOG.md`);
  const rec = require("./merge-backlog.js").reconcileBoard(base, ours, theirs);
  if (!rec.ok) return { ok: false, conflicts: rec.conflicts || [] };

  // A hard reset must never discard uncommitted work: the only tracked dirt we
  // may clear is the board itself (already reconciled into `rec.board` above).
  // Any other dirty path is genuine local state — fail closed so the caller
  // cannot move the checkout and silently lose it.
  const blockedBy = dirtyTracked(root)
    .map((e) => e.path)
    .filter((p) => p !== "BACKLOG.md");
  if (blockedBy.length) return { ok: false, conflicts: [], blockedBy };

  // Idempotency short-circuit: if HEAD already descends from `upstream` and its
  // board already equals the reconciled board, the local board-only commits are
  // already replayed. Reset+recommit would only mint a fresh SHA (identical tree,
  // new committer timestamp) on every call, so `backlog.js sync`/every mutation
  // would churn a new board commit. Nothing to do — leave HEAD untouched.
  const upstreamSha = gitOut(root, ["rev-parse", upstream]);
  const mergeBase = gitOut(root, ["merge-base", upstream, "HEAD"]);
  if (upstreamSha && mergeBase === upstreamSha && gitShow(root, "HEAD:BACKLOG.md") === rec.board) {
    return { ok: true, changed: false };
  }

  const reset = gitCmd(root, ["reset", "--hard", upstream]);
  if (reset.status !== 0) return { ok: false, conflicts: [], blockedBy: [] };
  fs.writeFileSync(path.join(root, "BACKLOG.md"), rec.board, "utf8");
  gitCmd(root, ["add", "--", "BACKLOG.md"]);
  const staged = gitCmd(root, ["diff", "--cached", "--quiet", "--", "BACKLOG.md"]);
  if (staged.status === 0) return { ok: true, changed: false };
  const c = gitCmd(root, ["commit", "-q", "-m", "chore(board): replay local board rows", "--", "BACKLOG.md"]);
  return { ok: c.status === 0, changed: c.status === 0 };
}

/* Bring the canonical checkout level with `upstream`, reconciling the board
 * row-aware. Returns `{ ok, behind, ahead, board, dropped, notes, blockedBy,
 * canPublish }`:
 *
 *   - `ok:false` — the board cannot be made safe (genuine uncommitted non-board
 *     changes block the fast-forward, or the board itself has an unresolvable
 *     row conflict). The caller must NOT mutate.
 *   - `canPublish:false` — the board was reconciled but the checkout is diverged
 *     (local non-board commits), so pushing would land unrelated work. The
 *     caller mutates locally and skips the publish.
 *
 * Reconcile runs BEFORE any fast-forward and does not need a clean tree, so a
 * mutation never reads a stale board even when the checkout can't move. */
function convergeCanonical(root, upstream, opts) {
  const notes = [];
  if (!opts || opts.fetch !== false) {
    gitCmd(root, ["fetch", "--quiet", "origin"], { timeout: 10000 });
  }
  const counts = gitCmd(root, ["rev-list", "--left-right", "--count", `HEAD...${upstream}`]);
  if (counts.status !== 0) {
    return { ok: true, behind: 0, ahead: 0, notes, board: readWorkingBoard(root), canPublish: false };
  }
  const [ahead, behind] = String(counts.stdout || "")
    .trim()
    .split(/\s+/)
    .map((n) => parseInt(n, 10) || 0);

  if (ahead > 0) {
    if (aheadOnlyBoard(root, upstream)) {
      const replay = replayBoardOnly(root, upstream);
      if (!replay.ok) {
        if (replay.blockedBy && replay.blockedBy.length) {
          notes.push(
            `main is ${behind} behind ${upstream} but has uncommitted changes to ${replay.blockedBy.join(", ")} — ` +
              `commit or discard them, then run: node scripts/backlog.js sync`
          );
        } else {
          notes.push(
            `main has local board commits that could not be replayed onto ${upstream} — reconcile manually: git pull --rebase`
          );
        }
        return {
          ok: false,
          behind,
          ahead,
          blockedBy: replay.blockedBy || replay.conflicts || [],
          notes,
          board: readWorkingBoard(root),
        };
      }
      notes.push(`replayed ${ahead} local board commit(s) onto ${upstream}`);
      return { ok: true, behind: 0, ahead: 0, notes, board: readWorkingBoard(root), canPublish: true };
    }
    // Diverged: local non-board commits. The common case is a local harness
    // deploy commit that was never pushed while upstream advanced with feature
    // landings — the note below already names `git pull --rebase` as the remedy,
    // so do exactly that automatically when the tree is otherwise clean (board
    // dirt is reconciled into `rec.board` first). A conflicting replay is
    // aborted and stays manual, so genuine divergence is never silently
    // rewritten. Without this, every board mutation skipped the publish and main
    // drifted stale ("board: not published (main is diverged)", F-303/F-304).
    const dirty = classifyDirty(root, upstream);
    const rec = reconcileWorkingBoard(root, upstream);
    if (!rec.ok) {
      notes.push(`main checkout board has conflicting rows (${(rec.conflicts || []).join(", ") || "unknown"}) — resolve manually`);
      return { ok: false, behind, ahead, blockedBy: rec.conflicts || [], notes, board: readWorkingBoard(root) };
    }
    let rebased = false;
    if (dirty.genuine.length === 0 && aheadOnlyHarness(root, upstream)) {
      const saved = readWorkingBoard(root);
      gitCmd(root, ["checkout", "--", "BACKLOG.md"]);
      const rebase = gitCmd(root, ["rebase", upstream]);
      if (rebase.status === 0) {
        rebased = true;
      } else {
        gitCmd(root, ["rebase", "--abort"]);
        fs.writeFileSync(path.join(root, "BACKLOG.md"), saved, "utf8");
      }
    }
    fs.writeFileSync(path.join(root, "BACKLOG.md"), rec.board, "utf8");
    if (rebased) {
      notes.push(`rebased ${ahead} local commit(s) onto ${upstream}`);
      if (rec.dropped.length) notes.push(`reconciled its board (archived upstream: ${rec.dropped.join(", ")})`);
      return { ok: true, behind: 0, ahead: 0, notes, board: rec.board, dropped: rec.dropped, canPublish: true };
    }
    if (rec.dropped.length) notes.push(`reconciled its board (archived upstream: ${rec.dropped.join(", ")})`);
    notes.push(
      `main is ${behind} behind and ${ahead} ahead of ${upstream} — local commits touch non-board files; ` +
        `not publishing (reconcile manually: git pull --rebase)`
    );
    return { ok: true, behind, ahead, notes, board: rec.board, canPublish: false };
  }

  if (behind === 0) {
    return { ok: true, behind: 0, ahead: 0, notes, board: readWorkingBoard(root), canPublish: true };
  }

  const dirty = classifyDirty(root, upstream);
  const rec = reconcileWorkingBoard(root, upstream);
  if (!rec.ok) {
    notes.push(`main checkout board has conflicting rows (${(rec.conflicts || []).join(", ") || "unknown"}) — resolve manually`);
    return { ok: false, behind, ahead: 0, blockedBy: rec.conflicts || [], notes, board: readWorkingBoard(root) };
  }
  const saved = readWorkingBoard(root);
  if (dirty.redundant.length) clearRedundant(root, upstream, dirty.redundant);
  gitCmd(root, ["checkout", "--", "BACKLOG.md"]);
  const ff = gitCmd(root, ["merge", "--ff-only", upstream]);
  if (ff.status !== 0) {
    fs.writeFileSync(path.join(root, "BACKLOG.md"), saved, "utf8");
    // Unrelated dirt is carried across a fast-forward (git preserves files the
    // landing does not touch); only a file the landing WOULD overwrite makes git
    // refuse. Pre-refusing every behind checkout with unrelated dirt stranded
    // main 1 behind on an uncommitted config toggle the landing never touched
    // (F-008). Attempt the merge and report the real blocker.
    notes.push(
      dirty.genuine.length
        ? `main is ${behind} behind ${upstream} but has local changes to ${dirty.genuine.join(", ")} that the fast-forward would overwrite — commit or discard them, then run: node scripts/backlog.js sync (git: ${firstLine(ff)})`
        : `main is ${behind} behind ${upstream} — could not fast-forward: ${(ff.stderr || ff.stdout || "").trim()}`
    );
    return { ok: false, behind, ahead: 0, blockedBy: dirty.genuine, notes, board: saved };
  }
  fs.writeFileSync(path.join(root, "BACKLOG.md"), rec.board, "utf8");
  notes.push(`fast-forwarded main to ${upstream} (${behind} commit(s))`);
  if (rec.dropped.length) notes.push(`reconciled its board (archived upstream: ${rec.dropped.join(", ")})`);
  return { ok: true, behind: 0, ahead: 0, notes, board: rec.board, dropped: rec.dropped, canPublish: true };
}

/* Paths publishBoard stages alongside the board (when tracked) so the owned-
 * files registry never lingers as canonical dirt either. */
const PUBLISH_EXTRA_PATHS = [".agents/memory/owned-files.md"];

function trackedPath(root, rel) {
  const r = gitCmd(root, ["ls-files", "--error-unmatch", "--", rel]);
  return r.status === 0;
}

/* Commit the board (and any changed owned-files registry) and fast-forward push
 * it, re-fetching + rebasing after a concurrent landing. Returns
 * `{ published, committed, reason, detail }`: `published:true` with reason "no
 * change" when nothing needed committing; `published:false` when the commit/push
 * could not complete (the commit may still exist locally — durable, just
 * unpublished). `detail` is git's own first error line, so a caller can name the
 * real cause instead of guessing "remote unreachable". `opts.deferPush` commits
 * locally but skips the network push (reason "deferred"): the request path stays
 * fast and a later `sync` publishes. */
function publishBoard(root, upstream, message, opts) {
  const rels = ["BACKLOG.md", ...PUBLISH_EXTRA_PATHS.filter((p) => trackedPath(root, p))];
  // `-f`: the extras are tracked-only (filtered by trackedPath above), but a
  // tracked path can still be ignored by .gitignore (`.agents/memory/`), and a
  // plain `git add` then aborts the whole publish with "paths are ignored" —
  // aborting every board mutation until the operator hit `sync` from a terminal
  // (F-004). -f cannot stage unrelated ignored files: only these paths ride along.
  const add = gitCmd(root, ["add", "-f", "--", ...rels]);
  if (add.status !== 0) {
    return { published: false, committed: false, reason: "add-failed", detail: firstLine(add) };
  }
  const staged = gitCmd(root, ["diff", "--cached", "--quiet", "--", ...rels]);
  let committed = false;
  if (staged.status !== 0) {
    const commit = gitCmd(root, ["commit", "-q", "-m", message, "--", ...rels]);
    if (commit.status !== 0) {
      return { published: false, committed: false, reason: "commit-failed", detail: firstLine(commit) };
    }
    committed = true;
  }
  // Push whenever HEAD carries anything upstream does not — a rebase in
  // convergeCanonical can leave a local board commit with a clean index, and it
  // must still be published.
  const counts = gitCmd(root, ["rev-list", "--left-right", "--count", `HEAD...${upstream}`]);
  const ahead = counts.status === 0 ? parseInt(String(counts.stdout || "").trim().split(/\s+/)[0], 10) || 0 : 0;
  if (ahead === 0) return { published: true, committed, reason: "no change" };
  if (opts && opts.deferPush) return { published: false, committed, reason: "deferred" };

  const base = upstream.includes("/") ? upstream.slice(upstream.indexOf("/") + 1) : upstream;
  for (let attempt = 1; attempt <= MAX_PUBLISH_ATTEMPTS; attempt++) {
    const push = gitCmd(root, ["push", "origin", `HEAD:${base}`]);
    if (push.status === 0) return { published: true, committed, reason: "pushed" };
    const text = `${push.stdout || ""}\n${push.stderr || ""}`;
    if (
      attempt < MAX_PUBLISH_ATTEMPTS &&
      /non-fast-forward|fetch first|tip of your current branch is behind|\[rejected\]/i.test(text)
    ) {
      gitCmd(root, ["fetch", "--quiet", "origin"], { timeout: 10000 });
      const replay = aheadOnlyBoard(root, upstream) ? replayBoardOnly(root, upstream) : { ok: false };
      if (!replay.ok) {
        return {
          published: false,
          committed,
          reason: "replay-conflict",
          detail: (replay.conflicts || []).join(", ") || firstLine(push),
        };
      }
      continue;
    }
    return { published: false, committed, reason: "push-failed", detail: firstLine(push) };
  }
  return { published: false, committed, reason: "retries-exhausted", detail: "push rejected after retries" };
}

/* Read-only view for `list` / `next`: the working board reconciled against the
 * last-known upstream, so an agent never decides from a stale board. Never
 * writes. Returns `{ board, behind, ok }`. */
function displayBoard(root, upstream) {
  const working = readWorkingBoard(root);
  if (!upstream) return { board: working, behind: 0, ok: true };
  const counts = gitCmd(root, ["rev-list", "--left-right", "--count", `HEAD...${upstream}`]);
  if (counts.status !== 0) return { board: working, behind: 0, ok: true };
  const [ahead, behind] = String(counts.stdout || "")
    .trim()
    .split(/\s+/)
    .map((n) => parseInt(n, 10) || 0);
  if (behind <= 0) return { board: working, behind, ok: true };
  const rec = reconcileWorkingBoard(root, upstream);
  return { board: rec.ok ? rec.board : working, behind, ok: rec.ok };
}

module.exports = {
  gitCmd,
  gitOut,
  mainWorktreeRoot,
  isCanonicalCheckout,
  currentUpstream,
  gitShow,
  readWorkingBoard,
  porcelainPath,
  reconcileWorkingBoard,
  classifyDirty,
  clearRedundant,
  convergeCanonical,
  publishBoard,
  displayBoard,
};
