"use strict";
/* F-052: the TUI auto clear-resume decision core + source contract.
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
    "./resume-plan.mjs",
  ]) {
    assert.ok(src.includes(call), `${call} used`);
  }
  assert.ok(src.includes("idleKind !== \"succeeded\""), "a failed execution never relaunches");
});

test("the plugin is registered for the TUI loader in both configs", () => {
  for (const rel of ["opencode.json", path.join("templates", "opencode.json")]) {
    const cfg = JSON.parse(fs.readFileSync(path.join(REPO, rel), "utf8"));
    assert.ok(
      cfg.plugins.includes("./.opencode/plugins/context-resume"),
      `${rel} loads the context-resume plugin directory`
    );
  }
  for (const rel of ["index.ts", "tui.tsx", "resume-plan.mjs"]) {
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
  const entries = ["tui.tsx", "index.ts"].map((rel) => path.join(PLUGIN_DIR, rel));
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

