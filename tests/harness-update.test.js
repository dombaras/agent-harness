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

// Never read the developer's real ~/develop/agent-harness checkout in these
// tests. A case that exercises the local checkout sets AGENT_HARNESS_HOME
// explicitly; the default is an empty directory (no package.json).
process.env.AGENT_HARNESS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "no-harness-"));

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

test("refresh treats the machine's local harness checkout as the newest source (F-044)", () => {
  // The reported failure: npm's latest was 0.5.1, LibraryOS was on 0.5.1, and
  // the local checkout was already 0.5.2 — yet the badge had no ↑ because the
  // project's package.json cannot name the harness. The machine's checkout is
  // the same authoritative source the global freshness plugin applies from.
  const dir = project("0.5.1");
  const home = tmpdir();
  fs.writeFileSync(
    path.join(home, "package.json"),
    JSON.stringify({ name: "opencode-agent-harness", version: "0.5.2" })
  );
  const prior = process.env.AGENT_HARNESS_HOME;
  process.env.AGENT_HARNESS_HOME = home;
  try {
    withNpm("0.5.1", null, () => upd.refresh(dir, true));
  } finally {
    if (prior === undefined) delete process.env.AGENT_HARNESS_HOME;
    else process.env.AGENT_HARNESS_HOME = prior;
  }
  assert.strictEqual(upd.status(dir).state, "behind", "the checkout leads the registry");
  assert.strictEqual(upd.status(dir).latest, "0.5.2");
  const doc = JSON.parse(fs.readFileSync(path.join(dir, ".serve", "harness-update.json"), "utf8"));
  assert.strictEqual(doc.checkout, "0.5.2", "the checkout source is recorded");

  // A project checkout (any other package name) is not a harness source.
  fs.writeFileSync(path.join(home, "package.json"), JSON.stringify({ name: "LibraryOS", version: "9.9.9" }));
  process.env.AGENT_HARNESS_HOME = home;
  try {
    withNpm("0.5.1", null, () => upd.refresh(dir, true));
  } finally {
    if (prior === undefined) delete process.env.AGENT_HARNESS_HOME;
    else process.env.AGENT_HARNESS_HOME = prior;
  }
  assert.strictEqual(upd.status(dir).latest, "0.5.1", "a non-harness package is ignored");
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
  assert.match(src, /Restart it with: opencode service restart/, "requires a service restart to activate it");
  assert.match(src, /restarting the TUI alone/, "says a TUI restart reloads nothing");
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

test("only the newest live process owns a tree's verdict (multi-server trees)", () => {
  // One checkout is served by several opencode processes (shared service + ACP
  // stdio servers). An older process that loaded the previous build kept
  // rewriting `restart-needed` after a newer TUI was already current, so the
  // badge said ↻restart forever (F-038). Newest live writer wins; an older one
  // cannot clobber it.
  const home = tmpdir();
  fs.writeFileSync(
    path.join(home, "package.json"),
    JSON.stringify({ name: "opencode-agent-harness", version: "9.9.9" })
  );
  const tree = tmpdir();
  fs.mkdirSync(path.join(tree, ".serve"), { recursive: true });
  assert.strictEqual(spawnSync("git", ["-C", tree, "init", "-q", "-b", "main"]).status, 0);
  fs.writeFileSync(path.join(tree, ".harness.json"), JSON.stringify({ version: "9.9.9" }));
  const verdictPath = path.join(tree, ".serve", "harness-freshness.json");

  const driver = path.join(tmpdir(), "freshness-owner.mjs");
  fs.writeFileSync(
    driver,
    [
      'import { pathToFileURL } from "node:url";',
      'import fs from "node:fs";',
      "const [pluginPath, tree] = process.argv.slice(2);",
      'const { default: plugin } = await import(pathToFileURL(pluginPath).href);',
      "async function* stream(signal) {",
      '  yield { type: "message.updated", data: { sessionID: "ses_owner" }, location: { directory: tree } };',
      "  await new Promise((resolve) => {",
      "    if (signal.aborted) return resolve();",
      '    signal.addEventListener("abort", resolve, { once: true });',
      "  });",
      "}",
      "const ctx = {",
      "  location: { directory: tree },",
      "  event: { subscribe: ({ signal }) => stream(signal) },",
      "  session: { hook: () => {} },",
      "};",
      "const stop = await plugin.setup(ctx);",
      "await new Promise((r) => setTimeout(r, 600));",
      "stop();",
      'console.log(JSON.stringify(JSON.parse(fs.readFileSync(`${tree}/.serve/harness-freshness.json`, "utf8"))));',
    ].join("\n")
  );

  const env = {
    ...process.env,
    AGENT_HARNESS_HOME: home,
    AGENT_HARNESS_NO_UPDATE_CHECK: "1",
    AGENT_HARNESS_FRESHNESS: "",
    // Keep the startup sweep away from the developer's real project registry.
    XDG_STATE_HOME: tmpdir(),
  };
  const run = () =>
    spawnSync(
      process.execPath,
      ["--experimental-strip-types", driver, path.join(__dirname, "..", "contrib", "global-plugins", "harness-freshness.ts"), tree],
      { encoding: "utf8", env, timeout: 30000 }
    );
  const last = (r) => JSON.parse((r.stdout || "").trim().split(/\r?\n/).pop());

  // A NEWER live process already wrote the verdict: this older one leaves it.
  fs.writeFileSync(
    verdictPath,
    JSON.stringify({
      status: "restart-needed",
      have: "9.9.9",
      latest: "9.9.9",
      pid: process.pid,
      startedAt: Date.now() + 60_000,
    })
  );
  let r = run();
  assert.strictEqual(r.status, 0, (r.stdout || "") + (r.stderr || ""));
  assert.strictEqual(last(r).status, "restart-needed", "a newer live writer owns the verdict");

  // The writer is now OLDER than this process: its stale verdict is replaced.
  fs.writeFileSync(
    verdictPath,
    JSON.stringify({
      status: "restart-needed",
      have: "9.9.9",
      latest: "9.9.9",
      pid: process.pid,
      startedAt: Date.now() - 60_000,
    })
  );
  r = run();
  assert.strictEqual(r.status, 0, (r.stdout || "") + (r.stderr || ""));
  assert.strictEqual(last(r).status, "current", "the newer process clears an older writer's verdict");
});

test("[drift-guard] every freshness verdict names the process that wrote it (F-038)", () => {
  // A service restart leaves the verdict file behind. Without provenance the
  // badge cannot tell a live verdict from a dead process's, so a
  // `restart-needed` written before the restart outlives it (the reported
  // permanent ↻restart). The writer records pid + start; the badge validates it.
  const src = fs.readFileSync(
    path.join(__dirname, "..", "contrib", "global-plugins", "harness-freshness.ts"),
    "utf8"
  );
  assert.match(src, /const PROCESS_PID = process\.pid/, "records the writing process");
  const write = src.slice(src.indexOf("const writeStatus ="), src.indexOf("/* Apply through"));
  assert.match(write, /pid: PROCESS_PID/, "every verdict carries the pid");
  assert.match(write, /startedAt: PROCESS_START/, "every verdict carries the process start");
  assert.match(
    src,
    /\.\.\.status/,
    "status-specific fields are written beside the provenance, not replaced by it"
  );
});

test("[drift-guard] a blocked update verdict keeps the cause, not only the stack tail (F-044)", () => {
  // The reported failure wrote the last six lines of a Node stack — bare
  // "at main (...)" frames — into `detail`, discarding the first line that
  // named the two locally-modified files. The cause must survive.
  const src = fs.readFileSync(
    path.join(__dirname, "..", "contrib", "global-plugins", "harness-freshness.ts"),
    "utf8"
  );
  const at = src.indexOf('status: "blocked", reason: "update failed"');
  assert.ok(at > 0, "the failed-update verdict exists");
  const body = src.slice(Math.max(0, at - 1200), at);
  assert.match(body, /lines\.slice\(0, 3\)/, "keeps the head (the error message)");
  assert.match(body, /lines\.slice\(-2\)/, "keeps the bounded tail");
  assert.doesNotMatch(body, /slice\(-6\)/, "no longer keeps only the last six stack lines");
});

test("the badge rejects a dead process's verdict on the reported tree shape (F-038)", async () => {
  // End-to-end read path: the plugin writes a real restart-needed verdict from a
  // throwaway process, then that process exits. The badge must not render it,
  // while the same verdict with a live writer must.
  const { pathToFileURL } = require("node:url");
  const { readHarnessRestart } = await import(
    pathToFileURL(
      path.join(__dirname, "..", "templates", ".opencode", "plugins", "harness-version", "version.mjs")
    ).href
  );
  const tree = project("0.4.4");
  const status = path.join(tree, ".serve", "harness-freshness.json");
  fs.mkdirSync(path.join(tree, ".serve"), { recursive: true });
  const wrote = fs.statSync(path.join(tree, ".harness.json")).mtimeMs;
  const writer = spawnSync(process.execPath, ["-e", "0"]);
  const writerStartedAt = Date.now() - 1000;
  fs.writeFileSync(
    status,
    JSON.stringify({
      status: "restart-needed",
      have: "0.4.4",
      latest: "0.4.4",
      wrote,
      pid: writer.pid,
      startedAt: writerStartedAt,
    })
  );
  assert.strictEqual(readHarnessRestart(tree), null, "a dead writer's verdict is dropped");
  fs.writeFileSync(
    status,
    JSON.stringify({
      status: "restart-needed",
      have: "0.4.4",
      latest: "0.4.4",
      wrote,
      pid: process.pid,
      startedAt: writerStartedAt,
    })
  );
  assert.deepStrictEqual(
    readHarnessRestart(tree),
    { have: "0.4.4", latest: "0.4.4", writerStartedAt },
    "a live writer's verdict renders"
  );
});

test("[drift-guard] freshness re-evaluation is wired to activity and names the service restart (F-035)", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "contrib", "global-plugins", "harness-freshness.ts"),
    "utf8"
  );
  assert.match(src, /const consider = async \(sid: string, dir/, "one bounded evaluation helper");
  assert.match(src, /const checked = new Map<string, number>\(\)/, "activity checks are time-stamped");
  assert.match(src, /Date\.now\(\) - last < RECHECK_MS/, "a live session re-checks after the window");
  assert.match(src, /AGENT_HARNESS_RECHECK_MS/, "the window is overridable for tests");
  assert.doesNotMatch(src, /checked\.has\(sid\)/, "not once-per-process any more");
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
  assert.match(src, /opencode service restart/, "names the V2 service restart, not a TUI restart");
  assert.match(src, /restarting the TUI alone/, "explains that a TUI restart reloads nothing");
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
    // The plugin's startup sweep reads the project registry. Without an isolated
    // state dir this suite registered its temp trees in the REAL registry and
    // stamped every real project "blocked / update available" with the fixture
    // version 9.9.9 (observed in LibraryOS, 2026-11-25).
    const state = tmpdir();
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
          XDG_STATE_HOME: state,
          XDG_CACHE_HOME: tmpdir(),
        },
      }
    );
    assert.strictEqual(r.status, 0, (r.stdout || "") + (r.stderr || ""));
    const ambientState = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
    const realRegistry = path.join(ambientState, "opencode-agent-harness", "projects.json");
    const realTrees = (() => {
      try {
        return JSON.parse(fs.readFileSync(realRegistry, "utf8")).trees || [];
      } catch {
        return [];
      }
    })();
    assert.ok(!realTrees.includes(tree), "the spawned plugin must not write the real project registry");
    const isolated = JSON.parse(
      fs.readFileSync(path.join(state, "opencode-agent-harness", "projects.json"), "utf8")
    );
    assert.ok(isolated.trees.includes(tree), "the isolated registry records the tree");
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

/* F-045: drive the real global plugin through a successful deploy. Before the
 * fix the success path wrote terminal `refreshed`, which the badge does not
 * render, so the footer kept claiming the old build. The same run must publish
 * the project probe cache so a project badge that predates `blocked` still
 * shows the update arrow. */
test("a successful apply writes restart-needed and publishes the project probe cache (F-045)", () => {
  const home = tmpdir();
  fs.writeFileSync(
    path.join(home, "package.json"),
    JSON.stringify({ name: "opencode-agent-harness", version: "9.9.9" })
  );
  fs.mkdirSync(path.join(home, "bin"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "bin", "agent-harness.js"),
    [
      'const fs = require("fs");',
      'const path = require("path");',
      'const target = process.argv[process.argv.indexOf("--target") + 1];',
      'fs.writeFileSync(process.env.STUB_MARKER, "applied");',
      'fs.writeFileSync(path.join(target, ".harness.json"), JSON.stringify({ version: "9.9.9" }, null, 2) + "\\n");',
    ].join("\n")
  );

  const driver = path.join(tmpdir(), "freshness-apply-driver.mjs");
  fs.writeFileSync(
    driver,
    [
      'import { pathToFileURL } from "node:url";',
      'import fs from "node:fs";',
      'import path from "node:path";',
      "const [pluginPath, tree] = process.argv.slice(2);",
      'const { default: plugin } = await import(pathToFileURL(pluginPath).href);',
      "async function* stream(signal) {",
      '  yield { type: "message.updated", data: { sessionID: "ses_apply" }, location: { directory: tree } };',
      "  await new Promise((resolve) => {",
      "    if (signal.aborted) return resolve();",
      '    signal.addEventListener("abort", resolve, { once: true });',
      "  });",
      "}",
      "const ctx = {",
      "  location: { directory: tree },",
      "  event: { subscribe: ({ signal }) => stream(signal) },",
      "  session: { hook: () => {} },",
      "};",
      "const stop = await plugin.setup(ctx);",
      'const verdict = path.join(tree, ".serve", "harness-freshness.json");',
      "const deadline = Date.now() + 8000;",
      "let doc = null;",
      "while (Date.now() < deadline) {",
      "  try { doc = JSON.parse(fs.readFileSync(verdict, 'utf8')); } catch { doc = null; }",
      '  if (doc && doc.status === "restart-needed") break;',
      "  await new Promise((r) => setTimeout(r, 25));",
      "}",
      "let probe = null;",
      'try { probe = JSON.parse(fs.readFileSync(path.join(tree, ".serve", "harness-update.json"), "utf8")); } catch {}',
      "stop();",
      "console.log(JSON.stringify({ doc, probe }));",
      'process.exit(doc && doc.status === "restart-needed" && probe ? 0 : 1);',
    ].join("\n")
  );

  const tree = tmpdir();
  const git = (...args) => spawnSync("git", ["-C", tree, ...args], { encoding: "utf8" });
  fs.mkdirSync(path.join(tree, ".serve"), { recursive: true });
  assert.strictEqual(git("init", "-q", "-b", "main").status, 0, "fixture is a git tree");
  fs.writeFileSync(path.join(tree, ".harness.json"), JSON.stringify({ version: "9.0.0" }));
  const marker = path.join(tmpdir(), "applied");

  const r = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      driver,
      path.join(__dirname, "..", "contrib", "global-plugins", "harness-freshness.ts"),
      tree,
    ],
    {
      encoding: "utf8",
      timeout: 30000,
      env: {
        ...process.env,
        AGENT_HARNESS_HOME: home,
        AGENT_HARNESS_NO_UPDATE_CHECK: "1",
        AGENT_HARNESS_FRESHNESS: "",
        XDG_STATE_HOME: tmpdir(),
        STUB_MARKER: marker,
      },
    }
  );
  assert.strictEqual(r.status, 0, (r.stdout || "") + (r.stderr || ""));
  const { doc, probe } = JSON.parse((r.stdout || "").trim().split(/\r?\n/).pop());

  assert.ok(fs.existsSync(marker), "the sanctioned update ran");
  assert.strictEqual(doc.status, "restart-needed", "success is an activation gap, not terminal");
  assert.strictEqual(doc.have, "9.9.9", "have names the deploy the verdict explains");
  assert.strictEqual(doc.active, "9.0.0", "active names the build the service loaded");
  assert.strictEqual(doc.latest, "9.9.9");
  assert.strictEqual(typeof doc.wrote, "number", "the verdict carries the write it saw");
  assert.strictEqual(typeof doc.pid, "number", "restart-needed keeps process provenance");
  assert.strictEqual(probe.schema, "harness-update/1", "the shared probe schema is published");
  assert.strictEqual(probe.deployed, "9.9.9", "the probe re-reads the deploy after the apply");
  assert.strictEqual(probe.latest, "9.9.9");
  assert.strictEqual(probe.checkout, "9.9.9", "the applier publishes its authoritative latest");
  assert.strictEqual(probe.local, null, "a project's own app version is not a harness version");

  const src = fs.readFileSync(
    path.join(__dirname, "..", "contrib", "global-plugins", "harness-freshness.ts"),
    "utf8"
  );
  assert.match(
    src,
    /status\.status === "blocked" && status\.wrote === undefined/,
    "every blocked verdict records the write it saw (F-045)"
  );
  assert.doesNotMatch(src, /status: "refreshed"/, "no success path writes the terminal refreshed state");
});

test("the startup sweep refreshes known trees without applying (F-045)", () => {
  const home = tmpdir();
  fs.writeFileSync(
    path.join(home, "package.json"),
    JSON.stringify({ name: "opencode-agent-harness", version: "9.9.9" })
  );
  const tree = tmpdir();
  const git = (...args) => spawnSync("git", ["-C", tree, ...args], { encoding: "utf8" });
  fs.mkdirSync(path.join(tree, ".serve"), { recursive: true });
  assert.strictEqual(git("init", "-q", "-b", "main").status, 0, "fixture is a git tree");
  fs.writeFileSync(path.join(tree, ".harness.json"), JSON.stringify({ version: "9.0.0" }));
  const state = tmpdir();
  fs.mkdirSync(path.join(state, "opencode-agent-harness"), { recursive: true });
  fs.writeFileSync(
    path.join(state, "opencode-agent-harness", "projects.json"),
    JSON.stringify({ schema: "harness-projects/1", trees: [tree] })
  );

  const driver = path.join(tmpdir(), "freshness-sweep-driver.mjs");
  fs.writeFileSync(
    driver,
    [
      'import { pathToFileURL } from "node:url";',
      'import fs from "node:fs";',
      'import path from "node:path";',
      "const [pluginPath, tree] = process.argv.slice(2);",
      'const { default: plugin } = await import(pathToFileURL(pluginPath).href);',
      "async function* stream(signal) {",
      "  await new Promise((resolve) => {",
      "    if (signal.aborted) return resolve();",
      '    signal.addEventListener("abort", resolve, { once: true });',
      "  });",
      "}",
      "const stop = await plugin.setup({",
      "  location: { directory: tree },",
      "  event: { subscribe: ({ signal }) => stream(signal) },",
      "  session: { hook: () => {} },",
      "});",
      'const probePath = path.join(tree, ".serve", "harness-update.json");',
      'const verdictPath = path.join(tree, ".serve", "harness-freshness.json");',
      "const deadline = Date.now() + 8000;",
      "let probe = null;",
      "let doc = null;",
      "while (Date.now() < deadline) {",
      "  try { probe = JSON.parse(fs.readFileSync(probePath, 'utf8')); } catch { probe = null; }",
      "  try { doc = JSON.parse(fs.readFileSync(verdictPath, 'utf8')); } catch { doc = null; }",
      '  if (probe && doc) break;',
      "  await new Promise((r) => setTimeout(r, 25));",
      "}",
      "stop();",
      "console.log(JSON.stringify({ doc, probe }));",
      "process.exit(probe && doc ? 0 : 1);",
    ].join("\n")
  );

  const r = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      driver,
      path.join(__dirname, "..", "contrib", "global-plugins", "harness-freshness.ts"),
      tree,
    ],
    {
      encoding: "utf8",
      timeout: 30000,
      env: {
        ...process.env,
        AGENT_HARNESS_HOME: home,
        AGENT_HARNESS_NO_UPDATE_CHECK: "1",
        AGENT_HARNESS_FRESHNESS: "",
        XDG_STATE_HOME: state,
      },
    }
  );
  assert.strictEqual(r.status, 0, (r.stdout || "") + (r.stderr || ""));
  const { doc, probe } = JSON.parse((r.stdout || "").trim().split(/\r?\n/).pop());
  assert.strictEqual(probe.latest, "9.9.9", "the known tree gets a fresh probe without a session event");
  assert.strictEqual(probe.deployed, "9.0.0");
  assert.strictEqual(doc.status, "blocked", "a stale tree is visible before any session activity");
  assert.strictEqual(doc.reason, "update available");
  assert.strictEqual(typeof doc.wrote, "number", "blocked records the write it saw");
  assert.strictEqual(
    JSON.parse(fs.readFileSync(path.join(tree, ".harness.json"), "utf8")).version,
    "9.0.0",
    "the startup sweep never applies an update"
  );
});

test("refresh re-reads the deploy before writing the cache (F-045)", () => {
  // A deploy can land while the registry lookup is in flight. The stub npm call
  // performs that write, so the old pre-lookup sample would be recorded: with the
  // fix the cache names the post-deploy version.
  const dir = project("0.4.4");
  const marker = path.join(tmpdir(), "deployed");
  const bin = tmpdir();
  const cli = path.join(bin, "npm-cli.js");
  fs.writeFileSync(
    cli,
    [
      'const fs = require("fs");',
      'const path = require("path");',
      'fs.writeFileSync(process.env.RACE_TARGET, JSON.stringify({ version: "0.4.6" }) + "\\n");',
      'process.stdout.write("0.4.6\\n");',
    ].join("\n")
  );
  const prior = process.env.npm_execpath;
  const priorTarget = process.env.RACE_TARGET;
  process.env.npm_execpath = cli;
  process.env.RACE_TARGET = path.join(dir, ".harness.json");
  try {
    const r = upd.refresh(dir, true);
    assert.strictEqual(r.deployed, "0.4.6", "re-read after the lookup");
  } finally {
    if (prior === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = prior;
    if (priorTarget === undefined) delete process.env.RACE_TARGET;
    else process.env.RACE_TARGET = priorTarget;
  }
  const doc = JSON.parse(fs.readFileSync(path.join(dir, ".serve", "harness-update.json"), "utf8"));
  assert.strictEqual(doc.deployed, "0.4.6", "the cache cannot name a build `.harness.json` already moved past");
});
