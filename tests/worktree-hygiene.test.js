"use strict";
/*
 * worktree-hygiene + check-worktrees — the close-out enforcement.
 *
 * Regression this locks: a landed feature used to leave (a) the main checkout
 * behind origin/main and (b) the merged feature worktree on disk, and every
 * session ended with a prose remark instead of a failing gate. The fixture
 * builds a real bare origin + linked worktree, so the test exercises the same
 * `git worktree list` / `merge-base` / `rev-list` calls the scripts use.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const hygiene = require("../scripts/qa/worktree-hygiene.js");

const ROOT = path.resolve(__dirname, "..");

function git(cwd, ...args) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.strictEqual(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
  return String(res.stdout || "").trim();
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-worktree-"));
  const origin = path.join(dir, "origin.git");
  const repo = path.join(dir, "repo");
  const wt = path.join(dir, "wt");
  spawnSync("git", ["init", "--bare", origin], { encoding: "utf8" });
  fs.mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  git(repo, "checkout", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "README.md"), "base\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-qm", "base");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-qu", "origin", "main");
  return { dir, origin, repo, wt };
}

test("hygiene flags a merged, clean worktree and stale main as leftovers", () => {
  const f = fixture();
  // The worktree starts at main's HEAD, so it is already merged.
  git(f.repo, "worktree", "add", "-q", f.wt, "-b", "f-1");

  const h = hygiene.hygiene(f.repo, "main", f.repo);
  assert.ok(h, "hygiene returns a report for a git repo");
  assert.strictEqual(h.hasBase, true);
  assert.strictEqual(h.main.behind, 0);
  assert.strictEqual(h.linked.length, 1);
  assert.strictEqual(h.stale.length, 1, "a merged, clean worktree is a leftover");
  assert.strictEqual(h.stale[0].branch, "f-1");
  assert.strictEqual(h.mergedDirty.length, 0);
  assert.match(hygiene.describe(h), /merged worktree\(s\) left on disk/);
  assert.ok(
    hygiene.closeOutAdvice(h).some((a) => a.includes("worktree-prune")),
    "close-out advice names the prune command"
  );
});

test("check-worktrees exits non-zero on leftovers and zero once they are pruned", () => {
  const f = fixture();
  git(f.repo, "worktree", "add", "-q", f.wt, "-b", "f-1");

  const env = { ...process.env };
  delete env.CI;
  const failed = spawnSync(process.execPath, [path.join(ROOT, "scripts/qa/check-worktrees.js"), "--root", f.repo], {
    encoding: "utf8",
    env,
  });
  assert.strictEqual(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stderr, /merged worktree left behind/);

  git(f.repo, "worktree", "remove", "--force", f.wt);
  const passed = spawnSync(process.execPath, [path.join(ROOT, "scripts/qa/check-worktrees.js"), "--root", f.repo], {
    encoding: "utf8",
    env,
  });
  assert.strictEqual(passed.status, 0, passed.stdout + passed.stderr);
  assert.match(passed.stdout, /check-worktrees: OK/);
});

test("check-worktrees is a no-op on CI runners", () => {
  const f = fixture();
  git(f.repo, "worktree", "add", "-q", f.wt, "-b", "f-1");
  const res = spawnSync(process.execPath, [path.join(ROOT, "scripts/qa/check-worktrees.js"), "--root", f.repo], {
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
  });
  assert.strictEqual(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /skipped in CI/);
});
