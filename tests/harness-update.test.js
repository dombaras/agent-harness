"use strict";
/* F-023: the cached harness update probe.
 *
 * The registry call is the only non-deterministic part, so `npm_execpath` is
 * pointed at a local stub (the same seam bin/agent-harness.js uses). The rest is
 * a pure read/compare/write contract: `.harness.json` vs the cached verdict.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const upd = require("../templates/scripts/harness-update.js");

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "harness-update-"));
}

function project(version) {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, ".harness.json"), JSON.stringify({ version }));
  return dir;
}

function writeCache(dir, latest, checkedAt = new Date().toISOString()) {
  fs.mkdirSync(path.join(dir, ".serve"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".serve", "harness-update.json"),
    JSON.stringify({ schema: upd.SCHEMA, checkedAt, latest, command: upd.COMMAND })
  );
}

/* A fake npm CLI reached through `npm_execpath`; prints the version npm would
 * print and records that it ran when `marker` is given. */
function withNpm(version, marker, fn) {
  const bin = tmpdir();
  const cli = path.join(bin, "npm-cli.js");
  const body =
    `process.stdout.write(${JSON.stringify(version)} + "\\n");` +
    (marker ? `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran");` : "");
  fs.writeFileSync(cli, body);
  const prior = process.env.npm_execpath;
  process.env.npm_execpath = cli;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = prior;
  }
}

test("status reports behind only when the cache names a newer harness", () => {
  const dir = project("0.4.4");
  assert.strictEqual(upd.status(dir).state, "unknown", "no cache yet");

  writeCache(dir, "0.5.0");
  assert.deepStrictEqual(
    { ...upd.status(dir) },
    {
      state: "behind",
      deployed: "0.4.4",
      latest: "0.5.0",
      checkedAt: upd.status(dir).checkedAt,
      command: upd.COMMAND,
    },
    "behind"
  );

  writeCache(dir, "0.4.4");
  assert.strictEqual(upd.status(dir).state, "current", "same version");
  writeCache(dir, "0.4.0");
  assert.strictEqual(upd.status(dir).state, "current", "local ahead of the cache");
});

test("refresh caches the newest source (registry or a newer local harness checkout)", () => {
  const dir = project("0.4.4");
  withNpm("0.5.0", null, () => {
    assert.strictEqual(upd.refresh(dir).state, "behind");
  });
  const doc = JSON.parse(fs.readFileSync(path.join(dir, ".serve", "harness-update.json"), "utf8"));
  assert.strictEqual(doc.schema, upd.SCHEMA);
  assert.strictEqual(doc.latest, "0.5.0");

  // The harness source checkout may legitimately lead the registry.
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "opencode-agent-harness", version: "0.6.0" })
  );
  withNpm("0.5.0", null, () => upd.refresh(dir, true));
  assert.strictEqual(upd.status(dir).latest, "0.6.0");
});

test("refresh always re-probes the registry; --max-age is the opt-in throttle", () => {
  const dir = project("0.4.4");
  writeCache(dir, "0.4.4");
  const marker = path.join(tmpdir(), "ran");
  withNpm('"0.5.0"', marker, () => {
    assert.strictEqual(upd.refresh(dir).state, "behind");
    assert.ok(fs.existsSync(marker), "a fresh cache must still call npm (no 24h TTL)");
  });
  assert.strictEqual(upd.status(dir).latest, "0.5.0", "the fresh registry verdict is cached");

  // An explicit max-age restores a cache window for callers that want one.
  const throttled = project("0.4.4");
  writeCache(throttled, "0.5.0");
  const noRun = path.join(tmpdir(), "ran");
  withNpm('"9.9.9"', noRun, () => {
    upd.refresh(throttled, false, 60_000);
    assert.ok(!fs.existsSync(noRun), "a caller-supplied window skips the registry");
  });
  assert.strictEqual(upd.status(throttled).latest, "0.5.0", "the cached verdict is kept");
});

test("refresh honours the kill switch", () => {
  const off = project("0.4.4");
  const prior = process.env.AGENT_HARNESS_NO_UPDATE_CHECK;
  process.env.AGENT_HARNESS_NO_UPDATE_CHECK = "1";
  try {
    assert.strictEqual(upd.refresh(off, true).state, "disabled");
    assert.ok(!fs.existsSync(path.join(off, ".serve", "harness-update.json")), "kill switch writes nothing");
  } finally {
    if (prior === undefined) delete process.env.AGENT_HARNESS_NO_UPDATE_CHECK;
    else process.env.AGENT_HARNESS_NO_UPDATE_CHECK = prior;
  }
});

test("context-guard re-checks on new and cleared/compacted sessions with --force", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "templates", ".opencode", "plugins", "context-guard.ts"),
    "utf8"
  );
  assert.match(src, /"refresh",\s*"--root",\s*root,\s*"--force"/, "forces past an older probe's TTL");
  assert.match(src, /session\.compaction\.ended/, "re-checks after a cleared/compacted context");
});

test("refresh leaves a non-harness checkout alone and tolerates a failed registry", () => {
  const plain = tmpdir();
  assert.strictEqual(upd.refresh(plain, true).state, "unknown", "no .harness.json -> no cache");

  const dir = project("0.4.4");
  const bin = tmpdir();
  const cli = path.join(bin, "npm-cli.js");
  fs.writeFileSync(cli, "process.exit(1)");
  const prior = process.env.npm_execpath;
  process.env.npm_execpath = cli;
  try {
    assert.strictEqual(upd.refresh(dir, true).state, "unknown", "offline degrades to unknown");
  } finally {
    if (prior === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = prior;
  }
});

test("the global freshness plugin applies updates and signals a restart (drift guard)", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "contrib", "global-plugins", "harness-freshness.ts"),
    "utf8"
  );
  assert.match(src, /"view",\s*"opencode-agent-harness"/, "probes the registry");
  assert.match(src, /AGENT_HARNESS_NO_UPDATE_CHECK/, "honours the kill switch");
  assert.match(
    src,
    /`opencode-agent-harness@\$\{latest\}`/,
    "the registry path installs the exact version it compared (npx, not advisory text)"
  );
  assert.match(src, /applyCommand\(tree, latest\)/, "a stale main checkout is updated, not just advised");
  assert.doesNotMatch(src, /source === "npm"/, "the registry path is no longer advisory-only");
  assert.match(src, /session\.created/, "checks on a new primary session");
  assert.match(src, /session\.compaction\.ended/, "re-checks after a cleared/compacted context");
  // opencode 2.4 moved the project directory to the top-level event location;
  // `data.location` is empty for session.created, so reading it (or the server
  // cwd fallback) first silently skipped every project.
  assert.match(
    src,
    /const eventDir = \(event as any\)\?\.location\?\.directory/,
    "reads the event's own top-level location"
  );
  const eventLoc = src.indexOf("const eventDir = (event as any)?.location?.directory");
  const dataLoc = src.indexOf("d.location?.directory");
  const ctxLoc = src.indexOf("ctx.location.directory");
  assert.ok(eventLoc >= 0 && dataLoc > eventLoc, "prefers event.location over data.location");
  assert.ok(dataLoc >= 0 && ctxLoc > dataLoc, "falls back to ctx.location only last");
  assert.match(
    src,
    /typeof eventDir === "string" && eventDir\s*\n\s*\? eventDir/,
    "uses the top-level directory when present"
  );
  assert.match(src, /HARNESS UPDATED/, "announces an applied update");
  assert.match(src, /Restart opencode now to load the update\./, "requires a restart to activate it");
});
