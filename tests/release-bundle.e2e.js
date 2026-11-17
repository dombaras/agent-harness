"use strict";
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const TOOL = path.join(ROOT, "tools", "make-release-bundle.mjs");
const PKG = require("../package.json");

function run(out, profile) {
  return spawnSync(
    process.execPath,
    [TOOL, "--out", out, "--profile", profile, "--allow-dirty"],
    { cwd: ROOT, encoding: "utf8", timeout: 120000 }
  );
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function readSums(dir) {
  const sums = fs.readFileSync(path.join(dir, "SHA256SUMS"), "utf8").trim().split("\n");
  const map = new Map();
  for (const line of sums) {
    const m = line.match(/^([a-f0-9]{64}) {2}(.+)$/);
    assert.ok(m, `malformed SHA256SUMS line: ${line}`);
    map.set(m[2], m[1]);
  }
  return map;
}

test("release bundle: full profile produces verifiable offline artifacts", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "harness-bundle-full-"));
  const r = run(out, "full");
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);

  for (const f of ["MANIFEST.json", "REVIEW-NOTES.md", "SHA256SUMS"]) {
    assert.ok(fs.existsSync(path.join(out, f)), `missing ${f}`);
  }
  const zip = path.join(out, `agent-harness-${PKG.version}-full-src.zip`);
  const bundle = path.join(out, `agent-harness-${PKG.version}.bundle`);
  assert.ok(fs.existsSync(zip), "missing source zip");
  assert.ok(fs.existsSync(bundle), "missing git bundle");

  // Every SHA256SUMS entry must match the bytes on disk.
  const sums = readSums(out);
  for (const [name, want] of sums) {
    assert.strictEqual(sha256(path.join(out, name)), want, `hash mismatch: ${name}`);
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(out, "MANIFEST.json"), "utf8"));
  assert.strictEqual(manifest.version, PKG.version);
  assert.strictEqual(manifest.profile, "full");
  assert.match(manifest.commit, /^[a-f0-9]{40}$/);
  assert.ok(manifest.files.some((f) => f.path === "templates/scripts/wsl-tune.sh"), "full keeps host scripts");
  assert.ok(manifest.files.every((f) => /^[a-f0-9]{64}$/.test(f.sha256)));

  const note = fs.readFileSync(path.join(out, "REVIEW-NOTES.md"), "utf8");
  assert.match(note, new RegExp(`opencode-agent-harness ${PKG.version.replace(/\./g, "\\.")}`));
  assert.match(note, /Runtime dependencies:\*\* none/);
  assert.match(note, /install scripts:\*\* none/);
});

test("release bundle: sdlc profile ships the process harness only, with a profile.json", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "harness-bundle-sdlc-"));
  const r = run(out, "sdlc");
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);

  const manifest = JSON.parse(fs.readFileSync(path.join(out, "MANIFEST.json"), "utf8"));
  assert.strictEqual(manifest.profile, "sdlc");
  const paths = new Set(manifest.files.map((f) => f.path));
  for (const bad of [
    "templates/scripts/ship.js",
    "templates/scripts/nightly.js",
    "templates/scripts/serve.js",
    "templates/scripts/qa/mobile-e2e/run-maestro.js",
    "templates/scripts/qa/check-capacity.js",
    "templates/scripts/qa/ci-triage.js",
    "services/board/server.js",
    "tests/agent-harness.test.js",
    "tools/make-release-bundle.mjs",
    "docs/open-work.md",
  ]) {
    assert.ok(!paths.has(bad), `sdlc must exclude ${bad}`);
  }
  for (const kept of [
    "bin/agent-harness.js",
    "templates/scripts/backlog.js",
    "templates/scripts/qa/run-gates.js",
    "templates/scripts/qa/capacity-lib.js",
    "templates/scripts/qa/merge-backlog.js",
    "templates/.opencode/skills/dev-loop/SKILL.md",
  ]) {
    assert.ok(paths.has(kept), `sdlc must keep ${kept}`);
  }
  assert.ok(paths.has("profile.json"), "the archive carries profile.json");

  // Every artifact on disk matches SHA256SUMS.
  const sums = readSums(out);
  for (const [name, want] of sums) {
    assert.strictEqual(sha256(path.join(out, name)), want, `hash mismatch: ${name}`);
  }

  // A single-commit snapshot keeps the excluded files out of history, and every
  // script the profile wires must have a backing file in the shipped tree.
  const clone = path.join(out, "clone");
  const g = spawnSync("git", ["clone", "-q", path.join(out, `agent-harness-${PKG.version}-sdlc.bundle`), clone], {
    encoding: "utf8",
    timeout: 60000,
  });
  assert.strictEqual(g.status, 0, g.stderr);
  const count = spawnSync("git", ["-C", clone, "rev-list", "--count", "HEAD"], { encoding: "utf8" });
  assert.strictEqual(count.stdout.trim(), "1", "sdlc bundle carries one commit, not full history");
  assert.ok(!fs.existsSync(path.join(clone, "templates/scripts/ship.js")), "excluded file absent from the clone");

  const profile = JSON.parse(fs.readFileSync(path.join(clone, "profile.json"), "utf8"));
  assert.strictEqual(profile.name, "sdlc");
  assert.ok(!profile.scripts.includes("ship"), "ship is not wired");
  assert.ok(!profile.scripts.includes("nightly"), "nightly is not wired");
  assert.ok(profile.scripts.includes("gates"), "the process gates stay wired");
  const cli = require("../bin/agent-harness.js");
  for (const name of profile.scripts) {
    assert.ok(cli.HARNESS_SCRIPTS[name], `${name} is a real harness script`);
    const m = cli.HARNESS_SCRIPTS[name].match(/scripts\/\S+/);
    assert.ok(m, `${name} names a script file`);
    assert.ok(fs.existsSync(path.join(clone, "templates", m[0])), `${name} -> ${m[0]} must ship with the profile`);
  }
});

test("release bundle: core profile drops host-tuning and keeps a clean history", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "harness-bundle-core-"));
  const r = run(out, "core");
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);

  const manifest = JSON.parse(fs.readFileSync(path.join(out, "MANIFEST.json"), "utf8"));
  assert.strictEqual(manifest.profile, "core");
  const paths = new Set(manifest.files.map((f) => f.path));
  for (const bad of [
    "templates/scripts/wsl-tune.sh",
    "templates/scripts/setup-tmpfs.sh",
    "templates/scripts/qa/mobile-e2e/run-maestro.js",
    "contrib/global-plugins/harness-freshness.ts",
  ]) {
    assert.ok(!paths.has(bad), `core must exclude ${bad}`);
  }
  assert.ok(paths.has("bin/agent-harness.js"), "core keeps the CLI");

  // The core bundle is a single-commit snapshot: excluded files are not in history.
  const clone = path.join(out, "clone");
  const g = spawnSync("git", ["clone", "-q", path.join(out, `agent-harness-${PKG.version}-core.bundle`), clone], {
    encoding: "utf8",
    timeout: 60000,
  });
  assert.strictEqual(g.status, 0, g.stderr);
  const log = spawnSync("git", ["-C", clone, "rev-list", "--count", "HEAD"], { encoding: "utf8" });
  assert.strictEqual(log.stdout.trim(), "1", "core bundle carries one commit, not full history");
  assert.ok(!fs.existsSync(path.join(clone, "templates/scripts/wsl-tune.sh")), "excluded file absent from clone");
});
