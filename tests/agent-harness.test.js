"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

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
