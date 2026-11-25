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
const { spawnSync } = require("node:child_process");

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
  assert.match(
    src,
    /Restart the opencode service \(the server process, not just the TUI\) now to load the update\./,
    "requires a service restart to activate it"
  );
});

test("a restart-needed verdict written by a previous process is replaced on session activity (F-035)", () => {
  // The reported failure: the previous opencode process wrote restart-needed,
  // the service restarted, but the restored session never re-fires
  // `session.created`, so the badge kept saying ↻restart. Drive the real plugin
  // (type-stripped) with a fake V2 ctx: one session-scoped activity event must
  // rewrite the verdict to `current`.
  const home = tmpdir();
  fs.writeFileSync(
    path.join(home, "package.json"),
    JSON.stringify({ name: "opencode-agent-harness", version: "9.9.9" })
  );
  const tree = tmpdir();
  fs.mkdirSync(path.join(tree, ".serve"), { recursive: true });
  fs.mkdirSync(path.join(tree, ".git"), { recursive: true });
  const git = (...args) => spawnSync("git", ["-C", tree, ...args], { encoding: "utf8" });
  assert.strictEqual(git("init", "-q", "-b", "main").status, 0, "fixture is a git tree");
  fs.writeFileSync(path.join(tree, ".harness.json"), JSON.stringify({ version: "9.9.9" }));
  // The deploy predates this process by construction: an old mtime is the
  // "previous service wrote it" signal.
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(tree, ".harness.json"), old, old);
  const verdictPath = path.join(tree, ".serve", "harness-freshness.json");
  fs.writeFileSync(
    verdictPath,
    JSON.stringify({ status: "restart-needed", have: "9.9.9", latest: "9.9.9", wrote: 1 })
  );

  const driver = path.join(tmpdir(), "freshness-driver.mjs");
  fs.writeFileSync(
    driver,
    [
      'import { pathToFileURL } from "node:url";',
      'import fs from "node:fs";',
      "const [pluginPath, tree] = process.argv.slice(2);",
      'const { default: plugin } = await import(pathToFileURL(pluginPath).href);',
      "async function* stream(signal) {",
      '  yield { type: "message.updated", data: { sessionID: "ses_restored" }, location: { directory: tree } };',
      "  await new Promise((resolve) => {",
      "    if (signal.aborted) return resolve();",
      '    signal.addEventListener("abort", resolve, { once: true });',
      "  });",
      "}",
      "const ctx = {",
      '  location: { directory: tree + "-server-cwd" }, // deliberately wrong on purpose (server cwd)',
      "  event: { subscribe: ({ signal }) => stream(signal) },",
      '  session: { hook: () => {} },',
      "};",
      "const stop = await plugin.setup(ctx);",
      'const verdict = `${tree}/.serve/harness-freshness.json`;',
      "const deadline = Date.now() + 5000;",
      "let doc = null;",
      "while (Date.now() < deadline) {",
      "  try { doc = JSON.parse(fs.readFileSync(verdict, 'utf8')); } catch { doc = null; }",
      '  if (doc && doc.status === "current") break;',
      "  await new Promise((r) => setTimeout(r, 25));",
      "}",
      "stop();",
      "console.log(JSON.stringify(doc));",
      'process.exit(doc && doc.status === "current" ? 0 : 1);',
    ].join("\n")
  );

  const env = {
    ...process.env,
    AGENT_HARNESS_HOME: home,
    AGENT_HARNESS_NO_UPDATE_CHECK: "1",
    AGENT_HARNESS_FRESHNESS: "",
  };
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", driver, path.join(__dirname, "..", "contrib", "global-plugins", "harness-freshness.ts"), tree],
    { encoding: "utf8", env, timeout: 30000 }
  );
  assert.strictEqual(r.status, 0, (r.stdout || "") + (r.stderr || ""));
  const doc = JSON.parse((r.stdout || "").trim().split(/\r?\n/).pop());
  assert.strictEqual(doc.status, "current", "the stale verdict was replaced on activity");
  assert.strictEqual(doc.have, "9.9.9", "the current on-disk version is recorded");
});

test("[drift-guard] freshness re-evaluation is wired to activity and names the service restart (F-035)", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "contrib", "global-plugins", "harness-freshness.ts"),
    "utf8"
  );
  assert.match(src, /const consider = async \(sid: string, dir/, "one once-per-session evaluation helper");
  assert.match(src, /await consider\(sid, startDir\)/, "every session-scoped event re-evaluates");
  assert.match(
    src,
    /event\?\.type === "session\.created" && d\.parentID/,
    "child sessions are excluded from the activity path"
  );
  assert.match(src, /ctx\.session\.hook\("context"/, "the context hook is the request-boundary trigger");
  const hookAt = src.indexOf('ctx.session.hook("context"');
  const hookBody = src.slice(hookAt, src.indexOf("return () => controller.abort()", hookAt));
  assert.match(hookBody, /consider\(sid, roots\.get\(sid\)\)/, "the hook re-evaluates a restored session");
  assert.match(src, /opencode service \(the server process, not just the TUI\)/, "names the service, not the TUI");
  assert.doesNotMatch(src, /restart opencode/i, "the old TUI-confusing wording is gone");
});

test("a metadata-only harness write needs no restart; a plugin write does, as advice (F-035)", () => {
  // The reported case: `0.4.16 -> 0.4.17` auto-committed while a session ran,
  // rewriting `.harness.json` alone. The old verdict blocked the resumed session
  // ("do NOT begin work yet") over a restart that would have changed nothing,
  // while the TUI badge already read 0.4.17. Drive the real plugin twice: the
  // write must be classified by what it actually touched, and even a real plugin
  // write is advice the task can proceed past.
  const home = tmpdir();
  fs.writeFileSync(
    path.join(home, "package.json"),
    JSON.stringify({ name: "opencode-agent-harness", version: "9.9.9" })
  );

  const driver = path.join(tmpdir(), "freshness-restart-driver.mjs");
  fs.writeFileSync(
    driver,
    [
      'import { pathToFileURL } from "node:url";',
      'import fs from "node:fs";',
      'import path from "node:path";',
      "const [pluginPath, tree, mode] = process.argv.slice(2);",
      'const { default: plugin } = await import(pathToFileURL(pluginPath).href);',
      "// the harness write lands AFTER this process loaded its plugins",
      "await new Promise((r) => setTimeout(r, 25));",
      'fs.writeFileSync(path.join(tree, ".harness.json"), JSON.stringify({ version: "9.9.9" }, null, 2) + "\\n");',
      'if (mode === "loaded") {',
      '  fs.mkdirSync(path.join(tree, ".opencode", "plugins"), { recursive: true });',
      '  fs.writeFileSync(path.join(tree, ".opencode", "plugins", "new.ts"), "// new plugin\\n");',
      "}",
      "async function* stream(signal) {",
      '  yield { type: "message.updated", data: { sessionID: "ses_restart" }, location: { directory: tree } };',
      "  await new Promise((resolve) => {",
      "    if (signal.aborted) return resolve();",
      '    signal.addEventListener("abort", resolve, { once: true });',
      "  });",
      "}",
      "let contextHook = null;",
      "const ctx = {",
      "  location: { directory: tree },",
      "  event: { subscribe: ({ signal }) => stream(signal) },",
      "  session: { hook: (name, fn) => { if (name === \"context\") contextHook = fn; } },",
      "};",
      "const stop = await plugin.setup(ctx);",
      'const verdict = path.join(tree, ".serve", "harness-freshness.json");',
      "const deadline = Date.now() + 5000;",
      "let doc = null;",
      "while (Date.now() < deadline) {",
      "  try { doc = JSON.parse(fs.readFileSync(verdict, 'utf8')); } catch { doc = null; }",
      '  if (doc && (doc.status === "current" || doc.status === "restart-needed")) break;',
      "  await new Promise((r) => setTimeout(r, 25));",
      "}",
      'const messages = [{ role: "user", content: [{ type: "text", text: "resume f-331" }] }];',
      'if (contextHook) contextHook({ sessionID: "ses_restart", messages });',
      "stop();",
      "const text = messages.length > 1 ? messages[messages.length - 1].content[0].text : \"\";",
      "console.log(JSON.stringify({ doc, text }));",
      "process.exit(doc ? 0 : 1);",
    ].join("\n")
  );

  const run = (mode) => {
    const tree = tmpdir();
    fs.mkdirSync(path.join(tree, ".serve"), { recursive: true });
    const git = (...args) => spawnSync("git", ["-C", tree, ...args], { encoding: "utf8" });
    assert.strictEqual(git("init", "-q", "-b", "main").status, 0, "fixture is a git tree");
    fs.writeFileSync(path.join(tree, ".harness.json"), JSON.stringify({ version: "9.9.9" }));
    const r = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        driver,
        path.join(__dirname, "..", "contrib", "global-plugins", "harness-freshness.ts"),
        tree,
        mode,
      ],
      {
        encoding: "utf8",
        timeout: 30000,
        env: {
          ...process.env,
          AGENT_HARNESS_HOME: home,
          AGENT_HARNESS_NO_UPDATE_CHECK: "1",
          AGENT_HARNESS_FRESHNESS: "",
        },
      }
    );
    assert.strictEqual(r.status, 0, (r.stdout || "") + (r.stderr || ""));
    return JSON.parse((r.stdout || "").trim().split(/\r?\n/).pop());
  };

  const meta = run("metadata");
  assert.strictEqual(meta.doc.status, "current", "a `.harness.json`-only write activates nothing");
  assert.doesNotMatch(meta.text, /HARNESS UPDATED/, "no restart notice when the loaded build did not change");

  const loaded = run("loaded");
  assert.strictEqual(loaded.doc.status, "restart-needed", "a plugin write is a real deploy");
  assert.match(loaded.text, /HARNESS UPDATED ON DISK/, "the session is told the disk is ahead");
  assert.doesNotMatch(loaded.text, /do NOT begin work yet/, "the task is never blocked on a restart");
  assert.match(loaded.text, /Continue the current task now/, "it says work can continue");
});
