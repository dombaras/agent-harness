"use strict";
/* [e2e] Real-loader plugin check (G11).
 *
 * The static drift-guard in `agent-harness.test.js` proves the plugin *source*
 * declares a stable id and only pinned V2 hooks — i.e. "registered" by
 * inspection. It cannot prove the running OpenCode **loader** actually loads the
 * files and that a real event reaches a hook. That class of bug (the 0.1.157
 * event-stream regression) is invisible to a source scan and to the fake-`ctx`
 * unit drivers, which feed the shape the test author expected.
 *
 * This test boots a fixture *location* on the running OpenCode service, asks the
 * service which plugins are active for that location (`GET /api/plugin`), and
 * then fires one real event — creating a session — and asserts the
 * `context-guard` plugin's observable side effect (a session lease file). If
 * either the loader or the event stream regresses, this fails.
 *
 * Why the *service* and not `opencode serve`: on 2.0.29 a bare `opencode serve`
 * does not run the location plugin pipeline (its `/api/plugin` returns an empty
 * list), while the background service does. A second `opencode serve --service`
 * is not safe to start from a test (it replaces the singleton and restarts the
 * caller's session), so this test uses the already-running service and **skips**
 * when it is absent — which is always the case in CI, so the suite stays green
 * there while the check has real teeth on a dev box.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const TEMPLATES_DIR = path.join(__dirname, "..", "templates");

/* A stable fixture path (not mkdtemp) so the service reuses one plugin instance
 * across runs instead of accumulating a new location per invocation. */
const FIXTURE = path.join(os.tmpdir(), "agent-harness-plugin-loader");

function opencodeVersion() {
  try {
    const r = spawnSync("opencode", ["--version"], { encoding: "utf8" });
    return r.status === 0 ? (r.stdout || "").trim() : null;
  } catch {
    return null;
  }
}

function serviceUrl() {
  try {
    const r = spawnSync("opencode", ["service", "status"], { encoding: "utf8" });
    const out = (r.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop();
    return r.status === 0 && /^https?:\/\//.test(out) ? out : null;
  } catch {
    return null;
  }
}

function servicePassword() {
  try {
    const p = path.join(os.homedir(), ".config", "opencode", "service.json");
    return JSON.parse(fs.readFileSync(p, "utf8")).password || null;
  } catch {
    return null;
  }
}

/* The ids the harness ships, read straight from the plugin sources so a renamed
 * or dropped id is caught here as well as by the static guard. */
function expectedIds() {
  const dir = path.join(TEMPLATES_DIR, ".opencode", "plugins");
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => {
      const m = fs.readFileSync(path.join(dir, f), "utf8").match(/id:\s*"([a-z0-9-]+)"/);
      assert.ok(m, `${f}: declares a plugin id`);
      return m[1];
    })
    .sort();
}

function buildFixture() {
  fs.rmSync(FIXTURE, { recursive: true, force: true });
  fs.mkdirSync(path.join(FIXTURE, ".opencode"), { recursive: true });
  fs.mkdirSync(path.join(FIXTURE, ".agents", "memory"), { recursive: true });
  // Mirror a real deploy: the plugin sources plus the scripts/memory they import.
  fs.cpSync(path.join(TEMPLATES_DIR, ".opencode", "plugins"), path.join(FIXTURE, ".opencode", "plugins"), { recursive: true });
  fs.cpSync(path.join(TEMPLATES_DIR, "scripts"), path.join(FIXTURE, "scripts"), { recursive: true });
  for (const mem of ["orchestration.md", "model-routing.md"]) {
    fs.copyFileSync(path.join(TEMPLATES_DIR, ".agents", "memory", mem), path.join(FIXTURE, ".agents", "memory", mem));
  }
  fs.writeFileSync(path.join(FIXTURE, "opencode.json"), '{ "$schema": "https://opencode.ai/config.json" }\n');
  // ctx.location.project resolves through the VCS root; give the fixture one.
  const git = (...args) => spawnSync("git", ["-C", FIXTURE, ...args], { stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "plugin-loader@harness.local");
  git("config", "user.name", "plugin-loader");
  git("add", "-A");
  git("commit", "-qm", "fixture");
}

function makeClient(url, password) {
  const auth = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
  const call = async (p, opts = {}) => {
    const res = await fetch(url + p, {
      ...opts,
      headers: { Authorization: auth, "Content-Type": "application/json", ...(opts.headers || {}) },
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { _raw: text };
    }
    return { status: res.status, json };
  };
  return {
    pluginList: (directory) =>
      call(`/api/plugin?location%5Bdirectory%5D=${encodeURIComponent(directory)}`),
    createSession: (directory) =>
      call("/api/session", { method: "POST", body: JSON.stringify({ location: { directory } }) }),
    deleteSession: (id) => call(`/api/session/${id}`, { method: "DELETE" }),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Resolve the service once; every test skips when it is unavailable. */
const VERSION = opencodeVersion();
const URL = VERSION ? serviceUrl() : null;
const PASSWORD = URL ? servicePassword() : null;
const AVAILABLE = Boolean(VERSION && URL && PASSWORD);
const SKIP = !VERSION
  ? "opencode binary not found"
  : !URL
    ? "no running opencode service"
    : !PASSWORD
      ? "no service password (~/.config/opencode/service.json)"
      : null;

let client;
if (AVAILABLE) client = makeClient(URL, PASSWORD);

test("[e2e] real loader registers every harness plugin id for a fixture location", async (t) => {
  if (SKIP) return t.skip(SKIP);
  buildFixture();
  const want = expectedIds();
  assert.ok(want.length >= 10, `expected >=10 harness plugins, found ${want.length}`);

  // Location activation is asynchronous; poll until the loader has run setup.
  let ids = [];
  for (let i = 0; i < 40; i++) {
    const { status, json } = await client.pluginList(FIXTURE);
    assert.strictEqual(status, 200, `GET /api/plugin -> ${status}`);
    ids = (json.data || [])
      .filter((p) => p.source && p.source.type !== "builtin")
      .map((p) => p.id);
    if (want.every((id) => ids.includes(id))) break;
    await sleep(1000);
  }
  const missing = want.filter((id) => !ids.includes(id));
  assert.deepStrictEqual(missing, [], `loader did not activate: ${missing.join(", ")} (active: ${ids.join(", ")})`);
});

test("[e2e] one guard event fires end-to-end (session.created -> session lease)", async (t) => {
  if (SKIP) return t.skip(SKIP);
  // Ensure the location's plugins are active before firing the event.
  const leaseDir = path.join(FIXTURE, ".serve", "sessions");
  fs.rmSync(leaseDir, { recursive: true, force: true });

  const created = await client.createSession(FIXTURE);
  assert.strictEqual(created.status, 200, `POST /api/session -> ${created.status}`);
  const sid = created.json && created.json.data && created.json.data.id;
  assert.ok(sid, "session id returned");
  try {
    let lease;
    for (let i = 0; i < 20; i++) {
      const file = path.join(leaseDir, `${sid}.json`);
      if (fs.existsSync(file)) {
        lease = JSON.parse(fs.readFileSync(file, "utf8"));
        break;
      }
      await sleep(500);
    }
    assert.ok(lease, `context-guard wrote ${sid}.json (session.created reached the hook)`);
    assert.strictEqual(lease.sessionID, sid, "lease carries the session id");
  } finally {
    await client.deleteSession(sid).catch(() => {});
  }
});
