"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");

/* Publish gate: the tarball must be self-sufficient. `npm pack` + install into
 * a throwaway app and run the installed CLI against an empty project — this is
 * the only check that proves `files` covers every runtime path a stranger gets. */
test("packed tarball contains the deployable harness and runs init", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "harness-pack-"));

  const pack = spawnSync("npm", ["pack", "--json", "--pack-destination", work], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120000,
  });
  assert.strictEqual(pack.status, 0, pack.stderr);
  const info = JSON.parse(pack.stdout)[0];
  const tgz = path.join(work, info.filename);
  assert.ok(fs.existsSync(tgz), "npm pack produced a tarball");

  const names = info.files.map((f) => f.path);
  for (const required of [
    "bin/agent-harness.js",
    "templates/opencode.json",
    "templates/AGENTS.md",
    "templates/.opencode/agents/planner.md",
    "templates/scripts/backlog.js",
  ]) {
    assert.ok(names.includes(required), `tarball is missing ${required}`);
  }

  const app = path.join(work, "app");
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, "package.json"), "{}\n");
  const install = spawnSync(
    "npm",
    ["install", "--no-save", "--no-package-lock", "--no-audit", "--no-fund", tgz],
    { cwd: app, encoding: "utf8", timeout: 120000 }
  );
  assert.strictEqual(install.status, 0, install.stderr);

  const target = path.join(work, "project");
  fs.mkdirSync(target);
  const cli = path.join(app, "node_modules", "opencode-agent-harness", "bin", "agent-harness.js");
  const init = spawnSync(
    process.execPath,
    [cli, "init", "--target", target, "--name", "PackTest", "--yes", "--dry-run"],
    { cwd: work, encoding: "utf8", timeout: 60000 }
  );
  assert.strictEqual(init.status, 0, init.stderr + init.stdout);
  assert.match(init.stdout, /would initialize/i);
  assert.ok(!fs.existsSync(path.join(target, ".harness.json")), "dry-run writes nothing");
});
