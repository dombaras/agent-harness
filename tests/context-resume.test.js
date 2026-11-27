"use strict";
/* F-052: the TUI auto clear-resume decision core + source contract.
 * F-061 adds the main-checkout variant: the selector proves one recent
 * checkpoint and the TUI resumes it in the SAME checkout behind the lease gate.
 *
 * The TUI part needs opencode's runtime, so the pure gates are kept in
 * `resume-plan.mjs` and proven here: a marker resumes ONLY when it names this
 * idle session, this feature worktree, is fresh for the session, the checkpoint
 * advanced past the crossing, and the durable cap is not spent. Every no-op
 * path (stale, flat, cap, landed, already handled) is a stop/ignore, never a
 * relaunch. The source contract pins the parts only the runtime can prove:
 * the TUI hook, the client calls, and the plugin registration.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const REPO = path.join(__dirname, "..");
const PLUGIN_DIR = path.join(REPO, "templates", ".opencode", "plugins", "context-resume");
const HELPER = path.join(PLUGIN_DIR, "resume-plan.mjs");
const MARKER_AT = "2026-11-26T12:00:00.000Z";
const SESSION_START = Date.parse(MARKER_AT) - 60_000;

let mod;
async function helper() {
  if (!mod) mod = await import(pathToFileURL(HELPER).href);
  return mod;
}

function marker(overrides = {}) {
  return {
    schema: 1,
    feature: "F-052",
    sessionID: "ses_alpha",
    tokens: 180000,
    at: MARKER_AT,
    checkpoint_count: 1,
    ...overrides,
  };
}

function handoff({ count = 2, next = "run the gates", phase = "implementation", outcome } = {}) {
  const lines = [
    "# handoff",
    "",
    "## Checkpoint",
    "",
    `- checkpoint_count: ${count}`,
    `- phase: ${phase}`,
    `- next_action: ${next}`,
  ];
  if (outcome) lines.push("", "## Session metadata", "", `- outcome: ${outcome}`);
  return lines.join("\n") + "\n";
}

function backlog({ archive = false, inProgress = "F-052" } = {}) {
  const row = (id) => `| ${id} | ? | test | handoff |`;
  return [
    "# Board",
    "",
    "## In progress",
    "",
    "| id | p | task | handoff |",
    "|---|---|---|---|",
    archive ? "" : row(inProgress),
    "",
    "## Archive (shipped · done)",
    "",
    "| id | p | task | handoff |",
    "|---|---|---|---|",
    archive ? row("F-052") : "",
    "",
  ].join("\n");
}

async function plan(overrides = {}) {
  const { planResume } = await helper();
  return planResume({
    marker: marker(),
    idleSessionID: "ses_alpha",
    sessionCreatedAt: SESSION_START,
    branch: "f-052",
    handoffText: handoff(),
    backlogText: backlog(),
    handled: null,
    resets: 0,
    maxResets: 3,
    ...overrides,
  });
}

const core = () => require(path.join(REPO, "templates", "scripts", "qa", "context-guard-core.js"));
const MAIN_NOW = Date.parse(MARKER_AT) + 5 * 60_000;

function mainMarker(overrides = {}) {
  return marker({ main: true, ...overrides });
}

async function planMain(overrides = {}) {
  const { planResume } = await helper();
  return planResume({
    marker: mainMarker(),
    idleSessionID: "ses_alpha",
    sessionCreatedAt: SESSION_START,
    branch: "main",
    checkoutKind: "main",
    leases: [],
    now: MAIN_NOW,
    isAlive: () => true,
    handoffText: handoff(),
    backlogText: backlog(),
    handled: null,
    resets: 0,
    maxResets: 3,
    ...overrides,
  });
}

test("resumes a fresh, progressed crossing in a feature worktree", async () => {
  const decision = await plan();
  assert.strictEqual(decision.action, "resume");
  assert.strictEqual(decision.feature, "F-052");
  assert.strictEqual(decision.nextResets, 1);
  assert.match(decision.prompt, /Resume the bounded work unit F-052 from its checkpoint only/);
  assert.ok(decision.key, "a handled key is returned so the same marker cannot fire twice");
});

test("uses the runner's finalize prompt when only the tail remains", async () => {
  const decision = await plan({
    handoffText: handoff({ phase: "verified — finalize", next: "run finalize" }),
  });
  assert.strictEqual(decision.action, "resume");
  assert.match(decision.prompt, /Finalize the bounded work unit F-052/);
});

test("ignores a marker for another session, schema, or worktree", async () => {
  assert.strictEqual((await plan({ idleSessionID: "ses_other" })).action, "ignore");
  assert.strictEqual((await plan({ marker: marker({ schema: 2 }) })).action, "ignore");
  assert.strictEqual((await plan({ branch: "docs/f-239-docs" })).action, "ignore");
  assert.strictEqual((await plan({ marker: marker({ feature: null }) })).action, "ignore");
  assert.strictEqual((await plan({ marker: null })).action, "ignore");
});

test("ignores a marker already handled and a stale marker from before the session", async () => {
  const first = await plan();
  assert.strictEqual((await plan({ handled: first.key })).action, "ignore");
  assert.strictEqual(
    (await plan({ sessionCreatedAt: Date.parse(MARKER_AT) + 60_000 })).action,
    "ignore"
  );
});

test("a flat checkpoint stops instead of relaunching the same context", async () => {
  // Marker recorded count 5; the handoff never advanced past it and has no
  // next_action, so a fresh session would replay the exact same state.
  const decision = await plan({
    marker: marker({ checkpoint_count: 5 }),
    handoffText: handoff({ count: 5, next: "" }),
  });
  assert.strictEqual(decision.action, "stop");
  assert.match(decision.reason, /did not advance the checkpoint/);
});

test("the durable reset cap stops auto-resume", async () => {
  const decision = await plan({ resets: 3, maxResets: 3 });
  assert.strictEqual(decision.action, "stop");
  assert.match(decision.reason, /context reset cap reached \(3\)/);
});

test("a landed feature is a stop with landed=true and the cap is reset", async () => {
  const archived = await plan({ backlogText: backlog({ archive: true }), resets: 2 });
  assert.strictEqual(archived.action, "stop");
  assert.strictEqual(archived.landed, true);
  assert.strictEqual(archived.resets, 0);

  const shipped = await plan({ handoffText: handoff({ outcome: "shipped" }) });
  assert.strictEqual(shipped.action, "stop");
  assert.strictEqual(shipped.landed, true);
});

/* F-061: the main checkout has no branch to name its feature, so the guard's
 * selector must prove exactly ONE recent checkpoint. These cases are the whole
 * bounded acceptance rule: session match, recency, strict-newest margin, landed
 * skip, and the ambiguity/stale stops that leave the advisory nudge alone. */
test("selectMainResumeCandidate picks one recent checkpoint and refuses ambiguity (F-061)", () => {
  const CG = core();
  const at = (feature, minsAgo, extra = {}) => ({
    feature,
    checkpointCount: 2,
    updated: MAIN_NOW - minsAgo * 60_000,
    ...extra,
  });

  const unique = CG.selectMainResumeCandidate({
    sessionID: "ses_alpha",
    now: MAIN_NOW,
    candidates: [at("F-061", 5)],
  });
  assert.strictEqual(unique.feature, "F-061");
  assert.strictEqual(unique.checkpointCount, 2);

  const own = CG.selectMainResumeCandidate({
    sessionID: "ses_alpha",
    sessionStartedAt: MAIN_NOW - 60 * 60_000,
    now: MAIN_NOW,
    candidates: [at("F-058", 90, { session: "ses_alpha" }), at("F-061", 5)],
  });
  assert.strictEqual(own.feature, "F-058", "a checkpoint naming this session outranks recency");
  assert.match(own.reason, /records this session/);

  const newest = CG.selectMainResumeCandidate({
    sessionID: "ses_alpha",
    now: MAIN_NOW,
    candidates: [at("F-061", 5), at("F-058", 20)],
  });
  assert.strictEqual(newest.feature, "F-061", "a strict newest-by-margin wins");

  const ambiguous = CG.selectMainResumeCandidate({
    sessionID: "ses_alpha",
    now: MAIN_NOW,
    candidates: [at("F-061", 5), at("F-058", 5.5)],
  });
  assert.strictEqual(ambiguous.feature, null, "two equally recent checkpoints never guess");
  assert.strictEqual(ambiguous.ambiguous, true);
  assert.match(ambiguous.reason, /ambiguous/);

  const stale = CG.selectMainResumeCandidate({
    sessionID: "ses_alpha",
    now: MAIN_NOW,
    candidates: [at("F-061", 180)],
  });
  assert.strictEqual(stale.feature, null, "outside the 2h window is not provable");

  const landed = CG.selectMainResumeCandidate({
    sessionID: "ses_alpha",
    now: MAIN_NOW,
    candidates: [at("F-061", 5, { landed: true })],
  });
  assert.strictEqual(landed.feature, null, "a landed checkpoint is never resumed");
});

test("a main marker resumes in the main checkout with the safety line (F-061)", async () => {
  const decision = await planMain();
  assert.strictEqual(decision.action, "resume");
  assert.strictEqual(decision.feature, "F-052");
  assert.strictEqual(decision.nextResets, 1);
  assert.match(decision.prompt, /Resume the bounded work unit F-052 from its checkpoint only/);
  assert.match(decision.prompt, /Main-checkout safety/);
  assert.match(decision.prompt, /never move the session or switch branches/);
});

test("a main marker is rejected outside main, on a feature branch, or with no feature", async () => {
  assert.strictEqual((await planMain({ checkoutKind: "linked" })).action, "ignore");
  assert.strictEqual((await planMain({ checkoutKind: null })).action, "ignore");
  assert.strictEqual((await planMain({ branch: "f-052" })).action, "ignore");
  assert.strictEqual((await planMain({ marker: mainMarker({ feature: null }) })).action, "ignore");
  assert.strictEqual((await planMain({ marker: null })).action, "ignore", "a consumed marker is no marker");
});

test("a main marker is ignored while another live primary shares the checkout", async () => {
  const live = [{ sessionID: "ses_other", pid: 4242, heartbeatAt: MAIN_NOW - 1000 }];
  assert.strictEqual((await planMain({ leases: live })).action, "ignore");

  // The session's own lease, a dead pid, and a stale heartbeat never block.
  const own = [{ sessionID: "ses_alpha", pid: 4243, heartbeatAt: MAIN_NOW }];
  const dead = [{ sessionID: "ses_dead", pid: 4244, heartbeatAt: MAIN_NOW - 4 * 60 * 60_000 }];
  assert.strictEqual((await planMain({ leases: [...own, ...dead] })).action, "resume");

  const { otherLiveLeaseCount, DEFAULT_LEASE_MAX_AGE_MS } = await helper();
  const lease = require(path.join(REPO, "scripts", "qa", "lease-lib.js"));
  assert.strictEqual(DEFAULT_LEASE_MAX_AGE_MS, lease.DEFAULT_MAX_AGE_MS, "the mirrored window matches");
  assert.strictEqual(
    otherLiveLeaseCount(live, { sessionID: "ses_alpha", now: MAIN_NOW, isAlive: () => true }),
    1
  );
  assert.strictEqual(
    otherLiveLeaseCount(live, { sessionID: "ses_alpha", now: MAIN_NOW, isAlive: () => false }),
    0,
    "a dead pid is not live"
  );
  assert.strictEqual(
    otherLiveLeaseCount(live, { sessionID: "ses_other", now: MAIN_NOW, isAlive: () => true }),
    0,
    "this session's own lease is excluded"
  );
});

test("a stale main marker never resumes", async () => {
  const decision = await planMain({ sessionCreatedAt: Date.parse(MARKER_AT) + 60_000 });
  assert.strictEqual(decision.action, "ignore");
});

test("main marker stops on flat, cap, landed, and consumed", async () => {
  const flat = await planMain({
    marker: mainMarker({ checkpoint_count: 5 }),
    handoffText: handoff({ count: 5, next: "" }),
  });
  assert.strictEqual(flat.action, "stop");
  assert.match(flat.reason, /did not advance the checkpoint/);

  const cap = await planMain({ resets: 3 });
  assert.strictEqual(cap.action, "stop");
  assert.match(cap.reason, /context reset cap reached \(3\)/);

  const archived = await planMain({ backlogText: backlog({ archive: true }), resets: 2 });
  assert.strictEqual(archived.action, "stop");
  assert.strictEqual(archived.landed, true);
  assert.strictEqual(archived.resets, 0);

  const shipped = await planMain({ handoffText: handoff({ outcome: "shipped" }) });
  assert.strictEqual(shipped.action, "stop");
  assert.strictEqual(shipped.landed, true);

  const first = await planMain();
  assert.strictEqual((await planMain({ handled: first.key })).action, "ignore");
});

test("a malformed marker file is no marker, never a throw", async () => {
  const { parseMarker, markerKey } = await helper();
  for (const body of ["", "not json", "null", "[]", "{}", JSON.stringify({ at: MARKER_AT })]) {
    assert.strictEqual(parseMarker(body), null, `shape ${body}`);
  }
  assert.ok(markerKey(marker()) !== markerKey(marker({ at: "2026-11-26T12:00:01.000Z" })));
  assert.strictEqual(markerKey(marker()), markerKey({ ...marker() }), "the key is deterministic");
});

test("featureFromBranch mirrors the server guard's contract", async () => {
  const { featureFromBranch } = await helper();
  const guard = require(path.join(REPO, "scripts", "qa", "context-guard-core.js"));
  for (const branch of ["f-052", "f-7", "F-12", "main", "docs/f-52-x", "", null]) {
    assert.strictEqual(featureFromBranch(branch), guard.featureFromBranch(branch), String(branch));
  }
});

test("the TUI source consumes only clean execution ends and the shared gates", () => {
  const src = fs.readFileSync(path.join(PLUGIN_DIR, "tui.tsx"), "utf8");
  for (const event of [
    '"session.execution.succeeded"',
    '"session.execution.failed"',
    '"session.execution.interrupted"',
  ]) {
    assert.ok(src.includes(event), `${event} subscribed`);
  }
  assert.ok(!src.includes("session.step.ended"), "never resume mid-step");
  for (const call of [
    "context.client.session.create(",
    "context.client.session.prompt(",
    "context.ui.router.navigate(",
    "context.ui.tabs.focus(",
    "context.ui.toast.show(",
    "context.storage.store(",
    'importFresh("./resume-plan.mjs"',
  ]) {
    assert.ok(src.includes(call), `${call} used`);
  }
  assert.ok(
    src.includes("resumeAfterIdle(idleKind, decision, errorText)"),
    "the failed-vs-interrupted decision lives in the pure module"
  );
  assert.ok(
    !/from\s+["']\.\/resume-plan\.mjs["']/.test(src),
    "the decision module is NOT a static import (a broken copy must not kill the plugin)"
  );
});

test("an execution end in another checkout resumes in place without stealing focus (F-064)", () => {
  const src = fs.readFileSync(path.join(PLUGIN_DIR, "tui.tsx"), "utf8");
  assert.ok(
    !/if \(current && path\.resolve\(current\) !== path\.resolve\(directory\)\) return/.test(src),
    "a background worktree/tab is no longer dropped"
  );
  assert.match(src, /const here = !!current && path\.resolve\(current\) === path\.resolve\(directory\)/);
  assert.match(src, /await startFresh\(decision, directory, here\)/, "same-directory gating is explicit");
  assert.ok(src.includes("open that session to continue"), "the off-screen resume names the directory");
});

test("a context-length failure resumes only through the fresh/progressed marker (F-064)", async () => {
  const { resumeAfterIdle, contextOverflow } = await helper();
  const resume = { action: "resume" };
  const stop = { action: "stop" };
  assert.strictEqual(resumeAfterIdle("succeeded", resume), true);
  assert.strictEqual(
    resumeAfterIdle("failed", resume, "AI_APICallError: input exceeds the context window"),
    true,
    "the context-fill path"
  );
  assert.strictEqual(
    resumeAfterIdle("failed", resume, "context_length_exceeded"),
    true,
    "provider-specific overflow code"
  );
  assert.strictEqual(
    resumeAfterIdle("failed", resume, "ECONNRESET: socket hang up"),
    false,
    "an unrelated failure never relaunches, even with a fresh marker"
  );
  assert.strictEqual(resumeAfterIdle("failed", resume, ""), false, "an unreadable failure is not a boundary");
  assert.strictEqual(resumeAfterIdle("interrupted", resume, "context length"), false, "an interrupt never relaunches");
  assert.strictEqual(resumeAfterIdle("succeeded", stop), false);
  assert.strictEqual(resumeAfterIdle("failed", stop, "context length"), false);
  assert.strictEqual(resumeAfterIdle("failed", null, "context length"), false);
  assert.strictEqual(contextOverflow("prompt is too long: 210000 tokens"), true);
});

test("a hot import re-evaluates a module rewritten on disk (F-064)", async () => {
  const { freshUrl, importFresh } = await import(pathToFileURL(path.join(PLUGIN_DIR, "hot-import.mjs")).href);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "context-resume-hot-"));
  try {
    const file = path.join(dir, "dep.mjs");
    fs.writeFileSync(file, 'export const version = "old"\n', "utf8");
    const href = pathToFileURL(file).href;
    const urlBefore = freshUrl(href);
    const first = await importFresh(href);
    assert.strictEqual(first.version, "old");

    fs.writeFileSync(file, 'export const version = "fixed"\n', "utf8");
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(file, future, future);
    assert.notStrictEqual(freshUrl(href), urlBefore, "the stamp changed");
    const second = await importFresh(href);
    assert.strictEqual(second.version, "fixed", "the deployed fix is evaluated again");
    assert.notStrictEqual(first, second, "a distinct module instance, not the cached one");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a handoff without a resumable checkpoint is never a resume seed (F-064)", () => {
  const core = require(path.join(REPO, "templates", "scripts", "qa", "run-loop-core.mjs"));
  assert.strictEqual(core.hasResumableCheckpoint(""), false);
  assert.strictEqual(core.hasResumableCheckpoint("# h\n\n## Checkpoint\n\n- checkpoint_count: 0\n"), false);
  assert.strictEqual(
    core.hasResumableCheckpoint("# h\n\n## Checkpoint\n\n- checkpoint_count: 0\n- next_action: continue\n"),
    true,
    "a recorded next_action is a seed even before the counter advances"
  );
  assert.strictEqual(core.hasResumableCheckpoint(handoff({ count: 2 })), true);

  const guard = fs.readFileSync(path.join(PLUGIN_DIR, "..", "context-guard.ts"), "utf8");
  assert.match(guard, /runLoop\.hasResumableCheckpoint\(handoff\)/, "the guard requires a seed");
  assert.match(guard, /"context-resume-skip"/, "the skip is observable");
});

test("the TUI consumes a main marker in the SAME checkout behind the lease gate (F-061)", () => {
  const src = fs.readFileSync(path.join(PLUGIN_DIR, "tui.tsx"), "utf8");
  assert.match(
    src,
    /context\.client\.session\.create\(\{ location: \{ directory \} \}\)/,
    "the fresh session opens in the same directory"
  );
  assert.ok(!src.includes("session.move"), "the session is never moved");
  assert.ok(
    src.indexOf("consumeMarker(directory)") < src.indexOf("await startFresh("),
    "the marker is consumed before the side effects"
  );
  assert.match(src, /\.serve/, "the checkout leases are read");
  assert.match(src, /readLeases\(directory\)/, "main passes the lease records to the plan");
  assert.match(src, /checkoutKind\(directory\)/, "the checkout kind is read");
  assert.match(src, /checkoutKind: kind/, "the plan sees the checkout kind");
  assert.match(src, /leases:/, "the plan sees the leases");
  assert.match(src, /isAlive: pidAlive/, "liveness is proven with process.kill(pid, 0)");
  assert.match(src, /process\.kill\(pid, 0\)/, "the pid probe is real");
  assert.match(src, /resumeAfterIdle\(idleKind, decision, errorText\)/, "a failed execution keeps the manual path");
  assert.match(src, /maxResets: DEFAULT_MAX_CONTEXT_RESETS/, "the 3-reset cap is unchanged");
  assert.ok(!src.includes("lease-lib.js"), "the CJS lease lib never enters the TUI ESM graph");
});

test("the plugin is registered for the TUI loader in both configs", () => {
  for (const rel of ["opencode.json", path.join("templates", "opencode.json")]) {
    const cfg = JSON.parse(fs.readFileSync(path.join(REPO, rel), "utf8"));
    assert.ok(
      cfg.plugins.includes("./.opencode/plugins/context-resume"),
      `${rel} loads the context-resume plugin directory`
    );
  }
  for (const rel of ["index.ts", "tui.tsx", "resume-plan.mjs", "hot-import.mjs"]) {
    // Read the COMMITTED copy, not the working tree: a locally deployed but
    // uncommitted file must not satisfy the repo contract (b513264 shipped
    // template copies with no deployed copies and only CI's clean checkout
    // noticed).
    const relPath = `.opencode/plugins/context-resume/${rel}`;
    let committed;
    try {
      committed = execFileSync("git", ["show", `:${relPath}`], { cwd: REPO, encoding: "utf8" });
    } catch {
      assert.fail(`${relPath} is not committed — a locally deployed copy is not enough`);
    }
    assert.strictEqual(
      committed.replace(/\r\n/g, "\n"),
      fs.readFileSync(path.join(PLUGIN_DIR, rel), "utf8").replace(/\r\n/g, "\n"),
      `${rel} is the deployed template copy`
    );
  }
});

/* F-054: OpenCode's TUI plugin loader evaluates the whole plugin graph as ESM.
 * Relative `.js`/`.cjs` deps are invisible CJS there (no exports), even though
 * Node/Bun interop loads them fine — so a passing unit import proves nothing.
 * Walk the graph and reject any CommonJS hop. */
const CJS_EXT = new Set([".js", ".cjs"]);

function resolveRelativeImport(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  if (path.extname(base)) return fs.existsSync(base) ? base : null;
  for (const ext of [".ts", ".tsx", ".mjs", ".js", ".cjs"]) {
    if (fs.existsSync(base + ext)) return base + ext;
  }
  for (const ext of [".ts", ".tsx", ".mjs", ".js", ".cjs"]) {
    const index = path.join(base, "index" + ext);
    if (fs.existsSync(index)) return index;
  }
  return null;
}

function esmGraphViolations(entries) {
  const visited = new Set();
  const violations = [];
  const visit = (file) => {
    if (visited.has(file)) return;
    visited.add(file);
    const ext = path.extname(file);
    if (CJS_EXT.has(ext)) {
      violations.push(`${file} is CommonJS (${ext})`);
      return;
    }
    const src = fs.readFileSync(file, "utf8");
    const specs = [];
    for (const m of src.matchAll(/(?:import|export)[\s\S]*?from\s*["']([^"']+)["']|import\s*["']([^"']+)["']/g)) {
      specs.push(m[1] || m[2]);
    }
    for (const spec of specs) {
      if (!spec.startsWith(".")) continue; // package / node: imports are not ours
      if (CJS_EXT.has(path.extname(spec))) {
        violations.push(`${file} imports CommonJS ${spec}`);
        continue;
      }
      const resolved = resolveRelativeImport(file, spec);
      if (!resolved) {
        violations.push(`${file} has an unresolved relative import ${spec}`);
        continue;
      }
      visit(resolved);
    }
  };
  for (const entry of entries) visit(entry);
  return { violations, visited: [...visited] };
}

test("the TUI plugin graph is ESM-only (never imports .js/.cjs)", () => {
  // `tui.tsx` loads the decision module dynamically (F-064), so the decision
  // graph is walked from its own entry as well as the plugin entries.
  const entries = ["tui.tsx", "index.ts", "resume-plan.mjs"].map((rel) =>
    path.join(PLUGIN_DIR, rel)
  );
  const { violations, visited } = esmGraphViolations(entries);
  assert.deepStrictEqual(violations, [], violations.join("\n"));
  assert.ok(
    visited.some((file) => file.endsWith(path.join("scripts", "qa", "run-loop-core.mjs"))),
    "the decision core is part of the TUI ESM graph"
  );
  assert.ok(
    !visited.some((file) => file.endsWith(path.join("scripts", "qa", "run-loop.js"))),
    "the CJS facade is not part of the TUI ESM graph"
  );
  const tui = fs.readFileSync(path.join(PLUGIN_DIR, "tui.tsx"), "utf8");
  assert.ok(
    visited.some((file) => file.endsWith(path.join("context-resume", "hot-import.mjs"))),
    "the loader plumbing is part of the entry graph"
  );
  assert.ok(!/from\s+["'][^"']+\.(js|cjs)["']/.test(tui), "the entry itself never imports a CJS file");
});

test("the ESM-graph guard catches a CommonJS import (negative fixture)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "context-resume-esm-"));
  try {
    const entry = path.join(dir, "tui.tsx");
    fs.writeFileSync(entry, 'import { x } from "./legacy.js"\n', "utf8");
    fs.writeFileSync(path.join(dir, "legacy.js"), "module.exports = { x: 1 }\n", "utf8");
    const { violations } = esmGraphViolations([entry]);
    assert.strictEqual(violations.length, 1, "exactly the CJS hop is reported");
    assert.match(violations[0], /imports CommonJS \.\/legacy\.js/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the decision core is real ESM with no CommonJS markers", () => {
  const core = fs.readFileSync(path.join(REPO, "templates", "scripts", "qa", "run-loop-core.mjs"), "utf8");
  assert.ok(!/^\s*module\.exports\b/m.test(core), "no module.exports");
  assert.ok(!/\brequire\s*\(/.test(core), "no require()");
  assert.match(core, /^export \{/m);
});

