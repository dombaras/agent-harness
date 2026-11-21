#!/usr/bin/env node
"use strict";
/*
 * test:opencode-compat — fail the deploy when a harness surface drifts from the
 * OpenCode V2 contract it was built against.
 *
 * The harness is V2-only. A V1 runtime loads none of its plugins while every
 * other check still says "ok", and a leftover V1 config/plugin shape is silently
 * accepted-and-ignored by the V2 loader — both classes are invisible until a
 * feature quietly does nothing (the `todowrite` miss was one: the tool is gated
 * behind `experimental.todo`, default false).
 *
 * Deterministic checks (no LLM, no network):
 *   1. Runtime — the local `opencode` binary, when present, must report major 2.
 *      Absent binary = skipped (CI has no runtime), never a failure.
 *   2. Config — `opencode.json` parses and enables `experimental.todo`, the
 *      capability flag for the built-in `todowrite` tool the todo discipline
 *      depends on.
 *   3. Deprecated V1 config keys (`small_model`, `agent`, `permission`, `tools`)
 *      are gone; a leftover `instructions` array is a warn (V2 accepts but
 *      ignores it; `mergeOpencodeJson` deliberately keeps a project's own entry).
 *   4. Plugin sources — no V1 package import (`@opencode-ai/plugin`), no V1
 *      event envelope (`event.properties`; V2 is `event.data`), and every
 *      `.opencode/plugins/*.ts` default-exports a V2 plugin.
 *   5. V1 layout — no `.opencode/tools/*.ts` and no legacy `.opencode/command/`
 *      (V2 still discovers the singular dir, so a stale copy shadows the new
 *      `commands/`).
 *
 * Usage: node scripts/qa/check-opencode-compat.js [--root <dir>] [--json]
 * Env:   AGENT_OPENCODE_COMPAT_SKIP_RUNTIME=1     skip the runtime probe
 *        AGENT_OPENCODE_COMPAT_REQUIRE_RUNTIME=1  a missing binary is a failure
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const argv = process.argv.slice(2);
const rootFlag = argv.indexOf("--root");
const root = path.resolve(rootFlag !== -1 && argv[rootFlag + 1] ? argv[rootFlag + 1] : path.resolve(__dirname, "..", ".."));
const jsonOut = argv.includes("--json");
const skipRuntime = process.env.AGENT_OPENCODE_COMPAT_SKIP_RUNTIME === "1";
const requireRuntime = process.env.AGENT_OPENCODE_COMPAT_REQUIRE_RUNTIME === "1";

const findings = [];
const warnings = [];
const passed = [];
const fail = (label, detail) => findings.push({ label, detail });
const warn = (label, detail) => warnings.push({ label, detail });
const ok = (label, detail) => passed.push({ label, detail });

/* ------------------------------------------------------------ 1. runtime */
function probeRuntime() {
  if (skipRuntime) {
    ok("runtime", "probe skipped (AGENT_OPENCODE_COMPAT_SKIP_RUNTIME=1)");
    return;
  }
  const res = spawnSync("opencode", ["--version"], { encoding: "utf8", timeout: 15000 });
  const out = `${res.stdout || ""} ${res.stderr || ""}`.trim();
  if (res.error || res.status !== 0) {
    if (requireRuntime) fail("runtime", "opencode is not on PATH (required by AGENT_OPENCODE_COMPAT_REQUIRE_RUNTIME=1)");
    else ok("runtime", "opencode not on PATH — runtime probe skipped (fine in CI)");
    return;
  }
  const m = out.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) {
    warn("runtime", `unparseable version banner: ${out.slice(0, 80)}`);
    return;
  }
  const major = Number(m[1]);
  if (major !== 2) {
    fail(
      "runtime",
      `opencode ${m[1]}.${m[2]}.${m[3]} — the harness requires V2 (major 2); a V1 runtime loads no harness plugins`
    );
    return;
  }
  ok("runtime", `opencode ${m[1]}.${m[2]}.${m[3]}`);
}

/* ------------------------------------------------------------- 2. config */
function readConfig() {
  const p = path.join(root, "opencode.json");
  if (!fs.existsSync(p)) {
    fail("config", "opencode.json is missing — run `agent-harness init` / `update`");
    return null;
  }
  try {
    const doc = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      fail("config", "opencode.json is not a JSON object");
      return null;
    }
    return doc;
  } catch (err) {
    fail("config", `opencode.json does not parse: ${err.message}`);
    return null;
  }
}

function checkConfig(doc) {
  if (!doc) return;
  const todo = doc.experimental && typeof doc.experimental === "object" ? doc.experimental.todo : undefined;
  if (todo === true) ok("experimental.todo", "enabled — the built-in `todowrite` tool is available");
  else fail("experimental.todo", "missing or not `true` — the todo panel stays empty; run `agent-harness update`");

  const v1 = ["small_model", "agent", "permission", "tools"].filter((k) => k in doc);
  if (v1.length) {
    fail("V1 config keys", `${v1.join(", ")} — V2 ignores these; run \`agent-harness update\` to migrate to \`agents\`/\`permissions\``);
  } else {
    ok("V1 config keys", "none (native V2 config)");
  }
  if ("instructions" in doc) {
    warn("instructions", "V2 parses but does not resolve `instructions`; move the rules into AGENTS.md / .agents/");
  }
}

/* ------------------------------------------------------------ 3. plugins */
const V1_PACKAGE = /@opencode-ai\/plugin/;
const V1_ENVELOPE = /\bevent\.properties\b/;

function pluginFiles() {
  const out = [];
  for (const rel of [".opencode/plugins", "contrib/global-plugins"]) {
    const dir = path.join(root, rel);
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && /\.(ts|js|mjs)$/.test(e.name)) out.push({ rel: `${rel}/${e.name}`, abs: path.join(dir, e.name) });
    }
  }
  return out;
}

function checkPlugins() {
  const files = pluginFiles();
  if (!files.length) {
    warn("plugins", "no .opencode/plugins/*.ts found — the guard/tools will not load");
    return;
  }
  for (const f of files) {
    const src = fs.readFileSync(f.abs, "utf8");
    if (V1_PACKAGE.test(src)) {
      fail("plugin package", `${f.rel} imports \`@opencode-ai/plugin\` (V1) — V2 plugins use type-only \`@opencode/plugin\``);
    }
    if (V1_ENVELOPE.test(src)) {
      fail("plugin event envelope", `${f.rel} reads \`event.properties\` — the V2 envelope carries the payload in \`event.data\``);
    }
    if (!/\bexport\s+default\b/.test(src)) {
      fail("plugin shape", `${f.rel} has no \`export default\` — V2 loads default-exported \`{ id, setup }\` plugins`);
    }
  }
  if (!findings.some((x) => x.label.startsWith("plugin ") || x.label === "plugin shape")) {
    ok("plugins", `${files.length} V2 plugin source(s) (default export, V2 envelope, no V1 package)`);
  }
}

/* ------------------------------------------------------------- 4. layout */
function dirHasFiles(rel, re) {
  const dir = path.join(root, rel);
  try {
    return fs.readdirSync(dir).some((name) => re.test(name));
  } catch {
    return false;
  }
}

function checkLayout() {
  const v1Tools = dirHasFiles(".opencode/tools", /\.(ts|js)$/);
  const v1Commands = dirHasFiles(".opencode/command", /\.md$/);
  if (v1Tools) fail("V1 layout", ".opencode/tools/* exists — V2 has no tools dir; re-run `agent-harness update` (prune)");
  if (v1Commands) fail("V1 layout", ".opencode/command/* exists — V2 still discovers it and it shadows `.opencode/commands/`");
  if (!v1Tools && !v1Commands) ok("layout", "native V2 (.opencode/{plugins,commands,agents,skills})");
}

/* ------------------------------------------------------------------ main */
probeRuntime();
const doc = readConfig();
checkConfig(doc);
checkPlugins();
checkLayout();

if (jsonOut) {
  console.log(
    JSON.stringify({ schema: "opencode-compat/1", root, passed, warnings, findings }, null, 2)
  );
  process.exit(findings.length ? 1 : 0);
}

console.log("opencode V2 compatibility — harness surfaces match the V2 contract");
for (const p of passed) console.log(`  \u2713 ${p.label}: ${p.detail}`);
for (const w of warnings) console.log(`  \u26a0 ${w.label}: ${w.detail}`);

if (findings.length) {
  console.log("\nIncompatible surfaces:");
  for (const f of findings) console.log(`  \u2717 ${f.label}: ${f.detail}`);
  console.log(
    "\nThe harness is OpenCode V2-only. Fix each item (usually `agent-harness update`)," +
      "\nthen re-run `npm run test:opencode-compat`."
  );
  process.exit(1);
}
console.log(`\nRESULT: ${passed.length} check(s) green, 0 incompatible surfaces.`);
