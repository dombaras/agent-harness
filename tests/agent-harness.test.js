"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawn, spawnSync } = require("child_process");

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

test("version is bumped whenever harness-owned files change (repo hygiene)", () => {
  // This guard only has teeth locally (uncommitted harness changes). In CI it
  // checks out a clean tree and is a no-op. It exists to catch the recurring
  // "forgot to bump package.json" mistake — including the case where a version
  // was already PUBLISHED from an uncommitted tree and more changes landed on
  // top of it (the registry, not git HEAD, is the real "already released" marker).
  let changed = [];
  try {
    changed = execFileSync("git", ["diff", "HEAD", "--name-only"], { encoding: "utf8" })
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    return; // not a git repo or no HEAD — nothing to guard
  }
  const harnessOwned = changed.filter(
    (f) => f.startsWith("bin/") || f.startsWith("templates/")
  );
  if (harnessOwned.length === 0) return;

  let released = "";
  try {
    released = JSON.parse(
      execFileSync("git", ["show", "HEAD:package.json"], { encoding: "utf8" })
    ).version;
  } catch {
    return; // can't determine the committed version — skip
  }

  // Prefer the last PUBLISHED version (what users actually have). If offline or
  // unpublished, fall back to git HEAD.
  try {
    const p = spawnSync(
      "npm",
      ["view", "@dombaras/agent-harness", "version", "--json", "--fetch-timeout=5000", "--fetch-retries=0"],
      { encoding: "utf8", timeout: 10000 }
    );
    if (p.status === 0 && p.stdout.trim()) {
      let v = null;
      try {
        v = JSON.parse(p.stdout.trim());
      } catch {
        v = p.stdout.trim();
      }
      if (v) released = String(v);
    }
  } catch {
    /* offline — fall back to git HEAD */
  }

  assert.notStrictEqual(
    h.PKG.version,
    released,
    `harness files changed (${harnessOwned.join(", ")}) but package.json version is still "${h.PKG.version}" (last released "${released}") — bump it`
  );
});

test("listFiles enumerates the full template tree", () => {
  const rels = h.listFiles(h.TEMPLATES_DIR).map((f) => f.rel.replace(/\\/g, "/"));
  assert.ok(rels.includes("AGENTS.md"));
  assert.ok(rels.includes("BACKLOG.md"));
  assert.ok(rels.includes(".agents/AGENTS.md"));
  assert.ok(rels.includes(".agents/rules/00-operating.md"));
  assert.ok(rels.includes(".opencode/agents/planner.md"));
  assert.ok(rels.includes("opencode.json"));
  const agentCount = rels.filter((r) => r.startsWith(".opencode/agents/") && r.endsWith(".md")).length;
  assert.strictEqual(agentCount, 15);
});

test("agents carry mechanical enforcement frontmatter", () => {
  const dir = path.join(h.TEMPLATES_DIR, ".opencode", "agents");
  const planner = read(path.join(dir, "planner.md"));
  assert.match(planner, /hidden:\s*true/);
  assert.match(planner, /"\*":\s*deny/);
  assert.match(planner, /\.agents\/features\/\*\/plan\.md":\s*allow/);
  assert.match(planner, /bash:\s*deny/);
  assert.match(planner, /steps:\s*\d+/);
  const productManager = read(path.join(dir, "product-manager.md"));
  assert.match(productManager, /"\*":\s*deny/);
  assert.match(productManager, /\.agents\/features\/\*\/intent\.md":\s*allow/);
  assert.match(productManager, /bash:\s*deny/);
  const qaArchitect = read(path.join(dir, "qa-architect.md"));
  assert.match(qaArchitect, /bash:\s*deny/);
});

test("thinker artifact grants are narrow (deny-by-default; owned doc writable in main tree and feature worktree)", () => {
  const dir = path.join(h.TEMPLATES_DIR, ".opencode", "agents");
  for (const [agent, allowed] of [
    ["planner.md", "plan.md"],
    ["product-manager.md", "intent.md"],
  ]) {
    const src = read(path.join(dir, agent));
    // deny-by-default for every path...
    assert.match(src, /"\*":\s*deny/);
    // ...except the single owned artifact, written in the same `edit:` block.
    const editBlock = src.split("permission:")[1].split("bash:")[0];
    assert.match(editBlock, new RegExp("\\.agents/features/\\*/" + allowed.replace(".", "\\.") + "\":\\s*allow"));
    // ...also writable when the artifact lives in the feature's git worktree
    // sibling (`../.worktrees/**`, where per-feature work is isolated).
    assert.match(editBlock, /\.\.\/\.worktrees\/\*\*\/\.agents\/features\/\*/);
    // no broad .agents/** allow sneaks in
    assert.doesNotMatch(editBlock, /\.agents\/\*\*\s*:\s*allow/);
    assert.doesNotMatch(editBlock, /"\*":\s*allow/);
  }
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

test("deploy preserves project-owned handoff files on re-deploy", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });

  const handoffPath = path.join(target, ".agents", "handoffs", "F-026.md");
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
  assert.strictEqual(merged.model, "deepseek/deepseek-flash");
  assert.strictEqual(merged.permission.edit, "deny");
  assert.ok(merged.instructions.includes("docs/my-rules.md"));
  assert.ok(merged.instructions.includes(".agents/rules/00-operating.md"));
});

test("update is non-interactive (never prompts)", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: false, isUpdate: true });
  assert.ok(exists(path.join(target, ".harness.json")));
});

test("qa-plan gate + sharded plan scaffold are deployed", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });

  assert.ok(
    exists(path.join(target, "scripts", "qa", "check-qa-plan.js")),
    "test:qa-plan gate script deployed"
  );
  assert.ok(
    exists(path.join(target, ".agents", "qa-plans", "README.md")),
    "sharded qa-plans scaffold created (create-if-missing project file)"
  );
  assert.ok(
    !exists(path.join(target, ".agents", "memory", "qa-plan.md")),
    "legacy single qa-plan.md is no longer scaffolded"
  );
  const qaPlans = read(path.join(target, ".agents", "qa-plans", "README.md"));
  assert.match(qaPlans, /## Coverage map/);
  assert.match(qaPlans, /## Waivers/);
});

test("handoffs scaffold is deployed sharded (no legacy single handoff.md)", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });

  assert.ok(
    exists(path.join(target, ".agents", "handoffs", "README.md")),
    "sharded handoffs scaffold created (create-if-missing project file)"
  );
  assert.ok(
    !exists(path.join(target, ".agents", "memory", "handoff.md")),
    "legacy single handoff.md is no longer scaffolded"
  );
  const readme = read(path.join(target, ".agents", "handoffs", "README.md"));
  assert.match(readme, /## Dispatch log/);
  assert.match(readme, /own your file/i);
});

test("orchestration.md memory scaffold is deployed, tunable, and preserved on re-deploy", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });
  const p = path.join(target, ".agents", "memory", "orchestration.md");
  assert.ok(exists(p), "orchestration.md scaffold created");
  const src = read(p);
  assert.match(src, /soft_turn_budget/);
  assert.match(src, /hard_safety_turn_limit/);
  assert.match(src, /dispatch fan-out/i);
  assert.match(src, /same_failure_turns/);
  assert.match(src, /orchestrator\.soft|soft_turn_budget/);

  fs.writeFileSync(p, "- soft_turn_budget: 20\n", "utf8");
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: true });
  assert.strictEqual(read(p), "- soft_turn_budget: 20\n", "project orchestration.md preserved");
});

test("operating rules encode bounded lifecycle + retry/gate/web discipline referencing orchestration.md", () => {
  const rules = read(path.join(h.TEMPLATES_DIR, ".agents", "rules", "00-operating.md"));
  assert.match(rules, /orchestration\.md/);
  assert.match(rules, /Context budget & lifecycle/);
  assert.match(rules, /Gate batching/);
  assert.match(rules, /No identical re-runs/);
  assert.match(rules, /Patch\/apply failures/);
  assert.match(rules, /Web\/network failures/);

  const rulebook = read(path.join(h.TEMPLATES_DIR, ".agents", "AGENTS.md"));
  assert.match(rulebook, /checkpoint/i);
  assert.match(rulebook, /work_type/);
  assert.match(rulebook, /termination_reason/);
  assert.match(rulebook, /Repeated-command \/ retry-loop detection/);

  const rootAgents = read(path.join(h.TEMPLATES_DIR, "AGENTS.md"));
  assert.match(rootAgents, /orchestration\.md/);
  assert.match(rootAgents, /Bounded orchestration/);

  const handoffSkill = read(path.join(h.TEMPLATES_DIR, ".agents", "skills", "handoff", "SKILL.md"));
  assert.match(handoffSkill, /Session metadata/);
  assert.match(handoffSkill, /work_type:/);
  assert.match(handoffSkill, /termination_reason:/);

  const plannerSkill = read(path.join(h.TEMPLATES_DIR, ".agents", "skills", "planner", "SKILL.md"));
  assert.match(plannerSkill, /Fan-out review/);
  assert.match(plannerSkill, /orchestration\.md/);
});

test("check-qa-scripts expects test:qa-plan", () => {
  const src = read(path.join(h.TEMPLATES_DIR, "scripts", "qa", "check-qa-scripts.js"));
  assert.match(src, /test:qa-plan/);
});

test("check-qa-scripts expects deploy:uat / deploy:prod / test:data-hygiene (env boundary)", () => {
  const src = read(path.join(h.TEMPLATES_DIR, "scripts", "qa", "check-qa-scripts.js"));
  assert.match(src, /deploy:uat/);
  assert.match(src, /deploy:prod/);
  assert.match(src, /test:data-hygiene/);
});

test("switch-model command + script are deployed to every project", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });

  const cmd = read(path.join(target, ".opencode", "command", "switch-model.md"));
  assert.match(cmd, /^---/, "switch-model command frontmatter");
  assert.match(cmd, /deepseek\/deepseek-flash/, "command targets the direct deepseek V4.1 flash default");
  assert.match(cmd, /deepseek\/deepseek-v4-pro/, "command exposes the pro escalation alias");
  assert.match(cmd, /switch-reasoning-model\.ps1/, "command invokes the deployed script");

  const script = read(path.join(target, "scripts", "switch-reasoning-model.ps1"));
  assert.match(script, /deepseek\/deepseek-flash/, "script aliases map to the direct deepseek V4.1 flash default");
  assert.match(script, /deepseek\/deepseek-v4-flash/, "script keeps the legacy v4 flash pin replaceable (migration/rollback)");
  assert.match(script, /deepseek\/deepseek-v4-pro/, "script aliases map to the pro escalation model");
  assert.match(script, /openrouter\/minimax\/minimax-m3/, "script exposes the OpenRouter alias");
  assert.match(script, /nvidia\/nemotron-3-ultra-550b-a55b:free/, "script exposes the Nemotron free alias");
  assert.match(script, /6 reasoning-tier agents|planner\.md/, "script rewrites the reasoning agents");

  // the command is re-deployed (overwritten) on update, like any harness file
  fs.writeFileSync(path.join(target, ".opencode", "command", "switch-model.md"), "LOCAL EDIT", "utf8");
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: true });
  assert.match(read(path.join(target, ".opencode", "command", "switch-model.md")), /deepseek\/deepseek-v4-pro/, "command restored on update");
});

test("switch-reasoning-model.ps1: replace list is derived from the alias map (no hardcoded find list)", () => {
  // Regression: the script used to hardcode the find list separately from the
  // alias map, so any value a user hand-set (or any alias added after the
  // hardcode) was invisible to the regex and the script silently reported
  // "already set". Derive the find list from the alias map so the two stay in
  // sync automatically.
  const script = read(path.join(h.TEMPLATES_DIR, "scripts", "switch-reasoning-model.ps1"));
  // Block-list a hardcoded multi-line @(...) literal assigned to $reasoningModels.
  // A single-line derivation like `@($aliases.Values | Sort-Object -Unique)` is
  // fine and should NOT match.
  assert.doesNotMatch(
    script,
    /\$reasoningModels\s*=\s*@\(\s*\r?\n\s+"/,
    "reasoningModels must not be a hardcoded multi-line list (derive from $aliases.Values instead)"
  );
  assert.match(
    script,
    /\$aliases\.Values/,
    "find list must be derived from the alias map"
  );
});

test("switch-reasoning-model.ps1: surfaces 'current value not in replace list' instead of silent 'already set'", () => {
  // Regression: when the regex never matches AND the current value != target,
  // the script used to print "No files changed (already set)" which is a lie.
  // It must emit a warning naming the unknown current value.
  const script = read(path.join(h.TEMPLATES_DIR, "scripts", "switch-reasoning-model.ps1"));
  assert.match(
    script,
    /not in replace list|not in replace list; edit by hand or add an alias/,
    "script must warn when a file's current model is not in the replace list"
  );
  assert.match(
    script,
    /skipped/,
    "script must collect skipped files and report them at the end"
  );
});

test("board command is deployed to every project (delegates to the deterministic CLI)", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });

  const cmd = read(path.join(target, ".opencode", "command", "board.md"));
  assert.match(cmd, /^---/, "board command frontmatter");
  assert.match(cmd, /BACKLOG\.md/, "command reads the local canonical board");
  assert.match(cmd, /node scripts\/backlog\.js list/, "command runs the deterministic CLI");
  assert.match(cmd, /Do NOT run git/, "command does not pull from git");
  assert.match(cmd, /Do NOT .* edit `BACKLOG\.md`/, "command forbids hand-editing the board");

  // the command is re-deployed (overwritten) on update, like any harness file
  fs.writeFileSync(path.join(target, ".opencode", "command", "board.md"), "LOCAL EDIT", "utf8");
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: true });
  assert.match(read(path.join(target, ".opencode", "command", "board.md")), /BACKLOG\.md/, "board command restored on update");
});

test("report command + deterministic agent-report script are deployed to every project", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });

  const cmd = read(path.join(target, ".opencode", "command", "report.md"));
  assert.match(cmd, /^---/, "report command frontmatter");
  assert.match(cmd, /scripts[\\/]agent-report\.js/, "command runs the deterministic report script");
  assert.match(cmd, /Do NOT fabricate token counts/, "command forbids fabricated token/cost");

  assert.ok(exists(path.join(target, "scripts", "agent-report.js")), "agent-report script deployed");

  const pkg = JSON.parse(read(path.join(target, "package.json")));
  assert.strictEqual(pkg.scripts["report"], "node scripts/agent-report.js");
});

test("agent-report aggregates dispatch logs, retries, escalations deterministically", () => {
  const target = tmpdir();
  fs.mkdirSync(path.join(target, "scripts"), { recursive: true });
  fs.copyFileSync(
    path.join(h.TEMPLATES_DIR, "scripts", "agent-report.js"),
    path.join(target, "scripts", "agent-report.js")
  );
  fs.mkdirSync(path.join(target, ".agents", "handoffs"), { recursive: true });
  fs.writeFileSync(
    path.join(target, ".agents", "handoffs", "F-003.md"),
    "# handoff\n\n## Dispatch log\n- planner -> opencode/gpt-5.6-luna -> shipped\n- frontend-engineer -> opencode/gpt-5.6-luna -> shipped\n- frontend-engineer -> opencode/gpt-5.6-luna -> shipped\n\n## Retries\n- frontend-engineer: 1 \u2014 corrected shared contract\n\n## Escalations\n- diagnostics-expert -> deepseek/deepseek-v4-pro reason: repeated failure\n",
    "utf8"
  );

  const res = spawnSync(process.execPath, ["scripts/agent-report.js"], { cwd: target, encoding: "utf8" });
  assert.strictEqual(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /Total dispatches:\s+3/);
  assert.match(res.stdout, /Retries recorded:\s+1/);
  assert.match(res.stdout, /Escalations:\s+1/);
  assert.match(res.stdout, /frontend-engineer/);
  assert.match(res.stdout, /absorb-before-spawn candidate/);

  const jsonRes = spawnSync(process.execPath, ["scripts/agent-report.js", "--json"], { cwd: target, encoding: "utf8" });
  assert.strictEqual(jsonRes.status, 0, jsonRes.stdout + jsonRes.stderr);
  const parsed = JSON.parse(jsonRes.stdout);
  assert.strictEqual(parsed.totalDispatches, 3);
  assert.strictEqual(parsed.personaCount["frontend-engineer"], 2);
  assert.strictEqual(parsed.suggestions.length, 1);
});

test("agent-report parses table dispatch logs (indexed + backticked columns)", () => {
  const target = tmpdir();
  fs.mkdirSync(path.join(target, "scripts"), { recursive: true });
  fs.copyFileSync(
    path.join(h.TEMPLATES_DIR, "scripts", "agent-report.js"),
    path.join(target, "scripts", "agent-report.js")
  );
  fs.mkdirSync(path.join(target, ".agents", "handoffs"), { recursive: true });

  // indexed 5-column table (F-056 style) with a "(per routing)" model placeholder
  fs.writeFileSync(
    path.join(target, ".agents", "handoffs", "F-056.md"),
    "# handoff\n\n## Dispatch log\n\n| # | Subagent | Model | Shipped | Deferred |\n|---|----------|-------|---------|----------|\n| 1 | product-manager | (per routing) | intent.md | - |\n| 2 | system-architect | (per routing) | scope.md | - |\n",
    "utf8"
  );
  // 3-column table (F-072 style) with backticked persona cells
  fs.writeFileSync(
    path.join(target, ".agents", "handoffs", "F-072.md"),
    "# handoff\n\n## Dispatch log\n\n| subagent | model | shipped / deferred |\n|---|---|---|\n| `mobile-engineer` | opencode/gpt-5.6-luna | shipped |\n| `qa-architect` | deepseek/deepseek-v4-pro | shipped |\n",
    "utf8"
  );

  const res = spawnSync(process.execPath, ["scripts/agent-report.js", "--json"], { cwd: target, encoding: "utf8" });
  assert.strictEqual(res.status, 0, res.stdout + res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.strictEqual(parsed.totalDispatches, 4);
  assert.strictEqual(parsed.personaCount["product-manager"], 1);
  assert.strictEqual(parsed.personaCount["system-architect"], 1);
  assert.strictEqual(parsed.personaCount["mobile-engineer"], 1);
  assert.strictEqual(parsed.personaCount["qa-architect"], 1);
  // the `#` index column must never be mistaken for a persona
  assert.ok(!("1" in parsed.personaCount), "index column is not parsed as a persona");
  assert.ok(!("2" in parsed.personaCount), "index column is not parsed as a persona");
  // "(per routing)" placeholder normalizes to "?"
  assert.strictEqual(parsed.modelCount["?"], 2);
});

test("agent-report aggregates session metadata (work_type/outcome/termination/checkpoints) verbatim", () => {
  const target = tmpdir();
  fs.mkdirSync(path.join(target, "scripts"), { recursive: true });
  fs.copyFileSync(
    path.join(h.TEMPLATES_DIR, "scripts", "agent-report.js"),
    path.join(target, "scripts", "agent-report.js")
  );
  fs.mkdirSync(path.join(target, ".agents", "handoffs"), { recursive: true });
  fs.writeFileSync(
    path.join(target, ".agents", "handoffs", "F-101.md"),
    [
      "# handoff",
      "",
      "## Dispatch log",
      "- planner -> opencode/gpt-5.6-luna -> shipped",
      "",
      "## Session metadata",
      "- work_type: feature",
      "- outcome: shipped",
      "- termination_reason: gate-pass",
      "- checkpoint_count: 2",
      "",
      "## Value shipped",
      "- done",
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(target, ".agents", "handoffs", "F-102.md"),
    [
      "# handoff",
      "",
      "## Dispatch log",
      "- diagnostics-expert -> deepseek/deepseek-v4-flash -> shipped",
      "",
      "## Session metadata",
      "- work_type: bugfix",
      "- outcome: deferred",
      "- termination_reason: blocked",
      "",
      "## Value shipped",
      "- done",
    ].join("\n"),
    "utf8"
  );

  const jsonRes = spawnSync(process.execPath, ["scripts/agent-report.js", "--json"], { cwd: target, encoding: "utf8" });
  assert.strictEqual(jsonRes.status, 0, jsonRes.stdout + jsonRes.stderr);
  const parsed = JSON.parse(jsonRes.stdout);
  assert.strictEqual(parsed.workTypeCount.feature, 1);
  assert.strictEqual(parsed.workTypeCount.bugfix, 1);
  assert.strictEqual(parsed.outcomeCount.shipped, 1);
  assert.strictEqual(parsed.outcomeCount.deferred, 1);
  assert.strictEqual(parsed.terminationCount["gate-pass"], 1);
  assert.strictEqual(parsed.terminationCount.blocked, 1);
  assert.strictEqual(parsed.totalCheckpoints, 2);
  assert.strictEqual(parsed.features["F-101"].meta.work_type, "feature");
  assert.strictEqual(parsed.validationWarnings.length, 0);

  const res = spawnSync(process.execPath, ["scripts/agent-report.js"], { cwd: target, encoding: "utf8" });
  assert.strictEqual(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /Work type \(recorded\):/);
  assert.match(res.stdout, /Outcome \(recorded\):/);
  assert.match(res.stdout, /Termination reason \(recorded\):/);
  assert.match(res.stdout, /Checkpoints:\s+2/);
  assert.match(res.stdout, /work_type: feature/);
});

test("agent-report flags out-of-vocabulary metadata and high fan-out without fabricating", () => {
  const target = tmpdir();
  fs.mkdirSync(path.join(target, "scripts"), { recursive: true });
  fs.copyFileSync(
    path.join(h.TEMPLATES_DIR, "scripts", "agent-report.js"),
    path.join(target, "scripts", "agent-report.js")
  );
  fs.mkdirSync(path.join(target, ".agents", "handoffs"), { recursive: true });
  const rows = [];
  for (let i = 1; i <= 9; i++) rows.push(`| ${i} | frontend-engineer | opencode/gpt-5.6-luna | shipped | - |`);
  fs.writeFileSync(
    path.join(target, ".agents", "handoffs", "F-200.md"),
    [
      "# handoff",
      "",
      "## Dispatch log",
      "",
      "| # | Subagent | Model | Shipped | Deferred |",
      "|---|---|---|---|---|",
      ...rows,
      "",
      "## Session metadata",
      "- work_type: mystery",
      "- outcome: nope",
      "",
      "## Value shipped",
      "- done",
    ].join("\n"),
    "utf8"
  );

  const jsonRes = spawnSync(process.execPath, ["scripts/agent-report.js", "--json"], { cwd: target, encoding: "utf8" });
  assert.strictEqual(jsonRes.status, 0, jsonRes.stdout + jsonRes.stderr);
  const parsed = JSON.parse(jsonRes.stdout);
  assert.strictEqual(parsed.totalDispatches, 9);
  assert.ok(parsed.suggestions.some((s) => /F-200: 9 dispatches.*fan-out review/.test(s)), JSON.stringify(parsed.suggestions));
  assert.strictEqual(parsed.validationWarnings.length, 2);
  assert.ok(parsed.validationWarnings.some((w) => /work_type `mystery` is not in the controlled vocabulary/.test(w)));
  assert.ok(parsed.validationWarnings.some((w) => /outcome `nope` is not in the controlled vocabulary/.test(w)));

  const res = spawnSync(process.execPath, ["scripts/agent-report.js"], { cwd: target, encoding: "utf8" });
  assert.strictEqual(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /Validation warnings/);
});

test("backlog CLI + custom tools + notify plugin are deployed to every project", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });

  assert.ok(exists(path.join(target, "scripts", "backlog.js")), "deterministic backlog CLI deployed");

  const tools = read(path.join(target, ".opencode", "tools", "backlog.ts"));
  // file "backlog.ts" + these exports become tools backlog_list/add/take/archive/freeze
  assert.match(tools, /export const list\b/);
  assert.match(tools, /export const add\b/);
  assert.match(tools, /export const take\b/);
  assert.match(tools, /export const archive\b/);
  assert.match(tools, /export const freeze\b/);
  assert.match(tools, /scripts[\\/]backlog\.js/, "tools shell out to the CLI");

  const plugin = read(path.join(target, ".opencode", "plugins", "backlog-notify.ts"));
  assert.match(plugin, /tool\.execute\.after/, "plugin hooks tool execution");
  assert.match(plugin, /showToast/, "plugin pushes a toast");

  // the `backlog` npm script is wired so `npm run backlog -- list` works
  const pkg = JSON.parse(read(path.join(target, "package.json")));
  assert.strictEqual(pkg.scripts["backlog"], "node scripts/backlog.js");
});

function scaffoldBacklogCliTarget() {
  const target = tmpdir();
  fs.mkdirSync(path.join(target, "scripts"), { recursive: true });
  fs.copyFileSync(
    path.join(h.TEMPLATES_DIR, "scripts", "backlog.js"),
    path.join(target, "scripts", "backlog.js")
  );
  copyBoardLib(target);
  fs.copyFileSync(path.join(h.TEMPLATES_DIR, "BACKLOG.md"), path.join(target, "BACKLOG.md"));
  return target;
}

/* Copy the shared row-primitive module next to the standalone board scripts
 * (backlog.js at scripts/, the QA gates at scripts/qa/) that now require it. */
function copyBoardLib(target) {
  const dir = path.join(target, "scripts", "qa");
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(h.TEMPLATES_DIR, "scripts", "qa", "board-lib.js"), path.join(dir, "board-lib.js"));
}

function runBacklogCli(target, args) {
  const res = spawnSync(process.execPath, ["scripts/backlog.js", ...args], { cwd: target, encoding: "utf8" });
  return { status: res.status, out: (res.stdout || "") + (res.stderr || "") };
}

test("backlog CLI accumulates, sorts, and delegates deterministically (no LLM)", () => {
  const t = scaffoldBacklogCliTarget();

  // accumulate: add three items with different priorities
  assert.strictEqual(runBacklogCli(t, ["add", "block something", "--p", "P1", "--evidence", "user report"]).status, 0);
  assert.strictEqual(runBacklogCli(t, ["add", "do a thing", "--p", "P2"]).status, 0);
  assert.strictEqual(runBacklogCli(t, ["add", "polish later"]).status, 0); // default P3

  // IDs are generated uniquely, and Open rows are sorted by priority (P1 -> P3)
  const backlog = read(path.join(t, "BACKLOG.md"));
  const openSection = backlog.split("## Frozen")[0];
  const order = ["F-001", "F-002", "F-003"];
  for (let i = 0; i < order.length; i++) {
    assert.ok(backlog.includes(order[i]), `${order[i]} written`);
    if (i > 0) {
      assert.ok(
        openSection.indexOf(order[i - 1]) < openSection.indexOf(order[i]),
        `${order[i - 1]} precedes ${order[i]} (priority sort)`
      );
    }
  }
  assert.match(backlog, /\| F-001 \| P1 \| \? \| block something \| user report \|/);

  // review: list prints In progress + Open, hiding Frozen/Archive by default
  const list = runBacklogCli(t, ["list"]);
  assert.strictEqual(list.status, 0, list.out);
  assert.match(list.out, /Open/);
  assert.match(list.out, /F-001/);

  // delegate: pick up F-001
  assert.match(runBacklogCli(t, ["take", "F-001", "--handoff", ".agents/handoffs/F-001.md"]).out, /took F-001/);
  let b = read(path.join(t, "BACKLOG.md"));
  assert.match(b.split("## Open")[1], /F-002/, "F-001 no longer in Open");
  assert.match(b.split("## In progress")[1].split("## Queued")[0], /\| F-001 \| \? \| block something \| \.agents\/handoffs\/F-001\.md \|/);

  // freeze F-002
  assert.match(runBacklogCli(t, ["freeze", "F-002", "--why", "not now", "--reopen", "customer asks"]).out, /froze F-002/);
  b = read(path.join(t, "BACKLOG.md"));
  assert.match(b.split("## Frozen")[1], /\| F-002 \| \? \| do a thing \| not now — reopen when customer asks \|/);

  // queue F-003, then pull it back with `next`
  assert.match(runBacklogCli(t, ["queue", "F-003"]).out, /queued F-003/);
  assert.match(runBacklogCli(t, ["next"]).out, /next: F-003/);
  assert.match(runBacklogCli(t, ["next", "--take", "--handoff", ".agents/handoffs/F-003.md"]).out, /next -> took F-003/);

  // ship F-001
  assert.match(runBacklogCli(t, ["archive", "F-001", "--closed", "shipped 2026-09-04"]).out, /archived F-001/);
  b = read(path.join(t, "BACKLOG.md"));
  assert.match(b.split("## Archive")[1], /\| F-001 \| \? \| block something \| shipped 2026-09-04 \|/);
  assert.doesNotMatch(b.split("## In progress")[1].split("## Queued")[0], /F-001/, "F-001 left In progress");

  // every mutation stays valid per the canonical gate
  fs.mkdirSync(path.join(t, "scripts", "qa"), { recursive: true });
  fs.copyFileSync(
    path.join(h.TEMPLATES_DIR, "scripts", "qa", "check-backlog.js"),
    path.join(t, "scripts", "qa", "check-backlog.js")
  );
  copyBoardLib(t);
  const gate = runBacklogGate(t);
  assert.strictEqual(gate.status, 0, gate.out);
  assert.match(gate.out, /RESULT: backlog green/);
});

test("backlog CLI rejects a non-P1..P4 priority and a blank add", () => {
  const t = scaffoldBacklogCliTarget();
  assert.strictEqual(runBacklogCli(t, ["add", "x", "--p", "P9"]).status, 1, "bad priority fails");
  assert.strictEqual(runBacklogCli(t, ["add"]).status, 1, "missing task fails");
});

test("backlog add escapes a `|` in a cell so it can't split the row (F-127 pipe variant)", () => {
  const t = scaffoldBacklogCliTarget();
  const r = runBacklogCli(t, ["add", "fix /en | he pages", "--evidence", "user | report"]);
  assert.strictEqual(r.status, 0, r.out);
  const b = read(path.join(t, "BACKLOG.md"));
  const openRows = backlogOpenDataRows(b);
  assert.strictEqual(openRows.length, 1, "pipe in a cell must not split the row");
  assert.match(openRows[0], /fix \/en \/ he pages/, "pipe sanitized but content preserved");
  assert.ok(!/task \| fix/.test(b), "no stray unescaped pipe mid-row");
  // the canonical gate accepts the result
  fs.mkdirSync(path.join(t, "scripts", "qa"), { recursive: true });
  fs.copyFileSync(
    path.join(h.TEMPLATES_DIR, "scripts", "qa", "check-backlog.js"),
    path.join(t, "scripts", "qa", "check-backlog.js")
  );
  copyBoardLib(t);
  const gate = runBacklogGate(t);
  assert.strictEqual(gate.status, 0, gate.out);
});

test("backlog add collapses a newline in a cell so it can't split the row (F-094 regression)", () => {
  const t = scaffoldBacklogCliTarget();
  const r = runBacklogCli(t, ["add", "task one\ntask two", "--evidence", "line1\nline2"]);
  assert.strictEqual(r.status, 0, r.out);
  const b = read(path.join(t, "BACKLOG.md"));
  const openRows = backlogOpenDataRows(b);
  assert.strictEqual(openRows.length, 1, "newline in a cell must not split the row");
  assert.match(b, /task one task two/);
});

/* Real Open rows only (skip the `| ID |...` header, `|---|` separator, blank
 * template placeholder row, and `_Rows:` examples) — the Open table ends at the
 * next `##` heading. */
function backlogOpenDataRows(backlog) {
  const openTail = backlog.split("## Open")[1].split("## Frozen")[0];
  return openTail
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(
      (l) =>
        /^\|.*\|$/.test(l) &&
        !/^\|\s*(ID|[Ii]d)\s*\|/.test(l) &&
        !/^\|[-:\s|]+\|$/.test(l) &&
        !/^\|\s*\|/.test(l) &&
        /^\|\s*F-\d+\s*\|/.test(l)
    );
}

test("backlog take/next reject a placeholder handoff path (fail fast, not a silent record)", () => {
  const t = scaffoldBacklogCliTarget();
  runBacklogCli(t, ["add", "do thing", "--p", "P1"]); // F-001
  const bad = runBacklogCli(t, ["take", "F-001", "--handoff", ".agents/handoffs/F-<id>.md"]);
  assert.strictEqual(bad.status, 1);
  assert.match(bad.out, /handoff/);

  const b1 = read(path.join(t, "BACKLOG.md"));
  assert.ok(!b1.includes("F-<id>"), "placeholder handoff never written to the board");

  const q = runBacklogCli(t, ["queue", "F-001"]);
  assert.strictEqual(q.status, 0, q.out);
  const badNext = runBacklogCli(t, ["next", "--take", "--handoff", ".agents/handoffs/F-<id>.md"]);
  assert.strictEqual(badNext.status, 1);
  assert.match(badNext.out, /handoff/);

  // a well-formed path still works
  const ok = runBacklogCli(t, ["next", "--take", "--handoff", ".agents/handoffs/F-001.md"]);
  assert.strictEqual(ok.status, 0, ok.out);
  assert.match(ok.out, /next -> took F-001/);
});

test("/next command claims atomically (next --take) before anything else", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });

  const cmd = read(path.join(target, ".opencode", "command", "next.md"));
  assert.match(cmd, /^---/, "next command frontmatter");
  assert.match(cmd, /next --take/, "next command runs the atomic claim");
  assert.match(cmd, /claim it first/i, "claim is the first step");
  // the atomic claim must precede the worktree isolation (which no longer auto-takes)
  const claimIdx = cmd.indexOf("next --take");
  const worktreeIdx = cmd.indexOf("worktree <id>");
  assert.ok(claimIdx !== -1 && worktreeIdx !== -1 && claimIdx < worktreeIdx, "claim precedes isolation");
  assert.match(cmd, /no other\s+session can pick the same row/i, "command explains the anti-double-pick guarantee");
});

test("next --take claims are atomic — concurrent sessions pick distinct rows", async () => {
  const t = scaffoldBacklogCliTarget();
  const n = 6;
  const ids = [];
  for (let i = 1; i <= n; i++) {
    assert.strictEqual(runBacklogCli(t, ["add", `task ${i}`, "--p", "P2"]).status, 0);
  }
  for (let i = 1; i <= n; i++) {
    const id = "F-" + String(i).padStart(3, "0");
    ids.push(id);
    assert.strictEqual(runBacklogCli(t, ["queue", id]).status, 0);
  }

  const script = path.join(t, "scripts", "backlog.js");
  const codes = await Promise.all(
    ids.map(
      () =>
        new Promise((resolve) => {
          const c = spawn(process.execPath, [script, "next", "--take"], {
            cwd: t,
            stdio: ["ignore", "ignore", "pipe"],
          });
          let err = "";
          c.stderr.on("data", (d) => (err += d));
          c.on("close", (code) => resolve({ code, err }));
        })
    )
  );
  assert.ok(
    codes.every((r) => r.code === 0),
    `all claims exit 0: ${codes.map((r) => `${r.code}:${r.err.trim()}`).join(" | ")}`
  );

  const b = read(path.join(t, "BACKLOG.md"));
  const idsInSection = (heading) =>
    b
      .split(heading)[1]
      .split("## ")[0]
      .split(/\r?\n/)
      .filter((l) => /^\s*\|/.test(l))
      .map((l) => (l.split("|")[1] || "").trim())
      .filter((id) => /^F-\d{3}$/.test(id));

  const inprogIds = idsInSection("## In progress");
  const queuedIds = idsInSection("## Queued");
  for (const id of ids) {
    assert.ok(inprogIds.includes(id), `${id} claimed In progress (no double-pick)`);
  }
  assert.strictEqual(inprogIds.length, n, "exactly n rows In progress — no row double-claimed");
  assert.strictEqual(queuedIds.length, 0, "Queued drained — no row left unclaimed");
});

test("deploy gitignores the transient board lock", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });
  const gi = read(path.join(target, ".gitignore"));
  assert.match(gi, /\.backlog\.lock/, "transient .backlog.lock is ignored");
});

test("serve helper is deployed, wired, and its runtime dir is gitignored", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });

  assert.ok(exists(path.join(target, "scripts", "serve.js")), "serve.js deployed");

  const pkg = JSON.parse(read(path.join(target, "package.json")));
  assert.strictEqual(pkg.scripts.serve, "node scripts/serve.js", "serve npm script wired");

  const gi = read(path.join(target, ".gitignore"));
  assert.match(gi, /\.serve\//, ".serve/ (pid files + logs) gitignored");
});

test("serve.js starts a detached server, waits for it, and stops it", () => {
  const target = tmpdir();
  const port = 30000 + Math.floor(Math.random() * 5000);
  const srv = path.join(target, "srv.js");
  fs.writeFileSync(srv, `require('http').createServer((q, s) => s.end('ok')).listen(${port});\n`, "utf8");
  const serve = path.join(h.TEMPLATES_DIR, "scripts", "serve.js");
  const nodeExe = '"' + process.execPath + '"';

  const startRes = spawnSync(
    process.execPath,
    [serve, "start", "--cmd", `${nodeExe} ${JSON.stringify(srv)}`, "--port", String(port), "--timeout", "15000"],
    { cwd: target, encoding: "utf8", timeout: 60000 }
  );
  assert.strictEqual(startRes.status, 0, startRes.stdout + startRes.stderr);
  assert.match(startRes.stdout, /serve start: launching/, "start reports the launch up front (never a silent wait)");
  assert.match(startRes.stdout, /ready on port/, "start reports readiness");
  assert.ok(exists(path.join(target, ".serve", `port-${port}.pid`)), "pid file recorded");

  const stopRes = spawnSync(process.execPath, [serve, "stop", "--port", String(port)], { cwd: target, encoding: "utf8" });
  assert.strictEqual(stopRes.status, 0, stopRes.stdout + stopRes.stderr);
  assert.match(stopRes.stdout, /stopped/, "stop reports the kill");
  assert.ok(!exists(path.join(target, ".serve", `port-${port}.pid`)), "pid file removed on stop");
});


test("qa-plans scaffold is preserved on re-deploy (project-owned)", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });

  const qaPlanPath = path.join(target, ".agents", "qa-plans", "F-001.md");
  fs.writeFileSync(qaPlanPath, "## Coverage map\n- custom path\n", "utf8");

  await h.deploy(target, { name: "Demo", yes: true, isUpdate: true });
  assert.strictEqual(read(qaPlanPath), "## Coverage map\n- custom path\n");
});

test("features scaffold + persona parity deploy", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });

  // INDEX scaffold is created like the memory scaffolds (project-owned)
  assert.ok(exists(path.join(target, ".agents", "features", "INDEX.md")), "features INDEX scaffold created");
  assert.ok(read(path.join(target, ".agents", "features", "INDEX.md")).includes("# Features"));

  // BACKLOG.md is scaffolded create-if-missing at the repo root (project-owned)
  assert.ok(exists(path.join(target, "BACKLOG.md")), "BACKLOG.md scaffold created");
  assert.ok(read(path.join(target, "BACKLOG.md")).includes("# BACKLOG"));

  // features persona ships both halves of the persona↔skill parity gate
  assert.ok(exists(path.join(target, ".opencode", "agents", "features.md")), "features agent deployed");
  assert.ok(exists(path.join(target, ".agents", "skills", "features", "SKILL.md")), "features skill deployed");

  // INDEX is preserved on re-deploy (project-owned, like .agents/memory)
  const indexPath = path.join(target, ".agents", "features", "INDEX.md");
  fs.writeFileSync(indexPath, "| F-001 | custom row | P3 | x | backlog |\n", "utf8");
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: true });
  assert.strictEqual(read(indexPath), "| F-001 | custom row | P3 | x | backlog |\n", "project INDEX preserved");
});

test("docs persona scaffold + parity deploy", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });

  // docs persona ships both halves of the persona↔skill parity gate
  assert.ok(exists(path.join(target, ".opencode", "agents", "docs.md")), "docs agent deployed");
  assert.ok(exists(path.join(target, ".agents", "skills", "docs", "SKILL.md")), "docs skill deployed");

  // the test:docs gate is wired into package.json scripts
  const pkg = JSON.parse(read(path.join(target, "package.json")));
  assert.strictEqual(pkg.scripts["test:docs"], "node scripts/qa/check-docs.js");
});

test("docs persona supports mid-project reconstruction from history inputs", () => {
  const skill = read(path.join(h.TEMPLATES_DIR, ".agents", "skills", "docs", "SKILL.md"));
  assert.match(skill, /Docs reconstruction/);
  assert.match(skill, /input bundle/i);
  assert.match(skill, /never run git yourself/i);
  assert.match(skill, /Never fabricate/);
  const agent = read(path.join(h.TEMPLATES_DIR, ".opencode", "agents", "docs.md"));
  assert.match(agent, /bash:\s*deny/);
  assert.match(agent, /Reconstruction mode/);
});

function scaffoldDocsTarget() {
  const target = tmpdir();
  fs.mkdirSync(path.join(target, "scripts", "qa"), { recursive: true });
  fs.copyFileSync(
    path.join(h.TEMPLATES_DIR, "scripts", "qa", "check-docs.js"),
    path.join(target, "scripts", "qa", "check-docs.js")
  );
  return target;
}

function runDocsGate(target) {
  const res = spawnSync(process.execPath, ["scripts/qa/check-docs.js"], { cwd: target, encoding: "utf8" });
  return { status: res.status, out: (res.stdout || "") + (res.stderr || "") };
}

test("test:docs passes with clean docs and a well-formed ADR", () => {
  const t = scaffoldDocsTarget();
  fs.writeFileSync(path.join(t, "README.md"), "# Demo\n\nSee [ADR](docs/adr/0001-pick.md).\n", "utf8");
  fs.mkdirSync(path.join(t, "docs", "adr"), { recursive: true });
  fs.writeFileSync(
    path.join(t, "docs", "adr", "0001-pick.md"),
    "# ADR-0001: pick a thing\n\nDate: 2026-09-01\nStatus: accepted\n\n## Context\nWe need a thing.\n\n## Decision\nWe picked the thing.\n\n## Consequences\nIt works.\n",
    "utf8"
  );
  const r = runDocsGate(t);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /green/);
});

test("test:docs fails on placeholder, dangling link, and malformed ADR", () => {
  const t = scaffoldDocsTarget();
  fs.writeFileSync(
    path.join(t, "README.md"),
    "# Demo\n\nSee [missing](nope.md) and {{PROJECT_NAME}}.\n",
    "utf8"
  );
  fs.mkdirSync(path.join(t, "docs", "adr"), { recursive: true });
  fs.writeFileSync(
    path.join(t, "docs", "adr", "0001-bad.md"),
    "# ADR-0001\n\nStatus: accepted\n\n## Decision\nOnly a decision.\n",
    "utf8"
  );
  const r = runDocsGate(t);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /un-substituted placeholder/);
  assert.match(r.out, /dangling link/);
  assert.match(r.out, /missing .* Context/);
});

test("test:docs fails when a shipped commit is missing from CHANGELOG.md", () => {
  const t = scaffoldDocsTarget();
  fs.writeFileSync(path.join(t, "README.md"), "# Demo\n", "utf8");
  git(t, ["init", "-q"]);
  git(t, ["config", "user.email", "t@t.t"]);
  git(t, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(t, "CHANGELOG.md"), "# Changelog\n", "utf8");
  git(t, ["add", "README.md", "CHANGELOG.md"]);
  git(t, ["commit", "-q", "-m", "docs: seed changelog"]);

  // a shipped feat commit with no changelog entry
  fs.writeFileSync(path.join(t, "lib.js"), "x\n", "utf8");
  git(t, ["add", "lib.js"]);
  git(t, ["commit", "-q", "-m", "feat: add thing (F-001)"]);

  const r = runDocsGate(t);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /missing entry/);
});

test("test:docs passes when every shipped commit is cited in CHANGELOG.md", () => {
  const t = scaffoldDocsTarget();
  fs.writeFileSync(path.join(t, "README.md"), "# Demo\n", "utf8");
  git(t, ["init", "-q"]);
  git(t, ["config", "user.email", "t@t.t"]);
  git(t, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(t, "CHANGELOG.md"), "# Changelog\n", "utf8");
  git(t, ["add", "README.md", "CHANGELOG.md"]);
  git(t, ["commit", "-q", "-m", "docs: seed changelog"]);

  fs.writeFileSync(path.join(t, "lib.js"), "x\n", "utf8");
  git(t, ["add", "lib.js"]);
  git(t, ["commit", "-q", "-m", "feat: add thing (F-001)"]);

  const hash = git(t, ["rev-parse", "--short", "HEAD"]);
  fs.appendFileSync(
    path.join(t, "CHANGELOG.md"),
    `- 2026-09-05 \`${hash}\` \u2014 add thing (F-001)\n`,
    "utf8"
  );
  git(t, ["add", "CHANGELOG.md"]);
  git(t, ["commit", "-q", "-m", "docs: record F-001 in changelog"]);

  const r = runDocsGate(t);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /recorded/);
});

test("test:docs fails when a review ship (.agents/reviews/**) has no changelog line", () => {
  // M5 changelog convention: a review that files follow-ups is a milestone, not an
  // invisible docs/chore — even a `docs`-typed commit touching .agents/reviews/**
  // must be cited in CHANGELOG.md.
  const t = scaffoldDocsTarget();
  fs.writeFileSync(path.join(t, "README.md"), "# Demo\n", "utf8");
  git(t, ["init", "-q"]);
  git(t, ["config", "user.email", "t@t.t"]);
  git(t, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(t, "CHANGELOG.md"), "# Changelog\n", "utf8");
  git(t, ["add", "README.md", "CHANGELOG.md"]);
  git(t, ["commit", "-q", "-m", "docs: seed changelog"]);

  fs.mkdirSync(path.join(t, ".agents", "reviews", "R-001"), { recursive: true });
  fs.writeFileSync(path.join(t, ".agents", "reviews", "R-001", "REPORT.md"), "# Review\n", "utf8");
  git(t, ["add", ".agents/reviews/R-001/REPORT.md"]);
  git(t, ["commit", "-q", "-m", "docs(review): F-104 follow-ups filed"]);

  const r = runDocsGate(t);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /ships \.agents\/reviews\//);
});

test("test:docs passes when the review ship is cited in CHANGELOG.md", () => {
  const t = scaffoldDocsTarget();
  fs.writeFileSync(path.join(t, "README.md"), "# Demo\n", "utf8");
  git(t, ["init", "-q"]);
  git(t, ["config", "user.email", "t@t.t"]);
  git(t, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(t, "CHANGELOG.md"), "# Changelog\n", "utf8");
  git(t, ["add", "README.md", "CHANGELOG.md"]);
  git(t, ["commit", "-q", "-m", "docs: seed changelog"]);

  fs.mkdirSync(path.join(t, ".agents", "reviews", "R-001"), { recursive: true });
  fs.writeFileSync(path.join(t, ".agents", "reviews", "R-001", "REPORT.md"), "# Review\n", "utf8");
  git(t, ["add", ".agents/reviews/R-001/REPORT.md"]);
  git(t, ["commit", "-q", "-m", "docs(review): F-104 follow-ups filed"]);

  const hash = git(t, ["rev-parse", "--short", "HEAD"]);
  fs.appendFileSync(path.join(t, "CHANGELOG.md"), `- 2026-09-05 \`${hash}\` \u2014 review filed (R-001)\n`, "utf8");
  git(t, ["add", "CHANGELOG.md"]);
  git(t, ["commit", "-q", "-m", "docs: record review in changelog"]);

  const r = runDocsGate(t);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /recorded/);
});

test("BACKLOG.md is preserved on re-deploy (project-owned, never overwritten)", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });

  const backlogPath = path.join(target, "BACKLOG.md");
  fs.writeFileSync(backlogPath, "# BACKLOG — canonical task list\n\n## Open\n\n| ID | P | Task | Evidence |\n|---|---|---|---|\n| F-099 | P2 | my live row | user report |\n", "utf8");

  await h.deploy(target, { name: "Demo", yes: true, isUpdate: true });
  assert.strictEqual(read(backlogPath).includes("F-099"), true, "project BACKLOG.md rows preserved");
});

test("deploy does not ship a todo.md", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });
  assert.ok(!exists(path.join(target, ".agents", "memory", "todo.md")), "no todo.md scaffold is created");
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
  assert.strictEqual(pkg.scripts["test:backlog"], "node scripts/qa/check-backlog.js");
  assert.strictEqual(pkg.scripts["test:product"], "node scripts/qa/check-product.js");
  assert.strictEqual(pkg.scripts["test:quality"], "node scripts/qa/check-quality.js");
});

test("deploy ships the quality rubric, reviews namespace, and test:quality gate", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });

  // M4: canonical quality rubric is project data (create-if-missing) + the gate script ships
  const rubric = path.join(target, ".agents", "memory", "quality-parameters.md");
  assert.ok(exists(rubric), "quality-parameters.md scaffolded");
  assert.match(read(rubric), /P1|dead-code/i);
  assert.ok(exists(path.join(target, "scripts", "qa", "check-quality.js")), "check-quality.js deployed");

  // M5: reviews namespace is project data (create-if-missing)
  const reviews = path.join(target, ".agents", "reviews", "README.md");
  assert.ok(exists(reviews), "reviews README scaffolded");
  assert.match(read(reviews), /REPORT\.md|quality-parameters/);

  // a project-authored review survives an update (create-if-missing, never overwritten)
  const rev = path.join(target, ".agents", "reviews", "R-001", "REPORT.md");
  fs.mkdirSync(path.dirname(rev), { recursive: true });
  fs.writeFileSync(rev, "LOCAL REVIEW", "utf8");
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: true });
  assert.strictEqual(read(rev), "LOCAL REVIEW", "project review preserved across update");
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

test("init auto-commits everything it deploys (scaffolds + BACKLOG.md tracked)", async () => {
  const target = tmpdir();
  git(target, ["init", "-q"]);
  git(target, ["config", "user.email", "t@t.t"]);
  git(target, ["config", "user.name", "t"]);

  const result = await h.deploy(target, {
    name: "Demo",
    yes: true,
    isUpdate: false,
    commit: true,
    push: false,
  });

  assert.strictEqual(result.commitResult.committed, true, "init created a commit");
  assert.match(git(target, ["log", "-1", "--pretty=%s"]), /^chore\(harness\):/);
  const tracked = git(target, ["ls-files"]).split(/\r?\n/).filter(Boolean);
  assert.ok(tracked.includes("BACKLOG.md"), "BACKLOG.md tracked after init");
  assert.ok(tracked.includes(".agents/handoffs/README.md"), "handoffs scaffold tracked after init");
  assert.ok(tracked.includes(".agents/features/INDEX.md"), "features scaffold tracked after init");
  assert.ok(tracked.includes(".opencode/command/board.md"), "command tracked after init");
  assert.ok(tracked.includes("AGENTS.md"), "AGENTS.md tracked after init");
  assert.ok(tracked.includes(".gitignore"), ".gitignore tracked after init");
  assert.strictEqual(git(target, ["status", "--porcelain"]), "", "working tree clean after init");
});

test("init merges the harness-managed gitignore section without clobbering project entries", async () => {
  const target = tmpdir();
  fs.writeFileSync(path.join(target, ".gitignore"), "node_modules/\n.env\n", "utf8");

  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });

  const gi = read(path.join(target, ".gitignore"));
  assert.ok(gi.includes("node_modules/"), "project entry preserved");
  assert.ok(gi.includes(".env"), "project entry preserved");
  assert.match(gi, /# agent-harness \(managed below\)/);
  assert.ok(gi.includes(".harness-backup/"), "harness local artifact ignored");

  // idempotent: a re-deploy must not duplicate the marker/entries
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: true });
  const gi2 = read(path.join(target, ".gitignore"));
  const markers = (gi2.match(/# agent-harness \(managed below\)/g) || []).length;
  assert.strictEqual(markers, 1, "marker is not duplicated on re-deploy");
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
    ".agents/qa-plans/return.md",
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
    ".agents/qa-plans/return.md",
    "## Change intent\n- change: remove condition selector from return\n\n" +
      "## Parallel-surface & variant audit\n" +
      "- mobile/features/return/ReturnStatusSheet.tsx audited: deferred — same simplification pending, logged in handoffs/\n" +
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
    ".agents/qa-plans/return.md",
    "## Change intent\n- change: remove condition selector from return\n\n" +
      "## Parallel-surface & variant audit\n" +
      "- mobile/features/return/ReturnStatusSheet.tsx audited: deferred — logged in handoffs/\n\n" +
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
    ".agents/qa-plans/return.md",
    "## Change intent\n- change: remove condition selector from return\n\n" +
      "## Coverage map\n- components/LendingActionDrawers.tsx -> test:quick::return\n\n## Waivers\n"
  );

  const r = runQaPlanGate(t);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /no flows/);
  assert.match(r.out, /RESULT: green/);
});

test("test:qa-plan unions coverage across multiple sharded plan files", async () => {
  const t = await scaffoldGatedTarget();
  writeFile(t, ".agents/memory/flow-map.md", "# Flow map\n");
  writeFile(t, "components/LendingActionDrawers.tsx", "export const x = 1;\n");
  writeFile(t, "mobile/features/return/ReturnStatusSheet.tsx", "export const y = 2;\n");
  // two sessions each own a disjoint plan file; coverage is split across them
  writeFile(
    t,
    ".agents/qa-plans/F-003.md",
    "## Coverage map\n- components/LendingActionDrawers.tsx -> test:quick::return\n\n## Waivers\n"
  );
  writeFile(
    t,
    ".agents/qa-plans/F-035.md",
    "## Coverage map\n- mobile/features/return/ReturnStatusSheet.tsx -> test:quick::return\n\n## Waivers\n"
  );

  const r = runQaPlanGate(t);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /RESULT: green/);
  // both files were consulted
  assert.match(r.out, /F-003\.md/);
  assert.match(r.out, /F-035\.md/);
});

test("test:qa-plan still reads the legacy .agents/memory/qa-plan.md (backward compat)", async () => {
  const t = await scaffoldGatedTarget();
  writeFile(t, ".agents/memory/flow-map.md", "# Flow map\n");
  writeFile(t, "components/LendingActionDrawers.tsx", "export const x = 1;\n");
  writeFile(
    t,
    ".agents/memory/qa-plan.md",
    "## Coverage map\n- components/LendingActionDrawers.tsx -> test:quick::return\n\n## Waivers\n"
  );

  const r = runQaPlanGate(t);
  assert.strictEqual(r.status, 0, r.out);
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

// ---------------------------------------------------------------- environments (dev / uat / prod)

test("environments memory scaffold is deployed and preserved on re-deploy", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });

  const p = path.join(target, ".agents", "memory", "environments.md");
  assert.ok(exists(p), "environments scaffold created");
  const src = read(p);
  assert.match(src, /development/);
  assert.match(src, /uat/);
  assert.match(src, /production/);
  assert.match(src, /DATABASE_URL_UAT/);
  assert.match(src, /deploy:uat/);

  fs.writeFileSync(p, "| uat | https://uat.example | custom\n", "utf8");
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: true });
  assert.strictEqual(read(p), "| uat | https://uat.example | custom\n", "project environments.md preserved");
});

test("rules encode the environment data boundary + deploy-to-UAT finalize step", () => {
  const rules = read(path.join(h.TEMPLATES_DIR, ".agents", "rules", "00-operating.md"));
  assert.match(rules, /never dump\/restore data across environments/);
  assert.match(rules, /deploy:uat/);
  assert.match(rules, /test:data-hygiene/);
  assert.match(rules, /environments\.md/);

  const rulebook = read(path.join(h.TEMPLATES_DIR, ".agents", "AGENTS.md"));
  assert.match(rulebook, /Deploy to UAT/);
  assert.match(rulebook, /no `pg_dump`\/restore\/copy/);
  assert.match(rulebook, /environments\.md/);
});

test("devops-engineer skill owns environment promotion discipline", () => {
  const skill = read(path.join(h.TEMPLATES_DIR, ".agents", "skills", "devops-engineer", "SKILL.md"));
  assert.match(skill, /Environment promotion/);
  assert.match(skill, /deploy:uat/);
  assert.match(skill, /prisma migrate deploy/);
  assert.match(skill, /never.*dump\/restore a database across environments/);
});

// ---------------------------------------------------------------- test:backlog gate + migration

function scaffoldBacklogTarget(backlogContent) {
  const target = tmpdir();
  fs.mkdirSync(path.join(target, "scripts", "qa"), { recursive: true });
  fs.copyFileSync(
    path.join(h.TEMPLATES_DIR, "scripts", "qa", "check-backlog.js"),
    path.join(target, "scripts", "qa", "check-backlog.js")
  );
  copyBoardLib(target);
  fs.writeFileSync(path.join(target, "BACKLOG.md"), backlogContent, "utf8");
  return target;
}

function runBacklogGate(target) {
  const res = spawnSync(process.execPath, ["scripts/qa/check-backlog.js"], { cwd: target, encoding: "utf8" });
  return { status: res.status, out: (res.stdout || "") + (res.stderr || "") };
}

const VALID_BACKLOG = `# BACKLOG — canonical task list

## Epics

| Key | Label | Goal |
|-----|-------|------|
| flow | Flow | Flow work |

## Active / next

- Next picks: **F-003** (P2).

## In progress

Active work.

| ID | Epic | Task | Handoff |
|----|------|------|---------|
| F-005 | flow | being worked | .agents/handoffs/F-005.md |

## Queued

Sorted by priority (P1 → P4).

| ID | P | Epic | Task | Evidence |
|----|---|------|------|----------|

## Open

Sorted by priority (P1 → P4).

| ID | P | Epic | Task | Evidence |
|----|---|------|------|----------|
| F-001 | P1 | flow | block something | user report |
| F-003 | P2 | flow | do a thing | file.ts |

## Frozen

Parked, not deleted.

| ID | Epic | Task | Why frozen / reopen when |
|----|------|------|--------------------------|
| F-002 | flow | parked task | superseded; reopen if it recurs |

## Archive (shipped · done)

| ID | Epic | Task | Closed |
|----|------|------|--------|
| F-004 | flow | done task | shipped 2026-08-30 |

## Not tracking (leave-in-place, no action)

Nothing noted.
`;

test("test:backlog passes a well-formed board", () => {
  const t = scaffoldBacklogTarget(VALID_BACKLOG);
  const r = runBacklogGate(t);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /RESULT: backlog green/);
});

test("test:backlog fails on illegal priority, blank evidence, frozen-without-reopen, duplicate ID", () => {
  const t = scaffoldBacklogTarget(`# BACKLOG — canonical task list

## Epics

| Key | Label | Goal |
|-----|-------|------|
| flow | Flow | Flow work |

## Open

| ID | P | Epic | Task | Evidence |
|----|---|------|------|----------|
| F-001 | P9 | flow | bad priority | ev |
| F-002 | P3 | flow | no evidence | |
| F-003 |  | flow | blank priority | ev |

## Frozen

| ID | Epic | Task | Why frozen / reopen when |
|----|------|------|--------------------------|
| F-004 | flow | no reopen | |

## Archive (shipped · done)

| ID | Epic | Task | Closed |
|----|------|------|--------|
| F-001 | flow | duplicate of F-001 | x |
`);
  const r = runBacklogGate(t);
  assert.strictEqual(r.status, 1, "gate must fail on malformed board");
  assert.match(r.out, /not in \{P1,P2,P3,P4\}/);
  assert.match(r.out, /evidence must not be blank/);
  assert.match(r.out, /priority must not be blank/);
  assert.match(r.out, /frozen row F-004.*reopen/i);
  assert.match(r.out, /duplicate ID/);
});

test("test:backlog fails on a blank in-progress task or handoff", () => {
  const t = scaffoldBacklogTarget(`# BACKLOG — canonical task list

## In progress

| ID | Epic | Task | Handoff |
|----|------|------|---------|
| F-010 | ? | | .agents/handoffs/F-010.md |
| F-011 | ? | doing it | |
`);
  const r = runBacklogGate(t);
  assert.strictEqual(r.status, 1, "gate must fail on blank in-progress cells");
  assert.match(r.out, /in-progress row F-010: task must not be blank/);
  assert.match(r.out, /in-progress row F-011: handoff must not be blank/);
});

test("test:backlog fails on a duplicate ID spanning In progress and Open", () => {
  const t = scaffoldBacklogTarget(`# BACKLOG — canonical task list

## In progress

| ID | Epic | Task | Handoff |
|----|------|------|---------|
| F-020 | ? | being worked | .agents/handoffs/F-020.md |

## Open

| ID | P | Epic | Task | Evidence |
|----|---|------|------|----------|
| F-020 | P2 | ? | also open | ev |
`);
  const r = runBacklogGate(t);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /duplicate ID `F-020`/);
});

test("test:backlog passes a board with only an In progress section", () => {
  const t = scaffoldBacklogTarget(`# BACKLOG — canonical task list

## In progress

| ID | Epic | Task | Handoff |
|----|------|------|---------|
| F-030 | ? | being worked | ? |
`);
  const r = runBacklogGate(t);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /RESULT: backlog green/);
});

test("test:backlog fails when INDEX.md is a live list instead of a pointer", () => {
  const t = scaffoldBacklogTarget(VALID_BACKLOG);
  fs.mkdirSync(path.join(t, ".agents", "features"), { recursive: true });
  fs.writeFileSync(path.join(t, ".agents", "features", "INDEX.md"), "| F-001 | live row | P1 | ev | backlog |\n", "utf8");
  const r = runBacklogGate(t);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /looks like a live list/);
});

test("test:backlog fails when BACKLOG.md is untracked in a git repo", () => {
  const t = scaffoldBacklogTarget(VALID_BACKLOG);
  git(t, ["init", "-q"]);
  git(t, ["config", "user.email", "t@t.t"]);
  git(t, ["config", "user.name", "t"]);
  // BACKLOG.md deliberately left untracked — the board can't sync across sessions
  const r = runBacklogGate(t);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /git-tracked/);
});

test("test:backlog passes when BACKLOG.md is committed", () => {
  const t = scaffoldBacklogTarget(VALID_BACKLOG);
  git(t, ["init", "-q"]);
  git(t, ["config", "user.email", "t@t.t"]);
  git(t, ["config", "user.name", "t"]);
  git(t, ["add", "BACKLOG.md"]);
  git(t, ["commit", "-q", "-m", "seed"]);
  const r = runBacklogGate(t);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /RESULT: backlog green/);
});

test("test:backlog reports an over-wide row honestly instead of a shifted-cell error", () => {
  // F-127 evidence: an unescaped `|` in a cell split one logical row into extra
  // cells; the old parser then surfaced a *shifted* cell as a bogus "depends on
  // unknown row NNN". The gate must name the real defect.
  const corrupt = VALID_BACKLOG.replace(
    "| F-003 | P2 | flow | do a thing | file.ts |",
    "| F-003 | P2 | flow | do a thing | extra | file.ts |"
  );
  const t = scaffoldBacklogTarget(corrupt);
  const r = runBacklogGate(t);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /F-003.*has 6 cells, expected 5/);
  assert.doesNotMatch(r.out, /depends on unknown row/, "no misleading shifted-cell error");
});

test("board row primitives live in one shared module (no duplicated splitCells)", () => {
  // P4 one-home-per-fact: the four board scripts must import from board-lib.js,
  // not each carry a private splitCells copy that drifts (F-094 was reverted in a
  // deployed copy precisely because the fix lived in only one of several copies).
  const scripts = [
    ["scripts", "backlog.js"],
    ["scripts", "qa", "check-backlog.js"],
    ["scripts", "qa", "check-concurrency.js"],
    ["scripts", "qa", "merge-backlog.js"],
  ];
  const boardLib = read(path.join(h.TEMPLATES_DIR, "scripts", "qa", "board-lib.js"));
  assert.match(boardLib, /function splitCells/, "board-lib ships the canonical splitCells");
  assert.match(boardLib, /function formatRow/, "board-lib ships the escaping formatRow");
  for (const segs of scripts) {
    const src = read(path.join(h.TEMPLATES_DIR, ...segs));
    assert.doesNotMatch(src, /function splitCells\s*\(/, `${segs.join("/")} must not redefine splitCells`);
    assert.match(src, /board-lib\.js/, `${segs.join("/")} imports the shared board-lib`);
  }
  const backlogSrc = read(path.join(h.TEMPLATES_DIR, "scripts", "backlog.js"));
  assert.doesNotMatch(backlogSrc, /function formatRow\s*\(/, "backlog.js must not redefine formatRow");
});

test("migrate-backlog consolidates INDEX.md F-rows and todo.md items into BACKLOG.md", () => {
  const target = tmpdir();
  fs.mkdirSync(path.join(target, ".agents", "features"), { recursive: true });
  fs.mkdirSync(path.join(target, ".agents", "memory"), { recursive: true });
  fs.writeFileSync(
    path.join(target, ".agents", "features", "INDEX.md"),
    [
      "# Features — backlog",
      "",
      "| ID | Item | Priority | Context | Status |",
      "|----|------|----------|---------|--------|",
      "| F-001 | block something | P1 | user report | backlog |",
      "| F-002 | parked task | P3 | superseeded note | frozen |",
      "| F-003 | done task | P2 | commit abc | shipped |",
      "",
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(target, ".agents", "memory", "todo.md"),
    "- Sprint 1: onboarding polish\n- follow-up: verify NLI timeout\n",
    "utf8"
  );

  const summary = h.migrateBacklog(target);

  assert.strictEqual(summary.open, 3, "F-001 + 2 todo items land in Open");
  assert.strictEqual(summary.frozen, 1, "frozen row preserved");
  assert.strictEqual(summary.archived, 1, "shipped row archived");

  const backlog = read(path.join(target, "BACKLOG.md"));
  assert.ok(backlog.includes("F-001"), "F-001 migrated");
  assert.ok(backlog.includes("F-002"), "F-002 (frozen) migrated");
  assert.ok(backlog.includes("F-003"), "F-003 (shipped) archived");
  assert.ok(backlog.includes("T-001"), "todo list item migrated as a stable T-xxx row");

  assert.match(read(path.join(target, ".agents", "features", "INDEX.md")), /BACKLOG\.md/, "INDEX rewritten as pointer");
  assert.match(read(path.join(target, ".agents", "memory", "todo.md")), /BACKLOG\.md/, "todo.md rewritten as pointer");
});

test("migrate-backlog is idempotent and never merges into a populated board", () => {
  const target = tmpdir();
  fs.mkdirSync(path.join(target, ".agents", "features"), { recursive: true });
  fs.writeFileSync(
    path.join(target, ".agents", "features", "INDEX.md"),
    "| ID | Item | Priority | Context | Status |\n|---|---|---|---|---|\n| F-009 | stray row | P3 | ev | backlog |\n",
    "utf8"
  );

  h.migrateBacklog(target);
  const first = read(path.join(target, "BACKLOG.md"));

  // re-run: board is populated, so nothing is merged again
  const summary2 = h.migrateBacklog(target);
  assert.ok(summary2.skipped, "second run is a no-op");
  assert.strictEqual(read(path.join(target, "BACKLOG.md")), first, "BACKLOG.md unchanged on re-run");
});

test("migrate-backlog maps in-progress/testing INDEX rows into the In progress section", () => {
  const target = tmpdir();
  fs.mkdirSync(path.join(target, ".agents", "features"), { recursive: true });
  fs.writeFileSync(
    path.join(target, ".agents", "features", "INDEX.md"),
    [
      "# Features — backlog",
      "",
      "| ID | Item | Priority | Context | Status |",
      "|----|------|----------|---------|--------|",
      "| F-010 | mid-flight work | P2 | .agents/handoffs/F-010.md | in-progress |",
      "| F-011 | under test | P3 | ev | testing |",
      "",
    ].join("\n"),
    "utf8"
  );

  const summary = h.migrateBacklog(target);
  assert.strictEqual(summary.inprogress, 2, "two in-progress rows migrated");

  const backlog = read(path.join(target, "BACKLOG.md"));
  assert.match(backlog, /## In progress/);
  assert.match(backlog, /\| F-010 \| \? \| mid-flight work \| \.agents\/handoffs\/F-010\.md \|/);
  assert.match(backlog, /\| F-011 \| \? \| under test \| ev \|/);
});

// ---------------------------------------------------------------- test:product gate

function scaffoldProductTarget() {
  const target = tmpdir();
  fs.mkdirSync(path.join(target, "scripts", "qa"), { recursive: true });
  fs.copyFileSync(
    path.join(h.TEMPLATES_DIR, "scripts", "qa", "check-product.js"),
    path.join(target, "scripts", "qa", "check-product.js")
  );
  return target;
}

function runProductGate(target) {
  const res = spawnSync(process.execPath, ["scripts/qa/check-product.js"], {
    cwd: target,
    encoding: "utf8",
  });
  return { status: res.status, out: (res.stdout || "") + (res.stderr || "") };
}

function writeFeature(target, slug, files) {
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(target, ".agents", "features", slug, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, "utf8");
  }
}

const VALID_INTENT = `status: proposed
## Actor(s)
- community member
## Need
- wants to return an item with one tap
## Outcome
- item is returned without friction
## Acceptance criteria
- a Return CTA is visible on the item and completing it marks the item returned
`;

const VALID_PLAN = `status: planned
## Value-first sequence
- 1. ship the Return CTA (serves the community member's one-tap return outcome)
- 2. wire the return API (serves the same outcome)
## Product concepts applied
- one-tap primary actions
- the 5 UI states
`;

test("test:product passes when there are no feature docs", () => {
  const t = scaffoldProductTarget();
  const r = runProductGate(t);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /green \(no feature docs\)/);
});

test("test:product fails a plan with no intent (tech-first)", () => {
  const t = scaffoldProductTarget();
  writeFeature(t, "return", { "plan.md": VALID_PLAN });
  const r = runProductGate(t);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /plan\.md but no intent\.md/);
});

test("test:product fails an intent missing a product section", () => {
  const t = scaffoldProductTarget();
  writeFeature(t, "return", {
    "intent.md": VALID_INTENT.replace(/## Outcome[\s\S]*$/, ""),
  });
  const r = runProductGate(t);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /missing product section/);
  assert.match(r.out, /## Outcome/);
});

test("test:product fails a plan missing value-led sections", () => {
  const t = scaffoldProductTarget();
  writeFeature(t, "return", { "intent.md": VALID_INTENT, "plan.md": "## Value-first sequence\n- step one\n" });
  const r = runProductGate(t);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /## Product concepts applied/);
});

test("test:product passes a complete intent + value-led plan", () => {
  const t = scaffoldProductTarget();
  writeFeature(t, "return", { "intent.md": VALID_INTENT, "plan.md": VALID_PLAN });
  const r = runProductGate(t);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /RESULT: green/);
});

test("product-principles memory scaffold is deployed and preserved on re-deploy", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });
  const p = path.join(target, ".agents", "memory", "product-principles.md");
  assert.ok(exists(p), "product-principles scaffold created");

  fs.writeFileSync(p, "## Actors\n- my custom actor\n", "utf8");
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: true });
  assert.strictEqual(read(p), "## Actors\n- my custom actor\n", "project product-principles preserved");
});

test("planner is product-first: reads product-principles and sequences value-first", () => {
  const skill = read(path.join(h.TEMPLATES_DIR, ".agents", "skills", "planner", "SKILL.md"));
  assert.match(skill, /product-principles\.md/);
  assert.match(skill, /Value-first sequence/);
  assert.match(skill, /Product concepts applied/);
  assert.match(skill, /smallest slice/);
  const agent = read(path.join(h.TEMPLATES_DIR, ".opencode", "agents", "planner.md"));
  assert.match(agent, /product-first/);
});

test("check-product.js is deployed to every project", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });
  assert.ok(exists(path.join(target, "scripts", "qa", "check-product.js")), "test:product gate deployed");
});

// ---------------------------------------------------------------- test:governance gate (sharded handoffs)

function scaffoldGovernanceTarget() {
  const target = tmpdir();
  fs.mkdirSync(path.join(target, "scripts", "qa"), { recursive: true });
  fs.copyFileSync(
    path.join(h.TEMPLATES_DIR, "scripts", "qa", "governance.js"),
    path.join(target, "scripts", "qa", "governance.js")
  );
  fs.mkdirSync(path.join(target, ".agents", "handoffs"), { recursive: true });
  return target;
}

function runGovernanceGate(target) {
  const res = spawnSync(process.execPath, ["scripts/qa/governance.js"], {
    cwd: target,
    encoding: "utf8",
  });
  return { status: res.status, out: (res.stdout || "") + (res.stderr || "") };
}

test("test:governance passes a valid sharded handoff", () => {
  const t = scaffoldGovernanceTarget();
  writeFile(
    t,
    ".agents/handoffs/F-003.md",
    "# Where we stopped — F-003\n\n## Dispatch log\n- qa-architect -> opencode/gpt-5-nano -> shipped\n\n## Done this session\n- x\n"
  );
  const r = runGovernanceGate(t);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /governance green/);
});

test("test:governance is fatal when no handoff files exist", () => {
  const t = scaffoldGovernanceTarget();
  const r = runGovernanceGate(t);
  assert.strictEqual(r.status, 2, r.out);
  assert.match(r.out, /missing session handoff/);
});

test("test:governance requires every sharded handoff to open with a dispatch-log entry", () => {
  const t = scaffoldGovernanceTarget();
  writeFile(t, ".agents/handoffs/F-003.md", "# x\n\n## Dispatch log\n- qa-architect -> m -> shipped\n");
  writeFile(t, ".agents/handoffs/F-035.md", "# y\n\n## Dispatch log\n\n## Done\n- z\n");
  const r = runGovernanceGate(t);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /F-035\.md/);
  assert.match(r.out, /at least one entry/);
});

test("test:governance fails a waiver without a reason", () => {
  const t = scaffoldGovernanceTarget();
  writeFile(
    t,
    ".agents/handoffs/F-003.md",
    "# x\n\n## Dispatch log\n- qa-architect -> m -> shipped\n\n## Waivers\n- waived: src/foo.ts\n"
  );
  const r = runGovernanceGate(t);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /reason/);
});

test("test:governance unions multiple sharded handoffs and still reads the legacy file", () => {
  const t = scaffoldGovernanceTarget();
  writeFile(t, ".agents/handoffs/F-003.md", "# a\n\n## Dispatch log\n- x -> y -> shipped\n");
  writeFile(t, ".agents/handoffs/F-035.md", "# b\n\n## Dispatch log\n- p -> q -> shipped\n");
  writeFile(t, ".agents/memory/handoff.md", "# legacy\n\n## Dispatch log\n- old -> model -> shipped\n");
  const r = runGovernanceGate(t);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /F-003\.md/);
  assert.match(r.out, /F-035\.md/);
  assert.match(r.out, /memory[\\/]handoff\.md/);
});

test("test:governance accepts a table-format dispatch log (data rows, not the header)", () => {
  const t = scaffoldGovernanceTarget();
  writeFile(
    t,
    ".agents/handoffs/F-060.md",
    "# Where we stopped — F-060\n\n## Dispatch log\n\n" +
      "| Subagent | Model | Shipped / deferred |\n" +
      "|---|---|---|\n" +
      "| product-manager | deepseek/deepseek-v4-pro | shipped intent.md |\n" +
      "| qa-architect | deepseek/deepseek-v4-pro | shipped tests.md |\n\n" +
      "## Done\n- x\n"
  );
  const r = runGovernanceGate(t);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /governance green/);
});

test("test:governance still fails a table dispatch log with a header but no data rows", () => {
  const t = scaffoldGovernanceTarget();
  writeFile(
    t,
    ".agents/handoffs/F-060.md",
    "# x\n\n## Dispatch log\n\n| Subagent | Model | Shipped / deferred |\n|---|---|---|\n\n## Done\n- z\n"
  );
  const r = runGovernanceGate(t);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /at least one entry/);
});

// ---------------------------------------------------------------- test:concurrency gate (working-tree isolation)

function scaffoldConcurrencyTarget() {
  const target = tmpdir();
  fs.mkdirSync(path.join(target, "scripts", "qa"), { recursive: true });
  fs.copyFileSync(
    path.join(h.TEMPLATES_DIR, "scripts", "qa", "check-concurrency.js"),
    path.join(target, "scripts", "qa", "check-concurrency.js")
  );
  copyBoardLib(target);
  git(target, ["init", "-q"]);
  git(target, ["config", "user.email", "t@t.t"]);
  git(target, ["config", "user.name", "t"]);
  return target;
}

function runConcurrencyGate(target) {
  const res = spawnSync(process.execPath, ["scripts/qa/check-concurrency.js"], {
    cwd: target,
    encoding: "utf8",
  });
  return { status: res.status, out: (res.stdout || "") + (res.stderr || "") };
}

function backlogWithInProgress(ids) {
  const rows = ids.map((id) => `| ${id} | task | .agents/handoffs/${id}.md |`).join("\n");
  return `# BACKLOG\n\n## In progress\n\n| ID | Task | Handoff |\n|----|------|---------|\n${rows}\n`;
}

test("test:concurrency passes a clean working tree", () => {
  const t = scaffoldConcurrencyTarget();
  writeFile(t, "BACKLOG.md", backlogWithInProgress(["F-044", "F-060"]));
  git(t, ["add", "-A"]);
  git(t, ["commit", "-q", "-m", "seed"]);
  const r = runConcurrencyGate(t);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /working tree clean/);
});

test("test:concurrency fails when 2+ sessions are In progress with a dirty tree", () => {
  const t = scaffoldConcurrencyTarget();
  writeFile(t, "BACKLOG.md", backlogWithInProgress(["F-044", "F-060"]));
  git(t, ["add", "-A"]);
  git(t, ["commit", "-q", "-m", "seed"]);
  writeFile(t, "app/foo.tsx", "t('development.loadFailed')\n"); // concurrent session's WIP
  const r = runConcurrencyGate(t);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /sessions are In progress/);
  assert.match(r.out, /uncommitted/);
  assert.match(r.out, /F-044/);
  assert.match(r.out, /F-060/);
});

test("test:concurrency warns (exit 0) when a single session is In progress with a dirty tree", () => {
  const t = scaffoldConcurrencyTarget();
  writeFile(t, "BACKLOG.md", backlogWithInProgress(["F-044"]));
  git(t, ["add", "-A"]);
  git(t, ["commit", "-q", "-m", "seed"]);
  writeFile(t, "app/foo.tsx", "// my own WIP\n");
  const r = runConcurrencyGate(t);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /1 session In progress/);
});

test("test:concurrency warns (exit 0) on a dirty tree with no In progress rows", () => {
  const t = scaffoldConcurrencyTarget();
  writeFile(t, "BACKLOG.md", "# BACKLOG\n\n## In progress\n\n| ID | Task | Handoff |\n|----|------|---------|\n\n");
  git(t, ["add", "-A"]);
  git(t, ["commit", "-q", "-m", "seed"]);
  writeFile(t, "stray.js", "// unowned\n");
  const r = runConcurrencyGate(t);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /no In progress rows/);
});

// ---------------------------------------------------------------- run-clean snapshot wrapper

function scaffoldRunCleanTarget() {
  const target = tmpdir();
  fs.mkdirSync(path.join(target, "scripts", "qa"), { recursive: true });
  fs.copyFileSync(
    path.join(h.TEMPLATES_DIR, "scripts", "qa", "run-clean.js"),
    path.join(target, "scripts", "qa", "run-clean.js")
  );
  git(target, ["init", "-q"]);
  git(target, ["config", "user.email", "t@t.t"]);
  git(target, ["config", "user.name", "t"]);
  writeFile(target, "tracked.txt", "committed\n");
  git(target, ["add", "-A"]);
  git(target, ["commit", "-q", "-m", "seed"]);
  return target;
}

function commitGate(target, gateContent) {
  writeFile(target, "gate.js", gateContent);
  git(target, ["add", "gate.js"]);
  git(target, ["commit", "-q", "-m", "add gate"]);
}

function runClean(target, args) {
  const res = spawnSync(process.execPath, ["scripts/qa/run-clean.js", ...args], {
    cwd: target,
    encoding: "utf8",
  });
  return { status: res.status, out: (res.stdout || "") + (res.stderr || "") };
}

test("run-clean stashes a dirty tree so the gate verifies committed state, then restores", () => {
  const t = scaffoldRunCleanTarget();
  commitGate(t, "process.exit(require('fs').existsSync('dirty.txt') ? 7 : 0);\n");
  writeFile(t, "dirty.txt", "uncommitted\n");
  const r = runClean(t, ["--", "node", "gate.js"]);
  assert.strictEqual(r.status, 0, r.out);
  assert.ok(exists(path.join(t, "dirty.txt")), "dirty file restored after the run");
});

test("run-clean propagates the gate's exit code and still restores the tree", () => {
  const t = scaffoldRunCleanTarget();
  commitGate(t, "process.exit(5);\n");
  writeFile(t, "dirty.txt", "uncommitted\n");
  const r = runClean(t, ["--", "node", "gate.js"]);
  assert.strictEqual(r.status, 5, r.out);
  assert.ok(exists(path.join(t, "dirty.txt")), "dirty file restored even when the gate fails");
});

test("run-clean runs in place when the tree is already clean", () => {
  const t = scaffoldRunCleanTarget();
  commitGate(t, "process.exit(0);\n");
  const r = runClean(t, ["--", "node", "gate.js"]);
  assert.strictEqual(r.status, 0, r.out);
});

// ---------------------------------------------------------------- backlog worktree isolation

test("backlog worktree isolates a feature into a git worktree + branch and records it", () => {
  const t = scaffoldBacklogCliTarget();
  git(t, ["init", "-q"]);
  git(t, ["config", "user.email", "t@t.t"]);
  git(t, ["config", "user.name", "t"]);
  git(t, ["add", "-A"]);
  git(t, ["commit", "-q", "-m", "seed"]);

  assert.strictEqual(runBacklogCli(t, ["add", "isolate me", "--p", "P2"]).status, 0);

  const suffix = path.basename(t);
  const branch = `b-${suffix}`;
  const dir = path.join(os.tmpdir(), `wt-${suffix}`);
  const r = runBacklogCli(t, ["worktree", "F-001", "--branch", branch, "--dir", dir]);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /isolated F-001/);

  assert.ok(exists(dir), "worktree directory created");
  assert.match(git(t, ["branch", "--list", branch]), new RegExp(branch), "feature branch created");

  const b = read(path.join(t, "BACKLOG.md"));
  assert.match(b.split("## In progress")[1].split("## Open")[0], new RegExp(`worktree: .*; branch: ${branch}`));
});

test("backlog worktree fails cleanly on an unknown row", () => {
  const t = scaffoldBacklogCliTarget();
  const r = runBacklogCli(t, ["worktree", "F-999"]);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /no row F-999/);
});

test("backlog worktree defaults to a .worktrees/<repo>/<slug> container, not a repo sibling", () => {
  const t = scaffoldBacklogCliTarget();
  git(t, ["init", "-q"]);
  git(t, ["config", "user.email", "t@t.t"]);
  git(t, ["config", "user.name", "t"]);
  git(t, ["add", "-A"]);
  git(t, ["commit", "-q", "-m", "seed"]);

  assert.strictEqual(runBacklogCli(t, ["add", "isolate me", "--p", "P2"]).status, 0);

  const r = runBacklogCli(t, ["worktree", "F-001"]);
  assert.strictEqual(r.status, 0, r.out);

  const parent = path.dirname(t);
  const expected = path.join(parent, ".worktrees", path.basename(t), "f-001");
  assert.ok(exists(expected), `worktree created under ${expected}`);
  assert.ok(!exists(path.join(parent, "f-001")), "no sibling folder pollutes the parent");

  const b = read(path.join(t, "BACKLOG.md"));
  assert.match(b.split("## In progress")[1].split("## Open")[0], /worktree: .*\.worktrees.*; branch: f-001/);
});

test("backlog archive removes the shipped feature's worktree", () => {
  const t = scaffoldBacklogCliTarget();
  git(t, ["init", "-q"]);
  git(t, ["config", "user.email", "t@t.t"]);
  git(t, ["config", "user.name", "t"]);
  git(t, ["add", "-A"]);
  git(t, ["commit", "-q", "-m", "seed"]);

  assert.strictEqual(runBacklogCli(t, ["add", "isolate me", "--p", "P2"]).status, 0);

  const suffix = path.basename(t);
  const branch = `b-${suffix}`;
  const dir = path.join(os.tmpdir(), `wt-${suffix}`);
  assert.strictEqual(runBacklogCli(t, ["worktree", "F-001", "--branch", branch, "--dir", dir]).status, 0);
  assert.ok(exists(dir), "worktree created");

  const a = runBacklogCli(t, ["archive", "F-001"]);
  assert.strictEqual(a.status, 0, a.out);
  assert.ok(!exists(dir), "worktree directory removed on archive");
  assert.match(a.out, /removed worktree/);
});

test("test:concurrency + run-clean are deployed and auto-wired", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });

  assert.ok(exists(path.join(target, "scripts", "qa", "check-concurrency.js")), "check-concurrency.js deployed");
  assert.ok(exists(path.join(target, "scripts", "qa", "run-clean.js")), "run-clean.js deployed");

  const pkg = JSON.parse(read(path.join(target, "package.json")));
  assert.strictEqual(pkg.scripts["test:concurrency"], "node scripts/qa/check-concurrency.js");

  const tools = read(path.join(target, ".opencode", "tools", "backlog.ts"));
  assert.match(tools, /export const worktree\b/, "backlog_worktree tool deployed");
  assert.match(tools, /worktree/, "worktree tool shells out to the CLI");
});

// ---------------------------------------------------------------- row-aware merge driver

const MB = path.join(h.TEMPLATES_DIR, "scripts", "qa", "merge-backlog.js");
const mb = require(MB);

function board({ open = [], queued = [], inprogress = [], frozen = [], archive = [] }) {
  const t = (hdr, rows) =>
    "| " + hdr.join(" | ") + " |\n|" + hdr.map(() => "---").join("|") + "|\n" +
    (rows.length ? rows.join("\n") : "");
  return [
    "# BACKLOG — canonical task list",
    "",
    "## Epics",
    "",
    t(["Key", "Label", "Goal"], []),
    "",
    "## In progress",
    "",
    t(["ID", "Epic", "Task", "Handoff"], inprogress),
    "",
    "## Queued",
    "",
    t(["ID", "P", "Epic", "Task", "Evidence", "Depends on"], queued),
    "",
    "## Open",
    "",
    t(["ID", "P", "Epic", "Task", "Evidence", "Depends on"], open),
    "",
    "## Frozen",
    "",
    t(["ID", "Epic", "Task", "Why frozen / reopen when"], frozen),
    "",
    "## Archive (shipped · done)",
    "",
    t(["ID", "Epic", "Task", "Closed"], archive),
    "",
    "## Not tracking (leave-in-place, no action)",
    "",
  ].join("\n");
}

function runMergeDriver(dir, base, ours, theirs) {
  const baseP = path.join(dir, "base.md");
  const oursP = path.join(dir, "ours.md");
  const theirsP = path.join(dir, "theirs.md");
  fs.writeFileSync(baseP, base, "utf8");
  fs.writeFileSync(oursP, ours, "utf8");
  fs.writeFileSync(theirsP, theirs, "utf8");
  const res = spawnSync(process.execPath, [MB, baseP, oursP, theirsP], { encoding: "utf8" });
  return { status: res.status, out: read(oursP), err: (res.stderr || "") + (res.stdout || "") };
}

test("merge-backlog resolves disjoint row moves (take + archive) by ID", () => {
  const base = board({ open: ["| F-001 | P1 | ? | a | ev | ? |", "| F-002 | P2 | ? | b | ev | ? |"] });
  const ours = board({ open: ["| F-002 | P2 | ? | b | ev | ? |"], inprogress: ["| F-001 | ? | a | .agents/handoffs/F-001.md |"] });
  const theirs = board({ open: ["| F-001 | P1 | ? | a | ev | ? |"], archive: ["| F-002 | ? | b | shipped |"] });

  const { resolved, conflicts } = mb.merge(base, ours, theirs);
  assert.strictEqual(conflicts.length, 0);
  assert.strictEqual(resolved.get("F-001").section, "inprogress");
  assert.strictEqual(resolved.get("F-002").section, "archive");

  const out = mb.rebuild(ours, resolved);
  assert.strictEqual((out.match(/\| F-001 \|/g) || []).length, 1, "F-001 appears exactly once");
  assert.strictEqual((out.match(/\| F-002 \|/g) || []).length, 1, "F-002 appears exactly once");
  assert.match(out.split("## In progress")[1].split("## Queued")[0], /\| F-001 \| \? \| a \| \.agents\/handoffs\/F-001\.md \|/);
  assert.match(out.split("## Archive")[1], /\| F-002 \| \? \| b \| shipped \|/);
});

test("merge-backlog keeps a row once when only one side moved it (no union duplicate)", () => {
  const base = board({ open: ["| F-001 | P1 | ? | a | ev | ? |"] });
  const ours = board({ open: [], inprogress: ["| F-001 | ? | a | .agents/handoffs/F-001.md |"] });
  const theirs = board({ open: ["| F-001 | P1 | ? | a | ev | ? |"] }); // unchanged

  const { resolved, conflicts } = mb.merge(base, ours, theirs);
  assert.strictEqual(conflicts.length, 0);
  assert.strictEqual(resolved.get("F-001").section, "inprogress");
  const out = mb.rebuild(ours, resolved);
  assert.strictEqual((out.match(/\| F-001 \|/g) || []).length, 1, "no duplicate row");
});

test("merge-backlog exits 1 with conflict markers when both sides change the same row", () => {
  const base = board({ open: ["| F-001 | P3 | ? | a | ev | ? |"] });
  const ours = board({ open: ["| F-001 | P1 | ? | a | ev | ? |"] });
  const theirs = board({ open: ["| F-001 | P2 | ? | a | ev | ? |"] });

  const r = runMergeDriver(tmpdir(), base, ours, theirs);
  assert.strictEqual(r.status, 1, r.err);
  assert.match(r.out, /<<<<<<< ours/);
  assert.match(r.out, /=======/);
  assert.match(r.out, /P1/);
  assert.match(r.out, /P2/);
});

test("deploy merges .gitattributes + registers the row-aware merge driver", async () => {
  const target = tmpdir();
  git(target, ["init", "-q"]);
  git(target, ["config", "user.email", "t@t.t"]);
  git(target, ["config", "user.name", "t"]);
  git(target, ["commit", "--allow-empty", "-q", "-m", "seed"]);
  fs.writeFileSync(path.join(target, ".gitattributes"), "* text=auto\n", "utf8");

  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });

  const ga = read(path.join(target, ".gitattributes"));
  assert.ok(ga.includes("* text=auto"), "project .gitattributes entry preserved");
  assert.match(ga, /# agent-harness \(managed below\)/);
  assert.ok(ga.includes("BACKLOG.md merge=backlog-demo"), "merge attribute merged with a per-project driver name");

  const driver = git(target, ["config", "--get", "merge.backlog-demo.driver"]);
  assert.ok(driver && driver.includes("merge-backlog.js"), "merge driver registered in local git config: " + driver);

  await h.deploy(target, { name: "Demo", yes: true, isUpdate: true });
  const ga2 = read(path.join(target, ".gitattributes"));
  assert.strictEqual((ga2.match(/# agent-harness \(managed below\)/g) || []).length, 1, "marker not duplicated");
});

test("nested harness projects get distinct merge-driver names that don't clobber each other", async () => {
  const target = tmpdir();
  git(target, ["init", "-q"]);
  git(target, ["config", "user.email", "t@t.t"]);
  git(target, ["config", "user.name", "t"]);
  git(target, ["commit", "--allow-empty", "-q", "-m", "seed"]);

  const nested = path.join(target, "mobile");
  fs.mkdirSync(nested);

  await h.deploy(target, { name: "RootApp", yes: true, isUpdate: false });
  await h.deploy(nested, { name: "MobileApp", yes: true, isUpdate: false });

  const rootGa = read(path.join(target, ".gitattributes"));
  const nestedGa = read(path.join(nested, ".gitattributes"));
  assert.ok(rootGa.includes("BACKLOG.md merge=backlog-rootapp"), "root driver name is project-scoped");
  assert.ok(nestedGa.includes("BACKLOG.md merge=backlog-mobileapp"), "nested driver name is project-scoped");

  // both driver registrations survive side-by-side in the one shared git config
  const rootDriver = git(target, ["config", "--get", "merge.backlog-rootapp.driver"]);
  const nestedDriver = git(target, ["config", "--get", "merge.backlog-mobileapp.driver"]);
  assert.ok(rootDriver && rootDriver.includes("merge-backlog.js"), "root driver registered");
  assert.ok(nestedDriver && nestedDriver.includes("merge-backlog.js"), "nested driver registered");
  assert.notStrictEqual(rootDriver, nestedDriver, "each project's driver points at its own script");
});

// ---------------------------------------------------------------- depends-on

test("backlog next skips a queued row whose dependency is not archived, then unblocks once it is", () => {
  const t = scaffoldBacklogCliTarget();
  assert.strictEqual(runBacklogCli(t, ["add", "prereq", "--p", "P1"]).status, 0); // F-001
  assert.strictEqual(runBacklogCli(t, ["add", "blocked task", "--p", "P2", "--depends-on", "F-001"]).status, 0); // F-002
  assert.strictEqual(runBacklogCli(t, ["queue", "F-002"]).status, 0);

  const r = runBacklogCli(t, ["next"]);
  assert.match(r.out, /all queued rows are blocked \(F-002\)/);

  const tk = runBacklogCli(t, ["take", "F-002"]);
  assert.strictEqual(tk.status, 1);
  assert.match(tk.out, /blocked/);

  // archive the dependency -> the row becomes pullable
  assert.strictEqual(runBacklogCli(t, ["archive", "F-001", "--closed", "done"]).status, 0);
  assert.match(runBacklogCli(t, ["next"]).out, /next: F-002/);
});

test("backlog add rejects a depends-on reference to an unknown row", () => {
  const t = scaffoldBacklogCliTarget();
  assert.strictEqual(runBacklogCli(t, ["add", "x", "--p", "P2", "--depends-on", "F-999"]).status, 1);
});

test("backlog depends sets and validates a row's dependency", () => {
  const t = scaffoldBacklogCliTarget();
  runBacklogCli(t, ["add", "a", "--p", "P2"]); // F-001
  runBacklogCli(t, ["add", "b", "--p", "P3"]); // F-002
  assert.match(runBacklogCli(t, ["depends", "F-002", "--on", "F-001"]).out, /depends on F-001/);
  const b = read(path.join(t, "BACKLOG.md"));
  assert.match(b.split("## Open")[1], /\| F-002 \| P3 \| \? \| b \| \? \| F-001 \|/);
  assert.strictEqual(runBacklogCli(t, ["depends", "F-002", "--on", "F-999"]).status, 1, "unknown ref rejected");
});

test("test:backlog fails on a Depends-on reference to an unknown row", () => {
  const t = scaffoldBacklogTarget(`# BACKLOG — canonical task list

## Open

| ID | P | Epic | Task | Evidence | Depends on |
|----|---|------|------|----------|------------|
| F-001 | P1 | ? | a | ev | F-999 |
`);
  const r = runBacklogGate(t);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /depends on unknown row `F-999`/);
});

test("test:backlog passes a valid Depends-on reference to an in-progress row", () => {
  const t = scaffoldBacklogTarget(`# BACKLOG — canonical task list

## In progress

| ID | Epic | Task | Handoff |
|----|------|------|---------|
| F-002 | ? | prereq | .agents/handoffs/F-002.md |

## Open

| ID | P | Epic | Task | Evidence | Depends on |
|----|---|------|------|----------|------------|
| F-001 | P1 | ? | a | ev | F-002 |
`);
  const r = runBacklogGate(t);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /RESULT: backlog green/);
});

// ---------------------------------------------------------------- owned files + concurrency

test("backlog owns writes and clears the owned-files registry", () => {
  const t = scaffoldBacklogCliTarget();
  runBacklogCli(t, ["add", "x", "--p", "P2"]); // F-001
  assert.match(runBacklogCli(t, ["owns", "F-001", "--files", "lib/wikidata.ts, scripts/*.ts"]).out, /owns/);
  assert.match(read(path.join(t, ".agents", "memory", "owned-files.md")), /F-001: lib\/wikidata\.ts, scripts\/\*\.ts/);
  runBacklogCli(t, ["owns", "F-001", "--files", "?"]);
  assert.doesNotMatch(read(path.join(t, ".agents", "memory", "owned-files.md")), /F-001/);
});

test("test:concurrency fails precisely when two In-progress rows own the same file", () => {
  const t = scaffoldConcurrencyTarget();
  writeFile(t, "BACKLOG.md", backlogWithInProgress(["F-044", "F-060"]));
  writeFile(t, ".agents/memory/owned-files.md", "- F-044: app/foo.tsx\n- F-060: app/foo.tsx, app/bar.tsx\n");
  writeFile(t, "app/foo.tsx", "// committed\n");
  git(t, ["add", "-A"]);
  git(t, ["commit", "-q", "-m", "seed"]);
  writeFile(t, "app/foo.tsx", "// wip\n");
  const r = runConcurrencyGate(t);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /owned by 2 In-progress rows/);
  assert.match(r.out, /app\/foo\.tsx/);
});

test("test:concurrency passes when dirty files are cleanly owned by one session", () => {
  const t = scaffoldConcurrencyTarget();
  writeFile(t, "BACKLOG.md", backlogWithInProgress(["F-044", "F-060"]));
  writeFile(t, ".agents/memory/owned-files.md", "- F-044: app/foo.tsx\n- F-060: lib/bar.ts\n");
  writeFile(t, "app/foo.tsx", "// committed\n");
  git(t, ["add", "-A"]);
  git(t, ["commit", "-q", "-m", "seed"]);
  writeFile(t, "app/foo.tsx", "// wip\n");
  const r = runConcurrencyGate(t);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /no cross-session overlap detected/);
});

test("test:concurrency FAILS when the shared BACKLOG.md is dirty under 2+ In-progress rows", () => {
  // Finding 4: the board is one shared file every session writes on main, so a
  // dirty BACKLOG.md with 2+ active sessions is provably ambiguous — it must be a
  // hard failure, not a tolerated warning.
  const t = scaffoldConcurrencyTarget();
  writeFile(t, "BACKLOG.md", backlogWithInProgress(["F-044", "F-060"]));
  git(t, ["add", "-A"]);
  git(t, ["commit", "-q", "-m", "seed"]);
  writeFile(t, "BACKLOG.md", backlogWithInProgress(["F-044", "F-060", "F-099"])); // another session's board delta
  const r = runConcurrencyGate(t);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /BACKLOG\.md is dirty/);
  assert.match(r.out, /FAILURE/);
});

test("test:concurrency fails when a tree mixes two sessions' WIP", () => {
  const t = scaffoldConcurrencyTarget();
  writeFile(t, "BACKLOG.md", backlogWithInProgress(["F-044", "F-060"]));
  writeFile(t, ".agents/memory/owned-files.md", "- F-044: app/foo.tsx\n- F-060: lib/bar.ts\n");
  writeFile(t, "app/foo.tsx", "// a\n");
  writeFile(t, "lib/bar.ts", "// b\n");
  git(t, ["add", "-A"]);
  git(t, ["commit", "-q", "-m", "seed"]);
  writeFile(t, "app/foo.tsx", "// a wip\n");
  writeFile(t, "lib/bar.ts", "// b wip\n");
  const r = runConcurrencyGate(t);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /mixes two sessions/);
});

// ---------------------------------------------------------------- test:integrate

function runIntegrateGate(target) {
  const res = spawnSync(process.execPath, ["scripts/qa/check-integrate.js"], { cwd: target, encoding: "utf8" });
  return { status: res.status, out: (res.stdout || "") + (res.stderr || "") };
}

test("test:integrate fails behind upstream and passes when up to date", () => {
  const dir = tmpdir();
  const remote = path.join(dir, "remote.git");
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", remote]);

  const work = path.join(dir, "work");
  fs.mkdirSync(work);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: work });
  execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: work });
  execFileSync("git", ["config", "user.name", "t"], { cwd: work });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: work });
  fs.mkdirSync(path.join(work, "scripts", "qa"), { recursive: true });
  fs.copyFileSync(path.join(h.TEMPLATES_DIR, "scripts", "qa", "check-integrate.js"), path.join(work, "scripts", "qa", "check-integrate.js"));
  writeFile(work, "f.txt", "v1\n");
  execFileSync("git", ["add", "-A"], { cwd: work });
  execFileSync("git", ["commit", "-q", "-m", "one"], { cwd: work });
  execFileSync("git", ["push", "-q", "-u", "origin", "main"], { cwd: work });

  let r = runIntegrateGate(work);
  assert.strictEqual(r.status, 0, r.out);

  const work2 = path.join(dir, "work2");
  execFileSync("git", ["clone", "-q", remote, work2]);
  execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: work2 });
  execFileSync("git", ["config", "user.name", "t"], { cwd: work2 });
  writeFile(work2, "f.txt", "v2\n");
  execFileSync("git", ["add", "-A"], { cwd: work2 });
  execFileSync("git", ["commit", "-q", "-m", "two"], { cwd: work2 });
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: work2 });

  r = runIntegrateGate(work);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /behind/);
  assert.match(r.out, /git rebase/);
});

test("test:integrate is wired into package.json scripts", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });
  const pkg = JSON.parse(read(path.join(target, "package.json")));
  assert.strictEqual(pkg.scripts["test:integrate"], "node scripts/qa/check-integrate.js");
});

test("skills/features SKILL.md is harness-owned (overwritten), not project scaffold", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });

  const skill = path.join(target, ".agents", "skills", "features", "SKILL.md");
  assert.ok(exists(skill), "features skill deployed");
  fs.writeFileSync(skill, "LOCAL EDIT", "utf8");

  await h.deploy(target, { name: "Demo", yes: true, isUpdate: true });
  assert.match(read(skill), /registrar only/, "features skill restored on update (harness-owned)");
});

// ---------------------------------------------------------------- test:quality gate (M4)

function runQualityGate(target, args) {
  const res = spawnSync(process.execPath, ["scripts/qa/check-quality.js", ...args], {
    cwd: target,
    encoding: "utf8",
  });
  return { status: res.status, out: (res.stdout || "") + (res.stderr || "") };
}

test("test:quality flags a dead export and an oversized new file on the diff", () => {
  const t = tmpdir();
  fs.mkdirSync(path.join(t, "scripts", "qa"), { recursive: true });
  fs.copyFileSync(
    path.join(h.TEMPLATES_DIR, "scripts", "qa", "check-quality.js"),
    path.join(t, "scripts", "qa", "check-quality.js")
  );
  git(t, ["init", "-q"]);
  git(t, ["config", "user.email", "t@t.t"]);
  git(t, ["config", "user.name", "t"]);
  writeFile(t, "package.json", "{}\n");
  writeFile(t, "lib/used.ts", "export function used() { return 1; }\n");
  writeFile(t, "lib/consumer.ts", "import { used } from './used';\nexport const x = used();\n");
  git(t, ["add", "-A"]);
  git(t, ["commit", "-q", "-m", "seed"]);

  // NEW dead export (no consumer) + NEW oversized file on the change
  writeFile(t, "lib/dead.ts", "export function deadExport() { return 2; }\n");
  const big = ["export function f() {}"];
  for (let i = 0; i < 1500; i++) big.push("// padding " + i);
  writeFile(t, "lib/big.ts", big.join("\n") + "\n");

  const r = runQualityGate(t, ["--base", "HEAD"]);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /deadExport.*no consumer/);
  assert.match(r.out, /lib\/big\.ts is \d+ lines/);

  // a used export is not flagged
  assert.doesNotMatch(r.out, /`used` has no consumer/, "used export must not be flagged");
});

test("test:quality passes a clean diff and an explicit-path clean scan", () => {
  const t = tmpdir();
  fs.mkdirSync(path.join(t, "scripts", "qa"), { recursive: true });
  fs.copyFileSync(
    path.join(h.TEMPLATES_DIR, "scripts", "qa", "check-quality.js"),
    path.join(t, "scripts", "qa", "check-quality.js")
  );
  git(t, ["init", "-q"]);
  git(t, ["config", "user.email", "t@t.t"]);
  git(t, ["config", "user.name", "t"]);
  writeFile(t, "package.json", "{}\n");
  writeFile(t, "lib/ok.ts", "export function ok() { return 1; }\n");
  writeFile(t, "lib/consumer.ts", "import { ok } from './ok';\nexport const x = ok();\n");
  git(t, ["add", "-A"]);
  git(t, ["commit", "-q", "-m", "seed"]);
  // clean change: nothing new, nothing grown
  writeFile(t, "lib/ok.ts", "export function ok() { return 1; }\n// touched\n");
  const r = runQualityGate(t, ["--base", "HEAD"]);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /green/);

  // explicit-path clean scan is green too (whole-file references resolve)
  const r2 = runQualityGate(t, ["--base", "HEAD", "--paths", "lib/ok.ts"]);
  assert.strictEqual(r2.status, 0, r2.out);
});
