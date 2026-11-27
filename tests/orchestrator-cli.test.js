"use strict";
/* CLI contract for orchestrate: status, why, enqueue --dry-run, flag off. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const CLI = path.join(__dirname, "..", "templates", "scripts", "orchestrator.js");
const ROOT = path.join(__dirname, "..");

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-cli-"));
  const git = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".agents/\n.serve/\n");
  git(["add", "."]);
  git(["commit", "-qm", "init"]);
  return dir;
}
function run(cwd, args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("status --json is bounded and writes nothing", () => {
  const dir = repo();
  const r = run(dir, ["status", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.enabled, false);
  assert.ok(out.capacity);
  assert.equal(fs.existsSync(path.join(dir, ".serve", "orchestrator", "state.json")), false);
});

test("plan --json works with no board and mutates nothing", () => {
  const dir = repo();
  const r = run(dir, ["plan", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.enabled, false);
  assert.deepEqual(out.rows, []);
  assert.equal(fs.existsSync(path.join(dir, ".serve")), false);
});

test("why for an unknown job exits 2 with a machine-readable code", () => {
  const dir = repo();
  const r = run(dir, ["why", "F-999", "--json"]);
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stdout).code, "not_found");
});

test("enqueue refuses when the feature flag is off", () => {
  const dir = repo();
  const r = run(dir, ["enqueue", "--feature", "F-1", "--owns", "src/a.js"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /flag is OFF/);
});

test("enqueue validates handoff, QA plan and owned files before writing", () => {
  const dir = repo();
  fs.mkdirSync(path.join(dir, ".agents"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".agents", "orchestrator.json"), JSON.stringify({ enabled: true }));
  const missing = run(dir, ["enqueue", "--feature", "F-1", "--owns", "src/a.js"]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /missing handoff/);
  assert.match(missing.stderr, /missing QA plan/);

  fs.mkdirSync(path.join(dir, ".agents", "handoffs"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".agents", "qa-plans"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".agents", "handoffs", "F-1.md"), "# handoff\n");
  fs.writeFileSync(path.join(dir, ".agents", "qa-plans", "F-1.md"), "# qa\n");
  const ok = run(dir, ["enqueue", "--feature", "F-1", "--owns", "src/a.js"]);
  assert.equal(ok.status, 0, ok.stderr);
  const job = JSON.parse(ok.stdout).job;
  assert.equal(job.state, "ready");
  assert.deepEqual(job.owned, ["src/a.js"]);

  const land = run(dir, ["land", "--dry-run", "--json"]);
  assert.equal(land.status, 0, land.stderr);
  assert.equal(JSON.parse(land.stdout).job.feature, "F-1");
});

test("dry-run enqueue never creates a journal", () => {
  const dir = repo();
  const r = run(dir, ["enqueue", "--feature", "F-1", "--owns", "src/a.js", "--dry-run"]);
  assert.equal(r.status, 2); // missing handoff/QA plan is still reported
  assert.equal(fs.existsSync(path.join(dir, ".serve", "orchestrator", "state.json")), false);
});

test("the deployed CLI path exists upstream in templates", () => {
  assert.ok(fs.existsSync(CLI));
  assert.ok(fs.existsSync(path.join(ROOT, "templates", "scripts", "qa", "orchestrator-lib.js")));
});
