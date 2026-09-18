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

  // Committed-history check: the diff check above only sees UNCOMMITTED work, so
  // a harness change committed without a version bump passed silently (the
  // recurring "forgot to bump package.json" miss). Walk history: since the last
  // commit that changed package.json's version, no commit may touch bin/ or
  // templates/ — the bump must ship in the same commit as (or after) the change.
  let history = [];
  try {
    history = execFileSync("git", ["log", "--format=%H", "--", "package.json"], { encoding: "utf8" })
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    history = [];
  }
  const versionAt = (ref) => {
    try {
      return JSON.parse(execFileSync("git", ["show", `${ref}:package.json`], { encoding: "utf8" })).version;
    } catch {
      return null;
    }
  };
  let lastBump = null;
  for (const sha of history) {
    const v = versionAt(sha);
    const prior = versionAt(`${sha}^`);
    if (v && v !== prior) {
      lastBump = sha;
      break;
    }
  }
  if (lastBump) {
    let after = [];
    try {
      after = execFileSync("git", ["log", "--format=%H", "--no-merges", `${lastBump}..HEAD`, "--", "bin/", "templates/"], {
        encoding: "utf8",
      })
        .split(/\r?\n/)
        .filter(Boolean);
    } catch {
      after = [];
    }
    assert.strictEqual(
      after.length,
      0,
      `${after.length} harness-file commit(s) landed after the last package.json version bump (${lastBump.slice(0, 7)}) — ` +
        `bump package.json in the same change`
    );
  }
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

  const oc = JSON.parse(read(path.join(target, "opencode.json")));
  assert.strictEqual(oc.agent.build.steps, 100, "deploy writes the mechanical turn cap");
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
  assert.strictEqual(merged.model, "opencode-go/deepseek-v4.1-flash");
  assert.strictEqual(merged.small_model, "opencode-go/glm-5.3-flash");
  assert.strictEqual(merged.permission.edit, "deny");
  assert.ok(merged.instructions.includes("docs/my-rules.md"));
  assert.ok(merged.instructions.includes(".agents/rules/00-operating.md"));
});

test("opencode.json merge ships agent.build.steps as an ADD-ONLY default", () => {
  // fresh project: the harness turn cap appears
  const fresh = tmpdir();
  const defaults = JSON.parse(
    h.mergeOpencodeJson(fresh, { PROJECT_NAME: "Demo", PROJECT_DOMAIN: "x" })
  );
  assert.strictEqual(defaults.agent.build.steps, 100, "hard turn cap is deployed by default");

  // a project override and unrelated agent config are preserved
  const target = tmpdir();
  fs.writeFileSync(
    path.join(target, "opencode.json"),
    JSON.stringify(
      {
        agent: {
          build: { steps: 150, model: "custom/model" },
          explore: { model: "custom/explore" },
        },
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
  const merged = JSON.parse(
    h.mergeOpencodeJson(target, { PROJECT_NAME: "Demo", PROJECT_DOMAIN: "x" })
  );
  assert.strictEqual(merged.agent.build.steps, 150, "project steps override wins");
  assert.strictEqual(merged.agent.build.model, "custom/model");
  assert.strictEqual(merged.agent.explore.model, "custom/explore");
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

  // Provider funds stop: a funds/quota error pauses the process instead of
  // silently degrading inline (the behavior the harness must never repeat).
  assert.match(rules, /Funds stop \(pause, announce, wait\)/);
  assert.match(rules, /top-up-complete/);
  assert.match(rulebook, /provider funds\/quota error is a STOP/);
  assert.match(rootAgents, /Provider funds stop/);

  const handoffSkill = read(path.join(h.TEMPLATES_DIR, ".agents", "skills", "handoff", "SKILL.md"));
  assert.match(handoffSkill, /Session metadata/);
  assert.match(handoffSkill, /work_type:/);
  assert.match(handoffSkill, /termination_reason:/);

  const plannerSkill = read(path.join(h.TEMPLATES_DIR, ".agents", "skills", "planner", "SKILL.md"));
  assert.match(plannerSkill, /Fan-out review/);
  assert.match(plannerSkill, /orchestration\.md/);
  assert.match(plannerSkill, /execution_mode: direct/);
  assert.match(plannerSkill, /dispatch_justification/);

  // Step Zero no longer mandates dispatch before any read/edit — the
  // complexity threshold and dispatch economics are the authority.
  assert.doesNotMatch(rules, /Before reading or editing any file for a task, dispatch/);
  assert.match(rules, /complexity threshold/i);

  const governance = read(path.join(h.TEMPLATES_DIR, "scripts", "qa", "governance.js"));
  assert.match(governance, /FANOUT_JUSTIFY_MIN/);
  assert.match(governance, /Fan-out justification/);
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
  assert.match(cmd, /opencode-go\/deepseek-v4\.1-flash/, "command targets the OpenCode Go default");
  assert.match(cmd, /deepseek\/deepseek-flash/, "command exposes the direct deepseek fallback alias");
  assert.match(cmd, /deepseek\/deepseek-v4-pro/, "command exposes the pro escalation alias");
  assert.match(cmd, /switch-reasoning-model\.ps1/, "command invokes the deployed script");

  const script = read(path.join(target, "scripts", "switch-reasoning-model.ps1"));
  assert.match(script, /opencode-go\/deepseek-v4\.1-flash/, "script aliases map to the OpenCode Go default");
  assert.match(script, /opencode-go\/deepseek-v4-pro/, "script exposes the Go pro escalation alias");
  assert.match(script, /deepseek\/deepseek-flash/, "script aliases map to the direct deepseek fallback");
  assert.match(script, /deepseek\/deepseek-v4-flash/, "script keeps the legacy v4 flash pin replaceable (migration/rollback)");
  assert.match(script, /deepseek\/deepseek-v4-pro/, "script aliases map to the pro escalation model");
  assert.match(script, /openrouter\/minimax\/minimax-m3/, "script exposes the OpenRouter alias");
  assert.match(script, /nvidia\/nemotron-3-ultra-550b-a55b:free/, "script exposes the Nemotron free alias");
  assert.match(script, /6 reasoning-tier agents|planner\.md/, "script rewrites the reasoning agents");

  // the command is re-deployed (overwritten) on update, like any harness file
  fs.writeFileSync(path.join(target, ".opencode", "command", "switch-model.md"), "LOCAL EDIT", "utf8");
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: true });
  assert.match(read(path.join(target, ".opencode", "command", "switch-model.md")), /opencode-go\/deepseek-v4\.1-flash/, "command restored on update");
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

test("switch-reasoning-model.sh: alias map, find list, and the .ps1 twin stay in parity", () => {
  // The POSIX twin is the active switcher on WSL/Linux. Its find list and alias
  // map are maintained separately, so lock them together and against the .ps1
  // twin — otherwise a new alias silently fails to replace on one platform.
  const sh = read(path.join(h.TEMPLATES_DIR, "scripts", "switch-reasoning-model.sh"));
  const ps1 = read(path.join(h.TEMPLATES_DIR, "scripts", "switch-reasoning-model.ps1"));

  const caseBlock = (sh.match(/case "\$target_lc" in([\s\S]*?)esac/) || [])[1] || "";
  const shAliasValues = new Set(
    [...caseBlock.matchAll(/target_model="([^"$][^"]*)"/g)].map((m) => m[1])
  );

  const listBlock = (sh.match(/reasoning_models="([\s\S]*?)"/) || [])[1] || "";
  const shFindList = new Set(
    listBlock.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  );

  const ps1AliasValues = new Set(
    [...ps1.matchAll(/^\s*"([^"]+)"\s*=\s*"([^"]+)"/gm)].map((m) => m[2])
  );

  assert.ok(shAliasValues.size > 0, "parsed the .sh alias map");
  assert.deepStrictEqual(
    [...shFindList].sort(),
    [...shAliasValues].sort(),
    ".sh find list must equal the .sh alias values (every switchable value is replaceable)"
  );
  assert.deepStrictEqual(
    [...ps1AliasValues].sort(),
    [...shAliasValues].sort(),
    ".sh and .ps1 alias maps must expose the same models"
  );
});

test("board command is deployed to every project (delegates to the deterministic CLI)", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });

  const cmd = read(path.join(target, ".opencode", "command", "board.md"));
  assert.match(cmd, /^---/, "board command frontmatter");
  assert.match(cmd, /BACKLOG\.md/, "command reads the local canonical board");
  assert.match(cmd, /node scripts\/backlog\.js list/, "command runs the deterministic CLI");
  assert.match(cmd, /--limit 0/, "command documents the bounded default + escape hatch");
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
  assert.doesNotMatch(tools, /--full/, "list tool is bounded, not a full-board dump");
  assert.match(tools, /--limit/, "list tool exposes the bounded limit");

  const plugin = read(path.join(target, ".opencode", "plugins", "backlog-notify.ts"));
  assert.match(plugin, /tool\.execute\.after/, "plugin hooks tool execution");
  assert.match(plugin, /showToast/, "plugin pushes a toast");

  // the `backlog` npm script is wired so `npm run backlog -- list` works
  const pkg = JSON.parse(read(path.join(target, "package.json")));
  assert.strictEqual(pkg.scripts["backlog"], "node scripts/backlog.js");
});

test("opencode tools resolve a real node runtime, never the opencode binary (process.execPath)", () => {
  // opencode ships as a compiled standalone binary, so inside its runtime
  // `process.execPath` is the opencode executable (opencode.exe), NOT Node —
  // spawning it with a script path just re-launches opencode (0.1.65
  // regression). Tools resolve a real node via nodeBin(): an explicit
  // OPENCODE_NODE override, the runtime's PATH resolver (skipping WSL /mnt
  // entries so a native node beats the interop Windows node.exe), then a bare
  // "node" as the last resort.
  // One home for the plumbing: nodeBin + the mid-session-worktree reroot live in
  // scripts/qa/tool-lib.js; every tool delegates to it (no private copies that
  // drift — backlog/checkpoint/session previously disagreed on the root marker).
  const lib = read(path.join(h.TEMPLATES_DIR, "scripts", "qa", "tool-lib.js"));
  assert.doesNotMatch(
    lib,
    /execFileSync\(\s*[^,)]*execPath/,
    "tool-lib must never spawn the opencode binary (process.execPath)"
  );
  assert.match(lib, /execFileSync\(\s*nodeBin\(\)/, "tool-lib spawns a resolved node via nodeBin()");
  assert.match(lib, /\.which\(\s*["']node["']/, "nodeBin must consult the runtime's PATH resolver");
  assert.match(lib, /OPENCODE_NODE/, "nodeBin must honor the OPENCODE_NODE override");

  const tools = ["backlog.ts", "checkpoint.ts", "session.ts"];
  for (const f of tools) {
    const src = read(path.join(h.TEMPLATES_DIR, ".opencode", "tools", f));
    assert.doesNotMatch(
      src,
      /execFileSync\(\s*[^,)]*execPath/,
      `${f} must not spawn the opencode binary (process.execPath)`
    );
    assert.doesNotMatch(src, /function nodeBin\s*\(/, `${f} must not carry a private nodeBin copy`);
    assert.doesNotMatch(src, /function rootOf\s*\(/, `${f} must not carry a private rootOf copy`);
    assert.match(src, /tool-lib\.js/, `${f} must use the shared tool-lib`);
    assert.match(src, /toolLib\.runScript\(|toolLib\.sessionRoot\(/, `${f} must delegate to tool-lib`);
  }
  // static gate over the whole template tree: no tool spawns the opencode binary
  const toolDir = path.join(h.TEMPLATES_DIR, ".opencode", "tools");
  for (const f of fs.readdirSync(toolDir).filter((n) => n.endsWith(".ts"))) {
    assert.doesNotMatch(
      read(path.join(toolDir, f)),
      /execFileSync\(\s*[^,)]*execPath/,
      `${f} must not spawn the opencode binary (process.execPath)`
    );
  }
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

/* Copy the shared standalone modules next to the board scripts (backlog.js at
 * scripts/, the QA gates at scripts/qa/) that require them: board-lib.js (row
 * primitive) and lease-lib.js (session-lease liveness). */
function copyBoardLib(target) {
  const dir = path.join(target, "scripts", "qa");
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ["board-lib.js", "lease-lib.js"]) {
    fs.copyFileSync(path.join(h.TEMPLATES_DIR, "scripts", "qa", name), path.join(dir, name));
  }
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

test("backlog CLI unqueue returns a Queued row to Open (priority-sorted, cells preserved)", () => {
  const t = scaffoldBacklogCliTarget();
  runBacklogCli(t, ["add", "queued item", "--p", "P2", "--evidence", "qa-unqueue"]);
  runBacklogCli(t, ["add", "urgent item", "--p", "P1"]);
  assert.match(runBacklogCli(t, ["queue", "F-001"]).out, /queued F-001/);

  const out = runBacklogCli(t, ["unqueue", "F-001"]);
  assert.strictEqual(out.status, 0, out.out);
  assert.match(out.out, /unqueued F-001 -> Open \(queued item\)/);

  const b = read(path.join(t, "BACKLOG.md"));
  assert.doesNotMatch(b.split("## Queued")[1].split("## Open")[0], /F-001/, "the row leaves Queued");
  assert.match(
    b.split("## Open")[1],
    /\| F-001 \| P2 \| \? \| queued item \| qa-unqueue \|/,
    "priority/evidence cells are preserved"
  );
  const open = b.split("## Open")[1];
  assert.ok(open.indexOf("F-002") < open.indexOf("F-001"), "re-inserted priority-sorted (P1 before P2)");

  const noop = runBacklogCli(t, ["unqueue", "F-001"]);
  assert.strictEqual(noop.status, 0, noop.out);
  assert.match(noop.out, /F-001: already Open/);

  runBacklogCli(t, ["take", "F-002", "--handoff", ".agents/handoffs/F-002.md"]);
  const refused = runBacklogCli(t, ["unqueue", "F-002"]);
  assert.strictEqual(refused.status, 1, refused.out);
  assert.match(refused.out, /only Queued rows can be returned to Open/);
});

test("backlog list is bounded by default and --limit controls the cap", () => {
  const t = scaffoldBacklogCliTarget();
  const p = path.join(t, "BACKLOG.md");
  const lines = read(p).split(/\r?\n/);
  const openIdx = lines.findIndex((l) => l.trim() === "## Open");
  const sepIdx = lines.findIndex((l, i) => i > openIdx && /^\|[-| ]+\|$/.test(l.trim()));
  const rows = [];
  for (let i = 1; i <= 45; i++) {
    rows.push(`| F-${String(i).padStart(3, "0")} | P3 | ? | task ${i} | ? | ? |`);
  }
  lines.splice(sepIdx + 1, 0, ...rows);
  fs.writeFileSync(p, lines.join("\n") + "\n", "utf8");

  // default cap: true counts first, then the first 40 rows, then the omitted count
  const def = runBacklogCli(t, ["list"]);
  assert.strictEqual(def.status, 0, def.out);
  assert.match(def.out, /Open \(45\)/, "true row count is still printed");
  assert.match(def.out, /\+5 row\(s\) omitted \(--limit 40, 0 = all\)/);
  assert.match(def.out, /F-040/);
  assert.doesNotMatch(def.out, /F-041/);

  // explicit small cap
  const two = runBacklogCli(t, ["list", "--limit", "2"]);
  assert.match(two.out, /Open \(45\)/);
  assert.match(two.out, /\+43 row\(s\) omitted/);
  assert.match(two.out, /F-002/);
  assert.doesNotMatch(two.out, /F-003/);

  // 0 = all (escape hatch)
  const all = runBacklogCli(t, ["list", "--limit", "0"]);
  assert.match(all.out, /F-045/);
  assert.doesNotMatch(all.out, /omitted/);
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

test("backlog write is EOF-stable — a mutation adds no blank line and a no-op is byte-identical", () => {
  const t = scaffoldBacklogCliTarget();
  const p = path.join(t, "BACKLOG.md");
  assert.strictEqual(runBacklogCli(t, ["add", "eof check", "--p", "P2"]).status, 0);
  const afterAdd = read(p);
  assert.ok(afterAdd.endsWith("\n"), "file ends with a newline");
  assert.ok(!afterAdd.endsWith("\n\n"), "a mutation must not append a trailing blank line");

  // a no-op read-modify-write (unqueue an already-Open row) must not change bytes
  const noop = runBacklogCli(t, ["unqueue", "F-001"]);
  assert.strictEqual(noop.status, 0, noop.out);
  assert.match(noop.out, /already Open/);
  assert.strictEqual(read(p), afterAdd, "no-op mutation is byte-for-byte idempotent");
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

test("withLock is a correct mutex — locked increments lose no updates under contention", async () => {
  const t = scaffoldBacklogCliTarget();
  const counter = path.join(t, "counter.txt");
  fs.writeFileSync(counter, "0", "utf8");

  const procs = 12;
  const incs = 8;
  const worker = path.join(t, "lock-worker.js");
  fs.writeFileSync(
    worker,
    `"use strict";
const fs = require("fs");
const { withLock } = require(${JSON.stringify(path.join(t, "scripts", "backlog.js"))});
const root = ${JSON.stringify(t)};
const counter = ${JSON.stringify(counter)};
for (let i = 0; i < ${incs}; i++) {
  withLock(root, () => {
    const n = parseInt(fs.readFileSync(counter, "utf8"), 10) || 0;
    fs.writeFileSync(counter, String(n + 1), "utf8");
  });
}
`,
    "utf8"
  );

  const results = await Promise.all(
    Array.from({ length: procs }, () =>
      new Promise((resolve) => {
        const c = spawn(process.execPath, [worker], { stdio: ["ignore", "ignore", "pipe"] });
        let err = "";
        c.stderr.on("data", (d) => (err += d));
        c.on("close", (code) => resolve({ code, err }));
      })
    )
  );
  for (const r of results) assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(
    parseInt(read(counter), 10),
    procs * incs,
    `every locked increment landed (expected ${procs * incs})`
  );
});

test("concurrent backlog add assigns distinct ids and lands every row", async () => {
  const t = scaffoldBacklogCliTarget();
  const script = path.join(t, "scripts", "backlog.js");
  const n = 12;
  const results = await Promise.all(
    Array.from({ length: n }, (_, i) =>
      new Promise((resolve) => {
        const c = spawn(process.execPath, [script, "add", `row ${i}`, "--p", "P3"], {
          cwd: t,
          stdio: ["ignore", "ignore", "pipe"],
        });
        let err = "";
        c.stderr.on("data", (d) => (err += d));
        c.on("close", (code) => resolve({ code, err }));
      })
    )
  );
  results.forEach((r, i) => assert.strictEqual(r.code, 0, `add ${i}: ${r.err}`));
  const rows = backlogOpenDataRows(read(path.join(t, "BACKLOG.md")));
  const ids = rows.map((l) => (l.split("|")[1] || "").trim());
  assert.strictEqual(ids.length, n, "all rows landed");
  assert.strictEqual(new Set(ids).size, n, "all ids distinct");
});

test("deploy records local-only ignores in .git/info/exclude, never in .gitignore", async () => {
  const target = tmpdir();
  git(target, ["init", "-q"]);
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });
  const exclude = read(path.join(target, ".git", "info", "exclude"));
  assert.match(exclude, /\.backlog\.lock/, "transient .backlog.lock is clone-locally excluded");
  assert.ok(!exists(path.join(target, ".gitignore")), "deploy never creates/rewrites the project .gitignore");

  // outside a git repo there is nothing to exclude for — and still no .gitignore
  const plain = tmpdir();
  await h.deploy(plain, { name: "Demo", yes: true, isUpdate: false });
  assert.ok(!exists(path.join(plain, ".gitignore")), "non-git target still gets no .gitignore");
});

test("serve helper is deployed, wired, and its runtime dir is excluded clone-locally", async () => {
  const target = tmpdir();
  git(target, ["init", "-q"]);
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });

  assert.ok(exists(path.join(target, "scripts", "serve.js")), "serve.js deployed");

  const pkg = JSON.parse(read(path.join(target, "package.json")));
  assert.strictEqual(pkg.scripts.serve, "node scripts/serve.js", "serve npm script wired");

  const exclude = read(path.join(target, ".git", "info", "exclude"));
  assert.match(exclude, /\.serve\//, ".serve/ (pid files + logs) excluded clone-locally");
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
  assert.strictEqual(pkg.scripts["test:prefix"], "node scripts/qa/check-prefix-stability.js");
  assert.strictEqual(pkg.scripts["report:cost"], "node scripts/agent-report.js --cost --since=14d");
  assert.strictEqual(pkg.scripts["checkpoint"], "node scripts/checkpoint.js");
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

test("update auto-commit never sweeps a path another session already staged", async () => {
  const target = tmpdir();
  git(target, ["init", "-q"]);
  git(target, ["config", "user.email", "t@t.t"]);
  git(target, ["config", "user.name", "t"]);
  git(target, ["commit", "--allow-empty", "-q", "-m", "seed"]);

  // another session's work, STAGED but not committed (a pre-existing index entry)
  fs.writeFileSync(path.join(target, "other-session.js"), "// another session\n", "utf8");
  git(target, ["add", "other-session.js"]);

  const result = await h.deploy(target, {
    name: "Demo",
    yes: true,
    isUpdate: true,
    commit: true,
    push: false,
  });

  assert.strictEqual(result.commitResult.committed, true, "harness commit was made");
  const committed = git(target, ["show", "--name-only", "--pretty=format:", "HEAD"])
    .split(/\r?\n/)
    .filter(Boolean);
  assert.ok(committed.length > 0, "the harness commit contains harness files");
  assert.ok(!committed.includes("other-session.js"), "the pre-staged file was not swept into the commit");
  assert.ok(
    result.commitResult.staged.every((p) => p !== "other-session.js"),
    "commitResult.staged reports only this run's files"
  );
  assert.match(
    git(target, ["status", "--porcelain"]),
    /^A  other-session\.js$/m,
    "the other session's file is still staged, uncommitted"
  );
});

// A local bare `origin`, a `target` clone tracking `main`, and a helper that
// advances origin from a second clone — the shape a feature-worktree push leaves
// the main checkout in (behind, with the main checkout never pulled).
function trackedRepoFixture() {
  const origin = tmpdir();
  git(origin, ["init", "--bare", "-q", "-b", "main"]);
  const target = tmpdir();
  git(target, ["init", "-q", "-b", "main"]);
  git(target, ["config", "user.email", "t@t.t"]);
  git(target, ["config", "user.name", "t"]);
  git(target, ["commit", "--allow-empty", "-q", "-m", "seed"]);
  git(target, ["remote", "add", "origin", origin]);
  git(target, ["push", "-q", "-u", "origin", "main"]);
  const advanceOrigin = (name) => {
    const other = tmpdir();
    execFileSync("git", ["clone", "-q", origin, other], { encoding: "utf8" });
    git(other, ["config", "user.email", "o@o.o"]);
    git(other, ["config", "user.name", "o"]);
    fs.writeFileSync(path.join(other, name), "from origin\n", "utf8");
    git(other, ["add", "-A"]);
    git(other, ["commit", "-q", "-m", `origin advance (${name})`]);
    git(other, ["push", "-q", "origin", "main"]);
  };
  return { origin, target, advanceOrigin };
}

test("update fast-forwards a clean stale branch, then commits on the current base", async () => {
  const { target, advanceOrigin } = trackedRepoFixture();
  advanceOrigin("origin-only.txt");

  const result = await h.deploy(target, {
    name: "Demo",
    yes: true,
    isUpdate: true,
    commit: true,
    push: true,
  });

  assert.ok(result.syncResult && result.syncResult.synced, "the stale branch was fast-forwarded");
  const counts = git(target, ["rev-list", "--left-right", "--count", "HEAD...origin/main"])
    .split(/\s+/)
    .map((n) => parseInt(n, 10) || 0);
  assert.strictEqual(counts[1], 0, "target is no longer behind origin/main");
  assert.strictEqual(
    git(target, ["rev-parse", "HEAD"]),
    git(target, ["rev-parse", "origin/main"]),
    "the harness commit pushed cleanly (no divergence)"
  );
  assert.match(git(target, ["log", "--oneline", "-5"]), /origin advance/, "the origin commit is an ancestor");
});

test("update refuses to commit onto a diverged branch (behind and ahead of origin)", async () => {
  const { target, advanceOrigin } = trackedRepoFixture();
  advanceOrigin("origin-only.txt");

  // a local commit on the stale base -> ahead AND behind (diverged)
  fs.writeFileSync(path.join(target, "local-only.txt"), "mine\n", "utf8");
  git(target, ["add", "-A"]);
  git(target, ["commit", "-q", "-m", "local work"]);

  await assert.rejects(
    h.deploy(target, { name: "Demo", yes: true, isUpdate: true, commit: true, push: false }),
    /diverged/
  );

  assert.ok(
    !/chore\(harness\)/.test(git(target, ["log", "--oneline"])),
    "no harness commit was created on the diverged branch"
  );
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
  assert.strictEqual(
    read(path.join(target, ".gitignore")),
    ".agents/\n.opencode/\nAGENTS.md\nopencode.json\n",
    "update never rewrites the project .gitignore"
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
  assert.ok(!exists(path.join(target, ".gitignore")), "init never creates a .gitignore (project-owned)");
  assert.strictEqual(git(target, ["status", "--porcelain"]), "", "working tree clean after init");
});

test("deploy never rewrites the project .gitignore, even around a stale harness marker", async () => {
  const target = tmpdir();
  git(target, ["init", "-q"]);
  // The pre-0.1.55 managed section, with project entries on BOTH sides of the
  // marker. The old merge truncated everything after the marker, un-ignoring
  // `.env` and `data/` (FamilyBudget F-020).
  const original =
    "node_modules/\n" +
    "# agent-harness (managed below)\n" +
    ".harness-backup/\n.backlog.lock\n.serve/\n.agents/guard-events.jsonl\n\n" +
    "# local financial data — never commit (PII)\ndata/\n\n" +
    "# secrets\n.env\n.env.*\n.envrc\n*.env\n!.env.example\n";
  fs.writeFileSync(path.join(target, ".gitignore"), original, "utf8");

  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });
  assert.strictEqual(read(path.join(target, ".gitignore")), original, ".gitignore untouched by init");

  await h.deploy(target, { name: "Demo", yes: true, isUpdate: true });
  assert.strictEqual(
    read(path.join(target, ".gitignore")),
    original,
    ".gitignore untouched by update (no marker truncation)"
  );

  const excludePath = path.join(target, ".git", "info", "exclude");
  const exclude = read(excludePath);
  assert.ok(exclude.includes(".harness-backup/"), "harness local artifacts excluded clone-locally");
  assert.ok(exclude.includes(".agents/guard-events.jsonl"), "guard log excluded clone-locally");

  await h.deploy(target, { name: "Demo", yes: true, isUpdate: true });
  assert.strictEqual(read(excludePath), exclude, "exclude merge is idempotent (marker not duplicated)");
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

test("test:backlog fails on a stray (non-root) BACKLOG.md board", () => {
  const t = scaffoldBacklogTarget(VALID_BACKLOG);
  git(t, ["init", "-q"]);
  git(t, ["config", "user.email", "t@t.t"]);
  git(t, ["config", "user.name", "t"]);
  fs.mkdirSync(path.join(t, "mobile"), { recursive: true });
  fs.writeFileSync(path.join(t, "mobile", "BACKLOG.md"), "# shadow board\n", "utf8");
  git(t, ["add", "."]);
  git(t, ["commit", "-q", "-m", "seed"]);
  const r = runBacklogGate(t);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /no stray BACKLOG\.md boards/);
  assert.match(r.out, /mobile\/BACKLOG\.md/);
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

test("test:governance requires a fan-out justification when the dispatch log has 5+ entries", () => {
  const t = scaffoldGovernanceTarget();
  const entries = ["a", "b", "c", "d", "e"].map((p) => `- ${p} -> m -> shipped`).join("\n");
  const doc = (extra = "") => `# x\n\nDate: 2026-09-12\n\n## Dispatch log\n${entries}\n\n${extra}`;

  writeFile(t, ".agents/handoffs/F-060.md", doc("## Done\n- z\n"));
  let r = runGovernanceGate(t);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /Fan-out justification/);

  // the planner's §Fan-out review mirrored into the handoff passes
  writeFile(
    t,
    ".agents/handoffs/F-060.md",
    doc("## Fan-out justification\n- each entry owns a disjoint file set (see plan.md §Fan-out review)\n")
  );
  r = runGovernanceGate(t);
  assert.strictEqual(r.status, 0, r.out);

  // a `dispatch_justification:` line is accepted too
  writeFile(
    t,
    ".agents/handoffs/F-060.md",
    doc("dispatch_justification: distinct deliverables, disjoint owned files\n")
  );
  r = runGovernanceGate(t);
  assert.strictEqual(r.status, 0, r.out);

  // 4 entries stay exempt
  const four = entries.split("\n").slice(0, 4).join("\n");
  writeFile(t, ".agents/handoffs/F-060.md", `# x\n\nDate: 2026-09-12\n\n## Dispatch log\n${four}\n\n## Done\n- z\n`);
  r = runGovernanceGate(t);
  assert.strictEqual(r.status, 0, r.out);
});

test("test:governance grandfathers pre-rule and undated fan-out handoffs", () => {
  const t = scaffoldGovernanceTarget();
  const entries = ["a", "b", "c", "d", "e", "f"].map((p) => `- ${p} -> m -> shipped`).join("\n");

  // dated before the rule shipped: never retroactively failed
  writeFile(t, ".agents/handoffs/F-007.md", `# x\n\nDate: 2026-09-01\n\n## Dispatch log\n${entries}\n\n## Done\n- z\n`);
  // undated legacy handoff: grandfathered too
  writeFile(t, ".agents/handoffs/F-008.md", `# x\n\n## Dispatch log\n${entries}\n\n## Done\n- z\n`);
  // the legacy aggregate is exempt even when it carries a recent date
  writeFile(t, ".agents/memory/handoff.md", `# legacy\n\nDate: 2026-09-12\n\n## Dispatch log\n${entries}\n`);
  const r = runGovernanceGate(t);
  assert.strictEqual(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /Fan-out justification/);
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
  // `.serve/` is clone-locally excluded in a real project; mirror that so lease
  // files don't register as dirty working-tree changes.
  fs.writeFileSync(path.join(target, ".gitignore"), ".serve/\n");
  git(target, ["init", "-q"]);
  git(target, ["config", "user.email", "t@t.t"]);
  git(target, ["config", "user.name", "t"]);
  return target;
}

function runConcurrencyGate(target, args = []) {
  const res = spawnSync(process.execPath, ["scripts/qa/check-concurrency.js", ...args], {
    cwd: target,
    encoding: "utf8",
  });
  return { status: res.status, out: (res.stdout || "") + (res.stderr || "") };
}

/* The template lease-lib, required in-process so tests can mint real leases
 * (with the test process's birth token) and assert the gate's verdict. */
const leaseLib = require(path.join(h.TEMPLATES_DIR, "scripts", "qa", "lease-lib.js"));

function writeRawLease(target, id, rec) {
  const dir = path.join(target, ".serve", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ sessionID: id, ...rec }));
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

test("test:concurrency warns (exit 0) on two live leases sharing a clean tree (0.1.70)", () => {
  const t = scaffoldConcurrencyTarget();
  writeFile(t, "BACKLOG.md", backlogWithInProgress(["F-044"]));
  for (const id of ["ses_lease_a", "ses_lease_b"]) leaseLib.writeLease(t, id);
  git(t, ["add", "-A"]);
  git(t, ["commit", "-q", "-m", "seed"]);
  const r = runConcurrencyGate(t);
  // A clean tree has no WIP to collide over: the lease census is advisory and
  // must never fail a legitimate push (the trap this fixes).
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /live sessions share this working tree/);
  assert.match(r.out, /working tree clean/);
  assert.match(r.out, /ses_lease_a/);
  assert.match(r.out, /pid \d+/); // per-lease diagnostics, not just opaque ids
});

test("test:concurrency ignores a lease whose pid was recycled (0.1.67 false positive)", () => {
  const t = scaffoldConcurrencyTarget();
  git(t, ["add", "-A"]);
  git(t, ["commit", "-q", "-m", "seed"]);
  // Same live pid, different process incarnation: birth token must reject it.
  const tok = leaseLib.birthToken(process.pid);
  const token =
    tok.procStart != null
      ? { bootId: tok.bootId, procStart: String(Number(tok.procStart) + 1) }
      : { bootId: "some-other-boot", procStart: "1" };
  writeRawLease(t, "ses_recycled", { pid: process.pid, startedAt: Date.now(), heartbeatAt: Date.now(), ...token });
  const r = runConcurrencyGate(t);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /working tree clean/);
});

test("test:concurrency ignores a lease whose pid is dead", () => {
  const t = scaffoldConcurrencyTarget();
  git(t, ["add", "-A"]);
  git(t, ["commit", "-q", "-m", "seed"]);
  writeRawLease(t, "ses_dead", { pid: 999999, startedAt: Date.now(), heartbeatAt: Date.now() });
  const r = runConcurrencyGate(t);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /working tree clean/);
});

test("test:concurrency ignores a lease with a stale heartbeat", () => {
  const t = scaffoldConcurrencyTarget();
  git(t, ["add", "-A"]);
  git(t, ["commit", "-q", "-m", "seed"]);
  leaseLib.writeLease(t, "ses_stale");
  // Backdate the heartbeat well past the freshness window.
  const p = path.join(t, ".serve", "sessions", "ses_stale.json");
  const rec = JSON.parse(read(p));
  rec.heartbeatAt = Date.now() - 13 * 60 * 60 * 1000;
  fs.writeFileSync(p, JSON.stringify(rec));
  const r = runConcurrencyGate(t);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /working tree clean/);
});

test("test:concurrency --prune clears dead/recycled/stale leases", () => {
  const t = scaffoldConcurrencyTarget();
  writeRawLease(t, "ses_dead", { pid: 999999, startedAt: Date.now(), heartbeatAt: Date.now() });
  const tok = leaseLib.birthToken(process.pid);
  writeRawLease(t, "ses_recycled", {
    pid: process.pid,
    startedAt: Date.now(),
    heartbeatAt: Date.now(),
    bootId: tok.bootId,
    procStart: String(Number(tok.procStart || "1") + 1),
  });
  leaseLib.writeLease(t, "ses_live");
  const r = runConcurrencyGate(t, ["--prune"]);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /removed ses_dead/);
  assert.match(r.out, /removed ses_recycled/);
  assert.ok(exists(path.join(t, ".serve", "sessions", "ses_live.json")), "live lease kept");
  assert.ok(!exists(path.join(t, ".serve", "sessions", "ses_dead.json")), "dead lease removed");
});

test("lease-lib clearLease/prune also drop the session worktree pointer", () => {
  const t = tmpdir();
  leaseLib.writeLease(t, "ses_ptr");
  fs.writeFileSync(path.join(t, ".serve", "sessions", "ses_ptr.worktree"), "/tmp/somewhere");
  leaseLib.clearLease(t, "ses_ptr");
  assert.ok(!exists(path.join(t, ".serve", "sessions", "ses_ptr.json")), "lease removed");
  assert.ok(!exists(path.join(t, ".serve", "sessions", "ses_ptr.worktree")), "pointer removed with the lease");

  // prune drops the pointer for a dead session too.
  writeRawLease(t, "ses_dead_ptr", { pid: 999999, startedAt: Date.now(), heartbeatAt: Date.now() });
  fs.writeFileSync(path.join(t, ".serve", "sessions", "ses_dead_ptr.worktree"), "/tmp/gone");
  leaseLib.pruneLeases(t);
  assert.ok(!exists(path.join(t, ".serve", "sessions", "ses_dead_ptr.worktree")), "stale pointer pruned");
});

test("test:concurrency lists stale leases but does not fail a clean tree", () => {
  const t = scaffoldConcurrencyTarget();
  for (const id of ["ses_lease_a", "ses_lease_b"]) leaseLib.writeLease(t, id);
  writeRawLease(t, "ses_dead", { pid: 999999, startedAt: Date.now(), heartbeatAt: Date.now() });
  git(t, ["add", "-A"]);
  git(t, ["commit", "-q", "-m", "seed"]);
  const r = runConcurrencyGate(t);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /stale lease\(s\) present but ignored/);
  assert.match(r.out, /--prune/);
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

test("backlog worktree runs a project-provided scripts/worktree-setup.js bootstrap", () => {
  const t = scaffoldBacklogCliTarget();
  writeFile(
    t,
    "scripts/worktree-setup.js",
    [
      "const fs = require('fs');",
      "const path = require('path');",
      "fs.writeFileSync(path.join(process.argv[2], 'SETUP_RAN'), 'ok');",
      "process.exit(0);",
    ].join("\n") + "\n"
  );
  git(t, ["init", "-q"]);
  git(t, ["config", "user.email", "t@t.t"]);
  git(t, ["config", "user.name", "t"]);
  git(t, ["add", "-A"]);
  git(t, ["commit", "-q", "-m", "seed"]);

  assert.strictEqual(runBacklogCli(t, ["add", "isolate me", "--p", "P2"]).status, 0);

  const suffix = path.basename(t);
  const branch = `b-${suffix}`;
  const dir = path.join(os.tmpdir(), `wt-setup-${suffix}`);
  const r = runBacklogCli(t, ["worktree", "F-001", "--branch", branch, "--dir", dir]);
  assert.strictEqual(r.status, 0, r.out);
  assert.ok(exists(path.join(dir, "SETUP_RAN")), "project bootstrap ran inside the new worktree");
});

test("backlog worktree fails cleanly on an unknown row", () => {
  const t = scaffoldBacklogCliTarget();
  const r = runBacklogCli(t, ["worktree", "F-999"]);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /no row F-999/);
});

test("backlog worktree --open launches the agent CLI inside the new worktree", () => {
  const t = scaffoldBacklogCliTarget();
  git(t, ["init", "-q"]);
  git(t, ["config", "user.email", "t@t.t"]);
  git(t, ["config", "user.name", "t"]);
  git(t, ["add", "-A"]);
  git(t, ["commit", "-q", "-m", "seed"]);
  assert.strictEqual(runBacklogCli(t, ["add", "isolate me", "--p", "P2"]).status, 0);

  const dir = path.join(os.tmpdir(), `wt-open-${path.basename(t)}`);
  // Stub the agent binary: it writes a marker relative to its cwd, proving the
  // launch inherited the worktree as the session root.
  const stub = "node -e \"require('fs').writeFileSync('OPENED_IN_WORKTREE','ok')\"";
  const res = spawnSync(
    process.execPath,
    ["scripts/backlog.js", "worktree", "F-001", "--branch", `bo-${path.basename(t)}`, "--dir", dir, "--open"],
    { cwd: t, encoding: "utf8", env: { ...process.env, HARNESS_OPEN_CMD: stub } }
  );
  const out = (res.stdout || "") + (res.stderr || "");
  assert.strictEqual(res.status, 0, out);
  assert.match(out, /isolated F-001/);
  assert.match(out, /opening/);
  assert.ok(exists(path.join(dir, "OPENED_IN_WORKTREE")), "launcher ran with cwd = worktree");
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

test("backlog worktree records a session worktree pointer the tools read; archive clears it", () => {
  const t = scaffoldBacklogCliTarget();
  git(t, ["init", "-q"]);
  git(t, ["config", "user.email", "t@t.t"]);
  git(t, ["config", "user.name", "t"]);
  git(t, ["add", "-A"]);
  git(t, ["commit", "-q", "-m", "seed"]);
  assert.strictEqual(runBacklogCli(t, ["add", "isolate me", "--p", "P2"]).status, 0);

  // The tools forward the session id via HARNESS_SESSION_ID; a session that
  // creates its worktree mid-session gets its board/handoff ops rerooted there.
  const sessionID = "ses_mid_worktree";
  const dir = path.join(os.tmpdir(), `wt-mid-${path.basename(t)}`);
  const run = (args) => {
    const res = spawnSync(process.execPath, ["scripts/backlog.js", ...args], {
      cwd: t,
      encoding: "utf8",
      env: { ...process.env, HARNESS_SESSION_ID: sessionID },
    });
    return { status: res.status, out: (res.stdout || "") + (res.stderr || "") };
  };

  const w = run(["worktree", "F-001", "--branch", `mid-${path.basename(t)}`, "--dir", dir]);
  assert.strictEqual(w.status, 0, w.out);
  const pointer = path.join(t, ".serve", "sessions", `${sessionID}.worktree`);
  assert.ok(exists(pointer), "session worktree pointer written");
  assert.strictEqual(read(pointer).trim(), dir, "pointer holds the absolute worktree path");

  // Another session's pointer must survive this session's archive.
  fs.writeFileSync(path.join(t, ".serve", "sessions", "ses_other.worktree"), "/tmp/elsewhere");

  const a = run(["archive", "F-001"]);
  assert.strictEqual(a.status, 0, a.out);
  assert.ok(!exists(pointer), "archive clears this session's pointer");
  assert.ok(exists(path.join(t, ".serve", "sessions", "ses_other.worktree")), "other sessions' pointers untouched");
});

/* A feature-worktree push reaches `origin/main` without updating the main
 * checkout. These two tests cover the two ways `backlog worktree` handles that:
 * fast-forward a clean stale main, and base the new branch on origin/main even
 * when the main checkout's own commits keep it from fast-forwarding. */
function backlogRepoOnOrigin() {
  const origin = tmpdir();
  git(origin, ["init", "--bare", "-q", "-b", "main"]);
  const t = scaffoldBacklogCliTarget();
  git(t, ["init", "-q", "-b", "main"]);
  git(t, ["config", "user.email", "t@t.t"]);
  git(t, ["config", "user.name", "t"]);
  git(t, ["add", "-A"]);
  git(t, ["commit", "-q", "-m", "seed"]);
  git(t, ["remote", "add", "origin", origin]);
  git(t, ["push", "-q", "-u", "origin", "main"]);

  assert.strictEqual(runBacklogCli(t, ["add", "isolate me", "--p", "P2"]).status, 0);
  git(t, ["add", "BACKLOG.md"]);
  git(t, ["commit", "-q", "-m", "row"]);
  git(t, ["push", "-q", "origin", "main"]);

  // advance origin/main from a second clone (the worktree push the main tree misses)
  const other = tmpdir();
  execFileSync("git", ["clone", "-q", origin, other], { encoding: "utf8" });
  git(other, ["config", "user.email", "o@o.o"]);
  git(other, ["config", "user.name", "o"]);
  fs.writeFileSync(path.join(other, "origin-only.txt"), "from origin\n", "utf8");
  git(other, ["add", "-A"]);
  git(other, ["commit", "-q", "-m", "origin advance"]);
  git(other, ["push", "-q", "origin", "main"]);
  return { origin, t };
}

test("backlog worktree refreshes a clean stale main and bases the branch on origin/main", () => {
  const { t } = backlogRepoOnOrigin();

  const suffix = path.basename(t);
  const branch = `b-${suffix}`;
  const dir = path.join(os.tmpdir(), `wt-sync-${suffix}`);
  const r = runBacklogCli(t, ["worktree", "F-001", "--branch", branch, "--dir", dir]);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /board: fast-forwarded main to origin\/main/);
  assert.ok(exists(path.join(t, "origin-only.txt")), "main checkout was fast-forwarded");
  assert.ok(exists(path.join(dir, "origin-only.txt")), "worktree based on origin/main");
  assert.match(r.out, /base: origin\/main/);
});

test("backlog worktree bases the branch on origin/main when local main cannot fast-forward", () => {
  const { t } = backlogRepoOnOrigin();

  // a local commit on the stale base: refresh must report, not rewrite
  fs.writeFileSync(path.join(t, "local-only.txt"), "mine\n", "utf8");
  git(t, ["add", "-A"]);
  git(t, ["commit", "-q", "-m", "local work"]);

  const suffix = path.basename(t);
  const branch = `b-${suffix}`;
  const dir = path.join(os.tmpdir(), `wt-diverge-${suffix}`);
  const r = runBacklogCli(t, ["worktree", "F-001", "--branch", branch, "--dir", dir]);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /board: main is .* behind and .* ahead/);
  assert.ok(exists(path.join(dir, "origin-only.txt")), "worktree still based on origin/main");
  assert.ok(!exists(path.join(dir, "local-only.txt")), "worktree does not inherit the diverged local commit");
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
  // Mid-session worktree isolation: the tools reroot to the worktree the CLI
  // recorded for this session (`.serve/sessions/<id>.worktree`).
  assert.match(tools, /HARNESS_SESSION_ID/, "tools forward their session id to the CLI");
  assert.match(tools, /\.worktree/, "tools read the session worktree pointer");
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

test("merge-backlog rebuild preserves every row when a section has multiple rows", () => {
  // Regression for the missing `key` in resolved values: rebuild() keyed by
  // `r.key` (undefined), so every section collapsed to its last row. Both sides
  // equal here, so a correct round-trip must keep all rows.
  const src = board({
    open: [
      "| F-001 | P1 | ? | a | ev | ? |",
      "| F-002 | P2 | ? | b | ev | ? |",
      "| F-003 | P3 | ? | c | ev | ? |",
    ],
    archive: [
      "| F-010 | ? | x | shipped |",
      "| F-011 | ? | y | shipped |",
      "| F-012 | ? | z | shipped |",
    ],
  });

  const { resolved, conflicts } = mb.merge(src, src, src);
  assert.strictEqual(conflicts.length, 0);
  const out = mb.rebuild(src, resolved);
  for (const id of ["F-001", "F-002", "F-003", "F-010", "F-011", "F-012"]) {
    assert.strictEqual((out.match(new RegExp(`\\| ${id} \\|`, "g")) || []).length, 1, `${id} appears exactly once`);
  }
});

test("merge-backlog conflict preserves every non-conflicting row in the written board", () => {
  const base = board({
    open: [
      "| F-001 | P3 | ? | a | ev | ? |",
      "| F-002 | P2 | ? | b | ev | ? |",
      "| F-003 | P1 | ? | c | ev | ? |",
    ],
    archive: ["| F-010 | ? | x | shipped |", "| F-011 | ? | y | shipped |"],
  });
  const ours = board({
    open: [
      "| F-001 | P1 | ? | a | ev | ? |", // both sides change F-001 -> conflict
      "| F-002 | P2 | ? | b | ev | ? |",
      "| F-003 | P1 | ? | c | ev | ? |",
    ],
    archive: ["| F-010 | ? | x | shipped |", "| F-011 | ? | y | shipped |"],
  });
  const theirs = board({
    open: [
      "| F-001 | P2 | ? | a | ev | ? |",
      "| F-002 | P2 | ? | b | ev | ? |",
      "| F-003 | P1 | ? | c | ev | ? |",
    ],
    archive: ["| F-010 | ? | x | shipped |", "| F-011 | ? | y | shipped |"],
  });

  const r = runMergeDriver(tmpdir(), base, ours, theirs);
  assert.strictEqual(r.status, 1, r.err);
  assert.match(r.out, /<<<<<<< ours/);
  for (const id of ["F-002", "F-003", "F-010", "F-011"]) {
    assert.strictEqual(
      (r.out.match(new RegExp(`\\| ${id} \\|`, "g")) || []).length,
      1,
      `non-conflicting ${id} survived the conflict`
    );
  }
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
  assert.ok(ga.includes("**/BACKLOG.md merge=backlog-demo"), "nested boards also route through the merge driver");
  assert.ok(ga.includes("*.sh text eol=lf"), "POSIX scripts pinned to LF across the Windows/WSL boundary");
  assert.ok(ga.includes("*.ps1 text eol=crlf"), "PowerShell scripts pinned to CRLF for Windows");

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

test("merge driver for a linked worktree target registers against the MAIN worktree", async () => {
  const target = tmpdir();
  git(target, ["init", "-q"]);
  git(target, ["config", "user.email", "t@t.t"]);
  git(target, ["config", "user.name", "t"]);
  git(target, ["commit", "--allow-empty", "-q", "-m", "seed"]);

  // deploy the main checkout first, then a linked feature worktree
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });
  const wt = path.join(target, "..", path.basename(target) + "-wt");
  git(target, ["worktree", "add", "-q", wt, "-b", "feat-x"]);
  await h.deploy(wt, { name: "Demo", yes: true, isUpdate: true });

  const driver = git(target, ["config", "--get", "merge.backlog-demo.driver"]);
  const mainScript = path.join(target, "scripts", "qa", "merge-backlog.js").split(path.sep).join("/");
  const wtScript = path.join(wt, "scripts", "qa", "merge-backlog.js").split(path.sep).join("/");
  assert.ok(driver.includes(mainScript), `driver points at the main worktree's script: ${driver}`);
  assert.ok(!driver.includes(wtScript), "driver must not point into the feature worktree");
  assert.strictEqual(h.resolveDriverRoot(wt), path.resolve(target), "worktree target resolves to the main worktree");
  assert.strictEqual(h.resolveDriverRoot(target), path.resolve(target), "main target stays itself");

  // the registered path survives worktree removal (no dangling driver)
  git(target, ["worktree", "remove", "--force", wt]);
  assert.ok(exists(path.join(target, "scripts", "qa", "merge-backlog.js")), "driver script survives worktree removal");
});

test("isWindowsMount flags WSL Windows-drive mounts only on POSIX hosts", () => {
  assert.strictEqual(h.isWindowsMount("/mnt/c/develop/FamilyBudget", "linux"), true);
  assert.strictEqual(h.isWindowsMount("/mnt/d/x", "linux"), true);
  assert.strictEqual(h.isWindowsMount("/home/ronen/develop/x", "linux"), false);
  assert.strictEqual(h.isWindowsMount("C:\\develop\\x", "win32"), false);
  assert.strictEqual(h.isWindowsMount("/mnt/c/develop/x", "win32"), false);
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

test("test:integrate targets origin/main, not the branch's own remote (post-rebase force-push)", () => {
  // Regression: a feature branch tracks `origin/<feature>`. After
  // `git rebase origin/main` the branch is ahead of its stale remote and behind
  // nothing on main — but the old gate compared HEAD to `@{u}` and demanded a
  // rebase that had just been done, blocking every legitimate force-push.
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
  fs.copyFileSync(
    path.join(h.TEMPLATES_DIR, "scripts", "qa", "check-integrate.js"),
    path.join(work, "scripts", "qa", "check-integrate.js")
  );
  writeFile(work, "f.txt", "v1\n");
  execFileSync("git", ["add", "-A"], { cwd: work });
  execFileSync("git", ["commit", "-q", "-m", "one"], { cwd: work });
  execFileSync("git", ["push", "-q", "-u", "origin", "main"], { cwd: work });

  execFileSync("git", ["checkout", "-q", "-b", "f-x"], { cwd: work });
  writeFile(work, "f.txt", "v2\n");
  execFileSync("git", ["commit", "-q", "-am", "two"], { cwd: work });
  execFileSync("git", ["push", "-q", "-u", "origin", "f-x"], { cwd: work });

  // rewrite the branch (amend) -> now ahead of the stale origin/f-x, behind main 0
  execFileSync("git", ["commit", "-q", "--amend", "-m", "two rewritten"], { cwd: work });

  const r = runIntegrateGate(work);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /up to date with origin\/main/);
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

// ---------------------------------------------------------------- test:wiring gate (orphan detector)

function scaffoldWiringTarget(scripts, files) {
  const target = tmpdir();
  fs.mkdirSync(path.join(target, "scripts", "qa"), { recursive: true });
  fs.copyFileSync(
    path.join(h.TEMPLATES_DIR, "scripts", "qa", "check-test-wiring.js"),
    path.join(target, "scripts", "qa", "check-test-wiring.js")
  );
  writeFile(target, "package.json", JSON.stringify({ scripts }, null, 2) + "\n");
  for (const [rel, content] of Object.entries(files)) writeFile(target, rel, content);
  return target;
}

function runWiringGate(target, args = []) {
  const res = spawnSync(process.execPath, ["scripts/qa/check-test-wiring.js", ...args], {
    cwd: target,
    encoding: "utf8",
  });
  return { status: res.status, out: (res.stdout || "") + (res.stderr || "") };
}

test("test:wiring fails a test file no script executes in an explicitly-managed test dir", () => {
  const t = scaffoldWiringTarget(
    { "test:quick": "node --test --test-force-exit scripts/qa/tests/a.test.js" },
    {
      "scripts/qa/tests/a.test.js": "// a\n",
      "scripts/qa/tests/b.test.js": "// orphan\n",
      "scripts/qa/tests/helpers.js": "// not a test file\n",
    }
  );
  const r = runWiringGate(t);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /b\.test\.js is in an explicitly-managed test directory/);
  assert.match(r.out, /a\.test\.js \(wired via/);
  assert.doesNotMatch(r.out, /helpers\.js/);
});

test("test:wiring accepts dir/glob wiring, waivers, and discovery-runner notices", () => {
  const viaGlob = scaffoldWiringTarget(
    { "test:quick": "node --test scripts/qa/tests/*.js" },
    { "scripts/qa/tests/a.test.js": "// a\n" }
  );
  let r = runWiringGate(viaGlob);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /wired via `scripts\/qa\/tests\/\*\.js`/);

  const viaWaiver = scaffoldWiringTarget(
    { "test:quick": "node --test scripts/qa/tests/a.test.js" },
    {
      "scripts/qa/tests/a.test.js": "// a\n",
      "scripts/qa/tests/b.test.js": "// test-wiring-waived: fixture loaded by a.test.js\n",
    }
  );
  r = runWiringGate(viaWaiver);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /waived: fixture loaded/);

  // a bare discovery runner executes default matches; per-file wiring is a notice
  const discovery = scaffoldWiringTarget(
    { "test:e2e": "playwright test", "test:e2e:install": "playwright install chromium" },
    { "e2e/smoke.spec.ts": "// spec\n" }
  );
  r = runWiringGate(discovery);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /default-discovery `playwright test`/);
  r = runWiringGate(discovery, ["--strict"]);
  assert.strictEqual(r.status, 1, r.out);

  // `playwright install` is not a test run — the spec file is an orphan, not a notice
  const installOnly = scaffoldWiringTarget(
    { "test:e2e:install": "playwright install chromium" },
    { "e2e/smoke.spec.ts": "// spec\n" }
  );
  r = runWiringGate(installOnly);
  assert.strictEqual(r.status, 1, r.out);
});

// ---------------------------------------------------------------- test:linger gate (exit contract)

function scaffoldLingerTarget(fileName, content) {
  const target = tmpdir();
  fs.mkdirSync(path.join(target, "scripts", "qa"), { recursive: true });
  fs.copyFileSync(
    path.join(h.TEMPLATES_DIR, "scripts", "qa", "check-linger.js"),
    path.join(target, "scripts", "qa", "check-linger.js")
  );
  writeFile(target, fileName, content);
  writeFile(
    target,
    "package.json",
    JSON.stringify({ scripts: { "test:quick": `node ${fileName}` } }) + "\n"
  );
  return target;
}

function runLingerGate(target, args) {
  const res = spawnSync(process.execPath, ["scripts/qa/check-linger.js", ...args], {
    cwd: target,
    encoding: "utf8",
    timeout: 30000,
  });
  return { status: res.status, out: (res.stdout || "") + (res.stderr || "") };
}

test("test:linger flags a passing-but-idling suite and passes a prompt exit", () => {
  const idler = scaffoldLingerTarget(
    "slow.js",
    "console.log('\\u2139 tests 2'); console.log('\\u2139 duration_ms 50'); setTimeout(function () {}, 2500);\n"
  );
  const r = runLingerGate(idler, ["--max-linger", "1", "--", "node", "slow.js"]);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /LINGER/);
  assert.match(r.out, /runner-reported tests: 2/);

  const prompt = scaffoldLingerTarget(
    "fast.js",
    "console.log('\\u2139 tests 2'); console.log('\\u2139 duration_ms 50');\n"
  );
  const r2 = runLingerGate(prompt, ["--max-linger", "1", "--", "node", "fast.js"]);
  assert.strictEqual(r2.status, 0, r2.out);
  assert.match(r2.out, /exit contract holds/);

  // the child's failure is propagated when there is no linger
  const failing = scaffoldLingerTarget(
    "fail.js",
    "console.log('\\u2139 tests 1'); console.log('\\u2139 duration_ms 5'); process.exit(5);\n"
  );
  const r3 = runLingerGate(failing, ["--", "node", "fail.js"]);
  assert.strictEqual(r3.status, 5, r3.out);
});

// ---------------------------------------------------------------- test-design parameters + persona gates

test("deploy ships the test-design parameters and wires test:wiring / test:linger", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });

  assert.ok(exists(path.join(target, "scripts", "qa", "check-test-wiring.js")), "wiring gate deployed");
  assert.ok(exists(path.join(target, "scripts", "qa", "check-linger.js")), "linger gate deployed");

  const pkg = JSON.parse(read(path.join(target, "package.json")));
  assert.strictEqual(pkg.scripts["test:wiring"], "node scripts/qa/check-test-wiring.js");
  assert.strictEqual(pkg.scripts["test:linger"], "node scripts/qa/check-linger.js");

  const tdp = path.join(target, ".agents", "memory", "test-design-parameters.md");
  assert.ok(exists(tdp), "test-design-parameters scaffold created");
  const src = read(tdp);
  assert.match(src, /\| T1 \|/);
  assert.match(src, /\| T7 \|/);
  assert.match(src, /\| T10 \|/);

  // project-owned: preserved across update
  fs.writeFileSync(tdp, "my custom T rules\n", "utf8");
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: true });
  assert.strictEqual(read(tdp), "my custom T rules\n", "project test-design-parameters preserved");
});

test("qa-architect persona carries the T1–T10 checklist and QA-plan record sections", () => {
  const skill = read(path.join(h.TEMPLATES_DIR, ".agents", "skills", "qa-architect", "SKILL.md"));
  assert.match(skill, /Test design & economics/);
  assert.match(skill, /Independent oracle/);
  assert.match(skill, /Test quality is part of coverage/);
  assert.match(skill, /## Test budget/);
  assert.match(skill, /## Oracle & owner/);
  assert.match(skill, /## Test-design self-check/);
  assert.match(skill, /test:wiring/);
  assert.match(skill, /test-design-parameters\.md/);

  const agent = read(path.join(h.TEMPLATES_DIR, ".opencode", "agents", "qa-architect.md"));
  assert.match(agent, /test-design-parameters\.md/);
  assert.match(agent, /test:wiring/);
  assert.doesNotMatch(agent, /\.agents\/memory\/qa-plan\.md/, "stale legacy qa-plan path removed");

  const runner = read(path.join(h.TEMPLATES_DIR, ".agents", "skills", "qa-runner", "SKILL.md"));
  assert.match(runner, /test:wiring/);
  assert.match(runner, /check-linger\.js/);
  assert.match(runner, /passing-but-idling/);

  const planReadme = read(path.join(h.TEMPLATES_DIR, ".agents", "qa-plans", "README.md"));
  assert.match(planReadme, /## Test budget/);
  assert.match(planReadme, /## Oracle & owner/);
  assert.match(planReadme, /## Test-design self-check/);

  const rulebook = read(path.join(h.TEMPLATES_DIR, ".agents", "AGENTS.md"));
  assert.match(rulebook, /test:wiring/);
  assert.match(rulebook, /test-design-parameters\.md/);
  assert.match(rulebook, /Test quality & economics rule/);

  const wiringCheck = read(path.join(h.TEMPLATES_DIR, "scripts", "qa", "check-qa-scripts.js"));
  assert.match(wiringCheck, /test:wiring/);
  assert.match(wiringCheck, /test:linger/);
});

test("qa-runner writes verbatim evidence to .agents/qa-runs and reports path + sha256", () => {
  const agent = read(path.join(h.TEMPLATES_DIR, ".opencode", "agents", "qa-runner.md"));
  assert.match(agent, /\.agents\/qa-runs\//);
  assert.match(agent, /evidence\.txt/);
  assert.match(agent, /hash-file/);
  assert.doesNotMatch(agent, /Pass\/fail per suite with verbatim failure detail/, "verbatim logs are no longer demanded in the message");

  const skill = read(path.join(h.TEMPLATES_DIR, ".agents", "skills", "qa-runner", "SKILL.md"));
  assert.match(skill, /\.agents\/qa-runs\//);
  assert.match(skill, /evidence\.txt/);
  assert.match(skill, /hash-file\.js/);
  assert.match(skill, /sha256/i);
});

test("qa-runs evidence scaffold is deployed and preserved on re-deploy", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });
  const readme = path.join(target, ".agents", "qa-runs", "README.md");
  assert.ok(exists(readme), "qa-runs scaffold deployed");
  fs.writeFileSync(readme, "custom project data", "utf8");
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: true });
  assert.strictEqual(read(readme), "custom project data", "project qa-runs README preserved");
});

test("hash-file prints a sha256sum-style digest and fails cleanly on a missing file", () => {
  const crypto = require("crypto");
  const t = tmpdir();
  const f = path.join(t, "evidence.txt");
  fs.writeFileSync(f, "hello\n", "utf8");
  const expected = crypto.createHash("sha256").update(read(f)).digest("hex");

  const res = spawnSync(
    process.execPath,
    [path.join(h.TEMPLATES_DIR, "scripts", "qa", "hash-file.js"), f],
    { encoding: "utf8" }
  );
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(res.stdout, new RegExp("^" + expected + "  "));

  const bad = spawnSync(
    process.execPath,
    [path.join(h.TEMPLATES_DIR, "scripts", "qa", "hash-file.js"), path.join(t, "nope.txt")],
    { encoding: "utf8" }
  );
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /hash-file: /);
});

// ---------------------------------------------------------------- context-guard core + plugin

const CG = path.join(h.TEMPLATES_DIR, "scripts", "qa", "context-guard-core.js");
const cg = require(CG);

test("context-guard parses the orchestration.md tables and falls back to defaults", () => {
  const fromTemplate = cg.parseThresholds(
    read(path.join(h.TEMPLATES_DIR, ".agents", "memory", "orchestration.md"))
  );
  assert.deepStrictEqual(fromTemplate.turns, {
    checkpoint_warning_turn: 50,
    soft_turn_budget: 60,
    compaction_target_turn: 60,
    new_context_preference_turn: 80,
    hard_safety_turn_limit: 100,
  });
  assert.deepStrictEqual(fromTemplate.stuck, {
    same_failure_turns: 3,
    identical_tool_calls: 3,
    no_state_change_turns: 4,
  });
  assert.deepStrictEqual(fromTemplate.request, {
    observe: 50000,
    warn: 80000,
    checkpoint: 120000,
    intervene: 160000,
  });

  assert.deepStrictEqual(cg.parseThresholds(""), cg.parseThresholds(null), "missing file -> documented defaults");

  const custom = cg.parseThresholds(
    [
      "| `compaction_target_turn` | 25 | x |",
      "| `identical_tool_calls` | 5 | x |",
      "| warn | 40K | x |",
      "| checkpoint | 90K+ | x |",
    ].join("\n")
  );
  assert.strictEqual(custom.turns.compaction_target_turn, 25);
  assert.strictEqual(custom.turns.checkpoint_warning_turn, 50, "unstated rows keep the default");
  assert.strictEqual(custom.stuck.identical_tool_calls, 5);
  assert.strictEqual(custom.request.warn, 40000);
  assert.strictEqual(custom.request.checkpoint, 90000);
});

test("context-guard resolves turn bands by threshold value (retunable, not a fixed ladder)", () => {
  const turns = cg.parseThresholds("").turns;
  assert.strictEqual(cg.turnBand(49, turns), null);
  assert.strictEqual(cg.turnBand(50, turns), "warning");
  assert.strictEqual(cg.turnBand(59, turns), "warning");
  assert.strictEqual(cg.turnBand(60, turns), "checkpoint");
  assert.strictEqual(cg.turnBand(79, turns), "checkpoint");
  assert.strictEqual(cg.turnBand(80, turns), "new-context");
  assert.strictEqual(cg.turnBand(99, turns), "new-context");
  assert.strictEqual(cg.turnBand(100, turns), "hard");

  const retuned = { ...turns, checkpoint_warning_turn: 20, compaction_target_turn: 30 };
  assert.strictEqual(cg.turnBand(29, retuned), "warning");
  assert.strictEqual(cg.turnBand(35, retuned), "checkpoint", "highest reached threshold wins");
});

test("context-guard injected text is byte-stable per band and never interpolated", () => {
  for (const band of ["warning", "checkpoint", "new-context", "hard"]) {
    const first = cg.bandText(band);
    assert.ok(first && first.startsWith("CONTEXT GUARD"));
    assert.strictEqual(cg.bandText(band), first, "re-reading a band returns the identical string");
    assert.doesNotMatch(first, /\b(50|60|80|100)\b/, "no threshold numeral is baked into the text");
  }
  assert.strictEqual(cg.bandText("unknown"), null);
  assert.ok(cg.LOOP_TEXT.startsWith("CONTEXT GUARD"));
});

test("context-guard composes band + funds + loop text in order (or null)", () => {
  const thresholds = cg.parseThresholds("");
  const state = cg.createSessionState();
  assert.strictEqual(cg.composeGuardText(state, thresholds), null, "nothing to say -> null");

  state.turns = 50;
  assert.strictEqual(cg.composeGuardText(state, thresholds), cg.BAND_TEXT.warning);

  state.turns = 60;
  state.fundsPending = true;
  state.fundsNotice = cg.fundsText("deepseek/deepseek-v4-pro", "tool:task");
  state.loopPending = true;
  const composed = cg.composeGuardText(state, thresholds);
  assert.ok(composed.startsWith(cg.BAND_TEXT.checkpoint), "band leads");
  assert.ok(composed.includes(state.fundsNotice), "funds stop is included");
  assert.ok(composed.endsWith(cg.LOOP_TEXT), "loop rule trails");
});

test("context-guard counts assistant turns once and reports band/request crossings", () => {
  const thresholds = cg.parseThresholds("");
  const state = cg.createSessionState();
  const msg = (id, tokens) => ({ id, role: "assistant", tokens });

  let note = cg.noteAssistant(state, msg("m1", { input: 30000, cache: { read: 25000 } }), thresholds);
  assert.strictEqual(note.newTurn, true);
  assert.strictEqual(note.turns, 1);
  assert.strictEqual(note.band, null);
  assert.strictEqual(note.requestTokens, 55000);
  assert.strictEqual(note.requestLevel, "observe");
  assert.strictEqual(note.requestChanged, true);

  note = cg.noteAssistant(state, msg("m1", { input: 30000, cache: { read: 25000 } }), thresholds);
  assert.strictEqual(note.newTurn, false, "same message id is not a second turn");
  assert.strictEqual(state.turns, 1);

  note = cg.noteAssistant(state, msg("m2", { input: 20000, cache: { read: 70000, write: 1000 } }), thresholds);
  assert.strictEqual(note.requestTokens, 91000);
  assert.strictEqual(note.requestLevel, "warn");
  assert.strictEqual(note.requestChanged, true);

  for (let i = 3; i <= 50; i++) note = cg.noteAssistant(state, msg("m" + i, null), thresholds);
  assert.strictEqual(state.turns, 50);
  assert.strictEqual(note.band, "warning");
  assert.strictEqual(note.bandChanged, true);

  note = cg.noteAssistant(state, msg("m51", null), thresholds);
  assert.strictEqual(note.newTurn, true);
  assert.strictEqual(note.bandChanged, false, "the same band is not re-reported");
});

test("context-guard counts identical tool calls cumulatively and flags the breach once", () => {
  const stuck = cg.parseThresholds("").stuck;
  const state = cg.createSessionState();
  const args = { command: "npm run test:quick" };

  assert.strictEqual(cg.noteToolCall(state, "bash", args, stuck).count, 1);
  assert.strictEqual(cg.noteToolCall(state, "bash", { command: "npm run test:quick" }, stuck).count, 2);
  let note = cg.noteToolCall(state, "bash", args, stuck);
  assert.strictEqual(note.count, 3);
  assert.strictEqual(note.firstFlag, true, "the 3rd identical call is the first flag");
  assert.strictEqual(note.loop, true);
  assert.ok(note.keyHash);

  note = cg.noteToolCall(state, "bash", args, stuck);
  assert.strictEqual(note.loop, true);
  assert.strictEqual(note.firstFlag, false, "the breach is only reported once");
  assert.strictEqual(state.loopPending, true);

  note = cg.noteToolCall(state, "read", { filePath: "a.ts" }, stuck);
  assert.strictEqual(note.loop, false);
  assert.strictEqual(state.loopPending, false, "a materially different call clears the recovery nudge");

  assert.strictEqual(
    cg.loopKey("edit", { filePath: "x.ts", oldString: "a", newString: "b" }),
    cg.loopKey("edit", { newString: "b", oldString: "a", filePath: "x.ts" }),
    "argument key order does not create a distinct call"
  );
});

test("context-guard excludes legitimate polling/glue repeats from the loop counter", () => {
  const stuck = cg.parseThresholds("").stuck;
  const state = cg.createSessionState();
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(cg.noteToolCall(state, "todowrite", { todos: [] }, stuck).counted, false);
    assert.strictEqual(cg.noteToolCall(state, "question", {}, stuck).counted, false);
    assert.strictEqual(cg.noteToolCall(state, "task", { prompt: "x" }, stuck).counted, false);
    assert.strictEqual(cg.noteToolCall(state, "backlog_list", {}, stuck).counted, false);
    assert.strictEqual(cg.noteToolCall(state, "batch", {}, stuck).counted, false);
    assert.strictEqual(cg.noteToolCall(state, "session_info", {}, stuck).counted, false);
    assert.strictEqual(cg.noteToolCall(state, "bash", { command: "node scripts/serve.js list" }, stuck).counted, false);
    assert.strictEqual(cg.noteToolCall(state, "bash", { command: "node scripts/serve.js status" }, stuck).counted, false);
  }
  assert.strictEqual(state.toolCounts.size, 0);
  assert.strictEqual(state.loopPending, false);
});

test("context-guard events are one JSON object per line with a leading ts", () => {
  const line = cg.formatGuardEvent({ kind: "band", sessionID: "ses_1", band: "checkpoint", turn: 61 });
  assert.match(line, /\n$/);
  assert.strictEqual(line.trimEnd().split("\n").length, 1);
  const parsed = JSON.parse(line);
  assert.strictEqual(parsed.kind, "band");
  assert.strictEqual(parsed.sessionID, "ses_1");
  assert.strictEqual(parsed.turn, 61);
  assert.ok(!Number.isNaN(Date.parse(parsed.ts)));
});

test("branch-switch guard detects a HEAD move (the 2026-09-18 direct-push-to-main shape)", () => {
  // The exact LibraryOS incident command: session B switched main under session A.
  assert.deepStrictEqual(
    cg.branchSwitch("cd /home/ronen/develop/PublicVirtualLibrary && git checkout main 2>&1 | tail -2 && git pull --ff-only 2>&1 | tail -2"),
    { ref: "main" }
  );
  assert.deepStrictEqual(cg.branchSwitch("git checkout -b docs/f-239-record-landing"), { ref: "docs/f-239-record-landing" });
  assert.deepStrictEqual(cg.branchSwitch("git switch main"), { ref: "main" });
  assert.deepStrictEqual(cg.branchSwitch("git switch -c feat/x"), { ref: "feat/x" });
  assert.deepStrictEqual(cg.branchSwitch("git -C /repo checkout develop"), { ref: "develop" });
  assert.deepStrictEqual(cg.branchSwitch("git checkout -"), { ref: "-" });
  assert.deepStrictEqual(cg.branchSwitch("git checkout --detach HEAD"), { ref: "HEAD" });
});

test("branch-switch guard ignores file restores and non-command-position mentions", () => {
  for (const command of [
    "git checkout -- BACKLOG.md .agents/memory/owned-files.md",
    "git checkout HEAD -- CHANGELOG.md",
    "git checkout .",
    "git checkout -- .",
    "git checkout main -- file.txt",
    "git checkout", // lists status
    "git restore --staged .",
    'echo "git checkout main"',
    'grep -rn "git checkout main" scripts/',
    "npm run test:quick",
  ]) {
    assert.strictEqual(cg.branchSwitch(command), null, `not a branch switch: ${command}`);
  }
  assert.strictEqual(cg.branchSwitch(""), null);
  assert.strictEqual(cg.branchSwitch(null), null);
});

test("branch-switch guard message names the ref + live sessions and points at isolation", () => {
  const text = cg.branchSwitchText("main", ["ses_A", "ses_B"]);
  assert.match(text, /\bmain\b/);
  assert.match(text, /ses_A/);
  assert.match(text, /ses_B/);
  assert.match(text, /backlog worktree/);
  assert.match(cg.branchSwitchText(null, []), /another branch/);
  assert.match(cg.branchSwitchText(null, []), /another primary session/);
});

test("context-guard recognizes provider funds/quota errors (hard stop) and ignores ordinary failures", () => {
  assert.strictEqual(cg.fundsError("Error: Insufficient balance"), true);
  assert.strictEqual(cg.fundsError("provider error: insufficient funds"), true);
  assert.strictEqual(cg.fundsError("You are out of credits"), true);
  assert.strictEqual(cg.fundsError("usage limit reached for this model"), true);
  assert.strictEqual(cg.fundsError("quota exceeded"), true);
  assert.strictEqual(cg.fundsError('{"statusCode":402,"message":"payment required"}'), true);
  assert.strictEqual(cg.fundsError("3 tests failed: expected 1 to equal 2"), false);
  assert.strictEqual(cg.fundsError("rate limit exceeded, retry in 20s"), false, "a transient rate limit is not a funds stop");
  assert.strictEqual(cg.fundsError(""), false);
  assert.strictEqual(cg.fundsError(null), false);
  assert.ok(cg.FUNDS_TEXT.startsWith("PROVIDER GUARD"));
  assert.match(cg.FUNDS_TEXT, /do NOT do the persona's work inline/);
  assert.strictEqual(cg.createSessionState().fundsPending, false, "the funds stop starts disarmed");
  assert.strictEqual(cg.createSessionState().fundsNotice, null, "no stale attribution notice");

  // Attribution: the failing provider/model is named from observed metadata.
  assert.strictEqual(cg.modelLabel({ providerID: "opencode", modelID: "gpt-5.6-luna" }), "opencode/gpt-5.6-luna");
  assert.strictEqual(cg.modelLabel({ provider: "deepseek", model: "deepseek-v4-pro" }), "deepseek/deepseek-v4-pro");
  assert.strictEqual(cg.modelLabel({ modelID: "solo" }), "solo");
  assert.strictEqual(cg.modelLabel({}), null);
  assert.strictEqual(cg.modelLabel(null), null);
  assert.strictEqual(cg.fundsText(), cg.FUNDS_TEXT, "the generic rule stays byte-identical when nothing is known");
  const named = cg.fundsText("opencode/gpt-5.6-luna", "tool:task");
  assert.match(named, /from `opencode\/gpt-5\.6-luna`/);
  assert.match(named, /observed in tool:task/);
  assert.match(named, /Announce the failing provider\/model/);
  assert.doesNotMatch(cg.fundsText(null, "session.error"), /from `/);
});

test("context-guard plugin source-contract: hooks wired to the core, no hardcoded thresholds", () => {
  const src = read(path.join(h.TEMPLATES_DIR, ".opencode", "plugins", "context-guard.ts"));
  assert.match(src, /from "@opencode-ai\/plugin"/);
  assert.match(src, /context-guard-core\.js/, "loads the shared pure core");
  for (const hook of [
    "event:",
    '"tool.execute.before"',
    '"tool.execute.after"',
    '"experimental.chat.messages.transform"',
    '"permission.ask"',
  ]) {
    assert.ok(src.includes(hook), `hook ${hook} present`);
  }
  assert.doesNotMatch(
    src,
    /"experimental\.chat\.system\.transform"/,
    "the guard must never mutate the system prompt on a band crossing (it evicts the provider prompt cache)"
  );
  assert.match(src, /orchestration\.md/, "thresholds come from the project memory file");
  assert.match(src, /parseThresholds/, "parses thresholds at runtime");
  assert.match(src, /file\.watcher\.updated/, "invalidates the threshold cache on edits");
  assert.match(src, /guard-events\.jsonl/);
  assert.match(src, /guard-event log write failed/, "a failed guard-log write is surfaced, never silent");
  assert.match(src, /childSessions/, "child sessions are tracked to be excluded from band/loop counting");
  assert.match(src, /lease-lib\.js/, "leases use the shared liveness lib test:concurrency also reads");
  assert.match(src, /writeLease/, "primary session creation records the lease");
  assert.match(src, /clearLease/, "session deletion clears the lease");
  assert.match(src, /touchLease/, "activity heartbeats the lease so a live-but-quiet session stays live");
  assert.match(src, /pruneLeases/, "startup sweep clears crashed/closed sessions' leases");
  assert.match(src, /branchSwitch\(/, "detects a branch-switch command via the shared core");
  assert.match(src, /branchSwitchText/, "the block message comes from the shared core");
  assert.match(src, /throw new Error\(message\)/, "the branch guard THROWS to abort the switch");
  assert.match(src, /childParent/, "child->parent mapping attributes subagent funds errors to the orchestrator");
  assert.match(src, /sessionModel/, "tracks the observed provider/model per session");
  assert.match(src, /modelLabel\(meta\.model\)/, "names the failed provider/model from the dispatch metadata");
  assert.match(src, /fundsText/, "injects an attributed funds-stop notice");
  assert.match(src, /fundsArmText/, "the tool-result funds scan is gated to structured failure evidence");
  assert.match(src, /composeGuardText/, "composes the core's byte-stable guard text");
  assert.match(src, /messages\.push/, "appends the guard text as a tail message, never the system prompt");
  assert.match(src, /synthetic: true/, "the injected tail message is marked synthetic");
  assert.match(src, /GUARD_MESSAGE_ID/, "a stable id replaces the tail message in place on re-request");
  assert.match(src, /fundsError/, "detects provider funds/quota errors mechanically");
  assert.match(src, /session\.error/, "also watches provider session errors");
  assert.match(src, /fundsPending = false/, "a user message releases the funds stop");
  assert.match(src, /doom_loop/, "builds on the built-in doom-loop permission");
  assert.doesNotMatch(src, /identical_tool_calls\s*[:=]\s*\d/, "no hardcoded loop threshold");
  assert.doesNotMatch(src, /(?:===|==|>=|>)\s*(?:50|60|80|100)\b/, "no hardcoded turn band numbers");
});

test("context-guard injects at the conversation tail and never mutates the cached prefix", async () => {
  const { pathToFileURL } = require("node:url");
  const pluginPath = path.join(h.TEMPLATES_DIR, ".opencode", "plugins", "context-guard.ts");
  const mod = await import(pathToFileURL(pluginPath).href);
  const plugin = await mod.ContextGuard({
    directory: tmpdir(),
    client: { app: { log: async () => {} } },
  });

  const sid = "ses_guard_primary";
  await plugin.event({ event: { type: "session.created", properties: { info: { id: sid } } } });
  // Cross the first band (checkpoint warning at turn 50).
  for (let i = 1; i <= 50; i++) {
    await plugin.event({
      event: {
        type: "message.updated",
        properties: { info: { id: "m" + i, role: "assistant", sessionID: sid } },
      },
    });
  }

  const messages = [
    { info: { role: "user", sessionID: sid }, parts: [{ type: "text", text: "hello" }] },
    { info: { role: "assistant", sessionID: sid }, parts: [{ type: "text", text: "working" }] },
    { info: { role: "user", sessionID: sid }, parts: [{ type: "text", text: "continue" }] },
  ];
  const before = JSON.parse(JSON.stringify(messages));
  const output = { messages };
  await plugin["experimental.chat.messages.transform"]({}, output);

  assert.strictEqual(messages.length, before.length + 1, "one synthetic guard message is appended");
  assert.deepStrictEqual(
    messages.slice(0, before.length),
    before,
    "the entire stored transcript is byte-identical — the provider prompt cache survives"
  );
  const injected = messages[messages.length - 1];
  assert.strictEqual(injected.info.role, "user");
  assert.strictEqual(injected.info.synthetic, true);
  assert.strictEqual(injected.parts.length, 1);
  assert.match(injected.parts[0].text, /CONTEXT GUARD/);
  assert.match(injected.parts[0].text, /checkpoint warning/);

  // A re-request in the same turn must update in place, never stack duplicates.
  await plugin["experimental.chat.messages.transform"]({}, output);
  assert.strictEqual(messages.length, before.length + 1, "no duplicate guard message");

  // Crossing the next band updates the tail message while the prefix stays put.
  for (let i = 51; i <= 60; i++) {
    await plugin.event({
      event: {
        type: "message.updated",
        properties: { info: { id: "m" + i, role: "assistant", sessionID: sid } },
      },
    });
  }
  await plugin["experimental.chat.messages.transform"]({}, output);
  assert.strictEqual(messages.length, before.length + 1);
  assert.match(messages[messages.length - 1].parts[0].text, /soft turn budget reached/);
  assert.deepStrictEqual(messages.slice(0, before.length), before, "prefix still byte-identical");

  // A child/subagent session is never nudged.
  await plugin.event({
    event: {
      type: "session.created",
      properties: { info: { id: "ses_guard_child", parentID: sid } },
    },
  });
  const childMessages = [{ info: { role: "user", sessionID: "ses_guard_child" }, parts: [] }];
  await plugin["experimental.chat.messages.transform"]({}, { messages: childMessages });
  assert.strictEqual(childMessages.length, 1, "subagent sessions get no guard message");
});

test("branch-switch plugin guard aborts a HEAD move only while another live session shares the checkout", async () => {
  const { pathToFileURL } = require("node:url");
  const leases = require(path.join(h.TEMPLATES_DIR, "scripts", "qa", "lease-lib.js"));
  const pluginPath = path.join(h.TEMPLATES_DIR, ".opencode", "plugins", "context-guard.ts");
  const mod = await import(pathToFileURL(pluginPath).href);
  const client = { app: { log: async () => {} } };

  // Two primary sessions in one checkout: another live lease is present.
  const shared = tmpdir();
  leases.writeLease(shared, "ses_other", {});
  const plugin = await mod.ContextGuard({ directory: shared, client });
  await plugin.event({ event: { type: "session.created", properties: { info: { id: "ses_me" } } } });

  await assert.rejects(
    plugin["tool.execute.before"](
      { tool: "bash", sessionID: "ses_me", callID: "c1" },
      { args: { command: "cd /repo && git checkout main 2>&1 | tail -2" } }
    ),
    /SESSION GUARD[\s\S]*ses_other[\s\S]*backlog worktree/,
    "the switch is aborted (thrown) while another live session shares the tree"
  );

  // File restores and non-git commands are never blocked.
  for (const command of ["git checkout -- BACKLOG.md", "git restore --staged .", "npm run test:quick"]) {
    await plugin["tool.execute.before"](
      { tool: "bash", sessionID: "ses_me", callID: "c2" },
      { args: { command } }
    );
  }

  // Solo checkout: the same switch is allowed.
  const solo = tmpdir();
  const soloPlugin = await mod.ContextGuard({ directory: solo, client });
  await soloPlugin.event({ event: { type: "session.created", properties: { info: { id: "ses_solo" } } } });
  await soloPlugin["tool.execute.before"](
    { tool: "bash", sessionID: "ses_solo", callID: "c3" },
    { args: { command: "git checkout main" } }
  );

  // A dead-pid lease is not live, so it must not block an innocent switch.
  const dead = tmpdir();
  const deadDir = path.join(dead, ".serve", "sessions");
  fs.mkdirSync(deadDir, { recursive: true });
  fs.writeFileSync(
    path.join(deadDir, "ses_dead.json"),
    JSON.stringify({
      sessionID: "ses_dead",
      pid: 99999999,
      bootId: leases.bootId(),
      procStart: "1",
      startedAt: Date.now(),
      heartbeatAt: Date.now(),
    })
  );
  const deadPlugin = await mod.ContextGuard({ directory: dead, client });
  await deadPlugin.event({ event: { type: "session.created", properties: { info: { id: "ses_d" } } } });
  await deadPlugin["tool.execute.before"](
    { tool: "bash", sessionID: "ses_d", callID: "c4" },
    { args: { command: "git switch main" } }
  );
});

test("funds scan trusts only structured failure evidence — docs quoting the rule never arm the stop", () => {
  // The exact F-169 regression: the mandated session-start read of model-routing.md
  // contains the literal trigger phrases; a healthy session must not pause on it.
  const doc =
    "A provider error reporting insufficient funds / balance / credits / quota " +
    "(`insufficient balance`, `insufficient funds`, `out of credits`, `usage limit reached`, HTTP 402, ...)";
  assert.strictEqual(cg.fundsArmText("read", { output: doc, metadata: {} }), null);
  assert.strictEqual(cg.fundsArmText("grep", { output: doc, metadata: { matches: 4 } }), null);
  assert.strictEqual(cg.fundsArmText("glob", { output: doc, metadata: { count: 1 } }), null);
  assert.strictEqual(cg.fundsArmText("bash", { output: doc, metadata: { exit: 0 } }), null);
  assert.strictEqual(
    cg.fundsArmText("task", { output: doc, metadata: { model: { providerID: "opencode", modelID: "gpt-5.6-luna" } } }),
    null,
    "a successful dispatch whose report quotes the rule is not a failure"
  );
  assert.strictEqual(cg.fundsArmText("bash", { output: doc, metadata: { exit: null } }), null);
  assert.strictEqual(cg.fundsArmText("bash", { output: doc, metadata: {} }), null);
  assert.strictEqual(cg.fundsArmText(null, {}), null);
  assert.strictEqual(cg.fundsArmText(undefined, undefined), null);

  // A failed dispatch (real observed shape) still arms, attributed to the model.
  const failedTask = cg.fundsArmText("task", {
    error:
      "Subagent failed (task_id: ses_x): Insufficient balance. Manage your billing here: https://opencode.ai/workspace/wrk/billing",
    output: null,
    metadata: { model: { providerID: "opencode", modelID: "gpt-5.6-luna" } },
  });
  assert.match(failedTask, /Insufficient balance/);
  assert.ok(cg.fundsError(failedTask), "the task failure text still matches the narrow funds regex");

  // A command that exited non-zero (a provider CLI failing) is failure evidence.
  const failedBash = cg.fundsArmText("bash", { output: "Insufficient balance", metadata: { exit: 1 } });
  assert.match(failedBash, /Insufficient balance/);
  assert.strictEqual(
    cg.fundsArmText("read", { error: "Insufficient balance" }),
    "Insufficient balance",
    "a structured tool error on any tool is still scanned"
  );
});

test("context-guard plugin + core deploy, stay harness-owned, and the guard log is excluded clone-locally", async () => {
  const target = tmpdir();
  git(target, ["init", "-q"]);
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });

  const corePath = path.join(target, "scripts", "qa", "context-guard-core.js");
  assert.ok(exists(corePath), "guard core deployed");
  const plugin = read(path.join(target, ".opencode", "plugins", "context-guard.ts"));
  assert.match(plugin, /tool\.execute\.before/);
  assert.match(plugin, /experimental\.chat\.messages\.transform/);

  const exclude = read(path.join(target, ".git", "info", "exclude"));
  assert.ok(exclude.includes(".agents/guard-events.jsonl"), "runtime guard log is excluded clone-locally");

  fs.writeFileSync(corePath, "LOCAL EDIT", "utf8");
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: true });
  assert.match(read(corePath), /parseThresholds/, "guard core is harness-owned (restored on update)");
});

// ---------------------------------------------------------------- provider-stats / cost telemetry (Phase B)

const PS = path.join(h.TEMPLATES_DIR, "scripts", "qa", "provider-stats.js");
const ps = require(PS);

function fixtureSession(overrides = {}) {
  return {
    id: "ses_x",
    parentId: null,
    title: "session",
    directory: "C:/develop/Demo",
    agent: "build",
    model: "deepseek-flash",
    provider: "deepseek",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    turns: 0,
    toolCalls: 0,
    maxIdentical: 0,
    loops: [],
    timeCreated: 0,
    timeUpdated: 0,
    ...overrides,
  };
}
function fixtureDoc(sessions, extraMeta = {}) {
  return {
    schema: ps.SCHEMA,
    meta: { schema: ps.SCHEMA, root: "C:/develop/Demo", since: null, projectIds: ["p1"], stuck: { identical_tool_calls: 3 }, softTurnBudget: 60, ...extraMeta },
    sessions,
  };
}

test("provider-stats parses since windows, model cells, and percentiles deterministically", () => {
  const now = Date.parse("2026-09-12T00:00:00Z");
  assert.strictEqual(ps.parseSince(null, now), null);
  assert.strictEqual(ps.parseSince("all", now), null);
  assert.strictEqual(ps.parseSince("14d", now), now - 14 * 86400000);
  assert.strictEqual(ps.parseSince("36h", now), now - 36 * 3600000);
  assert.strictEqual(ps.parseSince("2w", now), now - 2 * 604800000);
  assert.strictEqual(ps.parseSince("1m", now), now - 30 * 86400000);
  assert.strictEqual(ps.parseSince("2026-09-01", now), Date.parse("2026-09-01"));
  assert.throws(() => ps.parseSince("banana", now), /invalid since value/);
  assert.throws(() => ps.parseSince("14y", now), /invalid since value/);

  assert.deepStrictEqual(ps.parseModelCell('{"id":"deepseek-flash","providerID":"deepseek"}'), { model: "deepseek-flash", provider: "deepseek" });
  assert.deepStrictEqual(ps.parseModelCell("opencode/gpt-5-nano"), { model: "opencode/gpt-5-nano", provider: "?" });
  assert.deepStrictEqual(ps.parseModelCell(""), { model: "?", provider: "?" });

  assert.strictEqual(ps.percentile([], 50), null);
  assert.strictEqual(ps.percentile([5, 1, 3, 2, 4], 50), 3);
  assert.strictEqual(ps.percentile([5, 1, 3, 2, 4], 90), 5);
  assert.strictEqual(ps.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
});

test("provider-stats resolves the real opencode exe past Windows shims", () => {
  const npmShim = "C:\\Users\\x\\AppData\\Roaming\\npm\\opencode";
  const npmExe = "C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe";
  const exec = () => npmShim + "\n" + npmShim + ".cmd\n";
  assert.strictEqual(
    ps.resolveOpencode({ platform: "win32", env: {}, exists: (p) => p === npmExe, execFileSync: exec }),
    npmExe,
    "the extensionless POSIX shim is not exec-able on Windows; the real exe wins"
  );
  assert.strictEqual(
    ps.resolveOpencode({ platform: "win32", env: {}, exists: (p) => p === npmShim + ".exe", execFileSync: exec }),
    npmShim + ".exe",
    "a sibling .exe is preferred"
  );
  assert.strictEqual(
    ps.resolveOpencode({ platform: "linux", env: {}, exists: (p) => p === "/usr/local/bin/opencode", execFileSync: () => "/usr/local/bin/opencode\n" }),
    "/usr/local/bin/opencode",
    "POSIX shim paths run directly"
  );
  assert.strictEqual(
    ps.resolveOpencode({ platform: "win32", env: { OPENCODE_BIN: "C:\\tools\\opencode.exe" }, exists: (p) => p === "C:\\tools\\opencode.exe", execFileSync: () => "" }),
    "C:\\tools\\opencode.exe",
    "OPENCODE_BIN always wins"
  );
  assert.strictEqual(ps.resolveOpencode({ platform: "linux", env: {}, exists: () => false, execFileSync: () => { throw new Error("not found"); } }), null);
});

test("provider-stats aggregates primary + subagent groups, cache share, percentiles, and loops", () => {
  const sessions = [
    fixtureSession({
      id: "ses_a",
      title: "F-001 feature",
      cost: 0.5,
      turns: 70,
      tokens: { input: 100, output: 50, reasoning: 10, cacheRead: 900, cacheWrite: 20 },
      maxIdentical: 1,
    }),
    fixtureSession({
      id: "ses_a1",
      parentId: "ses_a",
      title: "explore",
      cost: 0.25,
      turns: 5,
      maxIdentical: 4,
      loops: [{ tool: "bash", hash: "abcd1234", count: 4 }],
    }),
    fixtureSession({ id: "ses_b", title: "F-002 bugfix", cost: 0.2, turns: 10, model: "gpt-5.6-luna", provider: "opencode" }),
  ];
  const agg = ps.aggregateSessions(sessions, { stuck: { identical_tool_calls: 3 }, softTurnBudget: 60 });

  assert.strictEqual(agg.totals.sessions, 3);
  assert.strictEqual(agg.totals.primarySessions, 2);
  assert.strictEqual(agg.totals.subagentSessions, 1);
  assert.strictEqual(agg.totals.cost, 0.95);
  assert.strictEqual(agg.totals.turns, 85);
  // cache-read share = 900 / (100 + 900 + 20)
  assert.ok(Math.abs(agg.totals.cacheReadShare - 900 / 1020) < 1e-9);
  assert.strictEqual(agg.groups.ses_a.cost, 0.75, "a primary group includes its subagent sessions");
  assert.strictEqual(agg.groups.ses_a.turns, 70, "group turns are the primary's own turns");
  assert.strictEqual(agg.groups.ses_a.totalTurns, 75);
  assert.strictEqual(agg.groups.ses_a.sessions, 2);

  assert.strictEqual(agg.topSessions[0].id, "ses_a");
  assert.strictEqual(agg.topSessions[0].cost, 0.75);
  assert.deepStrictEqual(agg.topSessions[0].models, ["deepseek-flash"]);
  assert.strictEqual(agg.percentiles.primaryCost.p50, 0.2, "nearest-rank P50 of the two group costs");
  assert.strictEqual(agg.percentiles.primaryCost.p90, 0.75);
  assert.strictEqual(agg.percentiles.primaryTurns.p90, 70);

  assert.strictEqual(agg.sessionsOverTurnBudget.threshold, 60);
  assert.strictEqual(agg.sessionsOverTurnBudget.count, 1);
  assert.strictEqual(agg.sessionsOverTurnBudget.sessions[0].id, "ses_a");

  assert.strictEqual(agg.loopCandidates.threshold, 3);
  assert.strictEqual(agg.loopCandidates.count, 1);
  assert.strictEqual(agg.loopCandidates.sessions[0].id, "ses_a1");
  assert.strictEqual(agg.loopCandidates.sessions[0].count, 4);

  assert.strictEqual(agg.modelMix[0].sessions, 2, "model mix counts the subagent sessions too");
  assert.strictEqual(agg.modelMix[0].cost, 0.75);
});

test("provider-stats collects by project id (worktree-aware) and detects canonical identical calls", () => {
  const calls = [];
  const sessionRows = [
    { id: "ses_a", parent_id: null, title: "primary", directory: "C:/develop/Demo", agent: "build", model: '{"id":"deepseek-flash","providerID":"deepseek"}', cost: 0.5, tokens_input: 10, tokens_output: 5, tokens_reasoning: 1, tokens_cache_read: 90, tokens_cache_write: 0, time_created: 1, time_updated: 2 },
    { id: "ses_a1", parent_id: "ses_a", title: "child", directory: "C:/develop/Demo", agent: "explore", model: '{"id":"big-pickle","providerID":"opencode"}', cost: 0.1, tokens_input: 1, tokens_output: 1, tokens_reasoning: 0, tokens_cache_read: 5, tokens_cache_write: 0, time_created: 1, time_updated: 2 },
  ];
  const now = Date.parse("2026-09-12T00:00:00Z");
  const runDb = (sql) => {
    calls.push(sql);
    if (sql.includes("FROM project_directory")) return [{ id: "p1" }];
    if (sql.includes("FROM session s")) return sessionRows;
    if (sql.includes("FROM message")) return [{ session_id: "ses_a", turns: 70 }, { session_id: "ses_a1", turns: 3 }];
    if (sql.includes("FROM part")) {
      return [
        { session_id: "ses_a", tool: "bash", input: '{"command":"npm test"}' },
        { session_id: "ses_a", tool: "bash", input: '{"command":"npm test"}' },
        { session_id: "ses_a", tool: "bash", input: '{"command":"npm test"}' },
        { session_id: "ses_a", tool: "edit", input: '{"filePath":"a.ts","oldString":"x","newString":"y"}' },
        { session_id: "ses_a", tool: "edit", input: '{"newString":"y","oldString":"x","filePath":"a.ts"}' },
        { session_id: "ses_a", tool: "todowrite", input: '{"todos":[]}' },
        { session_id: "ses_a", tool: "todowrite", input: '{"todos":[]}' },
        { session_id: "ses_a", tool: "todowrite", input: '{"todos":[]}' },
        { session_id: "ses_a", tool: "bash", input: '{"command":"node scripts/serve.js list"}' },
        { session_id: "ses_a", tool: "bash", input: '{"command":"node scripts/serve.js list"}' },
        { session_id: "ses_a", tool: "bash", input: '{"command":"node scripts/serve.js list"}' },
      ];
    }
    return [];
  };

  const stats = ps.collectStats({ root: "C:/develop/Demo", since: "14d", now, runDb });
  assert.strictEqual(stats.meta.projectIds[0], "p1");
  assert.ok(calls[0].includes(".worktrees"), "worktree sessions resolve through project_directory");
  assert.ok(calls[1].includes(`time_created >= ${now - 14 * 86400000}`), "the since window is applied in SQL");
  assert.strictEqual(stats.sessions.length, 2);
  assert.deepStrictEqual(stats.sessions[0].tokens, { input: 10, output: 5, reasoning: 1, cacheRead: 90, cacheWrite: 0 });
  assert.strictEqual(stats.sessions[0].model, "deepseek-flash");
  assert.strictEqual(stats.sessions[0].provider, "deepseek");
  assert.strictEqual(stats.sessions[0].turns, 70);

  // 3 identical bash calls = a loop; the two edits are the same call modulo key
  // order (count 2, below threshold); repeated todowrite and serve.js polling
  // are exempt and never counted.
  const primary = stats.sessions[0];
  assert.strictEqual(primary.maxIdentical, 3);
  assert.strictEqual(primary.loops.length, 1);
  assert.strictEqual(primary.loops[0].tool, "bash");
  assert.strictEqual(primary.loops[0].count, 3);
  assert.match(primary.loops[0].hash, /^[0-9a-f]{8}$/, "only the hash is retained, never raw args");

  const scoped = ps.collectStats({ root: "C:/develop/Demo", session: "ses_a1", runDb });
  assert.strictEqual(scoped.meta.scope.session, "ses_a1");
  assert.strictEqual(scoped.meta.scope.rootId, "ses_a", "a subagent session resolves to its primary root");
  assert.deepStrictEqual(scoped.sessions.map((s) => s.id), ["ses_a", "ses_a1"]);
});

test("provider-stats CLI reads a fixture, prints observed telemetry, and exports a round-trippable snapshot", () => {
  const target = tmpdir();
  const sessions = [
    fixtureSession({ id: "ses_a", title: "F-001 feature", cost: 0.5, turns: 70, tokens: { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 } }),
    fixtureSession({ id: "ses_a1", parentId: "ses_a", cost: 0.25, turns: 2 }),
  ];
  const fixture = path.join(target, "fixture.json");
  fs.writeFileSync(fixture, JSON.stringify(fixtureDoc(sessions)), "utf8");

  const jsonRes = spawnSync(process.execPath, [PS, "--fixture", fixture, "--json"], { encoding: "utf8" });
  assert.strictEqual(jsonRes.status, 0, jsonRes.stdout + jsonRes.stderr);
  const parsed = JSON.parse(jsonRes.stdout);
  assert.strictEqual(parsed.schema, ps.SCHEMA);
  assert.strictEqual(parsed.aggregates.totals.cost, 0.75);
  assert.strictEqual(parsed.aggregates.topSessions[0].id, "ses_a");

  const humanRes = spawnSync(process.execPath, [PS, "--fixture", fixture], { encoding: "utf8" });
  assert.strictEqual(humanRes.status, 0, humanRes.stdout + humanRes.stderr);
  assert.match(humanRes.stdout, /Provider telemetry/);
  assert.match(humanRes.stdout, /observed provider data/);

  const out = path.join(target, "exported.json");
  const exportRes = spawnSync(process.execPath, [PS, "--fixture", fixture, "--json", "--export", out], { encoding: "utf8" });
  assert.strictEqual(exportRes.status, 0, exportRes.stdout + exportRes.stderr);
  const round = ps.readFixture(out);
  assert.strictEqual(round.sessions.length, 2);
  assert.strictEqual(round.schema, ps.SCHEMA);

  const badRes = spawnSync(process.execPath, [PS, "--fixture", path.join(target, "missing.json")], { encoding: "utf8" });
  assert.strictEqual(badRes.status, 1, "an unreadable store/fixture fails loudly, never fabricates");
  assert.match(badRes.stderr, /provider-stats:/);
});

test("agent-report --cost joins handoffs to provider sessions and reports cost per shipped feature", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });

  fs.writeFileSync(
    path.join(target, ".agents", "handoffs", "F-001.md"),
    [
      "# handoff",
      "",
      "## Dispatch log",
      "- frontend-engineer -> opencode/gpt-5.6-luna -> shipped",
      "",
      "## Session metadata (structured — record what is known, never fabricate)",
      "- session: ses_a",
      "- work_type: feature",
      "- outcome: shipped",
      "- termination_reason: gate-pass",
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(target, ".agents", "handoffs", "F-002.md"),
    ["# handoff", "", "## Dispatch log", "- docs -> opencode/gpt-5-nano -> shipped", "", "## Session metadata", "- work_type: feature", "- outcome: shipped"].join("\n"),
    "utf8"
  );
  const sessions = [
    fixtureSession({ id: "ses_a", title: "F-001 feature", cost: 0.5, turns: 70, tokens: { input: 100, output: 50, reasoning: 10, cacheRead: 900, cacheWrite: 20 } }),
    fixtureSession({ id: "ses_a1", parentId: "ses_a", cost: 0.25, turns: 5 }),
    fixtureSession({ id: "ses_b", title: "unrelated", cost: 0.2, turns: 10 }),
  ];
  fs.writeFileSync(path.join(target, "provider.json"), JSON.stringify(fixtureDoc(sessions)), "utf8");

  const jsonRes = spawnSync(
    process.execPath,
    ["scripts/agent-report.js", "--cost", "--since=14d", "--fixture", "provider.json", "--json"],
    { cwd: target, encoding: "utf8" }
  );
  assert.strictEqual(jsonRes.status, 0, jsonRes.stdout + jsonRes.stderr);
  const parsed = JSON.parse(jsonRes.stdout);
  // the suffixed template heading still parses (session + metadata are read)
  assert.strictEqual(parsed.features["F-001"].meta.session, "ses_a");
  assert.strictEqual(parsed.workTypeCount.feature, 2);
  assert.strictEqual(parsed.provider.join.matched, 1);
  assert.strictEqual(parsed.provider.join.handoffsWithSession, 1);
  assert.strictEqual(parsed.provider.join.byFeature["F-001"].rootId, "ses_a");
  assert.strictEqual(parsed.provider.join.byFeature["F-001"].cost, 0.75, "the group includes the subagent session");
  assert.strictEqual(parsed.provider.join.unmatchedSessions, 1, "ses_b is a primary session with no handoff in window");
  assert.strictEqual(parsed.provider.join.shippedCount, 1);
  assert.strictEqual(parsed.provider.join.costPerShippedFeature, 0.75);
  assert.strictEqual(parsed.provider.aggregates.totals.cost, 0.95);

  const humanRes = spawnSync(process.execPath, ["scripts/agent-report.js", "--cost", "--since=14d", "--fixture", "provider.json"], {
    cwd: target,
    encoding: "utf8",
  });
  assert.strictEqual(humanRes.status, 0, humanRes.stdout + humanRes.stderr);
  assert.match(humanRes.stdout, /Cost telemetry \(observed provider data/);
  assert.match(humanRes.stdout, /Cost per shipped feature: \$0\.7500/);
  assert.match(humanRes.stdout, /Session join: 1\/1/);

  // without --cost the report stays byte-deterministic and never reads the store
  const plainRes = spawnSync(process.execPath, ["scripts/agent-report.js"], { cwd: target, encoding: "utf8" });
  assert.strictEqual(plainRes.status, 0, plainRes.stdout + plainRes.stderr);
  assert.doesNotMatch(plainRes.stdout, /Cost telemetry/);
  assert.match(plainRes.stdout, /Run with --cost/);

  const exported = path.join(target, "provider-export.json");
  const exportRes = spawnSync(
    process.execPath,
    ["scripts/agent-report.js", "--cost", "--fixture", "provider.json", "--export", exported],
    { cwd: target, encoding: "utf8" }
  );
  assert.strictEqual(exportRes.status, 0, exportRes.stdout + exportRes.stderr);
  assert.ok(exists(exported), "--export writes a fixture snapshot");
  assert.strictEqual(JSON.parse(read(exported)).schema, ps.SCHEMA);
});

test("session_info tool ships, reports the join key, and both telemetry files stay harness-owned", async () => {
  const src = read(path.join(h.TEMPLATES_DIR, ".opencode", "tools", "session.ts"));
  assert.match(src, /export const info\b/, "file session.ts + export info -> the session_info tool");
  assert.match(src, /context\.sessionID/, "reports the calling session id");
  assert.match(src, /session: \$\{rootID \|\| sessionID\}/, "the session: line is the primary join key");
  assert.match(src, /provider-stats\.js/, "reads observed telemetry, never fabricates it");
  assert.match(src, /unavailable/, "an unreachable store is reported as unavailable");

  const cmd = read(path.join(h.TEMPLATES_DIR, ".opencode", "command", "report.md"));
  assert.match(cmd, /--cost/, "the report command documents the cost join");

  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });
  assert.ok(exists(path.join(target, ".opencode", "tools", "session.ts")), "session_info tool deployed");
  assert.ok(exists(path.join(target, "scripts", "qa", "provider-stats.js")), "provider-stats deployed");

  const scriptPath = path.join(target, "scripts", "qa", "provider-stats.js");
  fs.writeFileSync(scriptPath, "LOCAL EDIT", "utf8");
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: true });
  assert.match(read(scriptPath), /aggregateSessions/, "provider-stats is harness-owned (restored on update)");
});

// ---------------------------------------------------------------- remaining D (R9/R10/R11/R12/R14)

test("model-routing ships the opportunistic tier with fallback + privacy caveat and machine-read targets", () => {
  const doc = read(path.join(h.TEMPLATES_DIR, ".agents", "memory", "model-routing.md"));
  assert.match(doc, /opportunistic \(free\/low-cost\)/);
  assert.match(doc, /agent\.explore\.model/);
  assert.match(doc, /opencode-go\/glm-5\.3-flash/);
  assert.doesNotMatch(
    doc,
    /opencode\/(?:big-pickle|gpt-|claude|glm|kimi|nemotron|muse|deepseek|gemini|grok|minimax|qwen|hy)/,
    "Zen pay-as-you-go is not part of the routing policy"
  );
  assert.match(doc, /Mandatory fallback/i);
  assert.match(doc, /Privacy caveat/i);
  assert.match(doc, /^opportunistic_models: /m);
  assert.match(doc, /^escalation_models: /m);
  assert.match(doc, /^fallback_models: /m);
  assert.match(doc, /model_escalation_evidence/);

  // Go-first provider policy (V4 Pro architect tier excepted) + the funds stop.
  assert.match(doc, /Provider priority & fallback \(Go for flash\/default, direct for V4 Pro\)/);
  assert.match(doc, /deepseek\/deepseek-v4-pro/);
  assert.match(doc, /Provider funds stop \(hard rule — pause, announce, wait\)/);
  assert.match(doc, /opencode-go\/deepseek-v4\.1-flash/);
  assert.match(doc, /funds\/quota error follows the provider funds stop/);

  const cfg = JSON.parse(read(path.join(h.TEMPLATES_DIR, "opencode.json")));
  assert.strictEqual(cfg.model, "opencode-go/deepseek-v4.1-flash", "OpenCode Go is the default provider");
  assert.strictEqual(cfg.small_model, "opencode-go/glm-5.3-flash", "the cheap Go model handles small jobs");
  assert.strictEqual(cfg.agent.explore.model, "opencode-go/glm-5.3-flash", "explore is the reference opportunistic pin (Go, no Zen)");
});

test("architect-tier personas pin direct DeepSeek V4 Pro; engineering pins Go V4.1 Flash", () => {
  for (const name of ["planner", "qa-architect", "system-architect", "security-engineer"]) {
    const agent = read(path.join(h.TEMPLATES_DIR, ".opencode", "agents", `${name}.md`));
    assert.match(agent, /^model: deepseek\/deepseek-v4-pro$/m, `${name} must pin direct V4 Pro (never Go)`);
  }
  for (const name of ["frontend-engineer", "mobile-engineer", "data-engineer", "devops-engineer", "qa-runner", "diagnostics-expert"]) {
    const agent = read(path.join(h.TEMPLATES_DIR, ".opencode", "agents", `${name}.md`));
    assert.match(agent, /^model: opencode-go\/deepseek-v4\.1-flash$/m, `${name} must pin Go V4.1 Flash`);
  }
});

test("test:dispatch accepts declared tier targets and still fails a stray unpinned model", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });
  const runGate = () =>
    spawnSync(process.execPath, ["scripts/qa/check-dispatch-config.js"], { cwd: target, encoding: "utf8" });

  const clean = runGate();
  assert.strictEqual(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /declared escalation target/);
  assert.match(clean.stdout, /agent\.explore\.model/, "the explore pin is validated like every other pin");
  assert.doesNotMatch(clean.stdout, /agent\.explore\.model `opencode\//, "explore is not pinned to Zen");

  const routing = path.join(target, ".agents", "memory", "model-routing.md");
  fs.appendFileSync(routing, "\nstray mention: opencode-go/kimi-k2.6\n", "utf8");
  const dirty = runGate();
  assert.strictEqual(dirty.status, 1, "an undeclared unpinned model still fails the drift check");
  assert.match(dirty.stdout, /doc\u2194config drift/);
});

test("test:dispatch refuses a Zen pay-as-you-go allowlist entry (Go + direct only)", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });
  const allow = path.join(target, "scripts", "qa", "models.allowlist.txt");
  fs.appendFileSync(allow, "\nopencode/gpt-5.6-luna\n", "utf8");
  const r = spawnSync(process.execPath, ["scripts/qa/check-dispatch-config.js"], { cwd: target, encoding: "utf8" });
  assert.strictEqual(r.status, 1, "a regenerated allowlist must not silently re-allow Zen");
  assert.match(r.stdout, /Zen pay-as-you-go/);
});

test("provider-stats classifies model mix by tier and surfaces escalation primary sessions", () => {
  const sessions = [
    fixtureSession({ id: "ses_pro", title: "pro primary", model: "deepseek/deepseek-v4-pro", provider: "deepseek", cost: 2, turns: 30 }),
    fixtureSession({ id: "ses_pro1", parentId: "ses_pro", model: "opencode-go/glm-5.3-flash", provider: "opencode-go", cost: 0, turns: 2 }),
    fixtureSession({ id: "ses_std", title: "standard", cost: 0.1, turns: 5 }),
  ];
  const agg = ps.aggregateSessions(sessions, {
    escalationModels: ["deepseek/deepseek-v4-pro"],
    opportunisticModels: ["opencode-go/glm-5.3-flash"],
  });

  assert.deepStrictEqual(agg.escalation.rootIds, ["ses_pro"]);
  assert.strictEqual(agg.escalation.count, 1);
  assert.strictEqual(agg.escalation.cost, 2);
  assert.strictEqual(agg.escalation.sessions[0].model, "deepseek/deepseek-v4-pro");
  assert.strictEqual(agg.opportunistic.sessions, 1, "the subagent opportunistic session is counted");
  assert.strictEqual(agg.modelMix.find((m) => m.model === "opencode-go/glm-5.3-flash").tier, "opportunistic");
  assert.strictEqual(agg.modelMix.find((m) => m.model === "deepseek/deepseek-v4-pro").tier, "escalation");
  assert.strictEqual(agg.modelMix.find((m) => m.model === "deepseek-flash").tier, "standard");
  const mix = Object.fromEntries(agg.tierMix.map((t) => [t.tier, t]));
  assert.strictEqual(mix.escalation.cost, 2);
  assert.strictEqual(mix.standard.sessions, 1);

  const parsed = ps.parseModelTiers("opportunistic_models: a/b, c/d\nescalation_models: e/f\n");
  assert.deepStrictEqual(parsed.opportunistic, ["a/b", "c/d"]);
  assert.deepStrictEqual(parsed.escalation, ["e/f"]);
});

test("agent-report --cost flags a pro primary session with no recorded escalation evidence", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });

  fs.writeFileSync(
    path.join(target, ".agents", "handoffs", "F-010.md"),
    [
      "# handoff",
      "",
      "## Dispatch log",
      "- system-architect -> deepseek/deepseek-v4-pro -> shipped",
      "",
      "## Session metadata",
      "- session: ses_pro",
      "- work_type: architecture",
      "- outcome: shipped",
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(target, ".agents", "handoffs", "F-011.md"),
    [
      "# handoff",
      "",
      "## Dispatch log",
      "- qa-architect -> opencode/gpt-5.6-luna -> shipped",
      "",
      "## Session metadata",
      "- session: ses_ok",
      "- work_type: feature",
      "- outcome: shipped",
      "- model_escalation_evidence: qa-architect -> pro: contradictory evidence resolved by escalation",
    ].join("\n"),
    "utf8"
  );
  const sessions = [
    fixtureSession({ id: "ses_pro", title: "F-010 architecture", model: "deepseek/deepseek-v4-pro", provider: "deepseek", cost: 1.5, turns: 40 }),
    fixtureSession({ id: "ses_ok", title: "F-011 feature", model: "deepseek/deepseek-v4-pro", provider: "deepseek", cost: 1.0, turns: 20 }),
  ];
  fs.writeFileSync(path.join(target, "provider.json"), JSON.stringify(fixtureDoc(sessions)), "utf8");

  const jsonRes = spawnSync(
    process.execPath,
    ["scripts/agent-report.js", "--cost", "--fixture", "provider.json", "--json"],
    { cwd: target, encoding: "utf8" }
  );
  assert.strictEqual(jsonRes.status, 0, jsonRes.stdout + jsonRes.stderr);
  const parsed = JSON.parse(jsonRes.stdout);
  assert.strictEqual(parsed.schema, "agent-report/1", "the --json schema is pinned");
  assert.strictEqual(parsed.provider.join.escalation.proSessions, 2);
  assert.strictEqual(parsed.provider.join.escalation.withEvidence, 1);
  assert.deepStrictEqual(parsed.provider.join.escalation.withoutEvidence.map((u) => u.feature), ["F-010"]);

  const humanRes = spawnSync(process.execPath, ["scripts/agent-report.js", "--cost", "--fixture", "provider.json"], {
    cwd: target,
    encoding: "utf8",
  });
  assert.strictEqual(humanRes.status, 0, humanRes.stdout + humanRes.stderr);
  assert.match(humanRes.stdout, /Escalation evidence: 2 primary session/);
  assert.match(humanRes.stdout, /F-010 .*no model_escalation_evidence/);
});

test("test:prefix passes a clean deploy and fails a volatile value in an always-loaded file", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });
  const gate = () =>
    spawnSync(process.execPath, ["scripts/qa/check-prefix-stability.js"], { cwd: target, encoding: "utf8" });

  const clean = gate();
  assert.strictEqual(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /prefix file\(s\) byte-stable/);

  fs.appendFileSync(path.join(target, "AGENTS.md"), "\nGenerated: 2026-09-12T09:30\n", "utf8");
  const dirty = gate();
  assert.strictEqual(dirty.status, 1, "a clock timestamp in the prefix fails the gate");
  assert.match(dirty.stdout, /clock timestamp/);
  assert.match(dirty.stdout, /AGENTS\.md:\d+/);

  // WSL machine paths (drive mount + UNC) are per-machine and must fail too
  fs.writeFileSync(path.join(target, "AGENTS.md"), "# Demo\n\nDB at /mnt/c/develop/PublicVirtualLibrary\n", "utf8");
  const wslMount = gate();
  assert.strictEqual(wslMount.status, 1, "a WSL /mnt/ path in the prefix fails the gate");
  assert.match(wslMount.stdout, /machine-specific absolute path/);

  fs.writeFileSync(path.join(target, "AGENTS.md"), "# Demo\n\nShare: \\\\wsl$\\Ubuntu-24.04\\srv\\x\n", "utf8");
  const wslUnc = gate();
  assert.strictEqual(wslUnc.status, 1, "a WSL UNC path in the prefix fails the gate");
  assert.match(wslUnc.stdout, /machine-specific absolute path/);

  // a bare historical date is stable context and stays allowed
  fs.writeFileSync(path.join(target, "AGENTS.md"), "# Demo\n\nAs of 2026-09-12 this is fine.\n", "utf8");
  const dateOk = gate();
  assert.strictEqual(dateOk.status, 0, dateOk.stdout + dateOk.stderr);
});

test("checkpoint writes a deterministic bounded-state block and resume prints it alone", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });
  const cp = (...args) => spawnSync(process.execPath, ["scripts/checkpoint.js", ...args], { cwd: target, encoding: "utf8" });

  const full = [
    "write",
    "--feature", "F-042",
    "--objective", "ship R12",
    "--phase", "testing",
    "--completed", "CLI written",
    "--active", "author resume flow",
    "--files-changed", "scripts/checkpoint.js",
    "--facts", "governance reads every handoff .md",
    "--decisions", "block replaces in place",
    "--risks", "handoff overwrite",
    "--next-action", "run tests",
    "--session", "ses_abc123",
  ];
  const w1 = cp(...full);
  assert.strictEqual(w1.status, 0, w1.stdout + w1.stderr);
  assert.match(w1.stdout, /checkpoint_count 1/);
  const file = read(path.join(target, ".agents", "handoffs", "F-042.md"));
  assert.match(file, /## Checkpoint \(resume\)/);
  assert.match(file, /- objective: ship R12/);
  assert.match(file, /- next_action: run tests/);
  assert.doesNotMatch(file, /\d{4}-\d{2}-\d{2}T/, "no timestamps — the block is deterministic");

  // a checkpoint created mid-session must not break the wrap-up gate
  const gov = spawnSync(process.execPath, ["scripts/qa/governance.js"], { cwd: target, encoding: "utf8" });
  assert.strictEqual(gov.status, 0, gov.stdout + gov.stderr);
  assert.match(file, /## Dispatch log/);

  const again = cp(...full);
  assert.match(again.stdout, /already matches/);
  assert.strictEqual((read(path.join(target, ".agents", "handoffs", "F-042.md")).match(/## Checkpoint \(resume\)/g) || []).length, 1);

  const changed = cp("write", "--feature", "F-042", "--objective", "ship R12", "--phase", "verified", "--next-action", "handoff");
  assert.match(changed.stdout, /checkpoint_count 2/);
  assert.strictEqual(
    (read(path.join(target, ".agents", "handoffs", "F-042.md")).match(/## Checkpoint \(resume\)/g) || []).length,
    1,
    "the block is replaced in place, never duplicated"
  );

  const r = cp("resume", "--feature", "F-042");
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^- objective: ship R12$/m);
  assert.doesNotMatch(r.stdout, /## Dispatch log/, "resume prints the checkpoint block only");
  const rj = cp("resume", "--feature", "F-042", "--json");
  assert.strictEqual(JSON.parse(rj.stdout).schema, "checkpoint/1");

  const missing = cp("resume", "--feature", "F-999");
  assert.strictEqual(missing.status, 1);
  assert.match(missing.stderr, /no handoff found/);
  const empty = cp("write", "--feature", "F-999");
  assert.strictEqual(empty.status, 1);
  assert.match(empty.stderr, /empty checkpoint/);
});

test("checkpoint CLI, tools, commands, and report:cost are deployed and stay harness-owned", async () => {
  const tool = read(path.join(h.TEMPLATES_DIR, ".opencode", "tools", "checkpoint.ts"));
  assert.match(tool, /export const write\b/);
  assert.match(tool, /export const resume\b/);
  assert.match(tool, /checkpoint\.js/, "shells out to the deterministic CLI");

  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });
  for (const rel of [
    "scripts/checkpoint.js",
    ".opencode/tools/checkpoint.ts",
    ".opencode/command/checkpoint.md",
    ".opencode/command/resume.md",
    "scripts/qa/check-prefix-stability.js",
  ]) {
    assert.ok(exists(path.join(target, ...rel.split("/"))), rel + " deployed");
  }
  const pkg = JSON.parse(read(path.join(target, "package.json")));
  assert.strictEqual(pkg.scripts.checkpoint, "node scripts/checkpoint.js");

  fs.writeFileSync(path.join(target, "scripts", "checkpoint.js"), "LOCAL EDIT", "utf8");
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: true });
  assert.match(read(path.join(target, "scripts", "checkpoint.js")), /resume/, "checkpoint.js restored on update");
});


// ---------------------------------------------------------------- deploy hardening (branch guard / package.json / lock / gitattributes)

test("deploy refuses to auto-commit onto a non-default branch; --allow-branch overrides", async () => {
  const { target } = trackedRepoFixture();
  git(target, ["checkout", "-q", "-b", "feature/stray"]);

  await assert.rejects(
    h.deploy(target, { name: "Demo", yes: true, isUpdate: true, commit: true, push: false }),
    /non-default branch|canonical/
  );
  assert.ok(!/chore\(harness\)/.test(git(target, ["log", "--oneline"])), "no harness commit on the stray branch");

  const result = await h.deploy(target, {
    name: "Demo",
    yes: true,
    isUpdate: true,
    commit: true,
    push: false,
    allowBranch: true,
  });
  assert.strictEqual(result.commitResult.committed, true, "--allow-branch lets the commit through");
  assert.ok(result.branchGuard && result.branchGuard.overridden, "the override is reported in the result");
});

test("mergePackageJson preserves project indentation and is a byte no-op when complete", async () => {
  const target = tmpdir();
  fs.writeFileSync(
    path.join(target, "package.json"),
    '{\n    "name": "app",\n    "version": "1.2.3",\n    "scripts": {\n        "start": "node ."\n    }\n}\n',
    "utf8"
  );

  const first = h.mergePackageJson(target);
  assert.strictEqual(first.changed, true);
  assert.match(first.text, /^    "name": "app"/m, "4-space indentation preserved");
  assert.match(first.text, /"test:dispatch":/);

  // deploy writes it; a second merge on the deployed file is a true no-op
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false, commit: false });
  const current = read(path.join(target, "package.json"));
  const second = h.mergePackageJson(target);
  assert.strictEqual(second.changed, false, "no missing scripts -> no change");
  assert.strictEqual(second.text, current, "returns byte-identical text");
  assert.match(read(path.join(target, "package.json")), /^    "name": "app"/m, "deploy kept the project indent");
});

test("deploy never rewrites or clobbers an unparseable package.json", async () => {
  const target = tmpdir();
  const jsonc = '{\n  // project uses JSONC\n  "name": "app"\n}\n';
  fs.writeFileSync(path.join(target, "package.json"), jsonc, "utf8");
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false, commit: false });
  assert.strictEqual(read(path.join(target, "package.json")), jsonc, "unparseable package.json left untouched");
});

test("gitattributes merge uses begin/end markers and preserves a project tail", () => {
  const t = tmpdir();
  fs.writeFileSync(
    path.join(t, ".gitattributes"),
    "*.md text\n# agent-harness (managed below)\nBACKLOG.md merge=old-driver\n*.sh text eol=lf\n# agent-harness (managed end)\n# project entries (must survive)\n*.log -diff\n",
    "utf8"
  );
  const out = h.mergeGitattributes(t, "backlog-demo");
  assert.doesNotMatch(out, /merge=old-driver/, "old managed block removed");
  assert.match(out, /BACKLOG\.md merge=backlog-demo/);
  assert.match(out, /# project entries \(must survive\)/, "project entry after the managed block survives");
  assert.match(out, /\*\.log -diff/);

  // legacy block (begin marker only, no end marker) is removed to EOF
  const legacy = tmpdir();
  fs.writeFileSync(
    path.join(legacy, ".gitattributes"),
    "*.md text\n# agent-harness (managed below)\nBACKLOG.md merge=old-driver\n",
    "utf8"
  );
  const out2 = h.mergeGitattributes(legacy, "backlog-demo");
  assert.doesNotMatch(out2, /merge=old-driver/);
  assert.match(out2, /\*\.md text/);
});

test("deploy excludes the transient deploy lock clone-locally", async () => {
  const target = tmpdir();
  git(target, ["init", "-q"]);
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false, commit: false });
  assert.match(read(path.join(target, ".git", "info", "exclude")), /\.harness\.lock\//);
});

// ---------------------------------------------------------------- tool-lib + lease-lib

test("tool-lib is the single source for node resolution and the mid-session worktree reroot", () => {
  const toolLib = require(path.join(h.TEMPLATES_DIR, "scripts", "qa", "tool-lib.js"));
  const prev = process.env.OPENCODE_NODE;
  process.env.OPENCODE_NODE = "/custom/node";
  assert.strictEqual(toolLib.nodeBin(), "/custom/node", "OPENCODE_NODE override honored");
  if (prev === undefined) delete process.env.OPENCODE_NODE;
  else process.env.OPENCODE_NODE = prev;

  const base = tmpdir();
  const wt = path.join(base, "worktree");
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, "BACKLOG.md"), "board\n", "utf8");
  fs.mkdirSync(path.join(base, ".serve", "sessions"), { recursive: true });
  fs.writeFileSync(path.join(base, ".serve", "sessions", "s1.worktree"), wt, "utf8");

  assert.strictEqual(
    toolLib.sessionRoot({ worktree: base, sessionID: "s1" }, "BACKLOG.md"),
    wt,
    "recorded mid-session worktree wins while its marker exists"
  );
  assert.strictEqual(
    toolLib.sessionRoot({ worktree: base, sessionID: "nope" }, "BACKLOG.md"),
    base,
    "no pointer -> launch tree"
  );
});

test("lease liveness is injectable and touchLease re-creates a missing lease", () => {
  const leases = require(path.join(h.TEMPLATES_DIR, "scripts", "qa", "lease-lib.js"));
  const now = Date.now();
  const rec = {
    sessionID: "s",
    pid: process.pid,
    bootId: leases.bootId(),
    procStart: leases.processStart(process.pid),
    startedAt: now,
    heartbeatAt: now,
  };
  assert.strictEqual(leases.leaseStatus(rec, { now }).live, true, "fresh lease is live");
  const stale = leases.leaseStatus(rec, { now: now + leases.DEFAULT_MAX_AGE_MS + 1000 });
  assert.strictEqual(stale.live, false);
  assert.strictEqual(stale.reason, "stale", "a lease is stale past the freshness window");

  const root = tmpdir();
  leases.writeLease(root, "s1");
  const file = path.join(leases.leaseDir(root), "s1.json");
  assert.ok(exists(file));
  fs.rmSync(file);
  leases.touchLease(root, "s1");
  assert.ok(exists(file), "touchLease re-creates a pruned/missing lease");
});

// ---------------------------------------------------------------- board hardening (cycles / worktree prune)

test("backlog rejects a dependency cycle (self and mutual) instead of silently blocking forever", () => {
  const t = scaffoldBacklogCliTarget();
  runBacklogCli(t, ["add", "a", "--p", "P1"]); // F-001
  runBacklogCli(t, ["add", "b", "--p", "P1"]); // F-002
  assert.strictEqual(runBacklogCli(t, ["depends", "F-001", "--on", "F-002"]).status, 0);

  const self = runBacklogCli(t, ["depends", "F-001", "--on", "F-001"]);
  assert.strictEqual(self.status, 1, self.out);
  assert.match(self.out, /cycle/);

  const mutual = runBacklogCli(t, ["depends", "F-002", "--on", "F-001"]);
  assert.strictEqual(mutual.status, 1, mutual.out);
  assert.match(mutual.out, /cycle/);
});

test("test:backlog fails a board containing a dependency cycle", () => {
  const t = scaffoldBacklogTarget(`# BACKLOG — canonical task list

## Open

| ID | P | Epic | Task | Evidence | Depends on |
|----|---|------|------|----------|------------|
| F-001 | P2 | ? | a | ev | F-002 |
| F-002 | P2 | ? | b | ev | F-001 |
`);
  const r = runBacklogGate(t);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /dependency cycle/);
});

test("worktree-prune removes a merged clean worktree and keeps an unmerged one", () => {
  const { target } = trackedRepoFixture();
  fs.mkdirSync(path.join(target, "scripts", "qa"), { recursive: true });
  fs.copyFileSync(path.join(h.TEMPLATES_DIR, "scripts", "backlog.js"), path.join(target, "scripts", "backlog.js"));
  copyBoardLib(target);
  fs.copyFileSync(path.join(h.TEMPLATES_DIR, "BACKLOG.md"), path.join(target, "BACKLOG.md"));
  git(target, ["add", "-A"]);
  git(target, ["commit", "-q", "-m", "seed harness scripts"]);
  git(target, ["push", "-q", "origin", "main"]);

  const mergedWt = path.join(tmpdir(), "wt-merged");
  git(target, ["branch", "feat-merged", "main"]);
  git(target, ["worktree", "add", mergedWt, "feat-merged"]);
  fs.writeFileSync(path.join(mergedWt, "merged.txt"), "merged\n", "utf8");
  execFileSync("git", ["-C", mergedWt, "add", "-A"], { encoding: "utf8" });
  execFileSync("git", ["-C", mergedWt, "commit", "-q", "-m", "feat-merged work"], { encoding: "utf8" });
  git(target, ["merge", "--ff-only", "feat-merged"]);
  git(target, ["push", "-q", "origin", "main"]);

  const openWt = path.join(tmpdir(), "wt-open");
  git(target, ["branch", "feat-open", "main"]);
  git(target, ["worktree", "add", openWt, "feat-open"]);
  fs.writeFileSync(path.join(openWt, "open.txt"), "open\n", "utf8");
  execFileSync("git", ["-C", openWt, "add", "-A"], { encoding: "utf8" });
  execFileSync("git", ["-C", openWt, "commit", "-q", "-m", "feat-open work"], { encoding: "utf8" });

  const res = spawnSync(process.execPath, ["scripts/backlog.js", "worktree-prune"], { cwd: target, encoding: "utf8" });
  assert.strictEqual(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /pruned wt-merged/);
  assert.ok(!exists(mergedWt), "merged worktree removed");
  assert.ok(exists(openWt), "unmerged worktree kept");
  assert.match(res.stdout, /not merged into/);
});

test("backlog-notify summarizes the worktree/depends/owns tools too", () => {
  const src = read(path.join(h.TEMPLATES_DIR, ".opencode", "plugins", "backlog-notify.ts"));
  assert.match(src, /backlog_worktree/);
  assert.match(src, /backlog_depends/);
  assert.match(src, /backlog_owns/);
});
