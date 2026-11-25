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
  assert.deepStrictEqual(readHarnessRestart(dir), { have: "0.4.18", latest: "0.4.18" }, "current deploy + live writer");

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

test("the badge renders the update arrow from the same cache", () => {
  const tui = fs.readFileSync(path.join(PLUGIN_DIR, "tui.tsx"), "utf8");
  assert.match(tui, /readHarnessUpdate\(directory\)/, "reads the cached verdict");
  assert.match(tui, /↑/, "renders the available version next to the deployed one");
  assert.match(tui, /text\?\.warning/, "uses the warning colour when behind");
});

test("the badge renders restart-needed from the freshness verdict (H-44)", () => {
  const tui = fs.readFileSync(path.join(PLUGIN_DIR, "tui.tsx"), "utf8");
  assert.match(tui, /readHarnessRestart\(directory\)/, "reads the freshness verdict");
  assert.match(tui, /↻restart/, "marks a deployed-but-not-active harness");
  assert.match(tui, /update \|\| restart/, "the restart marker also uses the warning colour");
});

test("the badge re-reads the deployed version and verdicts on every render", () => {
  const tui = fs.readFileSync(path.join(PLUGIN_DIR, "tui.tsx"), "utf8");
  const start = tui.indexOf("const badge = () =>");
  assert.ok(start > 0, "the badge render function exists");
  const body = tui.slice(start, tui.indexOf("const home =", start));
  for (const call of ["readHarnessVersion", "readHarnessUpdate", "readHarnessRestart"]) {
    assert.match(body, new RegExp(`${call}\\(directory\\)`), `${call} is read inside render, not setup`);
  }
  assert.match(body, /const directory = resolveDirectory\(\)/, "the badge's directory is resolved per render (F-038)");
  assert.doesNotMatch(
    tui.slice(tui.indexOf("const setupDirectory ="), start),
    /const directory = resolveDirectory\(\)/,
    "setup keeps only the fallback directory"
  );
  assert.doesNotMatch(
    tui.slice(tui.indexOf("const version ="), start),
    /readHarnessUpdate\(directory\)/,
    "setup must not pin the update verdict"
  );
});

test("the template ships both entrypoints and both footer slots", () => {
  assert.ok(fs.existsSync(path.join(PLUGIN_DIR, "index.ts")), "server entrypoint");
  assert.ok(fs.existsSync(path.join(PLUGIN_DIR, "tui.tsx")), "TUI entrypoint");
  const tui = fs.readFileSync(path.join(PLUGIN_DIR, "tui.tsx"), "utf8");
  assert.match(tui, /home\.footer\.status/, "badge on the home footer");
  assert.match(tui, /prompt\.footer\.status/, "badge on the session prompt footer");
  assert.match(tui, /readHarnessVersion\(directory\)/, "reads the checkout's deployed version");
  assert.match(tui, /if \(!version\) return/, "non-harness repos render nothing");
});
