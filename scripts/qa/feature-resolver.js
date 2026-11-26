#!/usr/bin/env node
"use strict";
/*
 * feature-resolver — one case/separator-insensitive feature resolver.
 *
 * The resume/checkpoint/finalize/backlog surfaces used to compare feature ids
 * with `===` and build `<raw-arg>.md`, so `f-045` missed `F-045.md`, a lowercase
 * write created a second handoff, and a handoff living in the main checkout was
 * invisible from its feature worktree (F-046).
 *
 * Resolution precedence, deterministic:
 *   1. a board row id (BACKLOG.md, normalized) — the canonical spelling;
 *   2. an existing handoff stem in any checkout of this repo;
 *   3. a linked worktree directory or branch name;
 *   4. the input itself, canonicalized (`f-45` -> `F-45`).
 *
 * `resolveFeature()` also returns the absolute handoff path when one exists and
 * near-miss ids when it does not, so a caller can fail loudly and usefully.
 * Read-only: nothing here writes a file.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function normalizeId(value) {
  return String(value == null ? "" : value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function stripExtension(value) {
  return String(value == null ? "" : value)
    .trim()
    .replace(/\.md$/i, "");
}

/* `f-45`, `F_45`, `f 45`, `f-045.md` -> `F-45` / `F-045`. Non-id slugs keep
 * their spelling (a handoff slug is not a backlog id). */
function canonicalId(value) {
  const raw = stripExtension(value);
  const m = raw.match(/^[fF][\s_-]*(\d+)$/);
  return m ? `F-${m[1]}` : raw;
}

function gitRunner(root) {
  return (args) => {
    const res = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    return res.status === 0 ? String(res.stdout || "") : null;
  };
}

/* `git worktree list --porcelain` -> [{ path, branch }], main checkout first. */
function listWorktrees(root, git) {
  const run = git || gitRunner(root);
  const out = run(["worktree", "list", "--porcelain"]);
  if (!out) return [];
  const list = [];
  let cur = null;
  for (const line of String(out).split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice("worktree ".length).trim(), branch: "" };
      list.push(cur);
    } else if (cur && line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "").trim();
    }
  }
  return list.filter((w) => w.path);
}

function mainWorktree(root, git) {
  const list = listWorktrees(root, git);
  return list.length ? list[0].path : null;
}

/* The linked worktree a feature id names by directory or branch, or null. */
function worktreeFor(feature, root, git) {
  const want = normalizeId(feature);
  if (!want) return null;
  for (const w of listWorktrees(root, git)) {
    if (path.resolve(w.path) === path.resolve(root)) continue;
    if (normalizeId(path.basename(w.path)) === want || normalizeId(w.branch) === want) return w;
  }
  return null;
}

/* Where a feature's handoff may live: its worktree first (the state belongs
 * there), then this checkout, then the shared main checkout. Deduped. */
function rootsFor(feature, root, git) {
  const out = [];
  const add = (dir) => {
    if (!dir) return;
    const abs = path.resolve(dir);
    if (!out.some((x) => path.resolve(x) === abs)) out.push(abs);
  };
  const wt = worktreeFor(feature, root, git);
  if (wt) add(wt.path);
  add(root);
  add(mainWorktree(root, git));
  return out;
}

/* Board row ids from a checkout's BACKLOG.md (the read-only fallback for a
 * project using the file board; the shared service syncs it). */
function boardIds(root) {
  try {
    const src = fs.readFileSync(path.join(root, "BACKLOG.md"), "utf8");
    const ids = [];
    for (const line of String(src).split(/\r?\n/)) {
      const m = line.match(/^\|\s*([A-Za-z]+-\d+)\s*\|/);
      if (m) ids.push(m[1].toUpperCase());
    }
    return ids;
  } catch (_) {
    return [];
  }
}

/* Every handoff file in the given checkouts: [{ id: stem, file, root }]. */
function handoffs(roots) {
  const out = [];
  const seen = new Set();
  for (const dir of roots || []) {
    const hdir = path.join(dir, ".agents", "handoffs");
    let names = [];
    try {
      names = fs.readdirSync(hdir);
    } catch (_) {
      continue;
    }
    for (const name of names) {
      if (!name.toLowerCase().endsWith(".md") || name.toLowerCase() === "readme.md") continue;
      const abs = path.join(hdir, name);
      if (seen.has(abs)) continue;
      seen.add(abs);
      out.push({ id: name.slice(0, -3), file: abs, root: path.resolve(dir) });
    }
  }
  return out;
}

function editDistance(a, b) {
  const s = String(a);
  const t = String(b);
  const dp = Array.from({ length: s.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= t.length; j++) dp[0][j] = j;
  for (let i = 1; i <= s.length; i++) {
    for (let j = 1; j <= t.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[s.length][t.length];
}

/* Up to `limit` plausible spellings, deterministic (distance, then id). */
function nearMisses(feature, candidates, limit = 3) {
  const want = normalizeId(feature);
  const seen = new Set();
  const scored = [];
  for (const raw of candidates || []) {
    const id = stripExtension(raw);
    const key = normalizeId(id);
    if (!key || key === want || seen.has(key)) continue;
    seen.add(key);
    const d = editDistance(want, key);
    const contains = key.includes(want) || want.includes(key);
    if (d <= 2 || (contains && Math.abs(key.length - want.length) <= 4)) scored.push({ id, d });
  }
  return scored
    .sort((a, b) => a.d - b.d || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((x) => x.id);
}

function resolveFeature(root, raw, opts = {}) {
  const input = String(raw == null ? "" : raw).trim();
  const base = path.resolve(opts.root || root || process.cwd());
  const git = opts.git;
  const wt = worktreeFor(input, base, git);
  const roots = rootsFor(input, base, git);
  const ids = [];
  for (const dir of [base, ...roots]) {
    for (const id of boardIds(dir)) if (!ids.includes(id)) ids.push(id);
  }
  const hs = handoffs(roots);

  let id = null;
  let source = null;
  const boardHit = ids.find((x) => normalizeId(x) === normalizeId(input));
  if (boardHit) {
    id = boardHit;
    source = "board";
  }
  if (!id) {
    const handoffHit = hs.find((x) => normalizeId(x.id) === normalizeId(input));
    if (handoffHit) {
      id = handoffHit.id;
      source = "handoff";
    }
  }
  if (!id && wt) {
    id = canonicalId(wt.branch || path.basename(wt.path));
    source = "worktree";
  }
  if (!id) id = canonicalId(input);

  const hit = hs.find((x) => normalizeId(x.id) === normalizeId(id));
  const suggestions = hit
    ? []
    : nearMisses(input, [
        ...ids,
        ...hs.map((x) => x.id),
        ...listWorktrees(base, git).map((w) => canonicalId(w.branch || path.basename(w.path))),
      ]);

  return {
    input,
    id,
    source,
    file: hit ? path.resolve(hit.file) : null,
    fileRoot: hit ? path.resolve(hit.root) : null,
    worktree: wt,
    roots,
    suggestions,
  };
}

module.exports = {
  normalizeId,
  stripExtension,
  canonicalId,
  listWorktrees,
  worktreeFor,
  rootsFor,
  boardIds,
  handoffs,
  nearMisses,
  resolveFeature,
};
