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

test("update fails closed on a locally-modified harness-owned file (no --accept-harness)", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });

  const rootAgents = path.join(target, "AGENTS.md");
  const original = read(rootAgents);
  fs.writeFileSync(rootAgents, "LOCAL EDIT", "utf8");

  await assert.rejects(
    () => h.deploy(target, { name: "Demo", yes: true, isUpdate: true, commit: true }),
    /locally-modified harness-owned file/,
    "the update refuses to clobber a hand-edited harness file"
  );

  assert.strictEqual(read(rootAgents), "LOCAL EDIT", "the local edit survives the refused update");
  assert.ok(
    !exists(path.join(target, h.BACKUP_DIR)) ||
      fs.readdirSync(path.join(target, h.BACKUP_DIR)).every((s) => !exists(path.join(target, h.BACKUP_DIR, s, "AGENTS.md"))),
    "no clobber backup was written when the update was refused"
  );

  // The explicit escape hatch overwrites deliberately and still backs up.
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: true, acceptHarness: true });
  assert.ok(read(rootAgents).includes("Operating Rules"), "harness file restored with --accept-harness");
  const backups = path.join(target, h.BACKUP_DIR);
  assert.ok(exists(backups));
  let found = false;
  for (const stamp of fs.readdirSync(backups)) {
    const p = path.join(backups, stamp, "AGENTS.md");
    if (exists(p) && read(p) === "LOCAL EDIT") found = true;
  }
  assert.ok(found, "local modification was backed up on the accepted overwrite");
  assert.notStrictEqual(original, "", "guard did not accidentally deploy an empty file");
});

test("update treats a CRLF *.ps1 (checked out per .gitattributes) as unchanged, not a local edit", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });

  const ps1 = path.join(target, "scripts", "switch-reasoning-model.ps1");
  const lf = read(ps1);
  const crlf = lf.replace(/\r?\n/g, "\r\n");
  fs.writeFileSync(ps1, crlf, "utf8");

  // A line-ending-only difference must neither fail closed nor be rewritten to
  // LF (which would leave the working tree dirty against the CRLF pin).
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: true });
  const after = read(ps1);
  assert.ok(after.includes("\r\n"), "the correctly checked-out CRLF script is left as-is");
  assert.ok(!after.includes("\r\r"), "no doubled carriage returns are introduced");

  // A real content edit is still caught.
  fs.writeFileSync(ps1, `${crlf}\r\n# local edit\r\n`, "utf8");
  await assert.rejects(
    () => h.deploy(target, { name: "Demo", yes: true, isUpdate: true, commit: true }),
    /locally-modified harness-owned file/,
    "a real edit to the script is still refused"
  );
});

test("update fails closed on a modified QA script and points upstream (F-289 shape)", async () => {
  const target = tmpdir();
  git(target, ["init", "-q", "-b", "main"]);
  git(target, ["config", "user.email", "t@t.t"]);
  git(target, ["config", "user.name", "t"]);
  git(target, ["commit", "--allow-empty", "-q", "-m", "seed"]);
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false, commit: false });

  const qaScript = path.join(target, "scripts", "qa", "board-sync.js");
  const original = read(qaScript);
  fs.writeFileSync(qaScript, original + "\n// project-side F-289 fix\n", "utf8");

  await assert.rejects(
    () => h.deploy(target, { name: "Demo", yes: true, isUpdate: true, commit: true }),
    (err) =>
      /scripts[/\\]qa[/\\]board-sync\.js/.test(err.message) &&
      /templates\//.test(err.message),
    "the error names the diverged QA script and the upstream remedy"
  );
  assert.match(read(qaScript), /project-side F-289 fix/, "the QA fix was not destroyed");
});

test("--accept-harness rolls back the clobber when the target test:quick is red", async () => {
  const target = tmpdir();
  git(target, ["init", "-q", "-b", "main"]);
  git(target, ["config", "user.email", "t@t.t"]);
  git(target, ["config", "user.name", "t"]);
  git(target, ["commit", "--allow-empty", "-q", "-m", "seed"]);
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false, commit: false });

  // Give the target a gate that deliberately fails, as the F-289 clobber did.
  const pkgPath = path.join(target, "package.json");
  const pkg = JSON.parse(read(pkgPath));
  pkg.scripts = { ...(pkg.scripts || {}), "test:quick": "node -e \"process.exit(1)\"" };
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");

  const rootAgents = path.join(target, "AGENTS.md");
  fs.writeFileSync(rootAgents, "LOCAL EDIT", "utf8");
  const configBefore = read(path.join(target, ".harness.json"));

  await assert.rejects(
    () =>
      h.deploy(target, {
        name: "Demo",
        yes: true,
        isUpdate: true,
        commit: true,
        acceptHarness: true,
      }),
    /failed `npm run test:quick`/,
    "a red target suite aborts the accepted-clobber commit"
  );

  assert.strictEqual(read(rootAgents), "LOCAL EDIT", "the clobber was rolled back on disk");
  assert.strictEqual(read(path.join(target, ".harness.json")), configBefore, ".harness.json rolled back");
  assert.strictEqual(
    git(target, ["log", "--oneline"]).split(/\r?\n/).filter(Boolean).length,
    1,
    "no harness commit was made"
  );
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

test("opencode.json ships a least-privilege external-directory policy", () => {
  const target = tmpdir();
  const workspaceRoot = h.workspaceRootFor(target);
  const merged = JSON.parse(
    h.mergeOpencodeJson(target, {
      PROJECT_NAME: "Demo",
      PROJECT_DOMAIN: "x",
      WORKSPACE_ROOT: workspaceRoot,
    })
  );
  const ext = merged.permission.external_directory;

  // Work + test artifacts are auto-allowed (the F-291 Maestro prompt fix).
  assert.strictEqual(ext["/tmp/**"], "allow");
  assert.strictEqual(ext["~/.maestro/**"], "allow", "Maestro E2E artifacts are auto-allowed");
  assert.strictEqual(ext["~/.android/**"], "allow", "the emulator AVD is auto-allowed");
  assert.strictEqual(ext[`${workspaceRoot}/**`], "allow", "repo + sibling worktrees are allowed");

  // Credential stores are denied even though the work root is allowed. Because
  // the last matching rule wins, the denies must follow the allows in the file.
  for (const p of [
    "~/.ssh/**",
    "~/.aws/**",
    "~/.gnupg/**",
    "~/.config/gh/**",
    "~/.netrc",
    "~/.git-credentials",
    "~/.config/opencode/auth.json",
  ]) {
    assert.strictEqual(ext[p], "deny", `${p} must be denied`);
  }
  assert.ok(
    !Object.prototype.hasOwnProperty.call(ext, "*"),
    "no blanket allow: an unmatched external path must still prompt"
  );

  // Write separation: the agent cannot rewrite its own policy/config or system.
  assert.strictEqual(merged.permission.edit["~/.config/opencode/**"], "deny");
  assert.strictEqual(merged.permission.edit["/etc/**"], "deny");
  assert.strictEqual(merged.permission.bash["sudo *"], "deny");
});

test("opencode.json permission merge keeps a project's own rules", () => {
  const target = tmpdir();
  fs.writeFileSync(
    path.join(target, "opencode.json"),
    JSON.stringify(
      { permission: { external_directory: { "~/custom/**": "allow" }, edit: "deny" } },
      null,
      2
    ) + "\n",
    "utf8"
  );
  const merged = JSON.parse(
    h.mergeOpencodeJson(target, {
      PROJECT_NAME: "Demo",
      PROJECT_DOMAIN: "x",
      WORKSPACE_ROOT: "/w",
    })
  );
  assert.strictEqual(merged.permission.edit, "deny", "a project's scalar rule is preserved");
  assert.strictEqual(
    merged.permission.external_directory["~/custom/**"],
    "allow",
    "a project's external_directory rule is added"
  );
  assert.strictEqual(
    merged.permission.external_directory["~/.maestro/**"],
    "allow",
    "the harness baseline still applies"
  );
  assert.strictEqual(
    merged.permission.external_directory["~/.ssh/**"],
    "deny",
    "secret denies survive the merge"
  );
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

test("agent output explains at the reader's level (behavior-level prose, not raw symbols)", () => {
  const rules = read(path.join(h.TEMPLATES_DIR, ".agents", "rules", "00-operating.md"));
  assert.match(rules, /Explain at the reader's level/);
  assert.match(rules, /only when precision needs it/);

  const rulebook = read(path.join(h.TEMPLATES_DIR, ".agents", "AGENTS.md"));
  assert.match(rulebook, /Explain at the reader's level/);
  assert.match(rulebook, /knows the product but not the codebase/);

  const rootAgents = read(path.join(h.TEMPLATES_DIR, "AGENTS.md"));
  assert.match(rootAgents, /Report value-first, at the reader's level/);

  const handoffSkill = read(path.join(h.TEMPLATES_DIR, ".agents", "skills", "handoff", "SKILL.md"));
  assert.match(handoffSkill, /Explain at the reader's level/);
  assert.match(handoffSkill, /no raw code identifiers/);
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
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: true, acceptHarness: true });
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
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: true, acceptHarness: true });
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
 * primitive), lease-lib.js (session-lease liveness), and the board-sync /
 * merge-backlog pair (canonical checkout converge + row-aware reconcile). */
function copyBoardLib(target) {
  const dir = path.join(target, "scripts", "qa");
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ["board-lib.js", "lease-lib.js", "board-sync.js", "merge-backlog.js"]) {
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

test("backlog worktree attributes its session pointer via the live-lease ancestry (bash invocation)", () => {
  if (!fs.existsSync("/proc/self/stat")) return; // Linux/WSL: the ancestry probe is /proc-based
  const t = scaffoldBacklogCliTarget();
  git(t, ["init", "-q"]);
  git(t, ["config", "user.email", "t@t.t"]);
  git(t, ["config", "user.name", "t"]);
  git(t, ["add", "-A"]);
  git(t, ["commit", "-q", "-m", "seed"]);
  assert.strictEqual(runBacklogCli(t, ["add", "isolate me", "--p", "P2"]).status, 0);

  // A tool call forwards HARNESS_SESSION_ID; the documented bash invocation does
  // not. The context-guard lease for THIS process is a live ancestor of the CLI,
  // so the pointer is attributed without the env var (the F-246 reroot gap that
  // sent checkpoint_write to the main tree).
  const leaseLib = require(path.join(h.TEMPLATES_DIR, "scripts", "qa", "lease-lib.js"));
  leaseLib.writeLease(t, "ses_ancestor");

  const dir = path.join(os.tmpdir(), `wt-ancestor-${path.basename(t)}`);
  const res = spawnSync(
    process.execPath,
    ["scripts/backlog.js", "worktree", "F-001", "--branch", `anc-${path.basename(t)}`, "--dir", dir],
    { cwd: t, encoding: "utf8", env: { ...process.env, HARNESS_SESSION_ID: "" } }
  );
  assert.strictEqual(res.status, 0, (res.stdout || "") + (res.stderr || ""));
  const pointer = path.join(t, ".serve", "sessions", "ses_ancestor.worktree");
  assert.ok(exists(pointer), "pointer attributed via the live-lease ancestry");
  assert.strictEqual(read(pointer).trim(), dir, "pointer holds the absolute worktree path");
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

  // `add` now publishes the board itself (the canonical transaction commits +
  // fast-forward pushes), so no manual commit/push is needed here.
  assert.strictEqual(runBacklogCli(t, ["add", "isolate me", "--p", "P2"]).status, 0);

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

test("backlog sync replays an offline local board commit onto origin and reconciles the archive", () => {
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
  assert.strictEqual(runBacklogCli(t, ["add", "first row", "--p", "P2"]).status, 0);
  assert.strictEqual(runBacklogCli(t, ["add", "second row", "--p", "P2"]).status, 0);

  // Go offline: the board edit commits locally but cannot publish — the F-147
  // "local-only row" shape, now durable instead of working-tree dirt.
  git(t, ["remote", "set-url", "origin", path.join(origin, "does-not-exist")]);
  const take = runBacklogCli(t, ["take", "F-002", "--handoff", ".agents/handoffs/F-002.md"]);
  assert.strictEqual(take.status, 0, take.out);
  assert.match(take.out, /committed locally/);
  assert.strictEqual(
    git(t, ["status", "--porcelain", "--untracked-files=no"]),
    "",
    "the offline take is committed, not working-tree dirt"
  );

  // Back online; upstream archives F-001.
  git(t, ["remote", "set-url", "origin", origin]);
  const other = tmpdir();
  execFileSync("git", ["clone", "-q", origin, other], { encoding: "utf8" });
  git(other, ["config", "user.email", "o@o.o"]);
  git(other, ["config", "user.name", "o"]);
  assert.strictEqual(runBacklogCli(other, ["archive", "F-001", "--closed", "shipped 2026-09-19"]).status, 0);

  // sync replays the local board commit on top of the landed archive.
  const r = runBacklogCli(t, ["sync"]);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /replayed 1 local board commit|published board/);
  const board = read(path.join(t, "BACKLOG.md"));
  assert.match(board.split("## Archive")[1], /\| F-001 \|/, "the landed archive is present");
  assert.match(board.split("## In progress")[1], /\| F-002 \|/, "the local take survived");
  assert.strictEqual(git(t, ["status", "--porcelain", "--untracked-files=no"]), "", "tree clean after sync");
  assert.strictEqual(
    git(t, ["rev-parse", "HEAD"]),
    git(t, ["rev-parse", "origin/main"]),
    "main published to origin/main"
  );
});

/* A canonical checkout wired to a bare origin, plus a second clone that stands
 * in for a concurrent worktree session. */
function canonicalBacklogRepo() {
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
  return { origin, t };
}
function cloneOther(origin) {
  const other = tmpdir();
  execFileSync("git", ["clone", "-q", origin, other], { encoding: "utf8" });
  git(other, ["config", "user.email", "o@o.o"]);
  git(other, ["config", "user.name", "o"]);
  return other;
}

test("backlog canonical add commits and publishes (no working-tree dirt)", () => {
  const { t } = canonicalBacklogRepo();
  const r = runBacklogCli(t, ["add", "published row", "--p", "P2", "--evidence", "x"]);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /published board to origin\/main/);
  assert.strictEqual(git(t, ["status", "--porcelain", "--untracked-files=no"]), "", "no working-tree dirt");
  assert.strictEqual(git(t, ["rev-parse", "HEAD"]), git(t, ["rev-parse", "origin/main"]), "main == origin/main");
  assert.match(git(t, ["show", "HEAD:BACKLOG.md"]), /published row/, "the row is committed");
});

test("backlog canonical take refuses a row already archived upstream (no resurrection)", () => {
  const { origin, t } = canonicalBacklogRepo();
  assert.strictEqual(runBacklogCli(t, ["add", "shipped row", "--p", "P2"]).status, 0);
  const other = cloneOther(origin);
  assert.strictEqual(runBacklogCli(other, ["archive", "F-001", "--closed", "shipped"]).status, 0);

  const r = runBacklogCli(t, ["take", "F-001", "--handoff", ".agents/handoffs/F-001.md"]);
  assert.notStrictEqual(r.status, 0, "taking an upstream-archived row is refused");
  assert.match(r.out, /archived/);
  const board = read(path.join(t, "BACKLOG.md"));
  assert.match(board.split("## Archive")[1], /\| F-001 \|/, "F-001 stays archived");
  const inProgress = board.split("## In progress")[1].split("## Queued")[0];
  assert.doesNotMatch(inProgress, /F-001/, "F-001 was not resurrected into In progress");
  assert.strictEqual(git(t, ["status", "--porcelain", "--untracked-files=no"]), "", "the reconcile left no dirt");
});

test("backlog redundant non-board dirt does not block convergence", () => {
  const { origin, t } = canonicalBacklogRepo();
  fs.writeFileSync(path.join(t, "notes.txt"), "a\n", "utf8");
  git(t, ["add", "-A"]);
  git(t, ["commit", "-q", "-m", "notes a"]);
  git(t, ["push", "-q", "origin", "main"]);
  assert.strictEqual(runBacklogCli(t, ["add", "first", "--p", "P2"]).status, 0);

  const other = cloneOther(origin);
  fs.writeFileSync(path.join(other, "notes.txt"), "b\n", "utf8");
  git(other, ["add", "-A"]);
  git(other, ["commit", "-q", "-m", "notes b"]);
  git(other, ["push", "-q", "origin", "main"]);

  // The local edit is byte-identical to upstream, so it carries no information
  // and must be cleared instead of freezing the fast-forward forever.
  fs.writeFileSync(path.join(t, "notes.txt"), "b\n", "utf8");
  const r = runBacklogCli(t, ["add", "second", "--p", "P2"]);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /fast-forwarded main to origin\/main/);
  assert.strictEqual(read(path.join(t, "notes.txt")), "b\n", "the redundant edit matched upstream");
  assert.strictEqual(git(t, ["status", "--porcelain", "--untracked-files=no"]), "", "tree clean after the transaction");
  assert.match(git(t, ["show", "HEAD:BACKLOG.md"]), /second/, "the new row is committed");
});

test("backlog worktree publishes the take before creating the checkout", () => {
  const { t } = canonicalBacklogRepo();
  assert.strictEqual(runBacklogCli(t, ["add", "isolate me", "--p", "P2"]).status, 0);
  const dir = path.join(os.tmpdir(), `wt-order-${path.basename(t)}`);
  const r = runBacklogCli(t, ["worktree", "F-001", "--branch", `b-${path.basename(t)}`, "--dir", dir]);
  assert.strictEqual(r.status, 0, r.out);
  // The take landed on origin BEFORE the checkout was created, so the new
  // worktree's snapshot already carries the In-progress row (no rebase conflict
  // when it later archives the row).
  assert.match(git(t, ["show", "origin/main:BACKLOG.md"]).split("## In progress")[1], /\| F-001 \|/);
  assert.match(read(path.join(dir, "BACKLOG.md")).split("## In progress")[1], /\| F-001 \|/);
  assert.strictEqual(git(t, ["status", "--porcelain", "--untracked-files=no"]), "", "main is clean after the take");
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

  await h.deploy(target, { name: "Demo", yes: true, isUpdate: true, acceptHarness: true });
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

test("context-guard finalization carve-out lands directly and confirms CI (no watch escape)", () => {
  // The tail is one call now: run `finalize` once, land on main, confirm CI.
  // There is no `--no-watch` escape and no merge-train watch to babysit.
  assert.match(cg.BAND_TEXT.checkpoint, /FINALIZATION CARVE-OUT/, "checkpoint names the carve-out");
  assert.match(cg.BAND_TEXT.checkpoint, /npm run finalize/, "checkpoint names the one-call finalizer");
  assert.match(cg.BAND_TEXT.checkpoint, /lands the branch directly on main/, "checkpoint says the branch lands on main");
  assert.doesNotMatch(cg.BAND_TEXT.checkpoint, /--no-watch|--watch-only|merge train/, "no watch escape remains");
  assert.match(cg.BAND_TEXT.hard, /npm run finalize/, "hard band names the one-call finalizer");
  assert.match(cg.BAND_TEXT.hard, /lands the branch directly on main/, "hard band says the branch lands on main");
  // The warning band is ADVISORY and must also carry the carve-out: at turn 50 a
  // task that is past implementation must be able to finalize, not stop and
  // strand the QA/finalize tail (LibraryOS F-259 stop #2).
  assert.match(cg.BAND_TEXT.warning, /ADVISORY, not a stop/, "warning says it is not a stop");
  assert.match(cg.BAND_TEXT.warning, /do NOT stop mid-phase/, "warning forbids stopping mid-phase");
  assert.match(cg.BAND_TEXT.warning, /FINALIZATION CARVE-OUT/, "warning carries the carve-out too");
  assert.match(cg.BAND_TEXT.warning, /npm run finalize/, "warning names the one-call finalizer");
});

test("context-guard injected block is labelled as a synthetic harness nudge, not a user message", () => {
  // The guard is delivered as a synthetic user-role message (the only shape the
  // transform forwards). LibraryOS F-259 stop #1: without a provenance banner
  // the model read the nudge as "the user is asking for a status update" and
  // stopped to ask for permission. The banner must be explicit and present on
  // every composed block.
  assert.match(cg.GUARD_PROVENANCE, /AUTOMATED HARNESS NUDGE/);
  assert.match(cg.GUARD_PROVENANCE, /NOT a user message/);
  const thresholds = cg.parseThresholds("");
  const state = cg.createSessionState();
  state.turns = 50;
  assert.ok(cg.composeGuardText(state, thresholds).startsWith(cg.GUARD_PROVENANCE));
  // The no-state nudge must instruct continuing, never "report the blocker" as a
  // first-class stop (the exact escape the model took).
  assert.doesNotMatch(cg.NO_STATE_TEXT, /or report the blocker/);
  assert.match(cg.NO_STATE_TEXT, /Continue the task; do not stop or ask for permission/);
});

test("context-guard composes band + funds + loop text in order (or null)", () => {
  const thresholds = cg.parseThresholds("");
  const state = cg.createSessionState();
  assert.strictEqual(cg.composeGuardText(state, thresholds), null, "nothing to say -> null");

  state.turns = 50;
  assert.strictEqual(
    cg.composeGuardText(state, thresholds),
    [cg.GUARD_PROVENANCE, cg.BAND_TEXT.warning].join("\n\n")
  );

  state.turns = 60;
  state.fundsPending = true;
  state.fundsNotice = cg.fundsText("deepseek/deepseek-v4-pro", "tool:task");
  state.loopPending = true;
  const composed = cg.composeGuardText(state, thresholds);
  assert.ok(composed.startsWith(cg.GUARD_PROVENANCE), "provenance banner leads every injection");
  assert.ok(composed.includes(cg.BAND_TEXT.checkpoint), "band follows the banner");
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

  // A request-context crossing arms the SAME warning band a turn crossing would.
  note = cg.noteAssistant(state, msg("m2", { input: 20000, cache: { read: 70000, write: 1000 } }), thresholds);
  assert.strictEqual(note.requestTokens, 91000);
  assert.strictEqual(note.requestLevel, "warn");
  assert.strictEqual(note.requestChanged, true);
  assert.strictEqual(note.band, "warning", "context pressure arms the warning band without 50 turns");
  assert.strictEqual(note.bandChanged, true);

  for (let i = 3; i <= 50; i++) note = cg.noteAssistant(state, msg("m" + i, null), thresholds);
  assert.strictEqual(state.turns, 50);
  assert.strictEqual(note.band, "warning");
  assert.strictEqual(note.bandChanged, false, "the same band is not re-reported");

  note = cg.noteAssistant(state, msg("m51", null), thresholds);
  assert.strictEqual(note.newTurn, true);

  // Turn-only pressure crosses warning at the threshold and checkpoint after it.
  const turnsOnly = cg.createSessionState();
  let t;
  for (let i = 1; i <= 50; i++) t = cg.noteAssistant(turnsOnly, msg("t" + i, null), thresholds);
  assert.strictEqual(t.band, "warning");
  assert.strictEqual(t.bandChanged, true);
  t = cg.noteAssistant(turnsOnly, msg("t51", null), thresholds);
  assert.strictEqual(t.band, "warning");
  assert.strictEqual(t.bandChanged, false);
  for (let i = 52; i <= 60; i++) t = cg.noteAssistant(turnsOnly, msg("t" + i, null), thresholds);
  assert.strictEqual(t.band, "checkpoint");
  assert.strictEqual(t.bandChanged, true);
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

test("context-guard combines turn and request-token pressure (strongest wins)", () => {
  const thresholds = cg.parseThresholds("");
  assert.strictEqual(cg.bandRank(cg.requestBand("observe")), 0);
  assert.strictEqual(cg.requestBand("warn"), "warning");
  assert.strictEqual(cg.requestBand("checkpoint"), "checkpoint");
  assert.strictEqual(cg.requestBand("intervene"), "new-context");

  const state = cg.createSessionState();
  state.turns = 1;
  state.requestLevel = "checkpoint";
  assert.strictEqual(cg.pressureBand(state, thresholds), "checkpoint", "context pressure alone drives the band");
  state.turns = 80;
  assert.strictEqual(cg.pressureBand(state, thresholds), "new-context", "the stronger of the two signals wins");
  state.requestLevel = null;
  assert.strictEqual(cg.pressureBand(state, thresholds), "new-context", "turn pressure alone still drives the band");
});

test("context-guard injects the checkpoint nudge on a request-token crossing", () => {
  const thresholds = cg.parseThresholds("");
  const state = cg.createSessionState();
  // 130K request context crosses the `checkpoint` request level (120K) on turn 1.
  cg.noteAssistant(
    state,
    { id: "r1", role: "assistant", tokens: { input: 30000, cache: { read: 100000 } } },
    thresholds
  );
  assert.strictEqual(state.turns, 1);
  assert.strictEqual(state.requestLevel, "checkpoint");
  assert.strictEqual(
    cg.composeGuardText(state, thresholds),
    [cg.GUARD_PROVENANCE, cg.BAND_TEXT.checkpoint].join("\n\n")
  );
});

test("context-guard refreshes request tokens on a repeat emit of the same message id", () => {
  // opencode emits a tokenless (all-zero) message.updated first, then a later
  // emit for the SAME id carrying real usage. The first emit must count the turn
  // but the later emit must still arm the request-token band (LibraryOS F-259:
  // deduping the whole handler left the request band dead in production).
  const thresholds = cg.parseThresholds("");
  const state = cg.createSessionState();

  const first = cg.noteAssistant(
    state,
    { id: "m1", role: "assistant", tokens: { input: 0, cache: { read: 0, write: 0 } } },
    thresholds
  );
  assert.strictEqual(first.newTurn, true);
  assert.strictEqual(state.turns, 1);
  assert.strictEqual(state.requestTokens, 0, "the first emit has no real usage yet");
  assert.strictEqual(state.band, null);

  const repeat = cg.noteAssistant(
    state,
    { id: "m1", role: "assistant", tokens: { input: 1298, cache: { read: 144000 } } },
    thresholds
  );
  assert.strictEqual(repeat.newTurn, false, "a repeat emit is not a second turn");
  assert.strictEqual(state.turns, 1);
  assert.strictEqual(repeat.requestTokens, 145298, "the token-bearing repeat refreshes usage");
  assert.strictEqual(repeat.requestLevel, "checkpoint");
  assert.strictEqual(repeat.requestChanged, true);
  assert.strictEqual(repeat.band, "checkpoint", "context pressure arms the band on the repeat emit");
  assert.strictEqual(repeat.bandChanged, true);
});

test("context-guard classifies material vs read-only tool calls", () => {
  assert.strictEqual(cg.isMaterial("edit", { filePath: "x" }), true);
  assert.strictEqual(cg.isMaterial("write", { filePath: "x" }), true);
  assert.strictEqual(cg.isMaterial("task", { prompt: "do" }), true);
  assert.strictEqual(cg.isMaterial("bash", { command: "git commit -m x" }), true);
  assert.strictEqual(cg.isMaterial("bash", { command: "echo hi > out.txt" }), true);
  assert.strictEqual(cg.isMaterial("bash", { command: "npm run test:quick" }), false);
  assert.strictEqual(cg.isMaterial("read", { filePath: "x" }), false);
  assert.strictEqual(cg.isMaterial("grep", { pattern: "x" }), false);
});

test("context-guard flags whole turns with no material state change (no-state detector)", () => {
  const thresholds = cg.parseThresholds("");
  const stuck = thresholds.stuck;
  const state = cg.createSessionState();
  const turn = (id) => cg.noteAssistant(state, { id, role: "assistant", tokens: null }, thresholds);

  turn("n1");
  cg.noteToolCall(state, "read", { filePath: "a.ts" }, stuck);
  turn("n2");
  cg.noteToolCall(state, "grep", { pattern: "x" }, stuck);
  turn("n3");
  cg.noteToolCall(state, "bash", { command: "npm run test:quick" }, stuck);
  turn("n4");
  const note = turn("n5");
  assert.strictEqual(state.noStateTurns, 4);
  assert.strictEqual(note.noStateChanged, true);
  assert.strictEqual(
    cg.composeGuardText(state, thresholds),
    [cg.GUARD_PROVENANCE, cg.NO_STATE_TEXT].join("\n\n")
  );
  assert.ok(note.noStateTurns >= 4);

  // A material edit clears the streak and the nudge.
  cg.noteToolCall(state, "edit", { filePath: "a.ts", oldString: "a", newString: "b" }, stuck);
  assert.strictEqual(state.noStatePending, false);
  assert.strictEqual(state.noStateTurns, 0);
  assert.strictEqual(cg.composeGuardText(state, thresholds), null);
});

test("context-guard flags the same failure signature repeating (same-failure detector)", () => {
  const stuck = cg.parseThresholds("").stuck;
  const state = cg.createSessionState();
  let note = cg.noteToolResult(state, "bash", { command: "npm test" }, false, "Error: boom", stuck);
  assert.strictEqual(note.count, 1);
  note = cg.noteToolResult(state, "bash", { command: "npm test -- x" }, false, "Error: boom", stuck);
  assert.strictEqual(note.count, 2);
  assert.strictEqual(note.firstFlag, false);
  note = cg.noteToolResult(state, "bash", { command: "npm test -- y" }, false, "Error: boom", stuck);
  assert.strictEqual(note.count, 3);
  assert.strictEqual(note.firstFlag, true);
  assert.strictEqual(state.failurePending, true);
  assert.ok(cg.composeGuardText(state, cg.parseThresholds("")).includes(cg.FAILURE_TEXT));

  // A success clears it.
  cg.noteToolResult(state, "bash", { command: "npm test -- z" }, true, "", stuck);
  assert.strictEqual(state.failurePending, false);
  assert.strictEqual(state.consecutiveFailures, 0);
  // A different failure restarts the count.
  note = cg.noteToolResult(state, "bash", {}, false, "Error: other", stuck);
  assert.strictEqual(note.count, 1);
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

test("main-checkout guard classifies code paths vs board/docs/metadata", () => {
  for (const p of [
    "app/api/admin/backlog/route.ts",
    "scripts/backlog.js",
    "scripts/qa/tests/backlog.test.ts",
    "package.json",
    "next.config.mjs",
    "src/components/Foo.tsx",
    ".env.local",
    "Dockerfile",
    "C:\\develop\\proj\\app\\page.tsx",
  ]) {
    assert.strictEqual(cg.isCodePath(p), true, `code: ${p}`);
  }
  for (const p of [
    ".agents/qa-plans/F-278.md",
    "/repo/.agents/handoffs/F-278.md",
    "BACKLOG.md",
    "CHANGELOG.md",
    "README.md",
    "docs/guide.md",
    "node_modules/x/index.js",
    ".serve/sessions/ses_1.json",
    "",
    null,
  ]) {
    assert.strictEqual(cg.isCodePath(p), false, `not code: ${p}`);
  }
});

test("main-checkout guard detects git mutations + in-place writes, not reads or the board CLI", () => {
  for (const command of [
    "git add .",
    "git commit -m 'x'",
    "git push origin main",
    "git -C /repo commit -m x",
    "git rebase origin/main",
    "git apply patch.diff",
    "git rm old.ts",
    "git add -A",
    "git commit -a -m x",
    "git add .agents/handoffs/F-278.md app/x.ts",
    "sed -i s/a/b/ app/x.ts",
    "perl -pi -e 's/a/b/' app/x.ts",
    "patch -p1 < fix.diff",
    "echo x > app/x.ts",
    "printf y >> scripts/backlog.js",
    "npm run build > out.txt",
    "cat a | tee app/x.ts",
  ]) {
    assert.strictEqual(cg.isCodeMutationCommand(command), true, `mutation: ${command}`);
  }
  for (const command of [
    "git status",
    "git fetch origin",
    "git log --oneline -5",
    "git diff --stat",
    "git worktree list",
    "node scripts/backlog.js worktree F-278",
    "node scripts/backlog.js next --take",
    "node scripts/backlog.js sync > /dev/null 2>&1",
    "npm run test:quick",
    "npm test",
    "echo hi > /tmp/out.txt",
    "npm run test:quick > /tmp/out.txt",
    'echo "a -> b"',
    'grep -rn "git commit" scripts/',
    "git add .agents/handoffs/F-278.md BACKLOG.md",
    "git add -- .agents/handoffs/F-278.md docs/guide.md",
    "git commit -m 'docs' -- .agents/handoffs/F-278.md",
    "git commit .agents/handoffs/F-278.md",
    "git rm docs/old.md",
    "sed -i s/a/b/ .agents/memory/history.md",
    "perl -pi -e 's/a/b/' README.md",
    "cat a | tee docs/guide.md",
    "",
    null,
  ]) {
    assert.strictEqual(cg.isCodeMutationCommand(command), false, `not a mutation: ${command}`);
  }
});

test("main-checkout guard exposes git ops with pathspecs + the effective repo selector", () => {
  const plain = cg.classifyCommand("git add .agents/handoffs/F-278.md && git commit -m x && git push");
  assert.deepStrictEqual(
    plain.gitOps.map((o) => [o.subcommand, o.pathless, o.paths]),
    [
      ["add", false, [".agents/handoffs/F-278.md"]],
      ["commit", true, []],
      ["push", true, []],
    ]
  );
  assert.strictEqual(plain.contentCode, false);

  const targeted = cg.classifyCommand("git -C /repo add -- app/x.ts docs/y.md");
  assert.strictEqual(targeted.gitOps[0].target, "/repo", "the -C repo selector is captured");
  assert.deepStrictEqual(targeted.gitOps[0].paths, ["app/x.ts", "docs/y.md"]);
  assert.strictEqual(cg.classifyCommand("git --git-dir=/repo/.git commit -m x").gitOps[0].target, "/repo/.git");
  assert.deepStrictEqual(cg.gitPathspecs("commit", ["-m", "msg", "--", "a.md", "b.ts"]), ["a.md", "b.ts"]);
  assert.deepStrictEqual(cg.gitPathspecs("commit", ["-m", "msg"]), [], "the -m value is not a pathspec");
});

test("main-checkout guard message names the target and points at isolation", () => {
  const text = cg.mainEditText("edit", "/repo/app/x.ts");
  assert.match(text, /SESSION GUARD/);
  assert.match(text, /MAIN checkout/);
  assert.match(text, /\/repo\/app\/x\.ts/);
  assert.match(text, /scripts\/backlog\.js worktree/);
  assert.match(text, /NOT executed/);
  assert.match(cg.mainEditText("bash", "/repo"), /command/);
  assert.match(cg.mainEditText("bash", "/repo"), /was NOT executed/);
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
  assert.match(src, /classifyCommand/, "main-checkout guard judges git ops by paths/target, not verb");
  assert.match(src, /gitOpTouchesCode/, "pathless commit/push are resolved against the live index/upstream");
  assert.match(src, /execFileSync/, "the index/upstream inspection shells out to git");
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
  assert.doesNotMatch(
    src,
    /note\.newTurn && note\.bandChanged/,
    "a band crossing is logged whenever it changes, not only on a new turn (token refresh emits are repeats)"
  );
  assert.match(src, /fundsError/, "detects provider funds/quota errors mechanically");
  assert.match(src, /session\.error/, "also watches provider session errors");
  assert.match(src, /fundsPending = false/, "a user message releases the funds stop");
  assert.match(src, /doom_loop/, "builds on the built-in doom-loop permission");
  assert.match(src, /inspectCommand/, "steers shell file-inspection to the dedicated tools");
  assert.match(src, /rerootBash/, "lifts a leading `cd <tree> &&` into the bash workdir argument");
  assert.match(src, /sessionBashRoot/, "defaults bash into the session's mid-session worktree");
  assert.match(src, /readWorktree/, "reads the session worktree pointer via the shared lease lib");
  assert.match(src, /dumpCommand/, "flags whole-tree output dumps");
  assert.match(src, /noteReadBefore/, "tracks in-session re-reads");
  assert.match(src, /noteReadAfter/, "flags guessed whole-file reads");
  assert.match(src, /clearOneShot/, "hygiene notices are one-shot, never nagging");
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
  assert.match(injected.parts[0].text, /AUTOMATED HARNESS NUDGE/, "the tail is labelled synthetic");
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

test("main-checkout plugin guard judges git ops by paths + effective target; docs maintenance on main is allowed", async () => {
  const { pathToFileURL } = require("node:url");
  const pluginPath = path.join(h.TEMPLATES_DIR, ".opencode", "plugins", "context-guard.ts");
  const mod = await import(pathToFileURL(pluginPath).href);
  const client = { app: { log: async () => {} } };

  const origin = tmpdir();
  git(origin, ["init", "--bare", "-q"]);
  const main = tmpdir();
  git(main, ["init", "-q"]);
  git(main, ["config", "user.email", "t@t.t"]);
  git(main, ["config", "user.name", "t"]);
  fs.mkdirSync(path.join(main, ".agents", "handoffs"), { recursive: true });
  fs.writeFileSync(path.join(main, "app.ts"), "export const x = 1\n");
  fs.writeFileSync(path.join(main, ".agents", "handoffs", "F-1.md"), "# handoff\n");
  git(main, ["add", "-A"]);
  git(main, ["commit", "-q", "-m", "seed"]);
  git(main, ["remote", "add", "origin", origin]);
  git(main, ["push", "-q", "-u", "origin", "HEAD:main"]);

  const plugin = await mod.ContextGuard({ directory: main, client });
  await plugin.event({ event: { type: "session.created", properties: { info: { id: "ses_main" } } } });
  const run = (command, args = {}) =>
    plugin["tool.execute.before"](
      { tool: "bash", sessionID: "ses_main", callID: "c" },
      { args: { command, ...args } }
    );
  const assertBlocked = (command) =>
    assert.rejects(run(command), /SESSION GUARD[\s\S]*MAIN checkout[\s\S]*NOT executed/, `blocked: ${command}`);

  // Docs maintenance on main is allowed — the false positive that blocked handoff
  // commits. (The index is empty at guard time, so the pathless commit is docs.)
  fs.writeFileSync(path.join(main, ".agents", "handoffs", "F-1.md"), "# handoff v2\n");
  await run("git add .agents/handoffs/F-1.md && git commit -q -m 'docs: handoff'");
  git(main, ["add", ".agents/handoffs/F-1.md"]);
  git(main, ["commit", "-q", "-m", "docs: handoff"]);
  await run("git commit --amend --no-edit"); // amending a docs-only commit stays allowed

  // Source edits / writes on main are still blocked.
  await assertBlocked("git add app.ts");
  await assertBlocked("echo x > app.ts");

  // A whole-index commit is judged by the live index: docs staged -> allowed.
  fs.writeFileSync(path.join(main, ".agents", "handoffs", "F-1.md"), "# handoff v3\n");
  git(main, ["add", ".agents/handoffs/F-1.md"]);
  await run("git commit -q -m 'docs: staged handoff'");
  // Code staged -> blocked.
  fs.writeFileSync(path.join(main, "app.ts"), "export const x = 2\n");
  git(main, ["add", "app.ts"]);
  await assertBlocked("git commit -q -m 'feat: code'");

  // A push is judged by the commits not yet on the upstream.
  git(main, ["reset", "--hard", "-q", "origin/main"]);
  git(main, ["commit", "-q", "--allow-empty", "-m", "docs-only marker"]);
  await run("git push -q origin HEAD:main");
  fs.writeFileSync(path.join(main, "app.ts"), "export const x = 3\n");
  git(main, ["add", "app.ts"]);
  git(main, ["commit", "-q", "-m", "feat: unpushed code"]);
  await assertBlocked("git push -q origin HEAD:main");
  await assertBlocked("git commit --amend --no-edit"); // amending a code commit is code

  // `git -C <main>` from a linked worktree is resolved to main, not bypassed via
  // the worktree cwd (the hole the docs-commit workaround exploited).
  const wt = path.join(tmpdir(), "linked");
  git(main, ["worktree", "add", "-q", wt, "-b", "feat"]);
  const wtPlugin = await mod.ContextGuard({ directory: wt, client });
  await wtPlugin.event({ event: { type: "session.created", properties: { info: { id: "ses_wt" } } } });
  const runWt = (command) =>
    wtPlugin["tool.execute.before"](
      { tool: "bash", sessionID: "ses_wt", callID: "c" },
      { args: { command } }
    );
  // main's index carries the unpushed code commit's tree? It's committed, so
  // stage fresh code and confirm the -C commit is blocked.
  fs.writeFileSync(path.join(main, "app.ts"), "export const x = 4\n");
  git(main, ["add", "app.ts"]);
  await assert.rejects(
    runWt(`git -C ${main} commit -q -m 'feat: code via -C'`),
    /SESSION GUARD[\s\S]*MAIN checkout/,
    "a -C <main> code commit is resolved to main and blocked, not bypassed"
  );
  // Docs staged in main through the same -C target are allowed.
  git(main, ["reset", "-q"]);
  fs.writeFileSync(path.join(main, ".agents", "handoffs", "F-1.md"), "# handoff v4\n");
  git(main, ["add", ".agents/handoffs/F-1.md"]);
  await runWt(`git -C ${main} commit -q -m 'docs: via -C'`);
});

test("tool-choice / reroot / read-hygiene core helpers classify the measured anti-patterns", () => {
  const g = require(CG);
  // Read-only shell inspection the dedicated Read/Grep/Glob tools cover.
  assert.strictEqual(g.inspectCommand("grep -rn 'foo' lib/"), "grep");
  assert.strictEqual(g.inspectCommand("cat a.ts"), "cat");
  assert.strictEqual(g.inspectCommand("ls -la apps/"), "ls");
  assert.strictEqual(g.inspectCommand("find . -name '*.ts'"), "find");
  assert.strictEqual(g.inspectCommand("sed -n '1,40p' a.ts"), "sed");
  assert.strictEqual(g.inspectCommand("sudo cat a.ts"), "cat", "wrappers are skipped");
  // The first shell segment is what matters; a trailing pipe/redirect is output shaping.
  assert.strictEqual(g.inspectCommand("cat a.ts | grep foo"), "cat");
  assert.strictEqual(g.inspectCommand("grep foo a.ts > out.txt"), "grep");
  assert.strictEqual(g.inspectCommand("grep -rn foo lib/ 2>/dev/null"), "grep");
  assert.strictEqual(g.inspectCommand("git log | grep foo"), null, "grep as a downstream filter is not an inspection");
  assert.strictEqual(g.inspectCommand("sed -i 's/a/b/' a.ts"), null);
  assert.strictEqual(g.inspectCommand("git status"), null);
  assert.strictEqual(g.inspectCommand("npm run test:quick"), null);

  // `cd <abs> && rest` -> workdir (the WSL cd-chaining habit).
  assert.deepStrictEqual(g.rerootBash("cd /repo && npm test"), { workdir: "/repo", command: "npm test" });
  assert.deepStrictEqual(g.rerootBash("cd ~/develop/x && git status"), { workdir: "~/develop/x", command: "git status" });
  assert.strictEqual(g.rerootBash("cd sub && npm test"), null, "relative cd is not lifted");
  assert.strictEqual(g.rerootBash("cd /a && cd /b && ls"), null, "two cds are not rewritten");
  assert.strictEqual(g.rerootBash("cd $DIR && ls"), null, "dynamic path is left alone");
  assert.strictEqual(g.rerootBash("npm test"), null);

  // Whole-tree dumps are flagged; ordinary commands are not.
  assert.strictEqual(g.dumpCommand("find / -maxdepth 5 -name BACKLOG.md"), "find");
  assert.strictEqual(g.dumpCommand("ls -R"), "ls");
  assert.strictEqual(g.dumpCommand("git diff --stat"), null);
  assert.strictEqual(g.dumpCommand("ls -la"), null);

  // Read hygiene one-shots.
  const s = g.createSessionState();
  assert.strictEqual(g.noteReadBefore(s, "a.ts").firstFlag, false);
  assert.strictEqual(g.noteReadBefore(s, "a.ts").firstFlag, true, "second read of the same path arms");
  assert.strictEqual(g.noteReadBefore(s, "a.ts").firstFlag, false, "fires at most once");
  const w = g.createSessionState();
  assert.strictEqual(
    g.noteReadAfter(w, {}, { output: "x".repeat(g.READ_LARGE_BYTES + 1) }).notice,
    "whole"
  );
  const r = g.createSessionState();
  assert.strictEqual(g.noteReadAfter(r, {}, { output: "boom", error: "ENOENT" }).notice, "missing");

  // Notices compose on the tail and clear as one-shots.
  const st = g.createSessionState();
  st.inspectPending = true;
  st.dumpPending = true;
  const text = g.composeGuardText(st, null);
  assert.match(text, /TOOL GUARD[\s\S]*read-only shell inspection/);
  assert.match(text, /whole tree/);
  g.clearOneShot(st);
  assert.strictEqual(st.inspectPending, false);
  assert.strictEqual(st.dumpPending, false);
});

test("bash reroot lifts `cd <tree> &&` into workdir and defaults to the session worktree", async () => {
  const { pathToFileURL } = require("node:url");
  const leases = require(path.join(h.TEMPLATES_DIR, "scripts", "qa", "lease-lib.js"));
  const pluginPath = path.join(h.TEMPLATES_DIR, ".opencode", "plugins", "context-guard.ts");
  const mod = await import(pathToFileURL(pluginPath).href);
  const directory = tmpdir();
  const wt = tmpdir();
  const plugin = await mod.ContextGuard({ directory, client: { app: { log: async () => {} } } });
  await plugin.event({ event: { type: "session.created", properties: { info: { id: "ses_r" } } } });

  // An explicit `cd <abs> && ...` is lifted into the bash workdir argument.
  const a = { args: { command: `cd ${wt} && npm run test:quick` } };
  await plugin["tool.execute.before"]({ tool: "bash", sessionID: "ses_r", callID: "c1" }, a);
  assert.strictEqual(a.args.workdir, wt);
  assert.strictEqual(a.args.command, "npm run test:quick");

  // A recorded mid-session worktree defaults a cwd-less command into it.
  leases.writeWorktree(directory, "ses_r", wt);
  const b = { args: { command: "git status --short" } };
  await plugin["tool.execute.before"]({ tool: "bash", sessionID: "ses_r", callID: "c2" }, b);
  assert.strictEqual(b.args.workdir, wt);

  // An explicit workdir is never overwritten.
  const c = { args: { command: "ls", workdir: "/elsewhere" } };
  await plugin["tool.execute.before"]({ tool: "bash", sessionID: "ses_r", callID: "c3" }, c);
  assert.strictEqual(c.args.workdir, "/elsewhere");
});

test("the guard nudges shell tool-choice and re-reads once, on the cache-safe tail", async () => {
  const { pathToFileURL } = require("node:url");
  const pluginPath = path.join(h.TEMPLATES_DIR, ".opencode", "plugins", "context-guard.ts");
  const mod = await import(pathToFileURL(pluginPath).href);
  const plugin = await mod.ContextGuard({ directory: tmpdir(), client: { app: { log: async () => {} } } });
  const sid = "ses_hygiene";
  await plugin.event({ event: { type: "session.created", properties: { info: { id: sid } } } });

  await plugin["tool.execute.before"](
    { tool: "bash", sessionID: sid, callID: "c1" },
    { args: { command: "grep -rn foo lib/" } }
  );
  const out1 = { messages: [{ info: { role: "user", sessionID: sid }, parts: [] }] };
  await plugin["experimental.chat.messages.transform"]({}, out1);
  assert.match(out1.messages.at(-1).parts[0].text, /read-only shell inspection/);
  // The notice is one-shot: the next request does not repeat it.
  const out2 = { messages: [{ info: { role: "user", sessionID: sid }, parts: [] }] };
  await plugin["experimental.chat.messages.transform"]({}, out2);
  assert.strictEqual(out2.messages.length, 1, "the tool-choice nudge is not repeated");

  // A second read of the same path arms the re-read nudge.
  await plugin["tool.execute.before"]({ tool: "read", sessionID: sid, callID: "r1" }, { args: { filePath: "a.ts" } });
  await plugin["tool.execute.before"]({ tool: "read", sessionID: sid, callID: "r2" }, { args: { filePath: "a.ts" } });
  const out3 = { messages: [{ info: { role: "user", sessionID: sid }, parts: [] }] };
  await plugin["experimental.chat.messages.transform"]({}, out3);
  assert.match(out3.messages.at(-1).parts[0].text, /already read this file/);
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
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: true, acceptHarness: true });
  assert.match(read(corePath), /parseThresholds/, "guard core is harness-owned (restored on update)");
});

// ---------------------------------------------------------------- provider-stats / cost telemetry (Phase B)

const PS = path.join(h.TEMPLATES_DIR, "scripts", "qa", "provider-stats.js");
const ps = require(PS);
const SR = path.join(h.TEMPLATES_DIR, "scripts", "qa", "session-recon.js");
const sr = require(SR);

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

test("provider-stats surfaces mid-cycle resume sessions (the E2E context-reset metric)", () => {
  const sessions = [
    ps.mapSessionRow({ id: "ses_r1", title: "Resuming F-256 from checkpoint", cost: 0.1, time_created: 1, time_updated: 2 }),
    ps.mapSessionRow({ id: "ses_r2", title: "Pull next backlog item", cost: 0.2, time_created: 3, time_updated: 4 }),
  ];
  const agg = ps.aggregateSessions(sessions, {});
  assert.strictEqual(agg.resumes.count, 1);
  assert.strictEqual(agg.resumes.sessions[0].id, "ses_r1");
  assert.match(agg.resumes.sessions[0].title, /Resuming/);
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

test("session-recon classifies shell tool-choice, cd-chaining, dumps and read hygiene", () => {
  const at = Date.parse("2026-09-20T00:00:00Z");
  const parts = [
    { session_id: "s", tool: "bash", input: JSON.stringify({ command: "grep -rn foo lib/" }), status: "completed", outputLen: 100, time_created: at },
    { session_id: "s", tool: "bash", input: JSON.stringify({ command: "cd /repo && npm test" }), status: "completed", outputLen: 100, time_created: at },
    { session_id: "s", tool: "bash", input: JSON.stringify({ command: "find / -name x" }), status: "completed", outputLen: 100, time_created: at },
    { session_id: "s", tool: "bash", input: JSON.stringify({ command: "for i in 1 2; do gh run view 1; done" }), status: "completed", outputLen: 100, time_created: at },
    { session_id: "s", tool: "read", input: JSON.stringify({ filePath: "a.ts" }), status: "completed", outputLen: 100, time_created: at },
    { session_id: "s", tool: "read", input: JSON.stringify({ filePath: "a.ts" }), status: "completed", outputLen: 100, time_created: at },
    { session_id: "s", tool: "read", input: JSON.stringify({ filePath: "big.ts" }), status: "completed", outputLen: 40000, time_created: at },
    { session_id: "s", tool: "read", input: JSON.stringify({ filePath: "gone.ts" }), status: "error", outputLen: 0, time_created: at },
    { session_id: "s", tool: "task", input: JSON.stringify({ prompt: "x".repeat(1200) }), status: "completed", outputLen: 0, time_created: at },
  ];
  const h2 = sr.analyzeTools(parts);
  assert.strictEqual(h2.bash, 4);
  assert.strictEqual(h2.inspectTotal, 2, "grep and find are both inspections");
  assert.strictEqual(h2.inspect.find((i) => i.tool === "grep").count, 1);
  assert.strictEqual(h2.cdWrapped, 1);
  assert.strictEqual(h2.dumps, 1);
  assert.strictEqual(h2.polling.gh, 1);
  assert.strictEqual(h2.read.total, 4);
  assert.strictEqual(h2.read.whole, 4);
  assert.strictEqual(h2.read.rereads, 1);
  assert.strictEqual(h2.read.large, 1);
  assert.strictEqual(h2.read.errors, 1);
  assert.strictEqual(h2.task.count, 1);
  assert.strictEqual(h2.task.promptBytesMax, 1200);
  assert.strictEqual(h2.perDay.length, 1, "one calendar day in the fixture");
});

test("session-recon turn bands + guard events summarize deterministically", () => {
  const bands = sr.analyzeTurnBands([
    { id: "a", parentId: null, turns: 10, cost: 0.1 },
    { id: "b", parentId: null, turns: 70, cost: 0.6 },
    { id: "c", parentId: "b", turns: 5, cost: 0.1 },
  ]);
  const b = bands.find((x) => x.band === "61-80");
  assert.strictEqual(b.sessions, 1, "only the primary session is banded");
  assert.strictEqual(b.cost, 0.6);
  assert.ok(Math.abs(b.costShare - 0.6 / 0.7) < 1e-9);

  const g = sr.summarizeGuardEvents([
    { kind: "band", ts: "2026-09-20T10:00:00Z" },
    { kind: "band", ts: "2026-09-20T11:00:00Z" },
    { kind: "no_state", ts: "2026-09-21T00:00:00Z" },
  ]);
  assert.strictEqual(g.total, 3);
  assert.strictEqual(g.kinds[0].kind, "band");
  assert.strictEqual(g.kinds[0].count, 2);
  assert.strictEqual(g.perDay.length, 2);
});

test("session-recon CLI reads a fixture, prints observed habits, and exports a round-trippable snapshot", () => {
  const target = tmpdir();
  const fixture = path.join(target, "recon.json");
  fs.writeFileSync(
    fixture,
    JSON.stringify({
      schema: sr.SCHEMA,
      meta: { schema: sr.SCHEMA, root: target, since: null },
      sessions: [
        { id: "ses_a", parentId: null, title: "F-1", agent: "build", model: "deepseek-flash", provider: "deepseek", cost: 0.5, turns: 70, tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 1, cacheWrite: 0 } },
      ],
      parts: [
        { session_id: "ses_a", tool: "bash", input: JSON.stringify({ command: "ls -la" }), status: "completed", outputLen: 10, time_created: 1 },
      ],
      guardEvents: [{ kind: "band", ts: "2026-09-20T00:00:00Z" }],
    }),
    "utf8"
  );

  const jsonRes = spawnSync(process.execPath, [SR, "--fixture", fixture, "--json"], { encoding: "utf8" });
  assert.strictEqual(jsonRes.status, 0, jsonRes.stdout + jsonRes.stderr);
  const parsed = JSON.parse(jsonRes.stdout);
  assert.strictEqual(parsed.schema, sr.SCHEMA);
  assert.strictEqual(parsed.aggregates.habits.inspectTotal, 1);
  assert.strictEqual(parsed.aggregates.guard.total, 1);

  const humanRes = spawnSync(process.execPath, [SR, "--fixture", fixture], { encoding: "utf8" });
  assert.strictEqual(humanRes.status, 0, humanRes.stdout + humanRes.stderr);
  assert.match(humanRes.stdout, /Session recon/);

  const out = path.join(target, "exported.json");
  const exportRes = spawnSync(process.execPath, [SR, "--fixture", fixture, "--export", out], { encoding: "utf8" });
  assert.strictEqual(exportRes.status, 0, exportRes.stdout + exportRes.stderr);
  const round = sr.readFixture(out);
  assert.strictEqual(round.sessions.length, 1);
  assert.strictEqual(round.parts.length, 1);

  const badRes = spawnSync(process.execPath, [SR, "--fixture", path.join(target, "missing.json")], { encoding: "utf8" });
  assert.strictEqual(badRes.status, 1, "an unreadable fixture fails loudly");
  assert.match(badRes.stderr, /session-recon:/);
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
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: true, acceptHarness: true });
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

test("checkpoint writes into the feature worktree when the session root is main", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });
  if (!exists(path.join(target, ".git"))) {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: target });
  }
  git(target, ["config", "user.email", "t@t.t"]);
  git(target, ["config", "user.name", "t"]);
  git(target, ["add", "-A"]);
  git(target, ["commit", "-q", "-m", "seed"]);
  const wt = path.join(os.tmpdir(), `cp-wt-${path.basename(target)}`);
  execFileSync("git", ["-C", target, "worktree", "add", "-q", "-b", "f-246", wt, "HEAD"], { encoding: "utf8" });

  // No session pointer (the bash-created-worktree case): the feature id matches
  // the linked worktree, so the checkpoint must land there, not in main.
  const cp = spawnSync(
    process.execPath,
    ["scripts/checkpoint.js", "write", "--feature", "F-246", "--objective", "fixture fix", "--next-action", "ship"],
    { cwd: target, encoding: "utf8" }
  );
  assert.strictEqual(cp.status, 0, (cp.stdout || "") + (cp.stderr || ""));
  assert.ok(exists(path.join(wt, ".agents", "handoffs", "F-246.md")), "checkpoint landed in the feature worktree");
  assert.ok(!exists(path.join(target, ".agents", "handoffs", "F-246.md")), "no stray handoff in the main tree");
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
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: true, acceptHarness: true });
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

// ---------------------------------------------------------------- ignore-aware search + tmpfs

test("deploy writes the canonical .ignore, preserves project entries, and is idempotent", async () => {
  const target = tmpdir();
  git(target, ["init", "-q"]);
  fs.writeFileSync(path.join(target, ".ignore"), "my-scratch/\n", "utf8");

  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false, commit: false });
  const ig = read(path.join(target, ".ignore"));
  assert.ok(ig.includes("my-scratch/"), "project .ignore entry preserved");
  assert.match(ig, /# agent-harness \(managed below\)/);
  assert.ok(ig.includes("node_modules/"), "node_modules excluded");
  assert.ok(ig.includes("__pycache__/"), "python caches excluded");
  assert.ok(ig.includes(".terraform/"), "terraform excluded");

  await h.deploy(target, { name: "Demo", yes: true, isUpdate: true, commit: false });
  const ig2 = read(path.join(target, ".ignore"));
  assert.strictEqual(ig2, ig, "re-deploy is byte-identical (idempotent)");
  assert.strictEqual((ig2.match(/# agent-harness \(managed below\)/g) || []).length, 1, "marker not duplicated");
  assert.ok(!exists(path.join(target, ".gitignore")), "the project .gitignore is never created by the harness");
});

test("mergeIgnoreFile replaces a stale managed block and keeps project entries on both sides", () => {
  const t = tmpdir();
  fs.writeFileSync(
    path.join(t, ".ignore"),
    "before/\n# agent-harness (managed below)\nold-tree/\n# agent-harness (managed end)\nafter/\n",
    "utf8"
  );
  const out = h.mergeIgnoreFile(t);
  assert.ok(out.includes("before/"), "entry before the block survives");
  assert.ok(out.includes("after/"), "entry after the block survives");
  assert.ok(!out.includes("old-tree/"), "stale managed entry removed");
  assert.ok(out.includes("node_modules/"), "canonical entries present");
  assert.strictEqual((out.match(/# agent-harness \(managed below\)/g) || []).length, 1);
});

test("deploy ships agent-search.sh + setup-tmpfs.sh, executable and LF, wired into npm scripts", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });

  for (const rel of ["scripts/agent-search.sh", "scripts/setup-tmpfs.sh"]) {
    const p = path.join(target, rel);
    assert.ok(exists(p), `${rel} deployed`);
    const src = read(p);
    assert.doesNotMatch(src, /\r/, `${rel} is LF`);
    const mode = fs.statSync(p).mode & 0o777;
    assert.ok(mode & 0o111, `${rel} is executable (mode ${mode.toString(8)})`);
  }

  const pkg = JSON.parse(read(path.join(target, "package.json")));
  assert.strictEqual(pkg.scripts.search, "bash scripts/agent-search.sh");
  assert.strictEqual(pkg.scripts.ramdisk, "bash scripts/setup-tmpfs.sh up");

  const search = read(path.join(target, "scripts", "agent-search.sh"));
  assert.doesNotMatch(search, /\brg\b[^\n]*--no-ignore/, "rg is never invoked with --no-ignore");
  assert.doesNotMatch(search, /\brg\b[^\n]*--unrestricted/, "rg is never invoked with --unrestricted");
  assert.match(search, /refusing/, "wrapper refuses ignore-disabling flags");
  assert.match(search, /--files/, "wrapper supports cheap file discovery");
  assert.match(search, /--max-columns|--max-filesize/, "wrapper bounds oversized files/lines");

  const tmpfs = read(path.join(target, "scripts", "setup-tmpfs.sh"));
  assert.match(tmpfs, /PIP_CACHE_DIR/);
  assert.match(tmpfs, /npm_config_cache/);
  assert.match(tmpfs, /GOCACHE/);
  assert.match(tmpfs, /RUSTC_WRAPPER=sccache/);
  assert.match(tmpfs, /VOLATILE/i, "tmpfs volatility is warned about");
});

test("setup-tmpfs.sh is a no-op outside WSL and idempotent/dry-runnable with overrides", () => {
  const script = path.join(h.TEMPLATES_DIR, "scripts", "setup-tmpfs.sh");
  const cfg = tmpdir();
  const base = {
    ...process.env,
    AGENT_TMPFS_DRY_RUN: "1",
    AGENT_TMPFS_CONFIG: cfg,
    AGENT_RAMDISK: path.join(cfg, "ramdisk"),
  };
  // No WSL signals, forced off: every action is a clean no-op.
  const env = { ...base };
  delete env.WSL_DISTRO_NAME;
  delete env.AGENT_TMPFS_FORCE;
  const off = spawnSync("bash", [script, "up"], {
    encoding: "utf8",
    env: { ...env, AGENT_TMPFS_FORCE: "0", AGENT_TMPFS_DRY_RUN: "1" },
  });
  assert.strictEqual(off.status, 0, off.stderr);
  assert.match(off.stdout, /not WSL — no-op/);

  // Forced-on dry run: prints the planned mount + env and changes nothing.
  const on = spawnSync("bash", [script, "up"], {
    encoding: "utf8",
    env: { ...base, AGENT_TMPFS_FORCE: "1" },
  });
  assert.strictEqual(on.status, 0, on.stderr);
  assert.match(on.stdout, /mount -t tmpfs -o size=\d+M,mode=0755/);
  assert.match(on.stdout, /VOLATILE/i, "dry-run warns about volatility");

  const envOut = spawnSync("bash", [script, "env"], { encoding: "utf8", env: base });
  assert.strictEqual(envOut.status, 0, envOut.stderr);
  assert.match(envOut.stdout, /^export /m);
  assert.match(envOut.stdout, /PIP_CACHE_DIR|npm_config_cache/);
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

test("worktree-prune <branch> prunes a squash-merged branch that ancestry cannot detect", () => {
  // Squash merges leave the branch commits out of main, so `git branch --merged`
  // never sees them; naming the branch is the explicit escape hatch.
  const { target } = trackedRepoFixture();
  fs.mkdirSync(path.join(target, "scripts", "qa"), { recursive: true });
  fs.copyFileSync(path.join(h.TEMPLATES_DIR, "scripts", "backlog.js"), path.join(target, "scripts", "backlog.js"));
  copyBoardLib(target);
  fs.copyFileSync(path.join(h.TEMPLATES_DIR, "BACKLOG.md"), path.join(target, "BACKLOG.md"));
  git(target, ["add", "-A"]);
  git(target, ["commit", "-q", "-m", "seed harness scripts"]);
  git(target, ["push", "-q", "origin", "main"]);

  const wt = path.join(tmpdir(), "wt-squash");
  git(target, ["branch", "feat-squash", "main"]);
  git(target, ["worktree", "add", wt, "feat-squash"]);
  fs.writeFileSync(path.join(wt, "feat.txt"), "x\n", "utf8");
  execFileSync("git", ["-C", wt, "add", "-A"], { encoding: "utf8" });
  execFileSync("git", ["-C", wt, "commit", "-q", "-m", "feat-squash work"], { encoding: "utf8" });

  // unnamed: not an ancestor of main -> kept
  let res = spawnSync(process.execPath, ["scripts/backlog.js", "worktree-prune"], { cwd: target, encoding: "utf8" });
  assert.strictEqual(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /kept wt-squash/);
  assert.ok(exists(wt), "unmerged-ancestry worktree kept by default");

  // explicit name -> pruned (still requires a clean checkout)
  res = spawnSync(process.execPath, ["scripts/backlog.js", "worktree-prune", "feat-squash"], { cwd: target, encoding: "utf8" });
  assert.strictEqual(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /pruned wt-squash/);
  assert.ok(!exists(wt), "explicitly named worktree pruned");
});

test("worktree-prune keeps a worktree owned by a live session (mid-ship safety)", () => {
  const { target } = trackedRepoFixture();
  fs.mkdirSync(path.join(target, "scripts", "qa"), { recursive: true });
  fs.copyFileSync(path.join(h.TEMPLATES_DIR, "scripts", "backlog.js"), path.join(target, "scripts", "backlog.js"));
  copyBoardLib(target);
  fs.copyFileSync(path.join(h.TEMPLATES_DIR, "BACKLOG.md"), path.join(target, "BACKLOG.md"));
  git(target, ["add", "-A"]);
  git(target, ["commit", "-q", "-m", "seed harness scripts"]);
  git(target, ["push", "-q", "origin", "main"]);

  const wt = path.join(tmpdir(), "wt-live");
  git(target, ["branch", "feat-live", "main"]);
  git(target, ["worktree", "add", wt, "feat-live"]);
  fs.writeFileSync(path.join(wt, "x.txt"), "x\n", "utf8");
  execFileSync("git", ["-C", wt, "add", "-A"], { encoding: "utf8" });
  execFileSync("git", ["-C", wt, "commit", "-q", "-m", "feat-live work"], { encoding: "utf8" });
  git(target, ["merge", "--ff-only", "feat-live"]);
  git(target, ["push", "-q", "origin", "main"]);

  // A live session's fresh lease plus its worktree pointer both claim this
  // checkout — the exact condition a mid-`ship` session is in.
  const sessions = path.join(target, ".serve", "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(
    path.join(sessions, "ses_live.json"),
    JSON.stringify({ sessionID: "ses_live", pid: process.pid, startedAt: Date.now(), heartbeatAt: Date.now() }),
    "utf8"
  );
  fs.writeFileSync(path.join(sessions, "ses_live.worktree"), wt, "utf8");

  let res = spawnSync(process.execPath, ["scripts/backlog.js", "worktree-prune"], { cwd: target, encoding: "utf8" });
  assert.strictEqual(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /kept wt-live \(in use by a live session\)/);
  assert.ok(exists(wt), "in-use worktree kept even though its branch is merged and clean");

  // Once the lease is gone the abandoned checkout converges as before.
  fs.rmSync(path.join(sessions, "ses_live.json"), { force: true });
  fs.rmSync(path.join(sessions, "ses_live.worktree"), { force: true });
  res = spawnSync(process.execPath, ["scripts/backlog.js", "worktree-prune"], { cwd: target, encoding: "utf8" });
  assert.strictEqual(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /pruned wt-live/);
  assert.ok(!exists(wt), "abandoned worktree pruned");
});

test("archive keeps the session worktree pointer while standing inside the checkout", () => {
  const { target } = trackedRepoFixture();
  fs.mkdirSync(path.join(target, "scripts", "qa"), { recursive: true });
  fs.copyFileSync(path.join(h.TEMPLATES_DIR, "scripts", "backlog.js"), path.join(target, "scripts", "backlog.js"));
  copyBoardLib(target);
  fs.copyFileSync(path.join(h.TEMPLATES_DIR, "BACKLOG.md"), path.join(target, "BACKLOG.md"));
  git(target, ["add", "-A"]);
  git(target, ["commit", "-q", "-m", "seed harness scripts"]);
  git(target, ["push", "-q", "origin", "main"]);

  runBacklogCli(target, ["add", "a thing", "--p", "P1", "--id", "F-001", "--evidence", "ev"]);

  const wt = path.join(path.dirname(target), "wt-" + path.basename(target));
  const env = { ...process.env, HARNESS_SESSION_ID: "ses_arch" };
  const mk = spawnSync(process.execPath, ["scripts/backlog.js", "worktree", "F-001", "--dir", wt], {
    cwd: target,
    encoding: "utf8",
    env,
  });
  assert.strictEqual(mk.status, 0, mk.stdout + mk.stderr);
  const pointer = path.join(target, ".serve", "sessions", "ses_arch.worktree");
  assert.ok(exists(pointer), "worktree records the session pointer");

  // The worktree's board must carry the annotated In-progress row.
  fs.copyFileSync(path.join(target, "BACKLOG.md"), path.join(wt, "BACKLOG.md"));

  const arc = spawnSync(process.execPath, ["scripts/backlog.js", "archive", "F-001"], { cwd: wt, encoding: "utf8", env });
  assert.strictEqual(arc.status, 0, arc.stdout + arc.stderr);
  assert.match(arc.stdout, /archived F-001/);
  assert.ok(exists(wt), "worktree left in place (archive ran inside it)");
  assert.ok(exists(pointer), "pointer kept while the session still owns the checkout (finalize runs ship next)");
});

test("backlog-notify summarizes the worktree/depends/owns tools too", () => {
  const src = read(path.join(h.TEMPLATES_DIR, ".opencode", "plugins", "backlog-notify.ts"));
  assert.match(src, /backlog_worktree/);
  assert.match(src, /backlog_depends/);
  assert.match(src, /backlog_owns/);
});

function initShipRepo() {
  const target = tmpdir();
  fs.mkdirSync(path.join(target, "scripts", "qa"), { recursive: true });
  fs.copyFileSync(path.join(h.TEMPLATES_DIR, "scripts", "ship.js"), path.join(target, "scripts", "ship.js"));
  // ship's convergence requires the shared board-sync module (and backlog.js
  // for the board lock); copyBoardLib below deploys board-sync + merge-backlog.
  fs.copyFileSync(path.join(h.TEMPLATES_DIR, "scripts", "backlog.js"), path.join(target, "scripts", "backlog.js"));
  copyBoardLib(target);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: target, encoding: "utf8" });
  execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: target });
  execFileSync("git", ["config", "user.name", "t"], { cwd: target });
  fs.writeFileSync(path.join(target, "README.md"), "x\n", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: target });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: target });
  return target;
}

function runShipCli(target, args) {
  const res = spawnSync(process.execPath, ["scripts/ship.js", ...args], { cwd: target, encoding: "utf8" });
  return { status: res.status, out: (res.stdout || "") + (res.stderr || "") };
}

test("ship refuses to ship the integration branch (main)", () => {
  const target = initShipRepo();
  const res = runShipCli(target, ["--no-gate"]);
  assert.strictEqual(res.status, 1, res.out);
  assert.match(res.out, /refusing to ship/);
});

test("ship refuses a dirty tree rather than shipping WIP", () => {
  const target = initShipRepo();
  execFileSync("git", ["checkout", "-q", "-b", "f-dirty"], { cwd: target });
  fs.writeFileSync(path.join(target, "README.md"), "changed\n", "utf8");
  const res = runShipCli(target, ["--no-gate"]);
  assert.strictEqual(res.status, 1, res.out);
  assert.match(res.out, /uncommitted tracked changes/);
});

test("ship commits a handoff-only checkpoint so the documented resume (`npm run ship`) works", () => {
  // The budget-pause deadlock: the code is committed, the checkpoint dirties
  // `.agents/handoffs/<id>.md`, and ship's dirty-tree guard aborts before the
  // push — so the exact resume command the checkpoint prints can never run.
  const target = initShipRepo();
  execFileSync("git", ["checkout", "-q", "-b", "f-checkpoint"], { cwd: target });
  fs.mkdirSync(path.join(target, ".agents", "handoffs"), { recursive: true });
  const handoff = path.join(target, ".agents", "handoffs", "F-001.md");
  fs.writeFileSync(handoff, "# handoff\n", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: target });
  execFileSync("git", ["commit", "-q", "-m", "seed handoff"], { cwd: target });
  fs.appendFileSync(handoff, "\n## Checkpoint\n- phase: finalizing\n", "utf8");

  // No origin -> the push after the auto-commit fails; the point is that ship
  // got PAST the dirty guard instead of refusing.
  const res = runShipCli(target, ["--no-gate", "--no-rebase"]);
  assert.strictEqual(res.status, 1, res.out);
  assert.doesNotMatch(res.out, /uncommitted tracked changes/);
  assert.match(res.out, /session handoff checkpoint/);
  assert.strictEqual(
    execFileSync("git", ["log", "-1", "--format=%s"], { cwd: target, encoding: "utf8" }).trim(),
    "docs(f-checkpoint): session checkpoint"
  );
  assert.strictEqual(git(target, ["status", "--porcelain"]), "", "handoff committed -> clean tree");
});

test("ship still refuses a non-handoff dirty file alongside a dirty handoff", () => {
  const target = initShipRepo();
  execFileSync("git", ["checkout", "-q", "-b", "f-mixed"], { cwd: target });
  fs.mkdirSync(path.join(target, ".agents", "handoffs"), { recursive: true });
  fs.writeFileSync(path.join(target, ".agents", "handoffs", "F-001.md"), "# handoff\n", "utf8");
  fs.writeFileSync(path.join(target, "README.md"), "wip\n", "utf8");
  const res = runShipCli(target, ["--no-gate", "--no-rebase"]);
  assert.strictEqual(res.status, 1, res.out);
  assert.match(res.out, /uncommitted tracked changes/);
});

test("[drift-guard] ship integrates, lands HEAD on main directly, and has no PR/label/watch path", () => {
  const src = read(path.join(h.TEMPLATES_DIR, "scripts", "ship.js"));
  assert.match(src, /git fetch|fetch", "origin/, "integrates early");
  assert.match(src, /rebase/, "rebases on origin/<base>");
  assert.match(src, /push", "origin", `HEAD:\$\{base\}`/, "lands HEAD directly on the integration branch");
  assert.match(src, /MAX_LAND_ATTEMPTS/, "has a bounded concurrent-landing retry");
  assert.match(src, /non-fast-forward|fetch first|\[rejected\]/, "recognizes a concurrent landing");
  assert.doesNotMatch(src, /pr", "create"/, "never opens a PR");
  assert.doesNotMatch(src, /merge-train/, "no merge train");
  assert.doesNotMatch(src, /--watch-only/, "no PR watch resume path");
});

test("[drift-guard] ship waits for green CI on the landed SHA (deploy runs after CI)", () => {
  const src = read(path.join(h.TEMPLATES_DIR, "scripts", "ship.js"));
  assert.match(src, /function waitCi/, "waits for the CI run on the landed SHA");
  assert.match(src, /function ciWorkflow/, "resolves the CI workflow by name");
  assert.match(src, /--no-ci-wait/, "has an explicit opt-out");
  assert.match(src, /concluded "\$\{run\.conclusion\}"/, "reports a red CI as a blocker");
  assert.doesNotMatch(src, /waitForMerge|waitWorkflow/, "no merge-train/deploy watch remains");
});

/* A fake `gh` for the watch tests: answers --version, pr list/view, and run list
 * from a JSON state file, so the poll loop is exercised without a network. */
function writeGhStub(target, state) {
  const binDir = path.join(target, ".gh-stub");
  fs.mkdirSync(binDir, { recursive: true });
  const ghPath = path.join(binDir, "gh");
  const statePath = path.join(target, ".gh-stub-state.json");
  fs.writeFileSync(statePath, JSON.stringify(state), "utf8");
  const script =
    "#!/usr/bin/env node\n" +
    '"use strict";\n' +
    "const fs = require('fs');\n" +
    `const state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, 'utf8'));\n` +
    "const args = process.argv.slice(2);\n" +
    "const sha = state.sha;\n" +
    "if (args[0] === '--version') { console.log('gh version 2.0.0'); process.exit(0); }\n" +
    "if (args[0] === 'pr' && args[1] === 'list') { console.log(JSON.stringify([{ number: 7, url: 'https://example.test/pull/7', state: state.prState }])); process.exit(0); }\n" +
    "if (args[0] === 'pr' && args[1] === 'view') { console.log(JSON.stringify({ state: state.prState, mergedAt: state.prState === 'MERGED' ? '2026-09-19T00:00:00Z' : null, mergeCommit: { oid: sha }, statusCheckRollup: state.checks || [] })); process.exit(0); }\n" +
    "if (args[0] === 'run' && args[1] === 'list') { const wf = args[args.indexOf('--workflow') + 1] || 'CI'; console.log(JSON.stringify([{ databaseId: 1, status: 'completed', conclusion: state.runConclusion || 'success', url: 'https://example.test/run/1', headSha: sha, name: wf }])); process.exit(0); }\n" +
    "console.log(JSON.stringify([]));\n" +
    "process.exit(0);\n";
  fs.writeFileSync(ghPath, script, "utf8");
  fs.chmodSync(ghPath, 0o755);
  return ghPath;
}

function runShip(target, ghPath, extraEnv) {
  const res = spawnSync(process.execPath, ["scripts/ship.js", "--no-gate"], {
    cwd: target,
    encoding: "utf8",
    env: {
      ...process.env,
      HARNESS_SHIP_GH_BIN: ghPath,
      HARNESS_SHIP_CI_NO_SLEEP: "1",
      HARNESS_SHIP_CI_TIMEOUT_MS: "5000",
      ...(extraEnv || {}),
    },
  });
  return { status: res.status, out: (res.stdout || "") + (res.stderr || "") };
}

function initShipRepoWithOrigin() {
  const origin = tmpdir();
  git(origin, ["init", "--bare", "-q", "-b", "main"]);
  const target = initShipRepo();
  git(target, ["remote", "add", "origin", origin]);
  git(target, ["push", "-q", "-u", "origin", "main"]);
  return { origin, target };
}

function commitCiWorkflow(target) {
  fs.mkdirSync(path.join(target, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(target, ".github", "workflows", "ci.yml"), "name: CI\non: push\n", "utf8");
  git(target, ["add", "-A"]);
  git(target, ["commit", "-q", "-m", "ci"]);
}

test("ship lands the feature branch directly on origin/main and confirms CI", () => {
  const { origin, target } = initShipRepoWithOrigin();
  execFileSync("git", ["checkout", "-q", "-b", "f-land"], { cwd: target });
  fs.writeFileSync(path.join(target, "feature.txt"), "feature\n", "utf8");
  git(target, ["add", "-A"]);
  git(target, ["commit", "-q", "-m", "feat: land"]);
  commitCiWorkflow(target);
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: target, encoding: "utf8" }).trim();
  const ghPath = writeGhStub(target, { sha, runConclusion: "success" });

  const res = runShip(target, ghPath);
  assert.strictEqual(res.status, 0, res.out);
  assert.match(res.out, /landed f-land -> origin\/main/);
  assert.match(res.out, /CI green/);
  const originMain = execFileSync("git", ["--git-dir", origin, "rev-parse", "main"], {
    encoding: "utf8",
  }).trim();
  assert.strictEqual(originMain, sha, "origin/main points at the landed feature commit");
});

test("ship rebases onto a concurrently-advanced origin/main and still lands", () => {
  const { origin, target } = initShipRepoWithOrigin();
  execFileSync("git", ["checkout", "-q", "-b", "f-race"], { cwd: target });
  fs.writeFileSync(path.join(target, "feature.txt"), "feature\n", "utf8");
  git(target, ["add", "-A"]);
  git(target, ["commit", "-q", "-m", "feat: race"]);
  commitCiWorkflow(target);

  // Another session lands on origin/main after our base.
  const other = tmpdir();
  execFileSync("git", ["clone", "-q", origin, other], { encoding: "utf8" });
  git(other, ["config", "user.email", "o@o.o"]);
  git(other, ["config", "user.name", "o"]);
  fs.writeFileSync(path.join(other, "other.txt"), "other\n", "utf8");
  git(other, ["add", "-A"]);
  git(other, ["commit", "-q", "-m", "other landing"]);
  git(other, ["push", "-q", "origin", "main"]);

  const ghPath = writeGhStub(target, { sha: "0000000", runConclusion: "success" });
  const res = runShip(target, ghPath);
  assert.strictEqual(res.status, 0, res.out);
  const log = execFileSync("git", ["--git-dir", origin, "log", "--oneline", "main"], {
    encoding: "utf8",
  });
  assert.match(log, /feat: race/, "our feature landed");
  assert.match(log, /other landing/, "the concurrent landing is preserved");
});

test("ship exits non-zero when CI is red on the landed SHA", () => {
  const { target } = initShipRepoWithOrigin();
  execFileSync("git", ["checkout", "-q", "-b", "f-red"], { cwd: target });
  fs.writeFileSync(path.join(target, "feature.txt"), "f\n", "utf8");
  git(target, ["add", "-A"]);
  git(target, ["commit", "-q", "-m", "feat: red"]);
  commitCiWorkflow(target);
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: target, encoding: "utf8" }).trim();
  const ghPath = writeGhStub(target, { sha, runConclusion: "failure" });

  const res = runShip(target, ghPath);
  assert.strictEqual(res.status, 1, res.out);
  assert.match(res.out, /concluded "failure"/);
});

test("ship confirms CI even when the feature worktree is pruned mid-watch", () => {
  const { target } = initShipRepoWithOrigin();
  const wt = path.join(path.dirname(target), "wt-" + path.basename(target));
  git(target, ["worktree", "add", "-q", "-b", "f-wt", wt]);
  fs.writeFileSync(path.join(wt, "feature.txt"), "feature\n", "utf8");
  execFileSync("git", ["-C", wt, "add", "-A"], { encoding: "utf8" });
  execFileSync("git", ["-C", wt, "commit", "-q", "-m", "feat: wt"], { encoding: "utf8" });
  fs.mkdirSync(path.join(wt, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(wt, ".github", "workflows", "ci.yml"), "name: CI\non: push\n", "utf8");
  execFileSync("git", ["-C", wt, "add", "-A"], { encoding: "utf8" });
  execFileSync("git", ["-C", wt, "commit", "-q", "-m", "ci"], { encoding: "utf8" });
  const sha = execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  // A fake `gh` that deletes the feature checkout on its first poll — the
  // concurrent `worktree-prune` from F-252 — then reports the run green.
  const binDir = path.join(target, ".gh-stub");
  fs.mkdirSync(binDir, { recursive: true });
  const ghPath = path.join(binDir, "gh");
  const statePath = path.join(target, ".gh-stub-state.json");
  fs.writeFileSync(statePath, JSON.stringify({ sha, wt }), "utf8");
  fs.writeFileSync(
    ghPath,
    "#!/usr/bin/env node\n" +
      '"use strict";\n' +
      "const fs = require('fs');\n" +
      `const s = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, 'utf8'));\n` +
      "const a = process.argv.slice(2);\n" +
      "if (a[0] === '--version') { console.log('gh version 2.0.0'); process.exit(0); }\n" +
      "if (a[0] === 'run' && a[1] === 'list') {\n" +
      "  if (!fs.existsSync(s.wt + '.gone')) { fs.rmSync(s.wt, { recursive: true, force: true }); fs.writeFileSync(s.wt + '.gone', '1'); }\n" +
      "  console.log(JSON.stringify([{ databaseId: 1, status: 'completed', conclusion: 'success', url: 'u', headSha: s.sha, name: 'CI' }]));\n" +
      "  process.exit(0);\n" +
      "}\n" +
      "console.log('[]'); process.exit(0);\n",
    "utf8"
  );
  fs.chmodSync(ghPath, 0o755);

  const res = spawnSync(process.execPath, ["scripts/ship.js", "--no-gate"], {
    cwd: wt,
    encoding: "utf8",
    env: {
      ...process.env,
      HARNESS_SHIP_GH_BIN: ghPath,
      HARNESS_SHIP_CI_NO_SLEEP: "1",
      HARNESS_SHIP_CI_TIMEOUT_MS: "5000",
    },
  });
  const out = (res.stdout || "") + (res.stderr || "");
  assert.ok(!exists(wt), "the concurrent prune removed the feature worktree");
  assert.strictEqual(res.status, 0, out);
  assert.match(out, /CI green/);
});

function initShipRepoOnOrigin() {
  const origin = tmpdir();
  git(origin, ["init", "--bare", "-q", "-b", "main"]);
  const target = initShipRepo();
  git(target, ["remote", "add", "origin", origin]);
  git(target, ["push", "-q", "-u", "origin", "main"]);
  // Advance origin/main from a second clone (the feature push the main tree misses).
  const other = tmpdir();
  execFileSync("git", ["clone", "-q", origin, other], { encoding: "utf8" });
  git(other, ["config", "user.email", "o@o.o"]);
  git(other, ["config", "user.name", "o"]);
  fs.writeFileSync(path.join(other, "origin-only.txt"), "from origin\n", "utf8");
  git(other, ["add", "-A"]);
  git(other, ["commit", "-q", "-m", "origin advance"]);
  git(other, ["push", "-q", "origin", "main"]);
  return { origin, target };
}

const BOARD_BASE = `# BACKLOG

## In progress

| ID | Epic | Task | Handoff |
|---|---|---|---|

## Open

| ID | P | Epic | Task | Evidence | Depends on |
|---|---|---|---|---|---|
| F-255 | P1 | user-flows | first book medal | ? | ? |
| F-257 | P1 | user-flows | rotem sees one book | ? | ? |

## Archive

| ID | Epic | Task | Shipped |
|---|---|---|---|
| F-254 | x | old | shipped 2026-01-01 |
`;

// The routine shape: the local take moved F-255 In progress and added F-258;
// the landed upstream archived F-255. Only the archived row is a "conflict".
const BOARD_OURS = `# BACKLOG

## In progress

| ID | Epic | Task | Handoff |
|---|---|---|---|
| F-255 | user-flows | first book medal | .agents/handoffs/F-255.md (branch: f-255) |

## Open

| ID | P | Epic | Task | Evidence | Depends on |
|---|---|---|---|---|---|
| F-257 | P1 | user-flows | rotem sees one book | ? | ? |
| F-258 | P2 | data-model | NLI umbrela api key | ? | ? |

## Archive

| ID | Epic | Task | Shipped |
|---|---|---|---|
| F-254 | x | old | shipped 2026-01-01 |
`;

const BOARD_THEIRS = `# BACKLOG

## In progress

| ID | Epic | Task | Handoff |
|---|---|---|---|

## Open

| ID | P | Epic | Task | Evidence | Depends on |
|---|---|---|---|---|---|
| F-257 | P1 | user-flows | rotem sees one book | ? | ? |

## Archive

| ID | Epic | Task | Shipped |
|---|---|---|---|
| F-254 | x | old | shipped 2026-01-01 |
| F-255 | user-flows | first book medal | shipped 2026-09-19 — medal |
`;

test("merge-backlog reconcile: a landed archive wins over the stale local take, local-only rows survive", () => {
  const r = mb.reconcileBoard(BOARD_BASE, BOARD_OURS, BOARD_THEIRS);
  assert.ok(r.ok, "the routine dirty-board shape reconciles");
  assert.deepStrictEqual(r.dropped, ["F-255"], "the stale local take is dropped for the landed archive");
  assert.ok(!r.board.split("## Archive")[0].includes("F-255"), "F-255 is gone from In progress");
  assert.match(r.board.split("## Archive")[1], /\| F-255 \| user-flows \| first book medal \| shipped 2026-09-19/);
  assert.match(r.board, /\| F-258 \| P2 \| data-model \| NLI umbrela api key/, "the local-only row survives");
});

test("merge-backlog reconcile refuses a genuine same-row conflict", () => {
  // Both sides edit the SAME open row differently and neither archived it —
  // that is not the routine take/archive shape, so it must not auto-resolve.
  const ours = BOARD_OURS.replace("rotem sees one book", "mine");
  const theirs = BOARD_THEIRS.replace("rotem sees one book", "theirs");
  const r = mb.reconcileBoard(BOARD_BASE, ours, theirs);
  assert.strictEqual(r.ok, false, "a non-archive conflict is not auto-resolved");
  assert.deepStrictEqual(r.conflicts, ["F-257"]);
});

test("merge-backlog reconcile of a template-shaped board is byte-identical to upstream (no phantom dirt)", () => {
  // The template ships column-aligned separators and a blank placeholder row in
  // every empty table. A reconcile that normalized those away would leave the
  // board byte-different from the landed upstream — i.e. working-tree dirt on
  // every converge. Guard the byte-stability the transaction relies on.
  const ours = [
    "# B",
    "",
    "## Open",
    "",
    "| ID | P | Epic | Task | Evidence | Depends on |",
    "|---|---|---|---|---|---|",
    "| F-001 | P2 | ? | row | ? | ? |",
    "",
    "## Archive",
    "",
    "| ID | Epic | Task | Closed |",
    "|----|------|------|--------|",
    "| | | | |",
    "",
    "## Frozen",
    "",
    "| ID | Epic | Task | Why frozen / reopen when |",
    "|----|------|------|--------------------------|",
    "| | | | |",
    "",
  ].join("\n");
  const theirs = [
    "# B",
    "",
    "## Open",
    "",
    "| ID | P | Epic | Task | Evidence | Depends on |",
    "|---|---|---|---|---|---|",
    "",
    "## Archive",
    "",
    "| ID | Epic | Task | Closed |",
    "|---|---|---|---|",
    "| F-001 | ? | row | shipped |",
    "",
    "## Frozen",
    "",
    "| ID | Epic | Task | Why frozen / reopen when |",
    "|----|------|------|--------------------------|",
    "| | | | |",
    "",
  ].join("\n");
  const r = mb.reconcileBoard(ours, ours, theirs);
  assert.ok(r.ok);
  assert.strictEqual(r.board, theirs, "the reconcile is byte-identical to the landed board");
});

test("backlog take/archive preserves member-report provenance markers (F-276)", () => {
  // The superadmin pending notice scans every section for `source member-report
  // <uuid>`. In progress / Archive have no Evidence column, so a marker left in
  // Evidence would vanish on take/archive and the handled report would look
  // pending again (re-imported as a duplicate). The marker must ride into the
  // destination's free-form cell.
  const t = scaffoldBacklogCliTarget();
  const marker = "source member-report 11111111-2222-3333-4444-555555555555";
  assert.strictEqual(runBacklogCli(t, ["add", "handled report", "--p", "P2", "--evidence", marker]).status, 0);
  assert.strictEqual(runBacklogCli(t, ["take", "F-001", "--handoff", ".agents/handoffs/F-001.md"]).status, 0);
  let board = read(path.join(t, "BACKLOG.md"));
  assert.match(board, /\| F-001 \|.*11111111-2222-3333-4444-555555555555/, "the marker rides into the In progress handoff cell");
  assert.strictEqual(runBacklogCli(t, ["archive", "F-001", "--closed", "shipped"]).status, 0);
  board = read(path.join(t, "BACKLOG.md"));
  assert.match(
    board.split("## Archive")[1],
    /11111111-2222-3333-4444-555555555555/,
    "the marker survives into the archive closed note"
  );
});

test("backlog add --defer commits locally but does not push until sync (F-278)", () => {
  const origin = tmpdir();
  git(origin, ["init", "--bare", "-q", "-b", "main"]);
  const target = scaffoldBacklogCliTarget();
  git(target, ["init", "-q", "-b", "main"]);
  git(target, ["config", "user.email", "t@t.t"]);
  git(target, ["config", "user.name", "t"]);
  git(target, ["add", "-A"]);
  git(target, ["commit", "-q", "-m", "init"]);
  git(target, ["remote", "add", "origin", origin]);
  git(target, ["push", "-q", "-u", "origin", "main"]);
  const before = git(target, ["rev-parse", "origin/main"]);

  const res = runBacklogCli(target, ["add", "deferred row", "--p", "P2", "--defer"]);
  assert.strictEqual(res.status, 0, res.out);
  assert.match(res.out, /background sync/, "the deferred path tells the caller a background sync will publish");
  assert.notStrictEqual(git(target, ["rev-parse", "HEAD"]), before, "the board commit exists locally");
  assert.strictEqual(git(target, ["rev-parse", "origin/main"]), before, "origin is untouched by --defer");
  assert.strictEqual(git(target, ["status", "--porcelain"]), "", "the deferred commit leaves a clean tree");

  const sync = runBacklogCli(target, ["sync"]);
  assert.strictEqual(sync.status, 0, sync.out);
  const originAfter = git(target, ["rev-parse", "origin/main"]);
  assert.notStrictEqual(originAfter, before, "sync publishes the deferred row");
  assert.strictEqual(git(target, ["rev-parse", "HEAD"]), originAfter, "main is level with origin after sync");
  assert.match(read(path.join(target, "BACKLOG.md")), /deferred row/, "the deferred row survives the publish");
});

test("[drift-guard] backlog preserves report provenance and supports --defer; board-sync honors deferPush", () => {
  const backlogSrc = read(path.join(h.TEMPLATES_DIR, "scripts", "backlog.js"));
  assert.match(backlogSrc, /REPORT_MARKER_PATTERN/, "member-report provenance is preserved across the row lifecycle (F-276)");
  assert.match(backlogSrc, /appendReportMarkers\(/, "markers ride into the destination free-form cell");
  assert.match(backlogSrc, /args\.defer/, "the --defer flag is parsed");
  assert.match(backlogSrc, /deferPush: defer/, "the canonical publish honors --defer");
  const bsSrc = read(path.join(h.TEMPLATES_DIR, "scripts", "qa", "board-sync.js"));
  assert.match(bsSrc, /opts\.deferPush/, "publishBoard can defer the network push");
});

test("[drift-guard] board-sync replay is a guarded reset --hard with a hermetic git env (F-289)", () => {
  const bsSrc = read(path.join(h.TEMPLATES_DIR, "scripts", "qa", "board-sync.js"));
  // The replay must advance HEAD, index and worktree together; a `reset --soft`
  // leaves a permanent staged reverse-diff on the canonical checkout (F-289).
  assert.match(bsSrc, /\["reset", "--hard", upstream\]/, "replay advances index+worktree with reset --hard");
  assert.doesNotMatch(bsSrc, /\["reset", "--soft", upstream\]/, "the stale reset --soft replay must not return");
  assert.match(bsSrc, /const blockedBy = dirtyTracked\(root\)/, "genuine non-board dirt blocks the hard reset");
  assert.match(bsSrc, /replay\.blockedBy/, "the blocker is surfaced to convergeCanonical");
  // A parent git hook can export repo-scoping GIT_* vars; `git -C <root>` must
  // stay hermetic or the suite targets the real checkout (F-289 QA follow-up).
  assert.match(bsSrc, /const REPO_SCOPING_GIT_VARS = \[/, "repo-scoping GIT_* vars are enumerated");
  assert.match(bsSrc, /function hermeticGitEnv\(\)/, "a hermetic git env is built");
  assert.match(bsSrc, /env: hermeticGitEnv\(\)/, "gitCmd runs with the hermetic env");
});

test("ship reconciles a dirty main board and fast-forwards after landing", () => {
  const origin = tmpdir();
  git(origin, ["init", "--bare", "-q", "-b", "main"]);
  const target = initShipRepo();
  fs.writeFileSync(path.join(target, "BACKLOG.md"), BOARD_BASE, "utf8");
  git(target, ["add", "-A"]);
  git(target, ["commit", "-q", "-m", "board"]);
  git(target, ["remote", "add", "origin", origin]);
  git(target, ["push", "-q", "-u", "origin", "main"]);

  const wt = path.join(os.tmpdir(), `ship-reconcile-${path.basename(target)}`);
  execFileSync("git", ["-C", target, "worktree", "add", "-q", "-b", "f-rec", wt, "HEAD"], { encoding: "utf8" });
  fs.mkdirSync(path.join(wt, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(wt, ".github", "workflows", "ci.yml"), "name: CI\non: push\n", "utf8");

  // The landed upstream archived F-255; the local working board still shows it
  // In progress plus a local-only F-258 — the "row stuck In progress" state.
  const other = tmpdir();
  execFileSync("git", ["clone", "-q", origin, other], { encoding: "utf8" });
  fs.writeFileSync(path.join(other, "BACKLOG.md"), BOARD_THEIRS, "utf8");
  git(other, ["config", "user.email", "o@o.o"]);
  git(other, ["config", "user.name", "o"]);
  git(other, ["add", "-A"]);
  git(other, ["commit", "-q", "-m", "land F-255"]);
  git(other, ["push", "-q", "origin", "main"]);
  fs.writeFileSync(path.join(target, "BACKLOG.md"), BOARD_OURS, "utf8");

  const sha = execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const ghPath = writeGhStub(target, { sha, runConclusion: "success" });

  const res = runShip(wt, ghPath);
  assert.strictEqual(res.status, 0, res.out);
  assert.match(res.out, /reconciled its board/);
  const board = read(path.join(target, "BACKLOG.md"));
  assert.match(board.split("## Archive")[1], /\| F-255 \|/, "the landed archive is present after reconcile");
  assert.match(board, /\| F-258 \|/, "the local-only row survived the reconcile");
  // The reconciled local-only row must be COMMITTED (and published), not left as
  // working-tree dirt — otherwise a later `git checkout -- BACKLOG.md` in main
  // silently wipes it (the F-147 incident).
  assert.match(res.out, /published its local-only board rows/);
  assert.strictEqual(
    git(target, ["status", "--porcelain", "--untracked-files=no"]),
    "",
    "the reconciled board is committed, not tracked dirt"
  );
  assert.match(
    git(target, ["show", "HEAD:BACKLOG.md"]),
    /\| F-258 \|/,
    "the local-only row is in HEAD (a checkout cannot wipe it)"
  );
  assert.strictEqual(
    execFileSync("git", ["-C", target, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    execFileSync("git", ["-C", target, "rev-parse", "origin/main"], { encoding: "utf8" }).trim(),
    "main (with the published board commit) is at origin/main"
  );
});

test("ship fast-forwards the main checkout so the board converges after landing", () => {
  const { target } = initShipRepoOnOrigin();
  const wt = path.join(os.tmpdir(), `ship-conv-${path.basename(target)}`);
  execFileSync("git", ["-C", target, "worktree", "add", "-q", "-b", "f-conv", wt, "HEAD"], { encoding: "utf8" });
  fs.mkdirSync(path.join(wt, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(wt, ".github", "workflows", "ci.yml"), "name: CI\non: push\n", "utf8");
  const sha = execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const ghPath = writeGhStub(target, { sha, runConclusion: "success" });

  const res = runShip(wt, ghPath);
  assert.strictEqual(res.status, 0, res.out);
  assert.match(res.out, /fast-forwarded the main checkout/);
  const mainHead = execFileSync("git", ["-C", target, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const originHead = execFileSync("git", ["-C", target, "rev-parse", "origin/main"], { encoding: "utf8" }).trim();
  assert.strictEqual(mainHead, originHead, "main checkout fast-forwarded to origin/main");
  assert.ok(exists(path.join(target, "origin-only.txt")), "the origin-only commit is now in the main checkout");
});

test("[drift-guard] ship converges the main checkout after landing (never a reset)", () => {
  const src = read(path.join(h.TEMPLATES_DIR, "scripts", "ship.js"));
  assert.match(src, /function convergeMainCheckout/, "the main checkout is converged after landing");
  assert.match(src, /boardSync\.convergeCanonical/, "convergence delegates to the shared board-sync module");
  assert.match(src, /withLock\(main/, "the convergence read-modify-write is serialized on the board lock");
  assert.match(src, /boardSync\.publishBoard/, "reconciled local-only rows are committed + pushed, never left as dirt");
  assert.match(src, /isHandoffPath/, "a budget-pause handoff checkpoint is auto-committed, not a dirty-tree abort");
  assert.doesNotMatch(src, /writeShipLedger|phase: "enqueued"|ENQUEUED — NOT DONE/, "no pending-landing ledger remains");
});

test("[drift-guard] every canonical board mutation reconciles + publishes via the transaction", () => {
  const src = read(path.join(h.TEMPLATES_DIR, "scripts", "backlog.js"));
  assert.match(src, /boardSync\.convergeCanonical/, "mutations converge the canonical checkout first");
  assert.match(src, /boardSync\.publishBoard/, "mutations publish the board (never leave working-tree dirt)");
  assert.match(src, /cmdWorktreePlan/, "the worktree take is planned separately so it can publish before the checkout is created");
  assert.match(src, /function cmdWorktreeApply/, "the worktree checkout is created after the publish");
});

test("[drift-guard] ship runs the process gates itself; CI is the post-land gate", () => {
  const src = read(path.join(h.TEMPLATES_DIR, "scripts", "ship.js"));
  assert.match(src, /PROCESS_GATES/, "process gates are owned by ship, not only the git hook");
  assert.match(src, /prePushInstalled\(root\)/, "process gates run only when no pre-push hook is installed");
  assert.match(src, /test:qa-plan -- --base=origin\//, "qa-plan is diff-scoped to the integration base");
  assert.doesNotMatch(src, /--allow-no-deploy/, "no deploy-label fail-closed branch remains");
  assert.doesNotMatch(src, /writeShipLedger|hasCiWorkflow/, "no label/ledger machinery remains");
});

test("harness maintenance push uses --no-verify so project hooks never strand it", () => {
  const src = read(path.join(__dirname, "..", "bin", "agent-harness.js"));
  assert.match(src, /\["push", "--no-verify", "origin", "HEAD"\]/);
});

test("agent-harness doctor reports release-cycle readiness", () => {
  const target = tmpdir();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: target });
  fs.writeFileSync(path.join(target, "README.md"), "x\n", "utf8");
  const cli = path.join(__dirname, "..", "bin", "agent-harness.js");
  const res = spawnSync(process.execPath, [cli, "doctor", "--target", target], { encoding: "utf8" });
  const out = (res.stdout || "") + (res.stderr || "");
  assert.match(out, /agent-harness doctor/);
  assert.match(out, /CI workflow/);
  assert.match(out, /failure\(s\), \d+ warning\(s\)/);
});

test("agent-harness doctor warns when the checkout is behind its upstream (stale board)", () => {
  const origin = tmpdir();
  git(origin, ["init", "--bare", "-q", "-b", "main"]);
  const target = tmpdir();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: target });
  git(target, ["config", "user.email", "t@t.t"]);
  git(target, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(target, "README.md"), "x\n", "utf8");
  git(target, ["add", "-A"]);
  git(target, ["commit", "-q", "-m", "seed"]);
  git(target, ["remote", "add", "origin", origin]);
  git(target, ["push", "-q", "-u", "origin", "main"]);
  const other = cloneOther(origin);
  fs.writeFileSync(path.join(other, "origin-only.txt"), "y\n", "utf8");
  git(other, ["add", "-A"]);
  git(other, ["commit", "-q", "-m", "advance"]);
  git(other, ["push", "-q", "origin", "main"]);

  const cli = path.join(__dirname, "..", "bin", "agent-harness.js");
  const res = spawnSync(process.execPath, [cli, "doctor", "--target", target], { encoding: "utf8" });
  const out = (res.stdout || "") + (res.stderr || "");
  assert.match(out, /\[warn\] board sync: checkout is 1 behind origin\/main/);
  assert.match(out, /node scripts\/backlog\.js sync/);
});

test("agent-harness run --dry-run prints the phase plan from the board state", () => {
  const target = tmpdir();
  fs.mkdirSync(path.join(target, ".agents", "handoffs"), { recursive: true });
  fs.writeFileSync(
    path.join(target, "BACKLOG.md"),
    [
      "# Backlog",
      "",
      "## In progress",
      "",
      "| ID | Epic | Task | Handoff |",
      "|----|------|------|---------|",
      "| F-256 | user-flows | cover sync | .agents/handoffs/F-256.md |",
      "",
    ].join("\n"),
    "utf8"
  );
  const cli = path.join(__dirname, "..", "bin", "agent-harness.js");
  const res = spawnSync(
    process.execPath,
    [cli, "run", "--target", target, "--dry-run", "--max-phases", "2"],
    { encoding: "utf8" }
  );
  const out = (res.stdout || "") + (res.stderr || "");
  assert.strictEqual(res.status, 0, out);
  assert.match(out, /phase 1\/2: starting the next-item workflow/);
  assert.match(out, /phase 2\/2: resuming F-256/);
  assert.match(out, /checkpoint\.js resume --feature F-256/, "the resume prompt reads the checkpoint only");
  assert.match(out, /run: stop — phase cap reached \(2\)/, "a dry-run cap is a plan, not a failure");
});

test("deploy seeds the CI/CD release scaffold create-if-missing (no merge train)", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });
  for (const rel of [
    ".github/workflows/ci.yml",
    ".github/workflows/deploy-uat.yml",
    ".github/workflows/uat-health.yml",
    ".husky/pre-push",
    ".vercelignore",
    "docs/ci-cd-pipeline.md",
  ]) {
    assert.ok(exists(path.join(target, rel)), `${rel} deployed`);
  }
  assert.ok(!exists(path.join(target, ".github", "workflows", "merge-train.yml")), "no merge-train workflow deployed");
  const pkg = JSON.parse(read(path.join(target, "package.json")));
  assert.ok(!("test:push-refs" in pkg.scripts), "no direct-main-push guard wired");

  // Project-owned afterwards: an update must never clobber an edited workflow.
  fs.writeFileSync(path.join(target, ".github", "workflows", "ci.yml"), "name: Mine\n", "utf8");
  await h.deploy(target, { yes: true, isUpdate: true, commit: false });
  assert.strictEqual(read(path.join(target, ".github", "workflows", "ci.yml")), "name: Mine\n");
});



test("deploy ships the ship command and wires npm run ship", async () => {
  const target = tmpdir();
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });
  assert.ok(exists(path.join(target, "scripts", "ship.js")), "scripts/ship.js deployed");
  const pkg = JSON.parse(read(path.join(target, "package.json")));
  assert.strictEqual(pkg.scripts.ship, "node scripts/ship.js");
});

test("test:qa-plan treats harness-shipped top-level scripts as tooling, not uncovered app code", () => {
  const target = tmpdir();
  fs.mkdirSync(path.join(target, "scripts", "qa"), { recursive: true });
  fs.copyFileSync(
    path.join(h.TEMPLATES_DIR, "scripts", "qa", "check-qa-plan.js"),
    path.join(target, "scripts", "qa", "check-qa-plan.js")
  );
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: target });
  execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: target });
  execFileSync("git", ["config", "user.name", "t"], { cwd: target });
  fs.writeFileSync(path.join(target, "app.js"), "// app\n", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: target });
  execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: target });

  // A plain harness update ships a new top-level CLI — it must not require a
  // project QA plan (it is harness tooling, guarded by the harness's own suite).
  fs.copyFileSync(
    path.join(h.TEMPLATES_DIR, "scripts", "ship.js"),
    path.join(target, "scripts", "ship.js")
  );
  const res = spawnSync(process.execPath, ["scripts/qa/check-qa-plan.js", "--base", "HEAD"], {
    cwd: target,
    encoding: "utf8",
  });
  assert.strictEqual(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /scripts\/ship\.js \(harness\/tooling/);

  // A genuine new application code path still fails the gate.
  fs.writeFileSync(path.join(target, "feature.js"), "// feature\n", "utf8");
  const res2 = spawnSync(process.execPath, ["scripts/qa/check-qa-plan.js", "--base", "HEAD"], {
    cwd: target,
    encoding: "utf8",
  });
  assert.strictEqual(res2.status, 1, res2.stdout + res2.stderr);
  assert.match(res2.stdout, /feature\.js NOT covered/);
});

test("test:docs accepts a squash-merged commit that ships its own changelog delta (rewritten hash)", () => {
  const t = scaffoldDocsTarget();
  fs.writeFileSync(path.join(t, "README.md"), "# Demo\n", "utf8");
  git(t, ["init", "-q"]);
  git(t, ["config", "user.email", "t@t.t"]);
  git(t, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(t, "CHANGELOG.md"), "# Changelog\n", "utf8");
  git(t, ["add", "README.md", "CHANGELOG.md"]);
  git(t, ["commit", "-q", "-m", "docs: seed changelog"]);

  // Squash-merge shape: ONE commit carries the code AND the changelog entry, but
  // the entry cites the ORIGINAL branch commit hash, not this commit's rewritten
  // hash — the gate must not demand a citation for the squash hash (F-235 drift).
  fs.writeFileSync(path.join(t, "lib.js"), "x\n", "utf8");
  fs.appendFileSync(
    path.join(t, "CHANGELOG.md"),
    "- 2026-09-05 `abc1234` \u2014 add thing (F-001)\n",
    "utf8"
  );
  git(t, ["add", "lib.js", "CHANGELOG.md"]);
  git(t, ["commit", "-q", "-m", "feat: add thing (F-001) (#7)"]);

  const r = runDocsGate(t);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /recorded/);
});

// ---------------------------------------------------------------- run-loop (E2E auto-resume)

const runLoop = require(path.join(h.TEMPLATES_DIR, "scripts", "qa", "run-loop.js"));

const RUN_BACKLOG = [
  "# Backlog",
  "",
  "## In progress",
  "",
  "| ID | Epic | Task | Handoff |",
  "|----|------|------|---------|",
  "| F-256 | user-flows | cover sync | .agents/handoffs/F-256.md |",
  "",
  "## Archive (shipped · done)",
  "",
  "| ID | Epic | Task | Closed |",
  "|---|---|---|---|",
  "| F-255 | x | y | 2026-09-18 |",
  "",
].join("\n");

test("run-loop parses the board and handoff state deterministically", () => {
  assert.strictEqual(runLoop.inProgressFeature(RUN_BACKLOG), "F-256");
  assert.strictEqual(runLoop.isArchived(RUN_BACKLOG, "F-255"), true);
  assert.strictEqual(runLoop.isArchived(RUN_BACKLOG, "F-256"), false);
  assert.strictEqual(runLoop.isArchived(RUN_BACKLOG, null), false);
  assert.strictEqual(runLoop.isArchived(RUN_BACKLOG, "F-2.5"), false, "the id is escaped, never a regex");
  assert.strictEqual(runLoop.inProgressFeature(""), null);
  assert.strictEqual(
    runLoop.handoffOutcome("## Session metadata\n\n- outcome: shipped\n- work_type: bugfix\n"),
    "shipped"
  );
  assert.strictEqual(runLoop.handoffOutcome("## Dispatch log\n"), null);
});

test("run-loop starts the next-item workflow on phase 0", () => {
  const d = runLoop.decideRunLoop({ backlogText: RUN_BACKLOG, handoffText: "", feature: null, phasesRun: 0 });
  assert.strictEqual(d.action, "resume");
  assert.strictEqual(d.feature, null);
  assert.match(d.prompt, /next item off the Queue/);
});

test("run-loop stops when the queue is empty and resumes the In-progress feature", () => {
  const empty = runLoop.decideRunLoop({ backlogText: "# Backlog\n", handoffText: "", feature: null, phasesRun: 0 });
  assert.strictEqual(empty.action, "resume", "phase 0 always attempts the next-item workflow");

  const resume = runLoop.decideRunLoop({ backlogText: RUN_BACKLOG, handoffText: "", feature: null, phasesRun: 1, lastExit: 0 });
  assert.strictEqual(resume.action, "resume");
  assert.strictEqual(resume.feature, "F-256");
  assert.match(resume.prompt, /F-256/);
  assert.match(resume.prompt, /checkpoint\.js resume/);
  assert.match(resume.prompt, /npm run finalize/);

  const stuck = runLoop.decideRunLoop({
    backlogText: "# Backlog\n## In progress\n\n| ID | Epic | Task | Handoff |\n|--|--|--|--|\n",
    handoffText: "",
    feature: null,
    phasesRun: 1,
    lastExit: 0,
  });
  assert.strictEqual(stuck.action, "stop");
  assert.match(stuck.reason, /no In-progress feature/);
});

test("run-loop treats an archived row or shipped outcome as landed", () => {
  const archived = runLoop.decideRunLoop({
    backlogText: RUN_BACKLOG,
    handoffText: "",
    feature: "F-255",
    phasesRun: 1,
    lastExit: 1,
  });
  assert.strictEqual(archived.action, "done", "landed wins even after a non-zero phase exit");
  assert.match(archived.reason, /archived/);

  const shipped = runLoop.decideRunLoop({
    backlogText: "# Backlog\n",
    handoffText: "## Session metadata\n\n- outcome: shipped\n",
    feature: "F-256",
    phasesRun: 2,
  });
  assert.strictEqual(shipped.action, "done");
  assert.match(shipped.reason, /shipped/);
});

test("run-loop stops at the phase cap and on a failed unlanded phase", () => {
  const cap = runLoop.decideRunLoop({ backlogText: RUN_BACKLOG, handoffText: "", feature: "F-256", phasesRun: 3, maxPhases: 3 });
  assert.strictEqual(cap.action, "stop");
  assert.match(cap.reason, /phase cap/);

  const failed = runLoop.decideRunLoop({ backlogText: RUN_BACKLOG, handoffText: "", feature: "F-256", phasesRun: 1, lastExit: 2 });
  assert.strictEqual(failed.action, "stop");
  assert.match(failed.reason, /exited 2/);
});

test("run-loop resume prompt never depends on the TUI command surface", () => {
  const prompt = runLoop.resumePrompt("F-256");
  assert.match(prompt, /do not replay any previous transcript/);
  assert.doesNotMatch(prompt, /^\/resume/, "run mode receives a message, not a slash command");
});

test("run-loop sends an implementation-complete checkpoint straight to finalization", () => {
  const complete = [
    "# handoff",
    "",
    "## Checkpoint (resume)",
    "",
    "- feature: F-257",
    "- phase: verification complete",
    "- next_action: archive and ship",
    "",
  ].join("\n");
  assert.strictEqual(runLoop.finalizationReady(complete), true);
  assert.strictEqual(runLoop.finalizationReady("## Checkpoint\n\n- phase: implementing\n"), false);

  const resumed = runLoop.decideRunLoop({
    backlogText: RUN_BACKLOG,
    handoffText: complete,
    feature: "F-257",
    phasesRun: 1,
    lastExit: 0,
  });
  assert.strictEqual(resumed.action, "resume");
  assert.match(resumed.reason, /finalizing F-257/);
  assert.match(resumed.prompt, /npm run finalize -- --feature F-257/);
  assert.doesNotMatch(resumed.prompt, /Continue from its next_action through gates/);

  const midWork = runLoop.decideRunLoop({
    backlogText: RUN_BACKLOG,
    handoffText: "## Checkpoint\n\n- phase: implementing\n",
    feature: "F-256",
    phasesRun: 1,
    lastExit: 0,
  });
  assert.match(midWork.prompt, /npm run finalize/, "mid-work resume points at the finalize command");
});

// ---------------------------------------------------------------- finalize (one-call tail)

const finalizeModule = require(path.join(h.TEMPLATES_DIR, "scripts", "finalize.js"));

function scaffoldFinalizeTarget() {
  const target = tmpdir();
  fs.mkdirSync(path.join(target, "scripts", "qa"), { recursive: true });
  for (const rel of ["scripts/backlog.js", "scripts/finalize.js", "scripts/qa/run-loop.js"]) {
    fs.copyFileSync(path.join(h.TEMPLATES_DIR, rel), path.join(target, rel));
  }
  copyBoardLib(target);
  fs.copyFileSync(path.join(h.TEMPLATES_DIR, "BACKLOG.md"), path.join(target, "BACKLOG.md"));
  // A stand-in ship that records its argv and exits 0: isolates finalize's own
  // archive/commit/idempotence logic from the network.
  fs.writeFileSync(
    path.join(target, "scripts", "ship.js"),
    '"use strict";\nconst fs=require("fs"),path=require("path");\n' +
      'fs.appendFileSync(path.join(__dirname,"..",".git","ship-args"), process.argv.slice(2).join(" ")+"\\n");\n',
    "utf8"
  );
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: target });
  execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: target });
  execFileSync("git", ["config", "user.name", "t"], { cwd: target });
  execFileSync("git", ["add", "-A"], { cwd: target });
  execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: target });
  // A real In-progress row via the CLI, so the parser sees the real table shape.
  const added = spawnSync(process.execPath, ["scripts/backlog.js", "add", "book sharing control", "--p", "P1"], {
    cwd: target,
    encoding: "utf8",
  });
  const id = (added.stdout.match(/\b(F-\d+)\b/) || [])[1];
  assert.ok(id, "test scaffold could not add a row: " + added.stdout + added.stderr);
  spawnSync(process.execPath, ["scripts/backlog.js", "take", id], { cwd: target, encoding: "utf8" });
  fs.mkdirSync(path.join(target, ".agents", "handoffs"), { recursive: true });
  fs.writeFileSync(path.join(target, ".agents", "handoffs", id + ".md"), "## Session metadata\n\n- outcome: shipped\n", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: target });
  execFileSync("git", ["commit", "-q", "-m", "seed row"], { cwd: target });
  execFileSync("git", ["checkout", "-q", "-b", "f-" + id.replace(/^F-/, "")], { cwd: target });
  return { target, id };
}

function runFinalizeCli(target, args) {
  const res = spawnSync(process.execPath, ["scripts/finalize.js", ...args], { cwd: target, encoding: "utf8" });
  return { status: res.status, out: (res.stdout || "") + (res.stderr || "") };
}

test("finalize archives the row, commits the tail, then ships (one deterministic call)", () => {
  const { target, id } = scaffoldFinalizeTarget();
  const r = runFinalizeCli(target, ["--feature", id]);
  assert.strictEqual(r.status, 0, r.out);

  const board = read(path.join(target, "BACKLOG.md"));
  const archive = board.split("## Archive")[1] || "";
  assert.match(archive, new RegExp("\\|\\s*" + id + "\\s*\\|"), "row moved to Archive");
  assert.strictEqual(git(target, ["status", "--porcelain"]), "", "finalization tail committed");
  assert.ok(exists(path.join(target, ".git", "ship-args")), "ship was invoked");
  const subject = execFileSync("git", ["log", "-1", "--format=%s"], { cwd: target, encoding: "utf8" }).trim();
  assert.match(subject, new RegExp("chore\\(" + id + "\\): finalize"));
});

test("finalize is idempotent — re-running never duplicates the row or re-archives", () => {
  const { target, id } = scaffoldFinalizeTarget();
  assert.strictEqual(runFinalizeCli(target, ["--feature", id]).status, 0);
  const r2 = runFinalizeCli(target, ["--feature", id]);
  assert.strictEqual(r2.status, 0, r2.out);
  const board = read(path.join(target, "BACKLOG.md"));
  const archive = board.split("## Archive")[1] || "";
  assert.strictEqual(
    (archive.match(new RegExp("\\|\\s*" + id + "\\s*\\|", "g")) || []).length,
    1,
    "exactly one Archive row, no duplicate"
  );
  const inProgress = (board.split("## In progress")[1] || "").split(/^## /m)[0];
  assert.doesNotMatch(inProgress, new RegExp("\\|\\s*" + id + "\\s*\\|"), "not left In progress");
});

test("finalize --dry-run plans without touching the board or shipping", () => {
  const { target, id } = scaffoldFinalizeTarget();
  const before = read(path.join(target, "BACKLOG.md"));
  const r = runFinalizeCli(target, ["--feature", id, "--dry-run"]);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /dry run/);
  assert.strictEqual(read(path.join(target, "BACKLOG.md")), before, "board untouched");
  assert.ok(!exists(path.join(target, ".git", "ship-args")), "ship not invoked");
});

test("finalize refuses the integration branch", () => {
  const { target } = scaffoldFinalizeTarget();
  execFileSync("git", ["checkout", "-q", "main"], { cwd: target });
  const r = runFinalizeCli(target, ["--feature", "F-999"]);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /refusing to finalize/);
});

test("finalize derives the feature id from an f-<n> branch", () => {
  assert.strictEqual(finalizeModule.featureFromBranch("f-257"), "F-257");
  assert.strictEqual(finalizeModule.featureFromBranch("feat/F-12-x"), "F-12");
  assert.strictEqual(finalizeModule.featureFromBranch("f-watch"), null);
});

test("[drift-guard] finalize collapses archive + commit + land into one call", () => {
  const src = read(path.join(h.TEMPLATES_DIR, "scripts", "finalize.js"));
  assert.match(src, /scripts", "ship\.js"/, "shells out to the real ship");
  assert.match(src, /"archive", feature/, "archives the row by id");
  assert.match(src, /git", \["add", "-A"\]/, "commits the finalization tail");
  assert.match(src, /landedAlready\(base\)/, "idempotence checks the branch is landed on main");
  assert.doesNotMatch(src, /--watch-only|prState/, "no PR watch resume path remains");
});

test("context-guard carries the finalization carve-out (run finalize, do not stop)", () => {
  const core = read(path.join(h.TEMPLATES_DIR, "scripts", "qa", "context-guard-core.js"));
  assert.match(core, /FINALIZATION CARVE-OUT/);
  assert.match(core, /npm run finalize -- --feature/);
  const guard = require(path.join(h.TEMPLATES_DIR, "scripts", "qa", "context-guard-core.js"));
  assert.match(guard.BAND_TEXT.checkpoint, /npm run finalize/);
  assert.match(guard.BAND_TEXT.hard, /npm run finalize/);
});

test("finalize command + script are deployed and wired", async () => {
  const t = await scaffoldGatedTarget();
  assert.ok(exists(path.join(t, "scripts", "finalize.js")), "scripts/finalize.js deployed");
  assert.ok(exists(path.join(t, ".opencode", "command", "finish.md")), "/finish command deployed");
  const pkg = JSON.parse(read(path.join(t, "package.json")));
  assert.strictEqual(pkg.scripts.finalize, "node scripts/finalize.js", "npm run finalize wired");
  const doctorOut = [];
  // doctor must report the finalize command is available.
  const orig = console.log;
  console.log = (...a) => doctorOut.push(a.join(" "));
  try {
    h.doctor(t);
  } finally {
    console.log = orig;
  }
  assert.match(doctorOut.join("\n"), /finalize command/);
});

// ---------------------------------------------------------------- capacity envelope

const capacity = require(path.join(h.TEMPLATES_DIR, "scripts", "qa", "capacity-lib.js"));
const CAPACITY_GATE = path.join(h.TEMPLATES_DIR, "scripts", "qa", "check-capacity.js");

test("capacity: orchestration.md declares the envelope and parsing falls back to defaults", () => {
  const text = read(path.join(h.TEMPLATES_DIR, ".agents", "memory", "orchestration.md"));
  const env = capacity.parseEnvelope(text);
  assert.strictEqual(env.maxHeavyTiers, 1, "one heavy tier machine-wide");
  assert.ok(env.minAvailableMemMb > 0, "a free-RAM floor is declared");
  assert.ok(env.maxLiveServes >= 1, "a live-serve ceiling is declared");
  assert.deepStrictEqual(
    capacity.parseEnvelope("| `unrelated_key` | 5 | note |"),
    capacity.DEFAULT_ENVELOPE,
    "a missing/unknown row falls back to the documented defaults"
  );
});

test("capacity: heavy classifier fires on freeze-class commands, not on trivial ones", () => {
  assert.strictEqual(capacity.classifyHeavy("~/android-sdk/emulator/emulator -avd x"), "emulator");
  assert.strictEqual(capacity.classifyHeavy("npm run dev"), "dev server");
  assert.strictEqual(capacity.classifyHeavy("npx next dev"), "next dev");
  assert.strictEqual(capacity.classifyHeavy("maestro test flow.yaml"), "maestro");
  assert.strictEqual(capacity.classifyHeavy("npm run test:verify"), "heavy test tier");
  assert.strictEqual(capacity.classifyHeavy("node scripts/serve.js start --cmd 'node srv.js'"), null);
  assert.strictEqual(capacity.classifyHeavy("git status"), null);
});

test("capacity: evaluate fails on a pending heavy over an existing tier, warns on soft signals", () => {
  const envelope = Object.assign({}, capacity.DEFAULT_ENVELOPE);
  const base = {
    root: ".",
    envelope,
    mem: { total: 10240, available: 3000, swapTotal: 4096, swapFree: 3072, swapUsedPct: 25 },
    load: { load1: 1, cpus: 10 },
    serves: [],
    tmpfs: [],
    wsl: true,
  };
  assert.strictEqual(capacity.evaluate(base, {}).ok, true, "healthy host passes");
  assert.strictEqual(
    capacity.evaluate(Object.assign({}, base, { serves: [{ name: "emulator", alive: true, heavy: true, ageMs: 1000 }] }), {
      pendingHeavy: 1,
    }).ok,
    false,
    "a second heavy tier is refused"
  );
  const lowMem = Object.assign({}, base, {
    mem: Object.assign({}, base.mem, { available: 200 }),
  });
  assert.match(capacity.evaluate(lowMem, {}).reasons.join(" "), /RAM available/);
  const many = Object.assign({}, base, {
    serves: [1, 2, 3].map((i) => ({ name: "s" + i, alive: true, heavy: false, ageMs: 1000 })),
  });
  const ev = capacity.evaluate(many, {});
  assert.strictEqual(ev.ok, true, "too many live serves is a warning, not a failure");
  assert.match(ev.warnings.join(" "), /live serve/);
});

test("capacity: the machine-wide heavy lock is exclusive and released by name", () => {
  const dir = tmpdir();
  const prev = process.env.AGENT_HEAVY_LOCK;
  process.env.AGENT_HEAVY_LOCK = path.join(dir, "heavy.lock");
  try {
    const first = capacity.acquireHeavyLock("emulator", capacity.DEFAULT_ENVELOPE);
    assert.strictEqual(first.ok, true, "first heavy launch takes the lock");
    const second = capacity.acquireHeavyLock("metro", capacity.DEFAULT_ENVELOPE);
    assert.strictEqual(second.ok, false, "a second heavy launch is refused");
    assert.strictEqual(second.held, true);
    assert.strictEqual(second.lock.name, "emulator");
    assert.strictEqual(capacity.releaseHeavyLock("emulator"), true, "released by name");
    assert.strictEqual(capacity.acquireHeavyLock("metro", capacity.DEFAULT_ENVELOPE).ok, true);
    capacity.releaseHeavyLock("metro");
    assert.strictEqual(capacity.readLock(), null, "lock file removed on release");
  } finally {
    if (prev === undefined) delete process.env.AGENT_HEAVY_LOCK;
    else process.env.AGENT_HEAVY_LOCK = prev;
  }
});

test("capacity gate fails when free RAM is below the envelope floor", () => {
  const dir = tmpdir();
  const meminfo = path.join(dir, "meminfo");
  fs.writeFileSync(meminfo, "MemTotal:       10240000 kB\nMemAvailable:     200000 kB\n");
  const r = spawnSync(process.execPath, [CAPACITY_GATE], {
    encoding: "utf8",
    env: Object.assign({}, process.env, {
      AGENT_CAPACITY_MEMINFO: meminfo,
      AGENT_HEAVY_LOCK: path.join(dir, "heavy.lock"),
    }),
  });
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /RAM available/);
  assert.match(r.stdout, /FAILURE/);
});

test("capacity gate is green on a healthy synthetic host and skips when memory is unreadable", () => {
  const dir = tmpdir();
  const ok = path.join(dir, "meminfo-ok");
  fs.writeFileSync(ok, "MemTotal:       10240000 kB\nMemAvailable:     6000000 kB\n");
  const healthy = spawnSync(process.execPath, [CAPACITY_GATE], {
    encoding: "utf8",
    env: Object.assign({}, process.env, {
      AGENT_CAPACITY_MEMINFO: ok,
      AGENT_HEAVY_LOCK: path.join(dir, "heavy.lock"),
    }),
  });
  assert.strictEqual(healthy.status, 0, healthy.stdout + healthy.stderr);

  const missing = spawnSync(process.execPath, [CAPACITY_GATE], {
    encoding: "utf8",
    env: Object.assign({}, process.env, {
      AGENT_CAPACITY_MEMINFO: path.join(dir, "does-not-exist"),
      AGENT_HEAVY_LOCK: path.join(dir, "heavy.lock"),
    }),
  });
  assert.strictEqual(missing.status, 0, "unreadable /proc is a skip, never a failure");
  assert.match(missing.stdout, /skipped/);
});

test("capacity guard is deployed and serve.js refuses an over-envelope heavy start", async () => {
  const target = tmpdir();
  git(target, ["init", "-q"]);
  await h.deploy(target, { name: "Demo", yes: true, isUpdate: false });

  assert.ok(exists(path.join(target, "scripts", "qa", "capacity-lib.js")), "capacity-lib deployed");
  assert.ok(exists(path.join(target, "scripts", "qa", "check-capacity.js")), "capacity gate deployed");
  const pkg = JSON.parse(read(path.join(target, "package.json")));
  assert.strictEqual(pkg.scripts["test:capacity"], "node scripts/qa/check-capacity.js", "test:capacity wired");

  const meminfo = path.join(target, "meminfo-fixture");
  fs.writeFileSync(meminfo, "MemTotal:       10240000 kB\nMemAvailable:     200000 kB\n");
  const serve = path.join(target, "scripts", "serve.js");
  const r = spawnSync(process.execPath, [serve, "start", "--cmd", "npm run dev", "--name", "app-dev"], {
    cwd: target,
    encoding: "utf8",
    env: Object.assign({}, process.env, {
      AGENT_CAPACITY_MEMINFO: meminfo,
      AGENT_HEAVY_LOCK: path.join(target, "heavy.lock"),
    }),
  });
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /would exceed the machine capacity envelope/);
  assert.ok(!exists(path.join(target, ".serve", "app-dev.pid")), "nothing spawned on refusal");

  const doctorOut = [];
  const orig = console.log;
  console.log = (...a) => doctorOut.push(a.join(" "));
  try {
    h.doctor(target);
  } finally {
    console.log = orig;
  }
  assert.match(doctorOut.join("\n"), /capacity/, "doctor reports a capacity line");
});

test("[drift-guard] capacity guard is one envelope owned by every surface", () => {
  const serve = read(path.join(h.TEMPLATES_DIR, "scripts", "serve.js"));
  assert.match(serve, /capacity-lib\.js/, "serve.js reads the shared capacity lib");
  assert.match(serve, /acquireHeavyLock/, "serve.js takes the machine-wide heavy lock");
  const plugin = read(path.join(h.TEMPLATES_DIR, ".opencode", "plugins", "context-guard.ts"));
  assert.match(plugin, /capacity-lib\.js/, "the guard plugin reads the shared capacity lib");
  assert.match(plugin, /heavyBlockText/, "the plugin blocks an over-envelope heavy start");
  const ship = read(path.join(h.TEMPLATES_DIR, "scripts", "ship.js"));
  assert.match(ship, /"test:capacity"/, "ship runs the capacity gate when no hook is installed");
  const prePush = read(path.join(h.TEMPLATES_DIR, ".husky", "pre-push"));
  assert.match(prePush, /test:capacity/, "the pre-push battery includes the capacity gate");
});

// ---------------------------------------------------------------- WSL tuning

const WM = path.join(h.TEMPLATES_DIR, "scripts", "qa", "wslconfig-merge.js");
const wm = require(WM);
const WSL_TUNE = path.join(h.TEMPLATES_DIR, "scripts", "wsl-tune.sh");

test("capacity: PSI pressure is sampled and warned on", () => {
  const dir = tmpdir();
  const psi = path.join(dir, "pressure");
  fs.mkdirSync(psi, { recursive: true });
  fs.writeFileSync(path.join(psi, "memory"), "some avg10=25.00 avg60=5.00 avg300=1.00 total=1\nfull avg10=10.00 avg60=2.00 avg300=0.50 total=1\n");
  fs.writeFileSync(path.join(psi, "cpu"), "some avg10=2.00 avg60=1.00 avg300=0.50 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n");
  const prev = { psi: process.env.AGENT_CAPACITY_PSI_DIR, ram: process.env.AGENT_HOST_RAM_MB, cpus: process.env.AGENT_HOST_CPUS };
  process.env.AGENT_CAPACITY_PSI_DIR = psi;
  process.env.AGENT_HOST_RAM_MB = "16384";
  process.env.AGENT_HOST_CPUS = "12";
  try {
    const sample = capacity.sample(dir, "");
    assert.strictEqual(sample.psi.mem.some10, 25);
    const ev = capacity.evaluate(sample, {});
    assert.match(ev.warnings.join(" "), /memory pressure/);
  } finally {
    for (const [k, v] of [
      ["AGENT_CAPACITY_PSI_DIR", prev.psi],
      ["AGENT_HOST_RAM_MB", prev.ram],
      ["AGENT_HOST_CPUS", prev.cpus],
    ]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("capacity: host-aware .wslconfig advice flags processor oversubscription and big swap", () => {
  const wsl = {
    config: capacity.parseWslConfig(
      "[wsl2]\nmemory=10GB\nprocessors=10\nswap=8GB\nvmIdleTimeout=86400000\n[experimental]\nautoMemoryReclaim=gradual\n"
    ),
  };
  const advice = capacity.wslConfigAdvice(wsl, { ramMb: 16 * 1024, cpus: 12 }).join("\n");
  assert.match(advice, /processors=10 of 12/, "flags leaving Windows only 2 threads");
  assert.match(advice, /swap=8GB/, "flags a large swap as thrash-prone");
  assert.match(advice, /vmIdleTimeout/, "flags a 24h idle timeout");
  assert.doesNotMatch(advice, /leaves Windows ~/, "10GB of 16GB is not over-allocated");

  // Host-aware: a VM that starves Windows is called out.
  const tight = capacity
    .wslConfigAdvice(
      { config: capacity.parseWslConfig("[wsl2]\nmemory=13GB\nprocessors=4\n") },
      { ramMb: 16 * 1024, cpus: 12 }
    )
    .join("\n");
  assert.match(tight, /leaves Windows ~3\.0 GB/);
});

test("capacity: readTuning reports swappiness and the user.slice ceiling", () => {
  const dir = tmpdir();
  const sysctl = path.join(dir, "sys");
  fs.mkdirSync(path.join(sysctl, "vm"), { recursive: true });
  fs.writeFileSync(path.join(sysctl, "vm", "swappiness"), "10\n");
  const slice = path.join(dir, "90-agent-cap.conf");
  fs.writeFileSync(slice, "[Slice]\nMemoryMax=9G\n");
  const prev = { s: process.env.AGENT_TUNING_SYSCTL_DIR, f: process.env.AGENT_TUNING_SLICE_FILE };
  process.env.AGENT_TUNING_SYSCTL_DIR = sysctl;
  process.env.AGENT_TUNING_SLICE_FILE = slice;
  try {
    const t = capacity.readTuning();
    assert.strictEqual(t.swappiness, 10);
    assert.strictEqual(t.sliceApplied, true);
  } finally {
    if (prev.s === undefined) delete process.env.AGENT_TUNING_SYSCTL_DIR;
    else process.env.AGENT_TUNING_SYSCTL_DIR = prev.s;
    if (prev.f === undefined) delete process.env.AGENT_TUNING_SLICE_FILE;
    else process.env.AGENT_TUNING_SLICE_FILE = prev.f;
  }
});

test("wslconfig-merge updates keys in place, preserves the rest, and is idempotent", () => {
  const src = "[wsl2]\nnetworkingMode=mirrored\nmemory=10GB\nprocessors=10\n\n[experimental]\nautoMemoryReclaim=gradual\n";
  const merged = wm.mergeConfig(src, [
    { section: "wsl2", key: "processors", value: "8" },
    { section: "wsl2", key: "swap", value: "4GB" },
    { section: "experimental", key: "sparseVhd", value: "true" },
  ]);
  assert.match(merged, /processors=8/);
  assert.doesNotMatch(merged, /processors=10/);
  assert.match(merged, /memory=10GB/);
  assert.match(merged, /networkingMode=mirrored/);
  assert.match(merged, /\[wsl2\][\s\S]*swap=4GB/);
  assert.match(merged, /\[experimental\][\s\S]*sparseVhd=true/);
  assert.strictEqual(
    wm.mergeConfig(merged, [{ section: "wsl2", key: "processors", value: "8" }]),
    merged,
    "re-applying the same value is a no-op"
  );

  const appended = wm.mergeConfig("[wsl2]\nmemory=8GB\n", [
    { section: "experimental", key: "sparseVhd", value: "true" },
  ]);
  assert.match(appended, /\[experimental\]/);
  assert.match(appended, /sparseVhd=true/);
});

test("wslconfig-merge CLI writes atomically and rejects a bad --set", () => {
  const dir = tmpdir();
  const cfg = path.join(dir, ".wslconfig");
  fs.writeFileSync(cfg, "[wsl2]\nmemory=10GB\nprocessors=10\n");
  const r = spawnSync(
    process.execPath,
    [WM, "--file", cfg, "--write", "--backup", "--set", "wsl2.processors=8", "--set", "wsl2.swap=4GB"],
    { encoding: "utf8" }
  );
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const after = read(cfg);
  assert.match(after, /processors=8/);
  assert.match(after, /swap=4GB/);
  assert.match(read(fs.readdirSync(dir).filter((f) => f.startsWith(".wslconfig.bak-")).map((f) => path.join(dir, f))[0]), /processors=10/);

  const bad = spawnSync(process.execPath, [WM, "--file", cfg, "--set", "nonsense"], { encoding: "utf8" });
  assert.strictEqual(bad.status, 1, bad.stdout + bad.stderr);
});

test("wsl-tune status reports and apply --dry-run changes nothing", () => {
  const dir = tmpdir();
  const env = Object.assign({}, process.env, {
    AGENT_WSL_TUNE_FORCE: "1",
    AGENT_WSL_TUNE_SYSCTL: path.join(dir, "99-agent-wsl.conf"),
    AGENT_WSL_TUNE_SLICE_DIR: path.join(dir, "user.slice.d"),
    AGENT_WSL_TUNE_UNIT_DIR: path.join(dir, "units"),
    AGENT_WSL_CONFIG: path.join(dir, ".wslconfig"),
  });
  const status = spawnSync("bash", [WSL_TUNE, "status"], { encoding: "utf8", env });
  assert.strictEqual(status.status, 0, status.stdout + status.stderr);
  assert.match(status.stdout, /wsl-tune status/);

  const dry = spawnSync("bash", [WSL_TUNE, "apply", "--dry-run"], {
    encoding: "utf8",
    env: Object.assign({}, env, { AGENT_WSL_TUNE_DRY_RUN: "1", AGENT_WSL_TUNE_PROCESSORS: "8" }),
  });
  assert.strictEqual(dry.status, 0, dry.stdout + dry.stderr);
  assert.match(dry.stdout, /would write/);
  assert.match(dry.stdout, /MemoryMax=9G/);
  assert.match(dry.stdout, /agent-wsl-backstop\.service/, "the soft init.scope backstop is written");
  assert.match(dry.stdout, /set-property init\.scope MemoryHigh/, "the backstop targets init.scope");
  assert.ok(!exists(path.join(dir, "99-agent-wsl.conf")), "dry-run writes nothing");
  assert.ok(!exists(path.join(dir, "user.slice.d")), "dry-run creates no slice dir");
  assert.ok(!exists(path.join(dir, "units")), "dry-run creates no unit dir");
});

test("wsl-tune wslconfig merges the host keys into .wslconfig", () => {
  const dir = tmpdir();
  const cfg = path.join(dir, ".wslconfig");
  fs.writeFileSync(cfg, "[wsl2]\nnetworkingMode=mirrored\nmemory=10GB\nprocessors=10\n");
  const r = spawnSync("bash", [WSL_TUNE, "wslconfig"], {
    encoding: "utf8",
    env: Object.assign({}, process.env, {
      AGENT_WSL_TUNE_FORCE: "1",
      AGENT_WSL_CONFIG: cfg,
      AGENT_WSL_TUNE_PROCESSORS: "8",
      AGENT_WSL_TUNE_SWAP: "4GB",
      AGENT_WSL_TUNE_IDLE_MS: "7200000",
    }),
  });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const after = read(cfg);
  assert.match(after, /processors=8/);
  assert.match(after, /memory=10GB/, "project keys preserved");
  assert.match(after, /networkingMode=mirrored/);
  assert.match(after, /swap=4GB/);
  assert.match(after, /sparseVhd=true/);
});

test("[drift-guard] serve caps + wsl-tune are wired end to end", () => {
  const serve = read(path.join(h.TEMPLATES_DIR, "scripts", "serve.js"));
  assert.match(serve, /--mem-max/, "serve.js exposes --mem-max");
  assert.match(serve, /--cpu-max/, "serve.js exposes --cpu-max");
  assert.match(serve, /systemd-run/, "serve.js caps heavy tiers via a transient unit");
  const tune = read(WSL_TUNE);
  assert.match(tune, /wslconfig-merge\.js/, "wsl-tune uses the safe merge helper");
  assert.match(tune, /MemoryMax=9G/, "wsl-tune caps user.slice memory");
  assert.match(tune, /vm\.swappiness=10/, "wsl-tune lowers swappiness");
  const bin = read(path.join(__dirname, "..", "bin", "agent-harness.js"));
  assert.match(bin, /wsl-tune/, "the wsl-tune script is wired into the deploy");
});

test("capacity: envelope declares the heavy-tier cap and the init.scope backstop", () => {
  const env = capacity.parseEnvelope(
    read(path.join(h.TEMPLATES_DIR, ".agents", "memory", "orchestration.md"))
  );
  assert.strictEqual(env.heavyMemMaxMb, 5120, "a default heavy-tier cgroup cap is declared");
  assert.strictEqual(env.backstopMemHighMb, 8704, "a soft init.scope backstop is declared");
  assert.strictEqual(capacity.DEFAULT_ENVELOPE.heavyMemMaxMb, 5120, "default fallback matches");
});

test("capacity: readTuning detects whether the real workload cgroup is capped", () => {
  const dir = tmpdir();
  const cg = path.join(dir, "cgroup");
  fs.mkdirSync(path.join(cg, "init.scope"), { recursive: true });
  fs.mkdirSync(path.join(cg, "user.slice"), { recursive: true });
  fs.writeFileSync(path.join(cg, "user.slice", "memory.max"), "9663676416\n");
  const unit = path.join(dir, "agent-wsl-backstop.service");
  const prev = {
    root: process.env.AGENT_TUNING_CGROUP_ROOT,
    unit: process.env.AGENT_TUNING_BACKSTOP_UNIT,
  };
  process.env.AGENT_TUNING_CGROUP_ROOT = cg;
  process.env.AGENT_TUNING_BACKSTOP_UNIT = unit;
  try {
    fs.writeFileSync(path.join(cg, "init.scope", "memory.high"), "max\n");
    fs.writeFileSync(path.join(cg, "init.scope", "memory.max"), "max\n");
    assert.strictEqual(
      capacity.readTuning().workloadCapped,
      false,
      "an uncapped init.scope is detected (the user.slice ceiling does not cover it)"
    );
    fs.writeFileSync(path.join(cg, "init.scope", "memory.high"), "8589934592\n");
    assert.strictEqual(
      capacity.readTuning().workloadCapped,
      true,
      "a finite init.scope MemoryHigh counts as capped"
    );
    assert.strictEqual(capacity.readTuning().backstopApplied, false, "no backstop unit yet");
    fs.writeFileSync(unit, "[Service]\n");
    assert.strictEqual(
      capacity.readTuning().backstopApplied,
      true,
      "an installed backstop unit counts as applied"
    );
  } finally {
    if (prev.root === undefined) delete process.env.AGENT_TUNING_CGROUP_ROOT;
    else process.env.AGENT_TUNING_CGROUP_ROOT = prev.root;
    if (prev.unit === undefined) delete process.env.AGENT_TUNING_BACKSTOP_UNIT;
    else process.env.AGENT_TUNING_BACKSTOP_UNIT = prev.unit;
  }
});

test("serve.js prune removes dead records and keeps live ones", () => {
  const target = tmpdir();
  fs.mkdirSync(path.join(target, ".serve"), { recursive: true });
  fs.writeFileSync(
    path.join(target, ".serve", "dead.pid"),
    JSON.stringify({ pid: 999999, name: "dead", cmd: "npm run dev" })
  );
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { stdio: "ignore" });
  fs.writeFileSync(
    path.join(target, ".serve", "live.pid"),
    JSON.stringify({ pid: child.pid, name: "live", cmd: "node srv.js" })
  );
  const serve = path.join(h.TEMPLATES_DIR, "scripts", "serve.js");
  try {
    const r = spawnSync(process.execPath, [serve, "prune"], { cwd: target, encoding: "utf8" });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.ok(!exists(path.join(target, ".serve", "dead.pid")), "dead record removed");
    assert.ok(exists(path.join(target, ".serve", "live.pid")), "live record kept");
    assert.match(r.stdout, /removed 1 stale record\(s\), kept 1 live/);
  } finally {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch (_) {
      /* already gone */
    }
  }
});

const HAS_SYSTEMD_USER = (() => {
  try {
    const r = spawnSync("systemctl", ["--user", "is-system-running"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return r.status === 0 || /running|degraded|starting|maintenance/.test(r.stdout || "");
  } catch (_) {
    return false;
  }
})();

test(
  "serve.js caps a heavy tier by default and runs it under user.slice",
  { skip: !HAS_SYSTEMD_USER ? "no systemd --user bus" : false },
  () => {
    const target = tmpdir();
    const serve = path.join(h.TEMPLATES_DIR, "scripts", "serve.js");
    // "next dev" classifies as heavy; the trailing comment keeps the command
    // trivial so the launch is quick, while the cap path is fully exercised.
    const r = spawnSync(
      process.execPath,
      [serve, "start", "--cmd", "sleep 20 # next dev", "--name", "capdemo"],
      {
        cwd: target,
        encoding: "utf8",
        env: Object.assign({}, process.env, { AGENT_CAPACITY_DISABLE: "1" }),
      }
    );
    try {
      assert.strictEqual(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /mem≤5120M/, "the default envelope cap is announced");
      const info = JSON.parse(read(path.join(target, ".serve", "capdemo.pid")));
      assert.ok(info.unit, "the heavy tier ran as a transient unit");
      assert.strictEqual(info.memMax, "5120M", "the envelope default cap is recorded");
      const cg = spawnSync("systemctl", ["--user", "show", info.unit, "-p", "ControlGroup", "--value"], {
        encoding: "utf8",
      }).stdout.trim();
      assert.match(
        cg,
        /\/user\.slice\//,
        "the heavy tier runs under user.slice, where the wsl-tune ceiling binds"
      );
    } finally {
      spawnSync(process.execPath, [serve, "stop", "--name", "capdemo"], {
        cwd: target,
        encoding: "utf8",
      });
    }
  }
);

test("[drift-guard] serve caps heavy tiers by default and wsl-tune installs the backstop", () => {
  const serve = read(path.join(h.TEMPLATES_DIR, "scripts", "serve.js"));
  assert.match(serve, /--no-cap/, "serve.js exposes --no-cap");
  assert.match(serve, /AGENT_SERVE_NO_CAP/, "serve.js has an env opt-out");
  assert.match(serve, /heavyMemMaxMb/, "serve.js applies the envelope's default heavy cap");
  assert.match(serve, /case "prune"/, "serve.js exposes prune");
  const tune = read(WSL_TUNE);
  assert.match(tune, /agent-wsl-backstop\.service/, "wsl-tune installs the init.scope backstop unit");
  assert.match(tune, /set-property init\.scope MemoryHigh/, "the backstop targets init.scope");
  const cap = read(path.join(h.TEMPLATES_DIR, "scripts", "qa", "capacity-lib.js"));
  assert.match(cap, /workloadCapped/, "capacity-lib detects whether the workload cgroup is capped");
});

test("[drift-guard] mobile E2E mechanism ships (runner, validator, config, helpers) and is documented", () => {
  const dir = path.join(h.TEMPLATES_DIR, "scripts", "qa", "mobile-e2e");
  for (const f of ["run-maestro.js", "check-flows.js", "config.yaml", "boot-emulator.sh", "run-detached.sh"]) {
    assert.ok(exists(path.join(dir, f)), `${f} must ship in templates/scripts/qa/mobile-e2e`);
  }

  // The runner's pure planner drives the entire perf layer — it must ship and
  // behave (default = one invocation per flow; reuse = same-actor batching; an
  // actor change switches user; a first-login journey is standalone).
  const runner = require(path.join(dir, "run-maestro.js"));
  const rec = (name, actor, setup = false) => ({
    file: `${name}.yaml`,
    name,
    actor,
    endsAs: actor,
    setup: null,
    oracle: null,
    hasSetup: setup,
    hasOracle: false,
    firstLogin: false,
  });
  const cold = runner.planInvocations([rec("a", "0502000001"), rec("b", "0502000001")], false);
  assert.strictEqual(cold.length, 2, "default is one invocation per flow");
  assert.ok(cold.every((inv) => inv.switchUser), "default re-establishes the session per flow");
  const warm = runner.planInvocations(
    [rec("a", "0502000001"), rec("b", "0502000001"), rec("c", "0502000006")],
    true
  );
  assert.strictEqual(warm.length, 3, "same-actor flows batch; an actor change splits");
  assert.strictEqual(warm[0].switchUser, true, "the first flow of an actor switches/establishes");
  assert.strictEqual(warm[1].switchUser, false, "the next same-actor flow reuses the session");
  assert.strictEqual(warm[2].switchUser, true, "an actor change switches the session");
  const first = { ...rec("f", "0502000001"), firstLogin: true };
  const firstPlan = runner.planInvocations([first, rec("a", "0502000001")], true);
  assert.strictEqual(firstPlan[0].records.length, 1, "a firstLogin flow is standalone");
  assert.strictEqual(firstPlan[0].switchUser, true, "a firstLogin flow establishes its own session");
  const switcher = { ...rec("s", "0502000001"), endsAs: "0500000000" };
  const switchPlan = runner.planInvocations([switcher, rec("n", "0502000001")], true);
  assert.strictEqual(switchPlan[0].records.length, 1, "an actor-switching (endsAs) flow runs alone");
  assert.strictEqual(switchPlan[1].switchUser, true, "the next actor is re-established after a switch");
  assert.deepStrictEqual(
    runner.orderFirstLoginFirst(["a.yaml", "b.yaml"], new Map([["b.yaml", { firstLogin: true }]])),
    ["b.yaml", "a.yaml"],
    "a firstLogin journey is ordered first"
  );
  assert.strictEqual(runner.parseFailedFlows("[Failed] a (1s) (boom)\n[Passed] b").get("a"), "boom");

  // The config turns off animations (the dominant per-command cost).
  assert.match(read(path.join(dir, "config.yaml")), /disableAnimations:\s*true/);

  // The validator accepts the optional `actor:` key and still rejects unknown keys.
  const validator = require(path.join(dir, "check-flows.js"));
  const okMatrix = [
    "journeys:",
    "  - id: x",
    "    flow: x.yaml",
    "    entry: mobile/app/login.tsx",
    '    actor: "0502000001"',
    "    firstLogin: true",
    "    screens: [mobile/app/login.tsx]",
    "    states: [ideal]",
    "",
  ].join("\n");
  assert.deepStrictEqual(validator.parseMatrix(okMatrix).violations, []);
  assert.ok(
    validator.parseMatrix(okMatrix.replace("firstLogin: true", "firstLogin: maybe")).violations.some((v) => /firstLogin/.test(v)),
    "a non-boolean firstLogin must fail"
  );
  const badMatrix = [
    "journeys:",
    "  - id: x",
    "    flow: x.yaml",
    "    entry: mobile/app/login.tsx",
    "    bogus: 1",
    "",
  ].join("\n");
  assert.ok(
    validator.parseMatrix(badMatrix).violations.some((v) => /unknown journey key/.test(v)),
    "an unknown journey key must fail"
  );

  // The runbook documents the fast/observable workflow.
  const doc = read(path.join(h.TEMPLATES_DIR, "docs", "mobile-testing.md"));
  assert.match(doc, /run-detached\.sh/, "runbook documents the detached runner helper");
  assert.match(doc, /--reuse-session/, "runbook documents session reuse");
  assert.match(doc, /boot-emulator\.sh/, "runbook documents the emulator helper");
});

test("[drift-guard] device tier is right-sized, group-budgeted, and notifyable", () => {
  const meDir = path.join(h.TEMPLATES_DIR, "scripts", "qa", "mobile-e2e");
  assert.ok(exists(path.join(meDir, "job-events.js")), "job-events.js must ship");

  const boot = read(path.join(meDir, "boot-emulator.sh"));
  assert.match(boot, /--print-profile/, "boot-emulator.sh exposes --print-profile");
  assert.match(boot, /detect_gpu|swiftshader_indirect/, "boot-emulator.sh auto-detects the GPU backend");
  assert.match(boot, /nproc/, "boot-emulator.sh derives cores from the host");
  assert.match(boot, /--group/, "boot-emulator.sh joins a tier group");

  const serve = read(path.join(h.TEMPLATES_DIR, "scripts", "serve.js"));
  assert.match(serve, /a === "--group"/, "serve.js parses --group");
  assert.match(serve, /updateHeavyMember/, "serve.js records the real server pid in the lock");
  assert.match(serve, /pendingGroup/, "serve.js evaluates the pending tier group");

  const cap = read(path.join(h.TEMPLATES_DIR, "scripts", "qa", "capacity-lib.js"));
  assert.match(cap, /pendingGroup/, "capacity-lib counts a group as one tier");

  const det = read(path.join(meDir, "run-detached.sh"));
  assert.match(det, /--wait/, "run-detached.sh supports --wait");
  assert.match(det, /events\.jsonl|EVENTS=/, "run-detached.sh records an events stream");
  assert.match(det, /record:/, "run-detached.sh points at the job record");

  const runner = read(path.join(meDir, "run-maestro.js"));
  assert.match(runner, /matrix_done/, "run-maestro.js emits matrix_done");
  assert.match(runner, /flow_result/, "run-maestro.js emits per-scenario results");

  const plugin = read(path.join(h.TEMPLATES_DIR, ".opencode", "plugins", "job-notify.ts"));
  assert.match(plugin, /promptAsync/, "job-notify wakes the session with a push notification");
  assert.match(plugin, /readEvents/, "job-notify tails the progress stream");
});

test("mobile E2E job-events reduce the progress stream for the notifier", () => {
  const j = require(path.join(h.TEMPLATES_DIR, "scripts", "qa", "mobile-e2e", "job-events.js"));
  const seq = [
    { type: "matrix_start", total: 2, mode: "reuse-session" },
    { type: "flow_start", name: "auth-login", index: 1, total: 2 },
    { type: "flow_result", name: "auth-login", status: "pass" },
    { type: "flow_result", name: "book-detail", status: "fail", reason: "Element not found: id x" },
    { type: "matrix_done", passed: 1, failed: 1, total: 2, report: "/r.json" },
  ];
  const s = j.summarize(seq);
  assert.strictEqual(s.passed, 1);
  assert.strictEqual(s.failed, 1);
  assert.strictEqual(s.done, true);
  assert.strictEqual(s.failures[0].name, "book-detail");
  const text = j.notificationText(s, { eventsPath: "/e.jsonl" });
  assert.match(text, /1 passed \/ 1 failed/);
  assert.match(text, /book-detail/);
  assert.match(text, /\/r\.json/);
  assert.match(j.progressLine(seq[3]), /flow FAIL: book-detail/);
  assert.match(j.progressLine(seq[1]), /flow start \(1\/2\)/);

  // A partially-written trailing line is tolerated (the run is still live).
  const dir = tmpdir();
  const f = path.join(dir, "ev.jsonl");
  fs.writeFileSync(f, `${JSON.stringify(seq[0])}\n{partial`);
  assert.strictEqual(j.readEvents(f).length, 1);
});

test("boot-emulator.sh --print-profile derives the profile from the host and AVD", () => {
  const script = path.join(h.TEMPLATES_DIR, "scripts", "qa", "mobile-e2e", "boot-emulator.sh");
  const dir = tmpdir();
  const cfg = path.join(dir, "config.ini");
  fs.writeFileSync(cfg, "hw.cpu.ncore = 2\n");
  const run = (env) => {
    const r = spawnSync("bash", [script, "--print-profile"], {
      encoding: "utf8",
      env: Object.assign({}, process.env, env),
    });
    assert.strictEqual(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const derived = run({ MOBILE_E2E_AVD: "t", MOBILE_E2E_AVD_CONFIG: cfg });
  assert.strictEqual(derived.avdCores, 2, "the AVD config is read");
  assert.strictEqual(derived.cores, 2, "cores are capped by the AVD's 2-core config");
  assert.strictEqual(derived.memory, 2048, "RAM default comes from the capacity envelope");
  assert.ok(["host", "swiftshader_indirect"].includes(derived.gpu), "GPU backend is auto-detected");

  const over = run({
    MOBILE_E2E_AVD: "t",
    MOBILE_E2E_AVD_CONFIG: cfg,
    MOBILE_E2E_CORES: "6",
    MOBILE_E2E_MEMORY: "3072",
    MOBILE_E2E_GPU: "host",
  });
  assert.strictEqual(over.cores, 6);
  assert.strictEqual(over.memory, 3072);
  assert.strictEqual(over.gpu, "host");
});

test("capacity: a shared tier group counts as one heavy tier and the lock tracks members", () => {
  const e = capacity.DEFAULT_ENVELOPE;
  const base = {
    envelope: e,
    mem: { available: 4000, total: 10000, swapTotal: 0, swapUsedPct: 0 },
    load: { load1: 1, cpus: 8 },
    psi: null,
    tmpfs: [],
    wsl: true,
    serves: [{ name: "emulator", alive: true, heavy: true, group: "mobile", ageMs: 1000 }],
  };
  assert.strictEqual(
    capacity.evaluate(base, { pendingHeavy: 1, pendingLive: 1 }).ok,
    false,
    "a second unrelated heavy tier is refused"
  );
  assert.strictEqual(
    capacity.evaluate(base, { pendingHeavy: 1, pendingLive: 1, pendingGroup: "mobile" }).ok,
    true,
    "a same-group member joins the running tier"
  );

  const dir = tmpdir();
  const prev = process.env.AGENT_HEAVY_LOCK;
  process.env.AGENT_HEAVY_LOCK = path.join(dir, "heavy.lock");
  try {
    assert.strictEqual(capacity.acquireHeavyLock("emulator", e, "mobile").ok, true);
    const join = capacity.acquireHeavyLock("app-dev", e, "mobile");
    assert.strictEqual(join.ok, true, "a same-group member may join");
    assert.strictEqual(join.joined, true);
    assert.strictEqual(capacity.acquireHeavyLock("other", e, null).ok, false, "an unrelated tier is refused");

    capacity.updateHeavyMember({ name: "app-dev", group: "mobile", pid: process.pid });
    const names = capacity.readLock().members.map((m) => m.name).sort();
    assert.deepStrictEqual(names, ["app-dev", "emulator"], "both members are recorded");

    assert.strictEqual(capacity.releaseHeavyLock("app-dev", "mobile"), true);
    assert.ok(capacity.readLock(), "the lock survives while a member remains");
    assert.strictEqual(capacity.releaseHeavyLock("emulator", "mobile"), true);
    assert.strictEqual(capacity.readLock(), null, "the lock is removed with the last member");
  } finally {
    if (prev === undefined) delete process.env.AGENT_HEAVY_LOCK;
    else process.env.AGENT_HEAVY_LOCK = prev;
  }
});
