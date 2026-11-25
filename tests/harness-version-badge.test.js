"use strict";
/* F-012: the harness-version badge's data source.
 *
 * The TUI part (`tui.tsx`) needs opencode's runtime; the version extraction is
 * kept in `version.mjs` so Node can prove the contract that matters: the badge
 * shows the DEPLOYED harness version from `.harness.json`, and every
 * non-harness/malformed shape yields null (no badge) instead of throwing inside
 * the TUI's setup().
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");

const PLUGIN_DIR = path.join(
  __dirname,
  "..",
  "templates",
  ".opencode",
  "plugins",
  "harness-version"
);
const HELPER = path.join(PLUGIN_DIR, "version.mjs");

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "harness-version-"));
}

async function loadHelper() {
  return import(pathToFileURL(HELPER).href);
}

test("readHarnessVersion returns the deployed .harness.json version", async () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, ".harness.json"), JSON.stringify({ version: "0.3.16" }));
  const { readHarnessVersion } = await loadHelper();
  assert.strictEqual(readHarnessVersion(dir), "0.3.16");
});

test("readHarnessVersion trims surrounding whitespace", async () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, ".harness.json"), JSON.stringify({ version: "  0.3.16\n" }));
  const { readHarnessVersion } = await loadHelper();
  assert.strictEqual(readHarnessVersion(dir), "0.3.16");
});

test("readHarnessVersion returns null for a missing or unreadable file", async () => {
  const { readHarnessVersion } = await loadHelper();
  assert.strictEqual(readHarnessVersion(tmpdir()), null, "missing .harness.json");
  assert.strictEqual(readHarnessVersion(undefined), null, "no location");
  assert.strictEqual(readHarnessVersion(""), null, "empty location");
  assert.strictEqual(readHarnessVersion(42), null, "non-string location");
});

test("readHarnessVersion returns null for malformed or version-less JSON", async () => {
  const { readHarnessVersion } = await loadHelper();
  const shapes = [
    "not json",
    "null",
    "[]",
    "{}",
    JSON.stringify({ version: 3 }),
    JSON.stringify({ version: "" }),
    JSON.stringify({ version: "   " }),
    JSON.stringify({ version: null }),
  ];
  for (const body of shapes) {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, ".harness.json"), body);
    assert.strictEqual(readHarnessVersion(dir), null, `shape ${body}`);
  }
});

test("readHarnessUpdate returns the cached newer version, and null otherwise", async () => {
  const { readHarnessUpdate } = await loadHelper();
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, ".harness.json"), JSON.stringify({ version: "0.4.4" }));
  fs.mkdirSync(path.join(dir, ".serve"), { recursive: true });
  const cache = path.join(dir, ".serve", "harness-update.json");

  fs.writeFileSync(cache, JSON.stringify({ latest: "0.5.0" }));
  assert.deepStrictEqual(readHarnessUpdate(dir), { deployed: "0.4.4", latest: "0.5.0" });

  fs.writeFileSync(cache, JSON.stringify({ latest: "0.4.4" }));
  assert.strictEqual(readHarnessUpdate(dir), null, "same version -> no arrow");
  fs.writeFileSync(cache, JSON.stringify({ latest: "0.4.0" }));
  assert.strictEqual(readHarnessUpdate(dir), null, "local ahead -> no arrow");
  for (const body of ["not json", "null", "[]", "{}", JSON.stringify({ latest: "" })]) {
    fs.writeFileSync(cache, body);
    assert.strictEqual(readHarnessUpdate(dir), null, `shape ${body}`);
  }
  assert.strictEqual(readHarnessUpdate(undefined), null, "no location");
  assert.strictEqual(readHarnessUpdate(tmpdir()), null, "missing .harness.json");
});

test("readHarnessRestart returns the restart-needed verdict, and null otherwise", async () => {
  const { readHarnessRestart } = await loadHelper();
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, ".serve"), { recursive: true });
  const status = path.join(dir, ".serve", "harness-freshness.json");

  fs.writeFileSync(
    status,
    JSON.stringify({ status: "restart-needed", have: "0.4.8", latest: "0.4.8", wrote: 1 })
  );
  assert.deepStrictEqual(readHarnessRestart(dir), { have: "0.4.8", latest: "0.4.8" });

  fs.writeFileSync(
    status,
    JSON.stringify({ status: "restart-needed", have: "0.4.8", latest: "0.4.8", active: "0.4.7", wrote: 1 })
  );
  assert.deepStrictEqual(
    readHarnessRestart(dir),
    { have: "0.4.8", latest: "0.4.8", active: "0.4.7" },
    "the service's loaded build passes through"
  );

  for (const body of [
    JSON.stringify({ status: "current", have: "0.4.8" }),
    JSON.stringify({ status: "update-available", have: "0.4.8" }),
    "not json",
    "null",
    "[]",
    "{}",
  ]) {
    fs.writeFileSync(status, body);
    assert.strictEqual(readHarnessRestart(dir), null, `shape ${body}`);
  }
  assert.strictEqual(readHarnessRestart(undefined), null, "no location");
  assert.strictEqual(readHarnessRestart(tmpdir()), null, "missing verdict");
});

test("a restart verdict only renders while it describes the current deploy and a live process (F-038)", async () => {
  // The reported failure: a verdict written by a previous service process
  // (have=0.4.17) survived a deploy to 0.4.18 and the restart that loaded it, so
  // the badge read the fresh version with a permanent ↻restart.
  const { readHarnessRestart } = await loadHelper();
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, ".serve"), { recursive: true });
  const cfg = path.join(dir, ".harness.json");
  fs.writeFileSync(cfg, JSON.stringify({ version: "0.4.18" }));
  const wrote = fs.statSync(cfg).mtimeMs;
  const status = path.join(dir, ".serve", "harness-freshness.json");
  const verdict = (extra) =>
    fs.writeFileSync(
      status,
      JSON.stringify({ status: "restart-needed", have: "0.4.18", latest: "0.4.18", wrote, ...extra })
    );

  verdict({ pid: process.pid, startedAt: Date.now() - 1000 });
  assert.deepStrictEqual(
    readHarnessRestart(dir),
    { have: "0.4.18", latest: "0.4.18", writerStartedAt: Number(JSON.parse(fs.readFileSync(status, "utf8")).startedAt) },
    "current deploy + live writer"
  );

  verdict({ have: "0.4.17", latest: "0.4.17", pid: process.pid });
  assert.strictEqual(readHarnessRestart(dir), null, "a later deploy supersedes the verdict");

  verdict({ wrote: wrote - 5000, pid: process.pid });
  assert.strictEqual(readHarnessRestart(dir), null, "the deploy is newer than the verdict");

  const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
  verdict({ pid: dead, startedAt: Date.now() - 1000 });
  assert.strictEqual(readHarnessRestart(dir), null, "the writing process is gone");

  verdict({ pid: "not-a-pid" });
  assert.strictEqual(readHarnessRestart(dir), null, "unusable provenance is not trusted");

  verdict({});
  assert.deepStrictEqual(
    readHarnessRestart(dir),
    { have: "0.4.18", latest: "0.4.18" },
    "a legacy verdict without provenance still renders (version/deploy checks apply)"
  );
});

test("a reused pid is not the writer (process identity, F-038)", { skip: !fs.existsSync("/proc/self/stat") }, async () => {
  const { readHarnessRestart } = await loadHelper();
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, ".serve"), { recursive: true });
  const cfg = path.join(dir, ".harness.json");
  fs.writeFileSync(cfg, JSON.stringify({ version: "0.5.4" }));
  const status = path.join(dir, ".serve", "harness-freshness.json");
  fs.writeFileSync(
    status,
    JSON.stringify({
      status: "restart-needed",
      have: "0.5.4",
      latest: "0.5.4",
      wrote: fs.statSync(cfg).mtimeMs,
      // Alive, but NOT the process that wrote the verdict.
      pid: process.ppid,
      pidBoot: "00000000-0000-0000-0000-000000000000",
      pidStart: "1",
    })
  );
  assert.strictEqual(readHarnessRestart(dir), null, "pid reuse must not keep the writer alive");
});

test("a foreign restart verdict cannot outlive a newer client that loaded the deploy", async () => {
  // One tree can be served by several opencode processes (shared service + ACP
  // stdio servers). A stale server's verdict painted ↻restart in a TUI that had
  // restarted after the deploy. A client that loaded the deployed build after
  // the verdict was written ignores it; one still on the old build keeps it.
  const { readHarnessRestart } = await loadHelper();
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, ".serve"), { recursive: true });
  const cfg = path.join(dir, ".harness.json");
  fs.writeFileSync(cfg, JSON.stringify({ version: "0.5.4" }));
  const wrote = fs.statSync(cfg).mtimeMs;
  const writerStartedAt = Date.now() - 60_000;
  fs.writeFileSync(
    path.join(dir, ".serve", "harness-freshness.json"),
    JSON.stringify({
      status: "restart-needed",
      have: "0.5.4",
      latest: "0.5.4",
      active: "0.5.1",
      pid: process.pid,
      startedAt: writerStartedAt,
      wrote,
    })
  );

  assert.strictEqual(
    readHarnessRestart(dir, { loaded: "0.5.4", startedAt: Date.now() }),
    null,
    "a newer client on the deployed build ignores another server's verdict"
  );
  assert.deepStrictEqual(
    readHarnessRestart(dir, { loaded: "0.5.1", startedAt: Date.now() }),
    { have: "0.5.4", latest: "0.5.4", active: "0.5.1", writerStartedAt },
    "a client still on the old build keeps the restart marker"
  );
  assert.ok(readHarnessRestart(dir), "no client start keeps the legacy behaviour");
});

test("the badge renders the update arrow from the same cache", () => {
  const tui = fs.readFileSync(path.join(PLUGIN_DIR, "tui.tsx"), "utf8");
  assert.match(tui, /readHarnessUpdate\(directory\)/, "reads the cached verdict");
  assert.match(tui, /↑/, "renders the available version next to the deployed one");
  assert.match(tui, /text\?\.warning/, "uses the warning colour when behind");
});

test("the badge names the loaded build first while a restart is pending (H-44)", async () => {
  const { formatHarnessBadge } = await loadHelper();
  const verdict = { have: "0.5.1", latest: "0.5.1" };
  assert.strictEqual(
    formatHarnessBadge({ current: "0.5.1", loaded: "0.4.18", restart: verdict }),
    "harness v0.4.18 → v0.5.1 ↻restart",
    "the first number is the build the service runs"
  );
  assert.strictEqual(
    formatHarnessBadge({ current: "0.5.2", loaded: "0.5.2", restart: { ...verdict, active: "0.5.1" } }),
    "harness v0.5.1 → v0.5.2 ↻restart",
    "a verdict's active build overrides the setup-time read"
  );
  assert.strictEqual(
    formatHarnessBadge({ current: "0.5.1", loaded: "0.5.1", restart: verdict }),
    "harness v0.5.1 ↻restart",
    "no gap to render when the loaded read agrees with disk"
  );
  assert.strictEqual(
    formatHarnessBadge({ current: "0.5.1", loaded: "0.4.18" }),
    "harness v0.5.1",
    "without a restart verdict the deployed build is the only state"
  );
  assert.strictEqual(
    formatHarnessBadge({ current: "0.5.1", loaded: "0.5.1", update: { deployed: "0.5.1", latest: "0.6.0" } }),
    "harness v0.5.1 ↑0.6.0"
  );
  assert.strictEqual(
    formatHarnessBadge({
      current: "0.5.1",
      loaded: "0.4.18",
      update: { deployed: "0.5.1", latest: "0.6.0" },
      restart: verdict,
    }),
    "harness v0.4.18 → v0.5.1 ↑0.6.0 ↻restart"
  );
  assert.strictEqual(formatHarnessBadge({}), null, "non-harness trees render nothing");
});

test("the badge renders restart-needed from the freshness verdict (H-44)", () => {
  const tui = fs.readFileSync(path.join(PLUGIN_DIR, "tui.tsx"), "utf8");
  const helper = fs.readFileSync(path.join(PLUGIN_DIR, "version.mjs"), "utf8");
  assert.match(tui, /readHarnessRestart\(directory\)/, "reads the freshness verdict");
  assert.match(
    tui,
    /formatHarnessBadge\(\{ current, loaded, update, restart, blocked \}\)/,
    "delegates formatting to the tested helper"
  );
  assert.match(helper, /↻restart/, "marks a deployed-but-not-active harness");
  assert.match(tui, /update \|\| restart \|\| blocked/, "the restart/blocked marker also uses the warning colour");
});

test("the badge re-reads the deployed version and verdicts on every render", () => {
  const tui = fs.readFileSync(path.join(PLUGIN_DIR, "tui.tsx"), "utf8");
  const start = tui.indexOf("const badge = () =>");
  assert.ok(start > 0, "the badge render function exists");
  const body = tui.slice(start, tui.indexOf("const home =", start));
  for (const call of ["readHarnessVersion", "readHarnessUpdate", "readHarnessRestart", "readHarnessBlocked"]) {
    assert.match(body, new RegExp(`${call}\\(directory\\)`), `${call} is read inside render, not setup`);
  }
  assert.match(body, /const directory = resolveDirectory\(\)/, "the badge's directory is resolved per render (F-038)");
  assert.doesNotMatch(
    tui.slice(tui.indexOf("const setupDirectory ="), start),
    /const directory = resolveDirectory\(\)/,
    "setup keeps only the fallback directory"
  );
  assert.match(tui, /const loaded = readHarnessVersion\(setupDirectory\)/, "setup pins the loaded build");
  assert.doesNotMatch(
    tui.slice(tui.indexOf("const loaded ="), start),
    /readHarnessUpdate\(directory\)/,
    "setup must not pin the update verdict"
  );
});

test("orient names the loaded build first while a restart is pending", () => {
  const { harnessStatus } = require("../templates/scripts/orient.js");
  assert.strictEqual(
    harnessStatus({ harnessVersion: "0.5.1", harnessRestart: { active: "0.4.18" } }),
    "harness 0.4.18 → 0.5.1 (restart needed)"
  );
  assert.strictEqual(
    harnessStatus({ harnessVersion: "0.5.1", harnessRestart: { active: null } }),
    "harness 0.5.1 (restart needed)",
    "unknown active build still flags the pending restart"
  );
  assert.strictEqual(harnessStatus({ harnessVersion: "0.5.1", harnessRestart: null }), "harness 0.5.1");
});

test("the template ships both entrypoints and both footer slots", () => {
  assert.ok(fs.existsSync(path.join(PLUGIN_DIR, "index.ts")), "server entrypoint");
  assert.ok(fs.existsSync(path.join(PLUGIN_DIR, "tui.tsx")), "TUI entrypoint");
  const tui = fs.readFileSync(path.join(PLUGIN_DIR, "tui.tsx"), "utf8");
  assert.match(tui, /home\.footer\.status/, "badge on the home footer");
  assert.match(tui, /prompt\.footer\.status/, "badge on the session prompt footer");
  assert.match(tui, /readHarnessVersion\(directory\)/, "reads the checkout's deployed version");
  assert.match(tui, /if \(!loaded\) return/, "non-harness repos render nothing");
});

test("readHarnessBlocked returns the blocked verdict with its cause, and null otherwise (F-044)", async () => {
  const { readHarnessBlocked } = await loadHelper();
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, ".serve"), { recursive: true });
  const status = path.join(dir, ".serve", "harness-freshness.json");

  fs.writeFileSync(
    status,
    JSON.stringify({ status: "blocked", have: "0.5.1", latest: "0.5.2", reason: "update failed", wrote: 1 })
  );
  assert.deepStrictEqual(
    readHarnessBlocked(dir),
    { have: "0.5.1", latest: "0.5.2", reason: "update failed" },
    "a failed update keeps its cause"
  );

  fs.writeFileSync(status, JSON.stringify({ status: "blocked", have: "0.5.1", latest: "0.5.2", wrote: 1 }));
  assert.strictEqual(readHarnessBlocked(dir).reason, "update blocked", "a reasonless verdict still reads as blocked");

  for (const body of [
    JSON.stringify({ status: "current", have: "0.5.1" }),
    JSON.stringify({ status: "restart-needed", have: "0.5.1" }),
    "not json",
    "null",
    "[]",
    "{}",
  ]) {
    fs.writeFileSync(status, body);
    assert.strictEqual(readHarnessBlocked(dir), null, `shape ${body}`);
  }
  assert.strictEqual(readHarnessBlocked(undefined), null, "no location");
  assert.strictEqual(readHarnessBlocked(tmpdir()), null, "missing verdict");
});

test("a blocked verdict outlives its writer but not a later deploy (F-045)", async () => {
  const { readHarnessBlocked } = await loadHelper();
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, ".serve"), { recursive: true });
  const cfg = path.join(dir, ".harness.json");
  fs.writeFileSync(cfg, JSON.stringify({ version: "0.5.1" }));
  const wrote = fs.statSync(cfg).mtimeMs;
  const status = path.join(dir, ".serve", "harness-freshness.json");
  const verdict = (extra) =>
    fs.writeFileSync(
      status,
      JSON.stringify({
        status: "blocked",
        have: "0.5.1",
        latest: "0.5.2",
        reason: "update failed",
        wrote,
        ...extra,
      })
    );

  verdict({ pid: process.pid });
  assert.ok(readHarnessBlocked(dir), "current deploy + live writer renders");

  verdict({ have: "0.5.0", latest: "0.5.1", pid: process.pid });
  assert.strictEqual(readHarnessBlocked(dir), null, "a later deploy supersedes the verdict");

  verdict({ wrote: wrote - 5000, pid: process.pid });
  assert.strictEqual(readHarnessBlocked(dir), null, "the deploy is newer than the verdict");

  const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
  verdict({ pid: dead });
  assert.deepStrictEqual(
    readHarnessBlocked(dir),
    { have: "0.5.1", latest: "0.5.2", reason: "update failed" },
    "the tree is still blocked after the attempting process exited (F-045)"
  );

  fs.writeFileSync(
    status,
    JSON.stringify({ status: "blocked", have: "0.5.1", latest: "0.5.2", reason: "update failed" })
  );
  assert.ok(readHarnessBlocked(dir), "a legacy blocked verdict without wrote still renders");
});

test("a legacy refreshed verdict renders as restart-needed once its deploy landed (F-045)", async () => {
  const { readHarnessRestart } = await loadHelper();
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, ".serve"), { recursive: true });
  const cfg = path.join(dir, ".harness.json");
  fs.writeFileSync(cfg, JSON.stringify({ version: "0.5.3" }));
  const status = path.join(dir, ".serve", "harness-freshness.json");
  // The pre-F-045 success shape: terminal `refreshed`, have = the OLD build.
  fs.writeFileSync(
    status,
    JSON.stringify({ status: "refreshed", have: "0.5.2", latest: "0.5.3", pid: process.pid })
  );
  assert.deepStrictEqual(
    readHarnessRestart(dir),
    { have: "0.5.3", latest: "0.5.3", active: "0.5.2" },
    "the deployed version explains the verdict; the old build is the active one"
  );

  // A later deploy (the record no longer names `latest`) is not this gap.
  fs.writeFileSync(cfg, JSON.stringify({ version: "0.5.4" }));
  assert.strictEqual(readHarnessRestart(dir), null, "a superseded refreshed record is dropped");
  assert.strictEqual(require("../templates/scripts/orient.js").harnessStatus({
    harnessVersion: "0.5.3",
    harnessRestart: { active: "0.5.2" },
  }), "harness 0.5.2 → 0.5.3 (restart needed)");
});

test("the badge renders a blocked auto-update instead of the stale version as current (F-044)", async () => {
  const { formatHarnessBadge } = await loadHelper();
  assert.strictEqual(
    formatHarnessBadge({
      current: "0.5.1",
      loaded: "0.5.1",
      update: { deployed: "0.5.1", latest: "0.5.2" },
      blocked: { have: "0.5.1", latest: "0.5.2", reason: "update failed" },
    }),
    "harness v0.5.1 ↑0.5.2 ⚠update failed"
  );
  assert.strictEqual(
    formatHarnessBadge({
      current: "0.5.1",
      loaded: "0.5.1",
      update: { deployed: "0.5.1", latest: "0.5.2" },
      blocked: { have: "0.5.1", latest: "0.5.2", reason: "update available" },
    }),
    "harness v0.5.1 ↑0.5.2 ⚠update pending",
    "a sweep-discovered update is pending, not blocked"
  );
  assert.strictEqual(
    formatHarnessBadge({
      current: "0.5.1",
      loaded: "0.5.1",
      blocked: { have: "0.5.1", latest: null, reason: "update blocked" },
    }),
    "harness v0.5.1 ⚠update blocked",
    "any other blocked reason still reads as blocked"
  );
  assert.strictEqual(
    formatHarnessBadge({ current: "0.5.1", loaded: "0.5.1" }),
    "harness v0.5.1",
    "no verdict, no marker"
  );
});

test("the footer reads the blocked verdict and colours it as a warning (F-044)", () => {
  const tui = fs.readFileSync(path.join(PLUGIN_DIR, "tui.tsx"), "utf8");
  assert.match(tui, /readHarnessBlocked\(directory\)/, "reads the blocked verdict per render");
  assert.match(tui, /update \|\| restart \|\| blocked/, "the blocked marker uses the warning colour");
});

test("orient names a blocked auto-update instead of the stale version as current (F-044)", () => {
  const { harnessStatus } = require("../templates/scripts/orient.js");
  assert.strictEqual(
    harnessStatus({ harnessVersion: "0.5.1", harnessBlocked: { reason: "update failed" } }),
    "harness 0.5.1 (update failed)"
  );
  assert.strictEqual(
    harnessStatus({ harnessVersion: "0.5.1", harnessBlocked: { reason: "update available" } }),
    "harness 0.5.1 (update pending)",
    "a sweep-discovered update is pending, not blocked"
  );
  assert.strictEqual(
    harnessStatus({ harnessVersion: "0.5.1", harnessBlocked: { reason: "branch diverged" } }),
    "harness 0.5.1 (update blocked)",
    "any other blocked reason is still surfaced"
  );
  assert.strictEqual(harnessStatus({ harnessVersion: "0.5.1", harnessBlocked: null }), "harness 0.5.1");
});

test("the deployed root mirrors the template byte-for-byte (F-044)", () => {
  const repo = path.join(__dirname, "..");
  for (const rel of [
    "scripts/orient.js",
    "scripts/harness-update.js",
    ".opencode/plugins/harness-version/version.mjs",
    ".opencode/plugins/harness-version/tui.tsx",
  ]) {
    assert.strictEqual(
      fs.readFileSync(path.join(repo, rel), "utf8"),
      fs.readFileSync(path.join(repo, "templates", rel), "utf8"),
      `${rel} is the deployed template copy`
    );
  }
});
