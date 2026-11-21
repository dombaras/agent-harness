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

test("the template ships both entrypoints and both footer slots", () => {
  assert.ok(fs.existsSync(path.join(PLUGIN_DIR, "index.ts")), "server entrypoint");
  assert.ok(fs.existsSync(path.join(PLUGIN_DIR, "tui.tsx")), "TUI entrypoint");
  const tui = fs.readFileSync(path.join(PLUGIN_DIR, "tui.tsx"), "utf8");
  assert.match(tui, /home\.footer\.status/, "badge on the home footer");
  assert.match(tui, /prompt\.footer\.status/, "badge on the session prompt footer");
  assert.match(tui, /readHarnessVersion\(directory\)/, "reads the checkout's deployed version");
  assert.match(tui, /if \(!version\) return/, "non-harness repos render nothing");
});
