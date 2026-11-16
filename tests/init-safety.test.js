"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, execFileSync } = require("child_process");

const CLI = path.resolve(__dirname, "..", "bin", "agent-harness.js");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "harness-init-"));
}

/* Hermetic: never let an inherited live-board env leak fixture rows. */
function cleanEnv() {
  const env = { ...process.env, BACKLOG_BACKEND: "file" };
  delete env.BACKLOG_API_URL;
  delete env.BACKLOG_API_TOKEN;
  delete env.BACKLOG_PROJECT;
  return env;
}

function run(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: cleanEnv(),
  });
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function gitRepo() {
  const dir = tmp();
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "harness@example.com"]);
  git(dir, ["config", "user.name", "Harness Test"]);
  fs.writeFileSync(path.join(dir, "README.md"), "# demo\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-q", "-m", "initial"]);
  return dir;
}

test("init does not commit or push by default", () => {
  const target = gitRepo();
  const before = git(target, ["rev-parse", "HEAD"]);

  const r = run(["init", "--target", ".", "--name", "Demo", "--yes"], target);
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  assert.strictEqual(
    git(target, ["rev-parse", "HEAD"]),
    before,
    "init must not create a commit unless --commit is passed"
  );
  assert.ok(fs.existsSync(path.join(target, ".harness.json")));
  assert.match(
    git(target, ["status", "--porcelain"]),
    /\.harness\.json/,
    "the files are written but left for the user to review"
  );
});

test("init refuses to clobber an existing project AGENTS.md", () => {
  const target = tmp();
  const own = "# Project instructions\n\nKeep this file.\n";
  fs.writeFileSync(path.join(target, "AGENTS.md"), own);

  const refused = run(["init", "--target", ".", "--name", "Demo", "--yes"], target);
  assert.notStrictEqual(refused.status, 0, "a first init must refuse a foreign AGENTS.md");
  assert.match(refused.stderr + refused.stdout, /already has an AGENTS\.md/);
  assert.strictEqual(fs.readFileSync(path.join(target, "AGENTS.md"), "utf8"), own);
  assert.ok(!fs.existsSync(path.join(target, ".harness.json")), "nothing may be written on refusal");

  const accepted = run(
    ["init", "--target", ".", "--name", "Demo", "--yes", "--accept-harness"],
    target
  );
  assert.strictEqual(accepted.status, 0, accepted.stderr + accepted.stdout);
  assert.match(fs.readFileSync(path.join(target, "AGENTS.md"), "utf8"), /Agent Operating Rules/);

  const stamps = fs.readdirSync(path.join(target, ".harness-backup"));
  assert.ok(stamps.length >= 1, "the old AGENTS.md is backed up");
  assert.strictEqual(
    fs.readFileSync(path.join(target, ".harness-backup", stamps[0], "AGENTS.md"), "utf8"),
    own
  );
});

test("init keeps the opencode-go model routing as the default", () => {
  const target = tmp();
  const r = run(["init", "--target", ".", "--name", "Demo", "--yes"], target);
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);

  const cfg = JSON.parse(fs.readFileSync(path.join(target, "opencode.json"), "utf8"));
  assert.strictEqual(cfg.model, "opencode-go/deepseek-v4.1-flash");
  assert.strictEqual(cfg.agents.title.model, "opencode-go/glm-5.3-flash");
  assert.strictEqual(cfg.agents.explore.model, "opencode-go/glm-5.3-flash");

  const planner = fs.readFileSync(path.join(target, ".opencode/agents/planner.md"), "utf8");
  assert.match(planner, /^model: opencode-go\/deepseek-v4-pro#high$/m);
});
