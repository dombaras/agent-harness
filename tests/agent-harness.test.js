"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const h = require("../bin/agent-harness.js");

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-harness-"));
}
function read(p) {
  return fs.readFileSync(p, "utf8");
}
function exists(p) {
  return fs.existsSync(p);
}

test("substitute replaces placeholders", () => {
  assert.strictEqual(h.substitute("Hello {{NAME}}!", { NAME: "World" }), "Hello World!");
  assert.strictEqual(h.substitute("{{A}}/{{B}}", { A: "x", B: "y" }), "x/y");
});

test("listFiles enumerates the full template tree", () => {
  const rels = h.listFiles(h.TEMPLATES_DIR).map((f) => f.rel.replace(/\\/g, "/"));
  assert.ok(rels.includes("AGENTS.md"));
  assert.ok(rels.includes(".agents/AGENTS.md"));
  assert.ok(rels.includes(".agents/rules/00-operating.md"));
  assert.ok(rels.includes(".opencode/agents/planner.md"));
  assert.ok(rels.includes("opencode.json"));
  const agentCount = rels.filter((r) => r.startsWith(".opencode/agents/") && r.endsWith(".md")).length;
  assert.strictEqual(agentCount, 13);
});

test("agents carry mechanical enforcement frontmatter", () => {
  const dir = path.join(h.TEMPLATES_DIR, ".opencode", "agents");
  const planner = read(path.join(dir, "planner.md"));
  assert.match(planner, /hidden:\s*true/);
  assert.match(planner, /edit:\s*deny/);
  assert.match(planner, /bash:\s*deny/);
  assert.match(planner, /steps:\s*\d+/);
  const qaArchitect = read(path.join(dir, "qa-architect.md"));
  assert.match(qaArchitect, /bash:\s*deny/);
});

test("deploy init materializes files, substitutes placeholders, writes config", async () => {
  const target = tmpdir();
  const result = await h.deploy(target, { name: "Demo", domain: "widgets", yes: true, isUpdate: false });
  assert.strictEqual(result.projectName, "Demo");

  const rootAgents = read(path.join(target, "AGENTS.md"));
  assert.ok(rootAgents.includes("Demo"));
  assert.ok(!rootAgents.includes("{{PROJECT_NAME}}"));

  assert.ok(read(path.join(target, ".agents", "rules", "00-operating.md")).includes("Demo"));
  assert.ok(exists(path.join(target, ".agents", "memory", "domain-map.md")));
  assert.ok(exists(path.join(target, ".agents", "memory", "history.md")));

  const cfg = JSON.parse(read(path.join(target, ".harness.json")));
  assert.strictEqual(cfg.projectName, "Demo");
  assert.strictEqual(cfg.version, h.PKG.version);
  assert.ok(cfg.files && typeof cfg.files === "object");
});

test("deploy preserves project-owned memory on re-deploy", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });

  const handoffPath = path.join(target, ".agents", "memory", "handoff.md");
  fs.writeFileSync(handoffPath, "custom project data", "utf8");

  await h.deploy(target, { name: "Demo", yes: true, isUpdate: true });
  assert.strictEqual(read(handoffPath), "custom project data");
});

test("update backs up a locally-modified harness-owned file", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });

  const rootAgents = path.join(target, "AGENTS.md");
  fs.writeFileSync(rootAgents, "LOCAL EDIT", "utf8");

  await h.deploy(target, { name: "Demo", yes: true, isUpdate: true });

  assert.ok(read(rootAgents).includes("Operating Rules"), "harness file restored");

  const backups = path.join(target, h.BACKUP_DIR);
  assert.ok(exists(backups));
  let found = false;
  for (const stamp of fs.readdirSync(backups)) {
    const p = path.join(backups, stamp, "AGENTS.md");
    if (exists(p) && read(p) === "LOCAL EDIT") found = true;
  }
  assert.ok(found, "local modification was backed up");
});

test("dry-run writes nothing", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, dryRun: true, isUpdate: false });
  assert.ok(!exists(path.join(target, ".harness.json")));
  assert.ok(!exists(path.join(target, "AGENTS.md")));
});

test("opencode.json merge preserves project keys and unions instructions", () => {
  const target = tmpdir();
  fs.writeFileSync(
    path.join(target, "opencode.json"),
    JSON.stringify(
      { model: "custom/model", permission: { edit: "deny" }, instructions: ["docs/my-rules.md"] },
      null,
      2
    ) + "\n",
    "utf8"
  );

  const merged = JSON.parse(h.mergeOpencodeJson(target, { PROJECT_NAME: "Demo", PROJECT_DOMAIN: "x" }));
  assert.strictEqual(merged.model, "opencode/deepseek-v4-pro");
  assert.strictEqual(merged.permission.edit, "deny");
  assert.ok(merged.instructions.includes("docs/my-rules.md"));
  assert.ok(merged.instructions.includes(".agents/rules/00-operating.md"));
});

test("update is non-interactive (never prompts)", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: false, isUpdate: true });
  assert.ok(exists(path.join(target, ".harness.json")));
});

test("qa-plan gate + memory scaffold are deployed", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });

  assert.ok(
    exists(path.join(target, "scripts", "qa", "check-qa-plan.js")),
    "test:qa-plan gate script deployed"
  );
  assert.ok(
    exists(path.join(target, ".agents", "memory", "qa-plan.md")),
    "qa-plan memory scaffold created (create-if-missing project file)"
  );
  const qaPlan = read(path.join(target, ".agents", "memory", "qa-plan.md"));
  assert.match(qaPlan, /## Coverage map/);
  assert.match(qaPlan, /## Waivers/);
});

test("check-qa-scripts expects test:qa-plan", () => {
  const src = read(path.join(h.TEMPLATES_DIR, "scripts", "qa", "check-qa-scripts.js"));
  assert.match(src, /test:qa-plan/);
});

test("qa-plan memory scaffold is preserved on re-deploy (project-owned)", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });

  const qaPlanPath = path.join(target, ".agents", "memory", "qa-plan.md");
  fs.writeFileSync(qaPlanPath, "## Coverage map\n- custom path\n", "utf8");

  await h.deploy(target, { name: "Demo", yes: true, isUpdate: true });
  assert.strictEqual(read(qaPlanPath), "## Coverage map\n- custom path\n");
});

test("deploy auto-wires harness gate scripts into package.json, preserving others", async () => {
  const target = tmpdir();
  fs.writeFileSync(
    path.join(target, "package.json"),
    JSON.stringify({ name: "app", scripts: { start: "node .", "test:quick": "vitest run" } }, null, 2) +
      "\n",
    "utf8"
  );

  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });

  const pkg = JSON.parse(read(path.join(target, "package.json")));
  assert.strictEqual(pkg.scripts["start"], "node .", "project script preserved");
  assert.strictEqual(pkg.scripts["test:quick"], "vitest run", "project tier script preserved");
  assert.strictEqual(pkg.scripts["test:dispatch"], "node scripts/qa/check-dispatch-config.js");
  assert.strictEqual(pkg.scripts["test:governance"], "node scripts/qa/governance.js");
  assert.strictEqual(pkg.scripts["test:qa-plan"], "node scripts/qa/check-qa-plan.js");
});

test("package.json merge does not downgrade a project-customized harness gate", async () => {
  const target = tmpdir();
  fs.writeFileSync(
    path.join(target, "package.json"),
    JSON.stringify(
      { scripts: { "test:qa-plan": "bash custom-harness-qapl.sh" } },
      null,
      2
    ) + "\n",
    "utf8"
  );

  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });

  const pkg = JSON.parse(read(path.join(target, "package.json")));
  assert.strictEqual(pkg.scripts["test:qa-plan"], "bash custom-harness-qapl.sh");
});

function git(target, args) {
  return execFileSync("git", args, { cwd: target, encoding: "utf8" }).trim();
}

test("update auto-commits only harness files and a no-op update makes no commit", async () => {
  const target = tmpdir();
  git(target, ["init", "-q"]);
  git(target, ["config", "user.email", "t@t.t"]);
  git(target, ["config", "user.name", "t"]);
  git(target, ["commit", "--allow-empty", "-q", "-m", "seed"]);

  const result = await h.deploy(target, {
    name: "Demo",
    yes: true,
    isUpdate: true,
    commit: true,
    push: false,
  });

  assert.strictEqual(result.commitResult.committed, true, "update created a commit");
  assert.ok(result.commitResult.staged.length > 0, "staged harness files exist");
  assert.match(git(target, ["log", "-1", "--pretty=%s"]), /^chore\(harness\):/);

  // unrelated uncommitted work must never be swept in by a subsequent update
  const unrelated = path.join(target, "my-own-work.js");
  fs.writeFileSync(unrelated, "// mine\n", "utf8");

  const before = git(target, ["status", "--porcelain"]).split(/\r?\n/).filter(Boolean);

  const configBefore = read(path.join(target, ".harness.json"));

  const result2 = await h.deploy(target, {
    name: "Demo",
    yes: true,
    isUpdate: true,
    commit: true,
    push: false,
  });

  const after = git(target, ["status", "--porcelain"]).split(/\r?\n/).filter(Boolean);
  assert.ok(before.includes("?? my-own-work.js"), "unrelated file starts untracked");
  assert.ok(after.includes("?? my-own-work.js"), "unrelated file still untracked after update");

  // a same-version, no-file-change update is a true no-op: no stray commit, and
  // the target is left byte-for-byte untouched (no .harness.json timestamp churn)
  assert.strictEqual(result2.nothingToUpdate, true, "second update detected as no-op");
  assert.strictEqual(result2.commitResult, null, "no-op update makes no commit attempt");
  assert.strictEqual(read(path.join(target, ".harness.json")), configBefore, ".harness.json untouched");
  const committedCount = git(target, ["log", "--oneline"]).split(/\r?\n/).filter(Boolean).length;
  assert.strictEqual(committedCount, 2, "no new commit was made on a no-op update");
});

test("update force-adds harness files the project gitignores and still commits", async () => {
  const target = tmpdir();
  git(target, ["init", "-q"]);
  git(target, ["config", "user.email", "t@t.t"]);
  git(target, ["config", "user.name", "t"]);
  // mimic a project that inherited the harness's own .gitignore pattern, which
  // ignores deployment artifacts (.agents/ .opencode/ AGENTS.md opencode.json).
  fs.writeFileSync(
    path.join(target, ".gitignore"),
    ".agents/\n.opencode/\nAGENTS.md\nopencode.json\n",
    "utf8"
  );
  git(target, ["add", ".gitignore"]);
  git(target, ["commit", "-q", "-m", "seed"]);

  const result = await h.deploy(target, {
    name: "Demo",
    yes: true,
    isUpdate: true,
    commit: true,
    push: false,
  });

  assert.strictEqual(
    result.commitResult.committed,
    true,
    "a gitignored harness file must not block the auto-commit"
  );
  assert.ok(result.commitResult.forceAdded.length > 0, "gitignored harness files were force-added");
  assert.ok(
    result.commitResult.forceAdded.some((p) => p.startsWith(".agents/")),
    "force-added paths include ignored harness-owned paths"
  );
  assert.match(
    git(target, ["log", "-1", "--pretty=%s"]),
    /^chore\(harness\):/,
    "the harness commit was made"
  );
});

test("update refuses to downgrade a target deployed with a newer harness", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });

  // simulate a target deployed from a local checkout that was never published,
  // and is therefore ahead of this CLI
  const cfgPath = path.join(target, ".harness.json");
  const cfg = JSON.parse(read(cfgPath));
  cfg.version = "999.0.0";
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");

  await assert.rejects(
    h.deploy(target, { name: "Demo", yes: true, isUpdate: true }),
    /NEWER than this CLI/
  );
});

test("update --no-commit skips git", async () => {
  const target = tmpdir();
  git(target, ["init", "-q"]);
  git(target, ["config", "user.email", "t@t.t"]);
  git(target, ["config", "user.name", "t"]);
  git(target, ["commit", "--allow-empty", "-q", "-m", "seed"]);

  const result = await h.deploy(target, {
    name: "Demo",
    yes: true,
    isUpdate: true,
    commit: false,
    push: false,
  });

  assert.strictEqual(result.commitResult.committed, false);
  const log = git(target, ["log", "--oneline"]).split(/\r?\n/).filter(Boolean);
  assert.ok(!log.some((l) => /chore\(harness\)/.test(l)), "no harness commit was created");
});

// ---------------------------------------------------------------- test:qa-plan gate (flow closure)

async function scaffoldGatedTarget() {
  const target = tmpdir();
  git(target, ["init", "-q"]);
  git(target, ["config", "user.email", "t@t.t"]);
  git(target, ["config", "user.name", "t"]);
  git(target, ["commit", "--allow-empty", "-q", "-m", "seed"]);
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });
  git(target, ["add", "-A"]);
  git(target, ["commit", "-q", "-m", "deploy harness"]);
  return target;
}

function writeFile(target, rel, content) {
  const p = path.join(target, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
}

function runQaPlanGate(target) {
  const res = spawnSync(process.execPath, ["scripts/qa/check-qa-plan.js"], { cwd: target, encoding: "utf8" });
  return { status: res.status, out: (res.stdout || "") + (res.stderr || "") };
}

const RETURN_FLOW = `
## flow: return
behavior: return POST with an optional condition payload (condition selector)
surfaces: components/LendingActionDrawers.tsx, mobile/features/return/ReturnStatusSheet.tsx
variants: condition-selector-present, condition-selector-absent
`;

test("test:qa-plan fails when a touched flow's sibling surface is not addressed", async () => {
  const t = await scaffoldGatedTarget();
  writeFile(t, ".agents/memory/flow-map.md", RETURN_FLOW);
  writeFile(t, "components/LendingActionDrawers.tsx", "export const x = 1;\n");
  writeFile(
    t,
    ".agents/memory/qa-plan.md",
    "## Change intent\n- change: remove condition selector from return\n\n" +
      "## Coverage map\n- components/LendingActionDrawers.tsx -> test:quick::return\n\n## Waivers\n"
  );

  const r = runQaPlanGate(t);
  assert.strictEqual(r.status, 1, "gate must fail on an unaddressed sibling surface");
  assert.match(r.out, /sibling surface/);
  assert.match(r.out, /mobile\/features\/return\/ReturnStatusSheet\.tsx/);
  assert.match(r.out, /Parallel-surface & variant audit/);
});

test("test:qa-plan passes when every sibling surface and declared variant is audited", async () => {
  const t = await scaffoldGatedTarget();
  writeFile(t, ".agents/memory/flow-map.md", RETURN_FLOW);
  writeFile(t, "components/LendingActionDrawers.tsx", "export const x = 1;\n");
  writeFile(
    t,
    ".agents/memory/qa-plan.md",
    "## Change intent\n- change: remove condition selector from return\n\n" +
      "## Parallel-surface & variant audit\n" +
      "- mobile/features/return/ReturnStatusSheet.tsx audited: deferred — same simplification pending, logged in handoff.md\n" +
      "- flow: return variant: condition-selector-present audited: removed by this change\n" +
      "- flow: return variant: condition-selector-absent -> test:quick::return (no-condition click-through)\n\n" +
      "## Coverage map\n- components/LendingActionDrawers.tsx -> test:quick::return\n\n## Waivers\n"
  );

  const r = runQaPlanGate(t);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /RESULT: green/);
});

test("test:qa-plan fails when a declared flow variant is not addressed", async () => {
  const t = await scaffoldGatedTarget();
  writeFile(t, ".agents/memory/flow-map.md", RETURN_FLOW);
  writeFile(t, "components/LendingActionDrawers.tsx", "export const x = 1;\n");
  writeFile(
    t,
    ".agents/memory/qa-plan.md",
    "## Change intent\n- change: remove condition selector from return\n\n" +
      "## Parallel-surface & variant audit\n" +
      "- mobile/features/return/ReturnStatusSheet.tsx audited: deferred — logged in handoff.md\n\n" +
      "## Coverage map\n- components/LendingActionDrawers.tsx -> test:quick::return\n\n## Waivers\n"
  );

  const r = runQaPlanGate(t);
  assert.strictEqual(r.status, 1, "gate must fail on an unaddressed declared variant");
  assert.match(r.out, /variant/);
  assert.match(r.out, /condition-selector-present/);
});

test("test:qa-plan warns but does not fail when flow-map.md has no flows", async () => {
  const t = await scaffoldGatedTarget();
  writeFile(t, ".agents/memory/flow-map.md", "# Flow map\n");
  writeFile(t, "components/LendingActionDrawers.tsx", "export const x = 1;\n");
  writeFile(
    t,
    ".agents/memory/qa-plan.md",
    "## Change intent\n- change: remove condition selector from return\n\n" +
      "## Coverage map\n- components/LendingActionDrawers.tsx -> test:quick::return\n\n## Waivers\n"
  );

  const r = runQaPlanGate(t);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /no flows/);
  assert.match(r.out, /RESULT: green/);
});

test("flow-map memory scaffold is deployed and preserved on re-deploy", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });
  assert.ok(exists(path.join(target, ".agents", "memory", "flow-map.md")), "flow-map scaffold created");

  const flowMapPath = path.join(target, ".agents", "memory", "flow-map.md");
  fs.writeFileSync(flowMapPath, "## flow: custom\nsurfaces: a.ts\n", "utf8");

  await h.deploy(target, { name: "Demo", yes: true, isUpdate: true });
  assert.strictEqual(read(flowMapPath), "## flow: custom\nsurfaces: a.ts\n", "project flow-map preserved");
});
