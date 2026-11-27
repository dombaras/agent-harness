#!/usr/bin/env node
"use strict";
/*
 * agent-harness — deploy the agent harness (personas, skills, rules, model
 * routing, QA gates) into a target project.
 *
 * Commands:
 *   init   [--target <dir>] [--name <project>] [--domain <desc>] [--yes] [--dry-run]
 *   update [--target <dir>] [--dry-run]
 *   migrate-backlog [--target <dir>]
 *   list
 *   --version | -v
 *   --help | -h
 *
 * `init`/`update` materialize templates/ into the target and substitute {{
 * PROJECT_NAME }} / {{ PROJECT_DOMAIN }}.
 *
 * Ownership model:
 *   - `.agents/memory/*` + `.agents/features/*` is project data -> create-if-missing (never overwrite).
 *   - `BACKLOG.md` (repo root) is project data -> create-if-missing (never overwrite); it is the
 *     canonical task list, and `update` must never clobber the project's live board.
 *   - `opencode.json` is MERGED: harness manages $schema/model and the `agents`
 *     defaults (title/build/explore) + the `permissions` baseline; every other
 *     key the project adds is preserved. (Native V2 shape: no `small_model`,
 *     singular `agent`, or keyed `permission`.)
 *   - `.gitattributes` and `.ignore` are MERGED as a harness-managed begin/end
 *     block; project entries outside the block are preserved.
 *   - all other harness-owned files are overwritten. If a harness-owned file was
 *     modified locally since the last deploy (tracked by checksum in
 *     `.harness.json`), it is backed up to `.harness-backup/<timestamp>/` first.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const readline = require("readline");
const { spawnSync } = require("child_process");

const PKG = require("../package.json");
const TEMPLATES_DIR = path.resolve(__dirname, "..", "templates");
/* Repo-only global-plugin sources (NOT under templates/, so `init`/`update` never
 * deploy them into a project). `install-global` links these into the user's
 * opencode global plugin dir. */
const GLOBAL_PLUGINS_SRC = path.resolve(__dirname, "..", "contrib", "global-plugins");
const CONFIG_FILE = ".harness.json";
const BACKUP_DIR = ".harness-backup";

/* A real `update` must ship a COMMITTED template tree. `update` reads
 * `templates/` from THIS checkout, not from a published package: an uncommitted
 * template is deployed downstream but never appears in a `chore(harness)` commit,
 * so the target sees it as project WIP and the next update can silently revert
 * it (the 2026-11-20 LibraryOS 0.3.6 incident). Returns the dirty status lines. */
function dirtyTemplateEntries(root) {
  const r = runGit(root || path.resolve(__dirname, ".."), ["status", "--porcelain", "--", "templates"]);
  if (!r.ok || !r.out) return [];
  return r.out.split(/\r?\n/).filter(Boolean);
}

// ---------------------------------------------------------------- helpers

/* Numeric semver compare (major.minor.patch; prerelease tags ignored).
 * Returns <0 / 0 / >0 like a normal comparator. */
function compareVersions(a, b) {
  const pa = String(a || "0").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "0").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

/* Best-effort: the latest `dist-tags.latest` for PKG.name on the configured
 * registry. Returns null when the registry is unreachable / package unknown,
 * so the check never blocks a deploy. */
function publishedLatestVersion() {
  const npmCli = process.env.npm_execpath
    ? path.join(path.dirname(process.env.npm_execpath), "npm-cli.js")
    : null;
  const args = ["view", PKG.name, "version", "--json", "--fetch-timeout=5000", "--fetch-retries=0"];
  const r = npmCli
    ? spawnSync(process.execPath, [npmCli, ...args], { encoding: "utf8", timeout: 10000 })
    : spawnSync("npm", args, { encoding: "utf8", timeout: 10000 });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout.trim());
  } catch (_) {
    return r.stdout.trim() || null;
  }
}

function listFiles(dir, base = dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(abs, base));
    else out.push({ abs, rel: path.relative(base, abs) });
  }
  return out;
}

function substitute(text, vars) {
  let out = text;
  for (const [key, value] of Object.entries(vars)) {
    out = out.split("{{" + key + "}}").join(value == null ? "" : String(value));
  }
  return out;
}

function relKey(rel) {
  return rel.split(path.sep).join("/");
}

/* A session handoff must never live in the shipped template tree: the dogfood
 * symlinks repo `scripts` -> `templates/scripts`, so an `__dirname`-rooted
 * checkpoint could drop one there, and `update` would scaffold it into every
 * project (F-26/H-49). Refuse the deploy and name the stray. README.md is the
 * shipped placeholder and is allowed. */
function assertNoTemplateHandoffs() {
  const dir = path.join(TEMPLATES_DIR, ".agents", "handoffs");
  if (!fs.existsSync(dir)) return;
  const strays = fs
    .readdirSync(dir)
    .filter((f) => f !== "README.md" && !f.startsWith("."))
    .sort();
  if (strays.length) {
    throw new Error(
      `templates/.agents/handoffs/ has stray file(s) that \`update\` would ship to every project:\n` +
        strays.map((f) => `    - templates/.agents/handoffs/${f}`).join("\n") +
        `\n  A checkpoint handoff belongs in the PROJECT root (cwd), not the template tree. ` +
        `Delete the stray(s) (F-26/H-49) and re-run.`
    );
  }
}

/* `.agents/memory/*` (session memory), `.agents/features/*` (feature doc tree),
 * `.agents/reviews/*` (durable review/audit deliverables), `.agents/qa-plans/*`
 * (one QA plan file per change), `.agents/qa-runs/*` (one directory of verbatim
 * QA evidence per change) and `.agents/handoffs/*` (one session handoff file per
 * session) are project data — scaffolded create-if-missing, never overwritten,
 * and never tracked in the manifest. qa-plans/qa-runs/handoffs are sharded per
 * change/session so concurrent sessions never collide on a single shared file.
 * Note: the check matches the directory DIRECTLY under `.agents` (not any
 * segment), so `.agents/skills/features/SKILL.md` stays harness-owned. */
function isProjectScaffold(rel) {
  const key = relKey(rel);
  // `.agents/nightly.json` is the project-owned nightly-cycle config (phases,
  // quiesce window, seed command): seeded once, never overwritten.
  if (key === ".agents/nightly.json") return true;
  const parts = rel.split(path.sep);
  const idx = parts.indexOf(".agents");
  if (idx === -1) return false;
  const sub = parts[idx + 1];
  return (
    sub === "memory" ||
    sub === "features" ||
    sub === "reviews" ||
    sub === "qa-plans" ||
    sub === "qa-runs" ||
    sub === "handoffs"
  );
}
/* The canonical `BACKLOG.md` at the repo root is also project data (a live task
 * list the project owns): scaffolded create-if-missing, never overwritten so an
 * `update` can never clobber the project's board, and never tracked in the
 * manifest (its content is the project's, not the harness's). */
function isBacklogFile(rel) {
  return relKey(rel) === "BACKLOG.md";
}
/* The CI/CD release scaffold is also project data: `init` seeds a working
 * pipeline (CI gate, CI-triggered artifact deploy, health probe, Vercel
 * build-context hygiene, and the reference doc) exactly once, and `update`
 * NEVER overwrites a project's edited workflows. This is what makes the
 * self-contained agent cycle reproducible on a fresh project instead of only in
 * the one repo it was hand-built in. */
function isReleaseScaffold(rel) {
  const key = relKey(rel);
  if (key === ".vercelignore") return true;
  if (key === ".husky/pre-push") return true;
  if (key === "docs/ci-cd-pipeline.md") return true;
  if (key.startsWith(".github/workflows/") && /\.ya?ml$/i.test(key)) return true;
  return false;
}
/* Combined: any file that must be scaffolded create-if-missing rather than
 * overwritten. */
function isCreateIfMissing(rel) {
  return isProjectScaffold(rel) || isBacklogFile(rel) || isReleaseScaffold(rel);
}
/* Back-compat alias (kept for any external caller referencing the old name). */
function isMemoryFile(rel) {
  return isProjectScaffold(rel);
}

function isOpencodeJson(rel) {
  return relKey(rel) === "opencode.json";
}

/* Canonical text form for checksums: CRLF is folded to LF so a file's line
 * endings can never masquerade as a local edit. `.gitattributes` pins `*.ps1`
 * to CRLF on checkout, so a correctly-checked-out Windows script arrives CRLF
 * while the harness template is LF — hashing raw bytes flagged that as a
 * hand-edit and made `update` fail closed (and rewriting it LF left git dirty).
 * Templates are LF-pinned, so folding CRLF→LF leaves every existing recorded
 * hash valid. */
function normalizeEol(text) {
  return String(text).replace(/\r\n/g, "\n");
}

function sha256(str) {
  return crypto.createHash("sha256").update(normalizeEol(str), "utf8").digest("hex");
}

/* `next dev` appends this marker block to the project's root AGENTS.md on every
 * run (and re-adds it when removed). It is tool-owned content, never a
 * hand-edit of the harness file: comparing raw bytes made `update` fail closed
 * on AGENTS.md, and rewriting the file just made `next dev` re-add the block
 * (F-349). Strip the block and its trailing separator before comparing. */
function stripNextDevMarker(text) {
  const lf = normalizeEol(text);
  if (!lf.includes("<!-- BEGIN:nextjs-agent-rules -->")) return lf;
  return lf.replace(
    /\n*<!-- BEGIN:nextjs-agent-rules -->[\s\S]*?<!-- END:nextjs-agent-rules -->[ \t]*\n?/g,
    ""
  );
}

/* Comparable form of the root AGENTS.md: the harness-owned content, ignoring
 * the `next dev` marker block and the trailing newline it may leave behind. */
function harnessAgentsComparable(text) {
  return stripNextDevMarker(text).replace(/\s+$/, "");
}

/* The harness-owned root AGENTS.md in template shape: the tool-owned `next dev`
 * block and its separator removed, exactly one trailing newline. `next dev` may
 * append the block after any deploy, so hashing raw bytes made a later template
 * change look like a project hand-edit and failed `update` closed (the 0.4.1
 * LibraryOS deploy stall). */
function harnessAgentsOwned(text) {
  return stripNextDevMarker(text).replace(/\s+$/, "") + "\n";
}

function safeJson(text, fallback) {
  if (text == null) return fallback;
  try {
    return JSON.parse(text);
  } catch (_) {
    return fallback;
  }
}

function readConfig(target) {
  const p = path.join(target, CONFIG_FILE);
  if (fs.existsSync(p)) return safeJson(fs.readFileSync(p, "utf8"), {});
  return {};
}

function ask(question, fallback, yes) {
  if (yes) return Promise.resolve(fallback || "");
  if (!process.stdin.isTTY) return Promise.resolve(fallback || "");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/* The work root a target's sibling worktrees live under: the target's parent
 * directory — e.g. `/home/ronen/develop` for `~/develop/PublicVirtualLibrary`.
 * Normalized to forward slashes so it is a valid glob on every platform. This
 * is substituted into `templates/opencode.json` as `{{WORKSPACE_ROOT}}` so the
 * `external_directory` policy allows the repo + its sibling worktrees without
 * hardcoding a machine-specific path. */
function workspaceRootFor(target) {
  return path.dirname(path.resolve(target)).split(path.sep).join("/");
}

function resolveVars(target, args) {
  const existing = readConfig(target);
  const projectName = args["--name"] || existing.projectName || path.basename(target);
  const projectDomain = args["--domain"] || existing.projectDomain || "";
  return {
    projectName,
    projectDomain,
    existing,
    VARIABLES: {
      PROJECT_NAME: projectName,
      PROJECT_DOMAIN: projectDomain,
      PROJECT_DIR: path.basename(path.resolve(target)),
      WORKSPACE_ROOT: workspaceRootFor(target),
    },
  };
}

// ---------------------------------------------------------------- opencode.json

function templateOpencodeJson() {
  const p = path.join(TEMPLATES_DIR, "opencode.json");
  return safeJson(fs.readFileSync(p, "utf8"), {});
}

// Merge harness-managed keys into the project's existing opencode.json,
// preserving every other key the project has added.
function mergeOpencodeJson(target, variables) {
  // `{{PROJECT_DIR}}` is the checkout directory name, which is also the per-repo
  // segment of the worktree container. Derive it from `target` so every caller
  // (install, update, tests) renders a valid worktree path without repeating it.
  const vars = { PROJECT_DIR: path.basename(path.resolve(target)), ...(variables || {}) };
  const harness = safeJson(
    substitute(fs.readFileSync(path.join(TEMPLATES_DIR, "opencode.json"), "utf8"), vars),
    {}
  );
  const p = path.join(target, "opencode.json");
  const existing = fs.existsSync(p) ? safeJson(fs.readFileSync(p, "utf8"), {}) : {};

  const merged = { ...existing, ...harness };

  // --- V1 -> V2 config convergence -------------------------------------------
  // An older deploy wrote harness-managed V1 keys (`small_model`, the singular
  // `agent` map, the keyed `permission` map, the `tools` enable/disable map, and an
  // `instructions` entry). V2 normalizes V1 shapes, but the file would then keep
  // both forms forever, so migrate the project's own values into the native V2
  // shape and drop the V1 key.
  //
  // `tools` (G1): V2 has no top-level or per-agent `tools` field, so a project's
  // MCP gating (`tools: { "pg*": false }` + `agents.<name>.tools: { "pg*": true }`)
  // lost the per-agent allow and left the server connected but unusable. Migrate
  // both maps into ordered `permissions` rules; per-agent rules are appended to
  // that agent's own rules, so the agent allow still wins over the global deny.
  const absorbAgentTools = (cfg) => {
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg) || !("tools" in cfg)) return cfg;
    const rules = convertV1Tools(cfg.tools);
    const out = { ...cfg };
    delete out.tools;
    if (rules.length) {
      out.permissions = [...(Array.isArray(cfg.permissions) ? cfg.permissions : []), ...rules];
    }
    return out;
  };
  const priorAgents = {};
  for (const src of [existing.agent, existing.agents]) {
    if (!src || typeof src !== "object" || Array.isArray(src)) continue;
    for (const [name, cfg] of Object.entries(src)) priorAgents[name] = absorbAgentTools(cfg);
  }
  if (
    typeof existing.small_model === "string" &&
    !(priorAgents.title && typeof priorAgents.title === "object" && priorAgents.title.model)
  ) {
    priorAgents.title = { ...(priorAgents.title || {}), model: existing.small_model };
  }
  const priorPermissions = [
    ...(Array.isArray(existing.permissions) ? existing.permissions : []),
    ...convertV1Permission(existing.permission),
    ...convertV1Tools(existing.tools),
  ];
  delete merged.agent;
  delete merged.small_model;
  delete merged.permission;
  delete merged.tools;
  if (Array.isArray(merged.instructions)) {
    const kept = merged.instructions.filter((x) => x !== ".agents/rules/00-operating.md");
    if (kept.length) merged.instructions = kept;
    else delete merged.instructions;
  }

  // ADD-ONLY agent defaults (project values win; every project agent preserved).
  if (harness.agents && typeof harness.agents === "object" && !Array.isArray(harness.agents)) {
    const agents = { ...priorAgents };
    for (const [name, cfg] of Object.entries(harness.agents)) {
      const prior = agents[name] && typeof agents[name] === "object" ? agents[name] : {};
      agents[name] = { ...cfg, ...prior };
    }
    merged.agents = agents;
  } else if (Object.keys(priorAgents).length) {
    merged.agents = priorAgents;
  }

  // Native worktree destination: a harness default, add-only. A project that
  // already chose a `worktree.directory` keeps it (project wins), same contract
  // as the agent defaults above.
  if (harness.worktree && typeof harness.worktree === "object" && !Array.isArray(harness.worktree)) {
    const prior =
      existing.worktree && typeof existing.worktree === "object" && !Array.isArray(existing.worktree)
        ? existing.worktree
        : {};
    merged.worktree = { ...harness.worktree, ...prior };
  } else if (existing.worktree) {
    merged.worktree = existing.worktree;
  }

  // The `permissions` baseline is an ordered array (V2: the last matching rule
  // wins), so a plain keyed merge is impossible. Union it: harness rules first,
  // the project's own rules appended after so they win a resource collision, and
  // exact duplicates dropped.
  if (Array.isArray(harness.permissions)) {
    const seen = new Set();
    const permissions = [];
    for (const rule of [...harness.permissions, ...priorPermissions]) {
      const key = JSON.stringify(rule);
      if (seen.has(key)) continue;
      seen.add(key);
      permissions.push(rule);
    }
    merged.permissions = permissions;
  } else if (priorPermissions.length) {
    merged.permissions = priorPermissions;
  }
  // `policies` is also an ordered array (hard allow/deny, last match wins within
  // one file), so union it the same way: harness statements first, the project's
  // own appended after so its explicit opt-in (e.g. an `mcp.use` allow that lifts
  // the default deny) is the last word, exact duplicates dropped. A pre-2.3
  // project may carry them under `experimental.policies`; migrate those too so
  // the two locations cannot disagree (docs: `experimental.policies` merges into
  // `policies`).
  const priorPolicies = [
    ...(Array.isArray(existing.policies) ? existing.policies : []),
    ...(existing.experimental &&
    typeof existing.experimental === "object" &&
    Array.isArray(existing.experimental.policies)
      ? existing.experimental.policies
      : []),
  ];
  if (Array.isArray(harness.policies) || priorPolicies.length) {
    const seenPolicies = new Set();
    const policies = [];
    for (const statement of [...(Array.isArray(harness.policies) ? harness.policies : []), ...priorPolicies]) {
      const key = JSON.stringify(statement);
      if (seenPolicies.has(key)) continue;
      seenPolicies.add(key);
      policies.push(statement);
    }
    merged.policies = policies;
  }
  // MCP servers live under `mcp.servers` in V2. A project owns its own `mcp`
  // block (servers are project-side, e.g. a dev-DB server), so if the harness
  // ever ships a default server the top-level spread would replace the WHOLE
  // block. Deep-merge by server NAME instead: a project's same-named server wins
  // (its keys win on a collision), project-only servers are preserved,
  // harness-only servers are added. This is the guard the backlog requires
  // before any default `mcp` block can ship in templates/opencode.json.
  if (harness.mcp && typeof harness.mcp === "object" && !Array.isArray(harness.mcp)) {
    merged.mcp = mergeMcp(harness.mcp, existing.mcp);
  }
  // `experimental.todo` is harness-managed (the todo-list discipline depends on
  // the `todowrite` tool, which V2 gates behind it); every other experimental
  // key belongs to the project and survives a re-deploy.
  merged.experimental = mergeExperimental(harness.experimental, existing.experimental);
  // `experimental.policies` (pre-2.3 location) was folded into the top-level
  // union above; drop the duplicate so the two cannot disagree on a re-merge.
  if (merged.experimental && typeof merged.experimental === "object" && "policies" in merged.experimental) {
    delete merged.experimental.policies;
  }
  return JSON.stringify(merged, null, 2) + "\n";
}

/* V1 -> V2 renamed tool/permission actions (docs/opencode-v2-migration:
 * "Permission actions also changed"). A V1 name that is not here either already
 * matches its V2 action (`edit`, `read`, `skill`, a `<server>_*` MCP action) or
 * has no V2 equivalent and would produce a rule that can never match. Shared by
 * `convertV1Permission` (the keyed `permission` map) and `convertV1Tools` (the
 * `tools` enable/disable map) so the two migrations can never drift.
 *
 * `apply_patch` is included even though V1's `tools`/`permission` maps exposed it
 * as `patch`: V2's runtime maps the `apply_patch` TOOL to the `patch` category and
 * then to the `edit` permission action (verified against the 2.0.31 binary). So
 * mapping it to `edit` here is what makes the narrow `edit`-deny grants
 * (planner/product-manager) actually cover `apply_patch` — otherwise that tool
 * would leak past a persona whose whole write surface is one artifact. */
const V1_ACTION = { bash: "shell", task: "subagent", write: "edit", patch: "edit", apply_patch: "edit" };

/* Convert a V1 keyed `permission` map (`{ <action>: { <resource>: effect } }`, or
 * `{ <action>: effect }`) into the V2 ordered rules array, mapping the renamed V1
 * actions (`bash`/`write`/`patch`/`task`) to their V2 names. Entry order is
 * preserved so the V2 "last matching rule wins" semantics match the V1 glob map as
 * closely as possible. */
function convertV1Permission(v1) {
  const out = [];
  if (!v1 || typeof v1 !== "object" || Array.isArray(v1)) return out;
  for (const [action, rule] of Object.entries(v1)) {
    const actionName = V1_ACTION[action] || action;
    if (rule && typeof rule === "object" && !Array.isArray(rule)) {
      for (const [resource, effect] of Object.entries(rule)) {
        if (typeof effect === "string") out.push({ action: actionName, resource, effect });
      }
    } else if (typeof rule === "string") {
      out.push({ action: actionName, resource: "*", effect: rule });
    }
  }
  return out;
}

/* Convert a V1 `tools` map (`{ <tool-or-glob>: boolean }`) into V2 permission
 * rules. V2 has **no top-level or per-agent `tools` field** (confirmed against
 * `Agent.Info` in `@opencode/schema@2.0.29`): tool enablement is an ordered
 * permission rule whose `action` is the tool name (`<server>_<tool>` for MCP) and
 * whose `resource` is `"*"`. Without this the V1 global disable survived as a
 * `permission` rule but the per-agent re-enable was silently dropped, so an MCP
 * server showed `connected` yet no agent could call its tools (G1, LibraryOS).
 * V1 tool names that V2 renamed go through the same `V1_ACTION` map. */
function convertV1Tools(v1) {
  const out = [];
  if (!v1 || typeof v1 !== "object" || Array.isArray(v1)) return out;
  for (const [name, enabled] of Object.entries(v1)) {
    if (typeof enabled !== "boolean") continue;
    out.push({ action: V1_ACTION[name] || name, resource: "*", effect: enabled ? "allow" : "deny" });
  }
  return out;
}

/* Merge a harness `mcp` block with a project's, by server name under
 * `mcp.servers` (the V2 location). Two plain-object server configs for the same
 * name are shallow-merged (project last, so it wins a key collision); anything
 * else (e.g. a project replacing a server) is taken from the project. Servers
 * only the harness defines are added. Any other top-level `mcp` key is preserved
 * (project wins). */
function mergeMcp(harnessMcp, priorMcp) {
  const prior =
    priorMcp && typeof priorMcp === "object" && !Array.isArray(priorMcp) ? priorMcp : {};
  const out = { ...harnessMcp };
  for (const [k, v] of Object.entries(prior)) if (k !== "servers") out[k] = v;
  const harnessServers =
    harnessMcp.servers && typeof harnessMcp.servers === "object" ? harnessMcp.servers : {};
  const priorServers = prior.servers && typeof prior.servers === "object" ? prior.servers : {};
  const servers = { ...harnessServers };
  for (const [name, server] of Object.entries(priorServers)) {
    const base = servers[name];
    const bothObjects =
      base &&
      typeof base === "object" &&
      !Array.isArray(base) &&
      server &&
      typeof server === "object" &&
      !Array.isArray(server);
    servers[name] = bothObjects ? { ...base, ...server } : server;
  }
  if (harnessMcp.servers || prior.servers || Object.keys(servers).length) out.servers = servers;
  return out;
}

/* Merge the harness `experimental` block with the project's. `todo` is
 * harness-managed: the todo-list discipline depends on the `todowrite` tool,
 * which V2 gates behind this flag (default false). Every other experimental
 * key belongs to the project and wins on a collision. */
function mergeExperimental(harnessExperimental, priorExperimental) {
  const harness =
    harnessExperimental && typeof harnessExperimental === "object" && !Array.isArray(harnessExperimental)
      ? harnessExperimental
      : {};
  const prior =
    priorExperimental && typeof priorExperimental === "object" && !Array.isArray(priorExperimental)
      ? priorExperimental
      : {};
  const out = { ...prior, ...harness };
  for (const key of Object.keys(harness)) {
    if (key !== "todo" && Object.prototype.hasOwnProperty.call(prior, key)) out[key] = prior[key];
  }
  return out;
}

/* Evaluate a `policies` list for one (action, resource) pair the way OpenCode
 * does: statements are ordered, the last matching one wins, and no match means
 * allowed. Resources use whole-value wildcards (`*` any run, `?` one char). This
 * is the deterministic oracle behind the update/doctor MCP warning — never
 * infer from a file having an `allow` somewhere, because order decides. Pure. */
function policyEffect(policies, action, resource) {
  let effect = "allow";
  const escape = (s) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const glob = (s) => "^" + escape(s).replace(/\*/g, ".*").replace(/\?/g, ".") + "$";
  for (const statement of Array.isArray(policies) ? policies : []) {
    if (!statement || statement.action !== action || typeof statement.resource !== "string") continue;
    // OpenCode: a pattern ending in " *" also matches the value without
    // arguments (`shell:git push *` covers `git push`), so try both forms.
    const patterns = [statement.resource];
    if (statement.resource.endsWith(" *")) patterns.push(statement.resource.slice(0, -2));
    if (!patterns.some((p) => new RegExp(glob(p)).test(resource))) continue;
    effect = statement.effect === "deny" ? "deny" : "allow";
  }
  return effect;
}

/* MCP servers a project configured under `mcp.servers` but whose *final* policy
 * effect is deny. The harness ships `mcp.use: *` deny; a project opts a server
 * in by appending a matching allow (last wins). After `update`, a pre-existing
 * server is therefore denied until that one-line opt-in exists, so update and
 * doctor must name it instead of letting the server vanish silently. */
function deniedMcpServers(doc) {
  if (!doc || typeof doc !== "object") return [];
  const servers =
    doc.mcp && typeof doc.mcp === "object" && doc.mcp.servers && typeof doc.mcp.servers === "object"
      ? Object.keys(doc.mcp.servers)
      : [];
  return servers.filter((name) => policyEffect(doc.policies, "mcp.use", name) === "deny");
}

// Harness-shipped npm scripts auto-wired into the target project's package.json
// scripts (merged, not clobbered). Every other script the project has is preserved.
// These gates ship with the harness, so a deploy wires them up like opencode.json.
const HARNESS_SCRIPTS = {
  backlog: "node scripts/backlog.js",
  feedback: "node scripts/feedback.js",
  ship: "node scripts/ship.js",
  finalize: "node scripts/finalize.js",
  "test:dispatch": "node scripts/qa/check-dispatch-config.js",
  "test:governance": "node scripts/qa/governance.js",
  "test:qa-plan": "node scripts/qa/check-qa-plan.js",
  "test:diagnosis": "node scripts/qa/check-diagnosis.js",
  "test:backlog": "node scripts/qa/check-backlog.js",
  "test:product": "node scripts/qa/check-product.js",
  "test:docs": "node scripts/qa/check-docs.js",
  "test:feedback": "node scripts/qa/check-feedback.js",
  "test:concurrency": "node scripts/qa/check-concurrency.js",
  "test:integrate": "node scripts/qa/check-integrate.js",
  "test:quality": "node scripts/qa/check-quality.js",
  "test:wiring": "node scripts/qa/check-test-wiring.js",
  "test:linger": "node scripts/qa/check-linger.js",
  "test:capacity": "node scripts/qa/check-capacity.js",
  "test:ci-policy": "node scripts/qa/check-ci-policy.js",
  "test:opencode-compat": "node scripts/qa/check-opencode-compat.js",
  "test:prefix": "node scripts/qa/check-prefix-stability.js",
  "audit:prefix": "node scripts/qa/prefix-audit.js",
  "ci-triage": "node scripts/qa/ci-triage.js",
  gates: "node scripts/qa/run-gates.js",
  where: "node scripts/qa/where.js",
  diff: "node scripts/qa/diff.js",
  "feature:scaffold": "node scripts/qa/feature-scaffold.js",
  report: "node scripts/agent-report.js",
  "report:cost": "node scripts/agent-report.js --cost --since=14d",
  "report:recon": "node scripts/qa/session-recon.js --since=14d",
  nightly: "node scripts/nightly.js",
  "report:nightly": "node scripts/nightly.js report",
  checkpoint: "node scripts/checkpoint.js",
  orient: "node scripts/orient.js",
  wait: "node scripts/wait-for.js",
  serve: "node scripts/serve.js",
  orchestrator: "node scripts/orchestrator.js",
  "test:orchestrator": "node --test tests/orchestrator-lib.test.js tests/orchestrator-store.test.js tests/orchestrator-cli.test.js",
  search: "bash scripts/agent-search.sh",
  ramdisk: "bash scripts/setup-tmpfs.sh up",
  "ramdisk:down": "bash scripts/setup-tmpfs.sh down",
  "wsl-tune": "bash scripts/wsl-tune.sh",
  gpu: "bash scripts/wsl-gpu.sh",
};

/* Release profiles. A handover archive may carry `profile.json` next to
 * package.json; when it does, `init` wires only the scripts it names so a
 * process-only build has no dead `ship`/`nightly` entries pointing at files it
 * does not ship. Absent file = the full harness (unchanged behaviour). */
function activeHarnessProfile() {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "profile.json"), "utf8"));
    return p && typeof p === "object" ? p : null;
  } catch {
    return null;
  }
}
function harnessScripts() {
  return filterHarnessScripts(activeHarnessProfile());
}
function filterHarnessScripts(profile) {
  if (!profile || !Array.isArray(profile.scripts)) return HARNESS_SCRIPTS;
  const allowed = new Set(profile.scripts);
  return Object.fromEntries(Object.entries(HARNESS_SCRIPTS).filter(([k]) => allowed.has(k)));
}

/* Detect a project's own indentation so a merge never reformats package.json
 * (a deploy that only normalizes whitespace still counts as a change and would
 * be swept into the `chore(harness)` auto-commit). */
function detectIndent(text) {
  const m = String(text).match(/^([ \t]+)"/m);
  return m ? m[1] : "  ";
}

// Merge harness gate scripts into the project's existing package.json, preserving
// every other script. ADD-ONLY: an existing script is never overwritten, so a
// project's deliberate customization of a gate survives re-deploys. When every
// harness script is already present this is a NO-OP (returns the byte-identical
// current text, `changed:false`) so the file is not rewritten/re-committed for
// formatting. Returns { text, hadPkg, changed, unparseable }.
function mergePackageJson(target) {
  const p = path.join(target, "package.json");
  const hadPkg = fs.existsSync(p);
  if (!hadPkg) {
    return { text: JSON.stringify({ scripts: { ...harnessScripts() } }, null, 2) + "\n", hadPkg, changed: true };
  }
  const current = fs.readFileSync(p, "utf8");
  const existing = safeJson(current, null);
  if (existing == null || typeof existing !== "object" || Array.isArray(existing)) {
    // Never clobber a package.json we cannot parse (JSONC / hand-edited).
    return { text: current, hadPkg, changed: false, unparseable: true };
  }
  const scripts = Object.assign({}, existing.scripts || {});
  let added = false;
  for (const [name, cmd] of Object.entries(harnessScripts())) {
    if (!(name in scripts)) {
      scripts[name] = cmd;
      added = true;
    }
  }
  if (!added) return { text: current, hadPkg, changed: false };
  const merged = { ...existing, scripts };
  return { text: JSON.stringify(merged, null, detectIndent(current)) + "\n", hadPkg, changed: true };
}

/* Harness local-only ignore entries: rollback artifacts, the transient board
 * lock, serve pid/log dir, and the guard telemetry log. These are LOCAL-ONLY
 * artifacts (never committed), so they are recorded in the clone-local
 * `.git/info/exclude` — NOT in the project's committed `.gitignore`.
 *
 * The harness deliberately never writes the project's `.gitignore`: an earlier
 * design merged a marked section into it, but that merge truncated every
 * project entry that followed the marker, silently un-ignoring secrets (`.env`,
 * `data/`) that the harness auto-commit then exposed/pushed (FamilyBudget
 * F-020). `.git/info/exclude` is untracked, per-clone, and never pushed, so it
 * cannot alter or expose project files. */
const HARNESS_IGNORE_MARKER = "# agent-harness (managed below)";
const HARNESS_IGNORE_ENTRIES = [
  ".harness-backup/",
  ".harness.lock/",
  ".serve/",
  ".agents/guard-events.jsonl",
];

/* Add-only merge of the harness local-only entries into the clone's
 * `.git/info/exclude`. No-op outside a git repo (nothing can commit there) and
 * when every entry is already present. Entries are prefixed with the target's
 * path within the repo, so a nested harness project (`mobile/`) gets patterns
 * that match its own tree. Never enters the deploy manifest/commit — the file
 * is not part of the project. */
function mergeGitInfoExclude(target) {
  if (!isGitRepo(target)) return;
  const rp = runGit(target, ["rev-parse", "--git-path", "info/exclude"]);
  if (!rp.ok || !rp.out) return;
  const pf = runGit(target, ["rev-parse", "--show-prefix"]);
  const prefix = pf.ok ? pf.out.replace(/\\/g, "/") : "";
  const entries = HARNESS_IGNORE_ENTRIES.map((e) => prefix + e);
  const p = path.isAbsolute(rp.out) ? rp.out : path.join(target, rp.out);
  const existing = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  const lines = existing.split(/\r?\n/);
  const missing = entries.filter((e) => !lines.includes(e));
  if (missing.length === 0) return;
  const hasMarker = lines.includes(HARNESS_IGNORE_MARKER);
  const base = existing.replace(/\s*$/, "");
  const block = (hasMarker ? [] : [HARNESS_IGNORE_MARKER]).concat(missing).join("\n");
  const out = (base ? base + "\n\n" : "") + block + "\n";
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, out, "utf8");
}

/* Harness-managed .gitattributes entries: route BACKLOG.md through the row-aware
 * merge driver (scripts/qa/merge-backlog.js) so concurrent board edits merge by
 * row ID instead of conflicting. Merged into the project's own .gitattributes,
 * preserving every project entry.
 *
 * The driver name is PER-PROJECT (`backlog-<project-slug>`), not a shared
 * `backlog`. Two harness projects can live in one git repo (e.g. a repo root +
 * a nested `mobile/` project); each carries a distinct `.gitattributes` driver
 * name and registers its own `merge.<driver>.driver`, so one project's `update`
 * can never clobber the other's driver registration. */
const GITATTRIBUTES_MARKER = "# agent-harness (managed below)";
const GITATTRIBUTES_END = "# agent-harness (managed end)";

function slugify(s) {
  const slug = String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "project";
}

function backlogDriverName(projectName) {
  return `backlog-${slugify(projectName)}`;
}

/* Remove a previously-managed block delimited by an explicit begin/end pair. New
 * files carry the end marker, so any project entry after it is preserved. A
 * legacy file (begin marker only) has its block removed to EOF — the block was
 * always appended last, so this matches the old behaviour with no data loss for
 * real files while new merges can never truncate a trailing project entry. */
function stripManagedBlock(text, beginMarker, endMarker) {
  const lines = String(text || "").split(/\r?\n/);
  const begin = lines.findIndex((l) => l === beginMarker);
  if (begin === -1) return lines;
  const end = lines.findIndex((l, i) => i > begin && l === endMarker);
  if (end === -1) return lines.slice(0, begin);
  return [...lines.slice(0, begin), ...lines.slice(end + 1)];
}

function stripGitattributesBlock(text) {
  return stripManagedBlock(text, GITATTRIBUTES_MARKER, GITATTRIBUTES_END);
}

/* Merge the canonical search-ignore set (`templates/.ignore`) into the target's
 * `.ignore` idempotently. `.ignore` is the file ripgrep/fd read (git does not),
 * so this is where the harness owns the high-cost-tree exclusions; the project's
 * committed `.gitignore` is never touched. Project entries outside the managed
 * markers are preserved and the managed block is replaced in place, so repeated
 * updates never duplicate or truncate anything. */
function isIgnoreFile(rel) {
  return relKey(rel) === ".ignore";
}

function mergeIgnoreFile(target) {
  const tmpl = path.join(TEMPLATES_DIR, ".ignore");
  const source = fs.existsSync(tmpl) ? fs.readFileSync(tmpl, "utf8") : "";
  const srcLines = source.split(/\r?\n/);
  const b = srcLines.findIndex((l) => l === GITATTRIBUTES_MARKER);
  const e = srcLines.findIndex((l, i) => i > b && l === GITATTRIBUTES_END);
  let managed = b !== -1 && e !== -1 ? srcLines.slice(b + 1, e) : srcLines.slice();
  while (managed.length && managed[managed.length - 1].trim() === "") managed.pop();
  const p = path.join(target, ".ignore");
  const existing = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  const kept = stripManagedBlock(existing, GITATTRIBUTES_MARKER, GITATTRIBUTES_END);
  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
  while (kept.length && kept[0].trim() === "") kept.shift();
  const block = [GITATTRIBUTES_MARKER, ...managed, GITATTRIBUTES_END, ""];
  const out = kept.length ? [...kept, "", ...block] : [...block];
  return out.join("\n");
}

function mergeGitattributes(target, driverName) {
  const p = path.join(target, ".gitattributes");
  const existing = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  const kept = stripGitattributesBlock(existing);
  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
  while (kept.length && kept[0].trim() === "") kept.shift();
  const managed = [
    GITATTRIBUTES_MARKER,
    "*.sh text eol=lf",
    "*.ps1 text eol=crlf",
    GITATTRIBUTES_END,
    "",
  ];
  const out = kept.length ? [...kept, "", ...managed] : [...managed];
  return out.join("\n");
}

/* ADR 0001 retired the BACKLOG.md row-aware merge driver: the board lives in
 * the external service, so there is no in-repo file to merge. Remove the
 * per-clone registration a previous harness version may have written, so a
 * stale absolute pointer (once a worktree it referenced is gone) cannot linger.
 * Best-effort: a fresh clone simply has nothing to remove. */
function unregisterBacklogMergeDriver(target, projectName) {
  if (!isGitRepo(target)) return;
  const driverName = backlogDriverName(projectName);
  runGit(target, ["config", "--unset", `merge.${driverName}.name`]);
  runGit(target, ["config", "--unset", `merge.${driverName}.driver`]);
}

// ---------------------------------------------------------------- git helpers

function runGit(target, args, opts) {
  const result = require("child_process").spawnSync("git", args, {
    cwd: target,
    encoding: "utf8",
    ...(opts && opts.timeout ? { timeout: opts.timeout } : {}),
  });
  return { ok: result.status === 0, status: result.status, out: (result.stdout || "").trim(), err: (result.stderr || "").trim() };
}

function isGitRepo(target) {
  const r = runGit(target, ["rev-parse", "--is-inside-work-tree"]);
  return r.ok;
}

/* The currently checked-out branch, or "" when detached / not a repo. */
function currentBranch(target) {
  const r = runGit(target, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!r.ok || !r.out || r.out === "HEAD") return "";
  return r.out;
}

/* The repo's canonical branch: `origin/HEAD` (set by clone) when available,
 * else `main` or `master` when one exists remotely/locally. Null when it cannot
 * be determined (e.g. a local-only repo with no remote), so a project without a
 * remote is never blocked. */
function defaultBranch(target) {
  const sym = runGit(target, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (sym.ok && sym.out) return sym.out.replace(/^origin\//, "");
  for (const name of ["main", "master"]) {
    if (runGit(target, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${name}`]).ok) return name;
    if (runGit(target, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]).ok) return name;
  }
  return null;
}

/* Cross-process deploy lock (an exclusive `.harness.lock` DIRECTORY, the same
 * atomic primitive the board lock uses). Two `update` runs against one target —
 * or an update racing a worktree push — must not interleave their read-modify-
 * write of `.harness.json` and the harness tree. The holder's pid is published
 * inside the directory; a missing/unparseable pid is treated as held (creator
 * mid-setup), and a provably-dead pid is broken. No-op outside a git repo. */
const DEPLOY_LOCK = ".harness.lock";
function pidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
async function withDeployLock(target, fn) {
  if (!isGitRepo(target)) return fn();
  const lockPath = path.join(target, DEPLOY_LOCK);
  const pidPath = path.join(lockPath, "pid");
  const deadline = Date.now() + 15000;
  let acquired = false;
  while (!acquired) {
    try {
      fs.mkdirSync(lockPath);
      acquired = true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let holder = NaN;
      try {
        holder = parseInt(fs.readFileSync(pidPath, "utf8"), 10);
      } catch {
        /* creator mid-setup — held, never stale */
      }
      if (Number.isFinite(holder) && holder > 0 && !pidAlive(holder)) {
        try {
          fs.rmSync(lockPath, { recursive: true, force: true });
        } catch {
          /* vanished — retry */
        }
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          "agent-harness: timed out waiting for the deploy lock — another update is writing this target."
        );
      }
      sleepMs(25);
    }
  }
  try {
    fs.writeFileSync(pidPath, String(process.pid));
    return await fn();
  } finally {
    try {
      fs.rmSync(lockPath, { recursive: true, force: true });
    } catch {
      /* best-effort release */
    }
  }
}

/* WSL mounts Windows drives at `/mnt/<drive>/...` (9p / virtio-fs) — file I/O,
 * especially node_modules churn, is far slower there than on the ext4
 * filesystem the WSL checkout lives on. Detect it so a deploy into a
 * Windows-mount project warns instead of silently crawling. `platform` is
 * injectable so the check is unit-testable on any host. */
function isWindowsMount(target, platform = process.platform) {
  return platform !== "win32" && /^\/mnt\/[a-z]\//i.test(String(target));
}

/* Compare HEAD to its upstream tracking branch after a best-effort fetch. Pure
 * read — never mutates. `known` is true only when a tracking branch exists and
 * the ahead/behind counts were read, so a repo without a remote is a no-op. */
function upstreamState(target) {
  const st = { upstream: "", ahead: 0, behind: 0, known: false };
  if (!isGitRepo(target)) return st;
  runGit(target, ["fetch", "--quiet", "origin"], { timeout: 10000 });
  const track = runGit(target, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (!track.ok || !track.out) return st;
  st.upstream = track.out;
  const counts = runGit(target, ["rev-list", "--left-right", "--count", `HEAD...${st.upstream}`]);
  if (!counts.ok) return st;
  const [ahead, behind] = counts.out.split(/\s+/).map((n) => parseInt(n, 10) || 0);
  st.ahead = ahead || 0;
  st.behind = behind || 0;
  st.known = true;
  return st;
}

/* Keep the target's branch current before the harness writes or commits onto it.
 * Feature work committed and pushed from its own `backlog worktree` leaves the
 * main checkout behind; if `update` then auto-commits a `chore(harness)` commit
 * on that stale base, the local branch diverges (behind AND ahead of origin) and
 * the push is rejected. A clean, strictly-behind branch is fast-forwarded so the
 * deploy lands on the current base; a diverged branch is refused so the operator
 * reconciles first (`git pull --rebase`) instead of deepening the split. Dry-run
 * only reports. Returns { blocked, notes, state, synced? }. */
function syncTargetBranch(target, dryRun) {
  const notes = [];
  const st = upstreamState(target);
  if (!st.known || st.behind === 0) return { blocked: false, notes, state: st };
  if (st.ahead > 0) {
    notes.push(
      `target branch is ${st.behind} behind and ${st.ahead} ahead of ${st.upstream} — ` +
        `refusing to write/commit onto a diverged branch; reconcile first: git pull --rebase`
    );
    return { blocked: true, notes, state: st };
  }
  if (dryRun) {
    notes.push(`would fast-forward ${st.behind} commit(s) to ${st.upstream}`);
    return { blocked: false, notes, state: st };
  }
  // A redundant local edit (working content already identical to upstream) must
  // not block the fast-forward — that silent block is what let the checkout
  // drift stale across landings. Genuine local edits are still never touched.
  const cleared = clearRedundantDirty(target, st.upstream);
  if (cleared.length) {
    notes.push(`cleared redundant local changes already in ${st.upstream}: ${cleared.join(", ")}`);
  }
  const ff = runGit(target, ["merge", "--ff-only", st.upstream]);
  if (!ff.ok) {
    notes.push(
      `target is ${st.behind} behind ${st.upstream} but could not fast-forward ` +
        `(uncommitted changes overlap) — reconcile first: git pull --rebase`
    );
    return { blocked: true, notes, state: st };
  }
  notes.push(`fast-forwarded ${st.behind} commit(s) to ${st.upstream}`);
  return { blocked: false, notes, state: st, synced: true };
}

/* Restore tracked non-board files whose working content already matches
 * `upstream` — they carry no local information, so clearing them is lossless and
 * lets the fast-forward proceed. Genuine local edits are left untouched (the
 * merge then fails and the operator reconciles). */
function clearRedundantDirty(target, upstream) {
  const status = runGit(target, ["status", "--porcelain", "--untracked-files=no"]);
  if (!status.ok || !status.out) return [];
  const cleared = [];
  for (const line of status.out.split(/\r?\n/).filter(Boolean)) {
    const p = line.slice(3).trim();
    if (!p || p === "BACKLOG.md") continue;
    const diff = runGit(target, ["diff", "--quiet", upstream, "--", p]);
    if (diff.status !== 0) continue;
    if (runGit(target, ["checkout", upstream, "--", p]).ok) cleared.push(p);
  }
  return cleared;
}

// Auto-commit ONLY the harness-owned files an update just changed, so the target
// project's next session never sees "unexplained" modified harness files. Scoped
// to this run's changed harness files (never `git add -A`) so unrelated
// uncommitted work is NEVER swept in — including work another session already
// STAGED: the diff and the commit both carry a pathspec, so pre-staged paths are
// left in the index instead of being swept into the harness commit. Memory/backup
// files are excluded (project data / rollback).
// Harness-owned paths are force-added (`-f`): target projects often gitignore
// .agents/ .opencode/ AGENTS.md (inherited from the harness's own .gitignore), and
// a plain `git add` would fail on the first ignored path and commit NOTHING.
// Returns { committed:boolean, staged:string[], skipped:string[], pushed:boolean|null, forceAdded:string[] }.
function commitHarnessChanges(target, changedRels, opts) {
  const out = { committed: false, staged: [], skipped: [], pushed: null, forceAdded: [] };
  if (!opts.commit) return out;
  if (!isGitRepo(target)) {
    out.skipped.push("not a git repo");
    return out;
  }
  // Final integrate guard: never create the commit on a stale base. The deploy
  // path fast-forwards a clean behind branch first; if origin advanced again
  // mid-deploy, refuse rather than bake in a divergent local commit.
  if (opts.checkUpstream !== false) {
    const st = upstreamState(target);
    if (st.known && st.behind > 0) {
      out.skipped.push(
        `branch is ${st.behind} behind ${st.upstream} — not committing (would diverge); ` +
          `run git pull --rebase and re-run update`
      );
      return out;
    }
  }
  if (changedRels.length === 0) {
    out.skipped.push("no harness files changed");
    return out;
  }
  const ignored = runGit(target, ["check-ignore", ...changedRels]);
  if (ignored.ok && ignored.out) {
    out.forceAdded = ignored.out.split(/\r?\n/).filter(Boolean).map(relKey);
  }
  const addR = runGit(target, ["add", "-f", "--", ...changedRels]);
  if (!addR.ok) {
    out.skipped.push("git add failed: " + firstGitErrorLine(addR.err));
    return out;
  }
  // Scope the "what changed" report AND the commit to this run's paths. A bare
  // `git diff --cached` / `git commit` operate on the WHOLE index, which is how a
  // concurrent session's pre-staged work ended up in a harness `chore` commit.
  const diffCached = runGit(target, ["diff", "--cached", "--name-only", "--", ...changedRels]);
  const staged = (diffCached.out || "").split(/\r?\n/).filter(Boolean).map(relKey);
  if (staged.length === 0) {
    out.skipped.push("no harness changes staged");
    return out;
  }
  out.staged = staged;
  const prior = opts.priorVersion ? opts.priorVersion + " -> " : "";
  const message = `chore(harness): opencode-agent-harness ${prior}${PKG.version}`;
  const commitR = runGit(target, ["commit", "-m", message, "--", ...changedRels]);
  if (!commitR.ok) {
    out.skipped.push("commit failed: " + firstGitErrorLine(commitR.err));
    return out;
  }
  out.committed = true;
  if (opts.push) {
    const hasRemote = runGit(target, ["remote"]).ok && runGit(target, ["remote"]).out;
    if (hasRemote) {
      // Harness maintenance pushes its own `chore(harness)` commit to the
      // canonical branch. Run it with --no-verify: the project's pre-push
      // battery is project-owned and may (rightly) refuse a direct main push or
      // trip a gate on a harness-only diff, which would otherwise strand the
      // harness commit unpushed. The branch guard above already keeps this off
      // any non-canonical branch.
      const pushR = runGit(target, ["push", "--no-verify", "origin", "HEAD"]);
      out.pushed = pushR.ok;
      if (!pushR.ok) out.skipped.push("push failed: " + firstGitErrorLine(pushR.err));
    } else {
      out.skipped.push("no git remote to push");
    }
  }
  return out;
}

/* Pull the first real error line out of git's stderr, dropping the LF/CRLF
 * warnings and `hint:` noise that bury the actual message. */
function firstGitErrorLine(err) {
  const line = String(err || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !/^warning:/i.test(l) && !/^hint:/i.test(l));
  return line || "git command failed";
}

/* The V1 -> V2 layout moved `.opencode/tools/*.ts` into `.opencode/plugins/`
 * and the singular `.opencode/command/` dir into `.opencode/commands/`. A deploy
 * cannot see a removed template, so without this a project keeps the stale V1
 * files — and V2 still discovers the legacy `command/` dir, so the old command
 * text would shadow the new `commands/`. Remove only the files the harness
 * itself shipped (never a project-added one), then prune the dir if empty. */
const OBSOLETE_HARNESS_FILES = [
  ".opencode/tools/backlog.ts",
  ".opencode/tools/checkpoint.ts",
  ".opencode/tools/session.ts",
  ".opencode/tools/orient.ts",
  ".opencode/tools/gates.ts",
  ".opencode/tools/wait.ts",
  ".opencode/tools/where.ts",
  ".opencode/command/board.md",
  ".opencode/command/checkpoint.md",
  ".opencode/command/feature.md",
  ".opencode/command/finish.md",
  ".opencode/command/next.md",
  ".opencode/command/report.md",
  ".opencode/command/resume.md",
  ".opencode/command/switch-model.md",
];

function pruneObsoleteHarnessFiles(target, dryRun) {
  const removed = [];
  const dirs = new Set();
  for (const rel of OBSOLETE_HARNESS_FILES) {
    const abs = path.join(target, rel);
    if (!fs.existsSync(abs)) continue;
    removed.push(relKey(rel));
    dirs.add(path.dirname(abs));
    if (!dryRun) {
      try {
        fs.unlinkSync(abs);
      } catch (_) {
        /* best-effort */
      }
    }
  }
  if (!dryRun) {
    for (const dir of dirs) {
      try {
        if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      } catch (_) {
        /* leave a dir a project still uses */
      }
    }
  }
  return removed;
}

// ---------------------------------------------------------------- deploy

function backup(target, rel, content) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(target, BACKUP_DIR, stamp, relKey(rel));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content, "utf8");
}

/* Locally-modified harness-owned files a deploy WOULD overwrite:
 * `{ rel, targetAbs, prev }`. A file counts only when its content differs from
 * the incoming template (a no-op rewrite is harmless) AND its on-disk bytes no
 * longer match the checksum recorded in `.harness.json` — i.e. the project
 * edited a harness-owned file since the last deploy. Merged files
 * (`.gitattributes`, `.ignore`, `opencode.json`, `package.json`) and
 * create-if-missing project data are excluded: those never clobber. */
/* First `init` into a repo that already has its own AGENTS.md: overwriting it
 * would destroy project instructions the harness did not create. Refuse before
 * writing anything; --accept-harness deliberately overwrites after a backup. */
function collectInitAgentsConflict(target, variables) {
  if (fs.existsSync(path.join(target, CONFIG_FILE))) return null;
  const targetAbs = path.join(target, "AGENTS.md");
  if (!fs.existsSync(targetAbs)) return null;
  const tplAbs = path.join(TEMPLATES_DIR, "AGENTS.md");
  if (!fs.existsSync(tplAbs)) return null;
  const incoming = substitute(fs.readFileSync(tplAbs, "utf8"), variables);
  return normalizeEol(fs.readFileSync(targetAbs, "utf8")) === normalizeEol(incoming)
    ? null
    : targetAbs;
}

function collectLocalHarnessDivergences(target, previousFiles, variables) {
  const divergent = [];
  for (const { abs, rel } of listFiles(TEMPLATES_DIR)) {
    const key = relKey(rel);
    if (key === ".gitattributes" || key === "package.json") continue;
    if (isIgnoreFile(rel) || isOpencodeJson(rel) || isCreateIfMissing(rel)) continue;
    const deployedHash = previousFiles[key];
    if (!deployedHash) continue; // not previously deployed: no tracked local edit
    const targetAbs = path.join(target, rel);
    if (!fs.existsSync(targetAbs)) continue;
    const prev = fs.readFileSync(targetAbs, "utf8");
    // `sha256` folds CRLF -> LF, so a git `eol=crlf` checkout whose content
    // matches the deployed template is already "unmodified" here (F-045).
    const prevHash = key === "AGENTS.md" ? sha256(harnessAgentsOwned(prev)) : sha256(prev);
    if (deployedHash === prevHash) continue; // unmodified since last deploy
    const content = substitute(fs.readFileSync(abs, "utf8"), variables);
    // An EOL-only difference is not a project hand-edit: a template is LF while
    // `.gitattributes` may check the target out CRLF. Normalize before
    // comparing; a real content edit still diverges and fails closed (F-045).
    if (normalizeEol(prev) === normalizeEol(content)) continue;
    // The root AGENTS.md carries a `next dev` block that the tool re-appends:
    // a block-only difference is not a project hand-edit (F-349).
    if (key === "AGENTS.md" && harnessAgentsComparable(prev) === harnessAgentsComparable(content)) continue;
    divergent.push({ rel: key, targetAbs, prev });
  }
  return divergent;
}

/* Run the target's own mechanical gate after an accepted overwrite. A clobber
 * that breaks the project's own suite (the F-289 board-sync regression) must not
 * be committed as a `chore(harness)` commit. Returns { ran, ok, output }. */
function runTargetQuickGate(target) {
  const pkgPath = path.join(target, "package.json");
  let scripts = {};
  try {
    scripts = JSON.parse(fs.readFileSync(pkgPath, "utf8")).scripts || {};
  } catch (_) {
    return { ran: false, ok: true, output: "" };
  }
  if (!scripts["test:quick"]) return { ran: false, ok: true, output: "" };
  const r = spawnSync("npm", ["run", "test:quick"], {
    cwd: target,
    encoding: "utf8",
    timeout: 0,
  });
  const output = String(r.stdout || "") + String(r.stderr || "");
  if (r.error || r.status == null) return { ran: false, ok: true, output };
  return { ran: true, ok: r.status === 0, output };
}

async function deploy(target, opts) {
  const { name, domain, yes, dryRun, isUpdate, commit, push, allowBranch, acceptHarness } = opts || {};
  if (isWindowsMount(target)) {
    console.warn(
      `  WARNING: target "${target}" is on a Windows drive mount (/mnt/...) — file I/O is ` +
        `much slower than the WSL ext4 filesystem. Prefer a path under ~/develop.`
    );
  }
  // The deployed harness is V2-native; warn when the machine's `opencode` is V1
  // so the mismatch is visible now instead of showing up as "no tools loaded".
  warnOpencodeVersion();
  const existing = readConfig(target);
  const projectName = name || existing.projectName || path.basename(target);
  const driverName = backlogDriverName(projectName);
  let projectDomain = domain || existing.projectDomain || "";
  if (!projectDomain && !isUpdate && !yes && process.stdin.isTTY) {
    projectDomain = await ask(`Project domain (one line) for "${projectName}": `, "");
  }
  const VARIABLES = {
    PROJECT_NAME: projectName,
    PROJECT_DOMAIN: projectDomain,
    PROJECT_DIR: path.basename(path.resolve(target)),
    WORKSPACE_ROOT: workspaceRootFor(target),
  };

  // Fail closed before writing when this checkout's own templates/ is dirty: the
  // deploy would ship unreleased work and the target could never attribute it to
  // a harness release. `--dry-run` previews, `--allow-dirty-templates` overrides
  // deliberately for harness development.
  if (isUpdate && opts.requireCleanTemplates && !dryRun) {
    const dirty =
      opts.dirtyTemplates !== undefined ? opts.dirtyTemplates : dirtyTemplateEntries();
    if (dirty.length && !opts.allowDirtyTemplates) {
      throw new Error(
        `refusing to deploy from an uncommitted templates/ tree (${dirty.length} path(s)):\n` +
          dirty.map((l) => `    ${l}`).join("\n") +
          `\n  Commit + release the harness first, then re-run update. An uncommitted template is` +
          ` deployed but never recorded in the target's \`chore(harness)\` commit, so it lands as` +
          ` project WIP and the next update can silently revert it.\n` +
          `  Override deliberately with --allow-dirty-templates.`
      );
    }
  }

  // All writes/commits run under a per-target deploy lock (a no-op outside a git
  // repo and on dry-run) so two updates can never interleave their read-modify-
  // write of .harness.json / the harness tree.
  const runDeploy = async () => {
  assertNoTemplateHandoffs();
  const existing = readConfig(target);

  // First-run guard: never clobber a project's own AGENTS.md on `init`.
  if (!isUpdate && !acceptHarness) {
    const conflict = collectInitAgentsConflict(target, VARIABLES);
    if (conflict) {
      throw new Error(
        `"${projectName}" already has an AGENTS.md that this harness did not create:\n` +
          `  ${conflict}\n` +
          `  Refusing to run \`init\` and overwrite it. Move or merge that file, run in a\n` +
          `  clean directory, or re-run with --accept-harness (the existing file is\n` +
          `  backed up under ${BACKUP_DIR}/ first).`
      );
    }
  }

  // Refuse to downgrade: the target's deployed harness is newer than this CLI.
  // This is how the "I updated from a local checkout that I never published"
  // mistake surfaces instead of silently writing older templates over a newer
  // deployment (and auto-committing that regression).
  if (isUpdate && existing.version && compareVersions(existing.version, PKG.version) > 0) {
    throw new Error(
      `"${projectName}" has harness v${existing.version} — NEWER than this CLI (v${PKG.version}). ` +
        `Not downgrading. Publish v${existing.version} (or this CLI) so \`update\` can re-sync from the registry.`
    );
  }

  // Branch guard: never auto-commit/push harness files onto a non-default
  // branch. A deploy run from a feature branch (or a main checkout a session
  // left on a chore branch) would strand the harness commit off `main` and the
  // canonical branch would silently stay stale — the LibraryOS 2026-09-18 case
  // (harness 0.1.73 landed on `origin/chore/archive-f-244`, main stuck at
  // 0.1.72). Skipped when undeterminable (no remote) or when not committing.
  let branchGuard = null;
  if (commit) {
    const cur = currentBranch(target);
    const def = defaultBranch(target);
    const hasHead = runGit(target, ["rev-parse", "--verify", "--quiet", "HEAD"]).ok;
    if (!cur && hasHead) {
      if (!allowBranch) {
        throw new Error(
          `"${projectName}" is in detached HEAD — refusing to auto-commit/push harness files. ` +
            `Check out ${def || "the canonical branch"} (git switch ${def || "main"}) and re-run, or pass --allow-branch.`
        );
      }
    } else if (def && cur !== def) {
      if (!allowBranch) {
        throw new Error(
          `"${projectName}" is on branch \`${cur}\`, not the canonical \`${def}\` — refusing to ` +
            `auto-commit/push harness files onto a non-default branch (they would be stranded off ` +
            `\`${def}\` and its harness version would stay stale). Switch to \`${def}\` ` +
            `(git switch ${def}) and re-run \`update\`, or pass --allow-branch to override.`
        );
      }
      branchGuard = { branch: cur, defaultBranch: def, overridden: true };
      console.warn(`  WARNING: deploying onto non-default branch \`${cur}\` (--allow-branch).`);
    }
  }

  // Integrate-early: bring a stale checkout current (or refuse a diverged one)
  // BEFORE any harness file is written, so the auto-commit below can never land
  // on the stale base a worktree push left behind. Skipped when this run will
  // not commit (--no-commit) and reported-only on dry-run.
  let syncResult = null;
  if (commit) {
    syncResult = syncTargetBranch(target, !!dryRun);
    for (const note of syncResult.notes) console.log(`  ${note}`);
    if (syncResult.blocked) throw new Error(`"${projectName}": ${syncResult.notes[0]}`);
  }

  const previousFiles = existing.files || {};
  const actions = [];
  const manifest = {};
  // Harness-owned files present on disk with the correct bytes ("unchanged").
  // They are not in `changedRels`, so a present-but-untracked one would never be
  // committed by this deploy (see the untracked sweep after the loop).
  const harnessOwnedPresent = [];

  // Fail closed on a locally-modified harness-owned file BEFORE writing anything.
  // A silent overwrite destroys a project-side fix to a harness file (F-289:
  // the 0.1.99 deploy clobbered scripts/qa/board-sync.js, breaking the target's
  // own suite). The operator must either upstream the fix into this harness's
  // `templates/` and release, or re-run with --accept-harness to overwrite
  // deliberately (the old bytes are still backed up).
  const divergent = collectLocalHarnessDivergences(target, previousFiles, VARIABLES);
  if (divergent.length && !acceptHarness) {
    const list = divergent.map((d) => `    - ${d.rel}`).join("\n");
    throw new Error(
      `"${projectName}" has locally-modified harness-owned file(s):\n${list}\n` +
        `  These diverge from the deployed checksum in .harness.json, so \`update\` would ` +
        `overwrite a hand-edit.\n` +
        `  Fix it upstream instead: port the change into this harness's \`templates/\` ` +
        `(a drift-guard test if it is a gate/QA script), bump + release the harness, then re-run \`update\`.\n` +
        `  To discard the local edit and take the template copy (a backup is written), re-run with --accept-harness.`
    );
  }
  // Snapshot for the post-overwrite gate rollback: if the accepted copy breaks the
  // target's own suite, restore these files and abort before committing.
  const configPath = path.join(target, CONFIG_FILE);
  const configPrev = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : null;

  // Auto-wire harness gate scripts into the target package.json (merged, add-only).
  // A no-op merge leaves the file byte-identical so its own formatting is never
  // rewritten/re-committed; an unparseable package.json is preserved untouched.
  {
    const { text, hadPkg, changed, unparseable } = mergePackageJson(target);
    const key = "package.json";
    const targetAbs = path.join(target, "package.json");
    if (unparseable) actions.push({ rel: key, kind: "preserve" });
    else if (!hadPkg) actions.push({ rel: key, kind: "create" });
    else if (changed) actions.push({ rel: key, kind: "merge" });
    else actions.push({ rel: key, kind: "unchanged" });
    manifest[key] = sha256(text);
    if (!dryRun && (changed || !hadPkg)) {
      fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
      fs.writeFileSync(targetAbs, text, "utf8");
    }
  }

  // Merge harness-managed .gitattributes (line-ending pins). ADR 0001 removed
  // the BACKLOG.md row-aware merge driver — the board lives in the service.
  {
    const text = mergeGitattributes(target, driverName);
    const key = ".gitattributes";
    const targetAbs = path.join(target, ".gitattributes");
    const had = fs.existsSync(targetAbs);
    const current = had ? fs.readFileSync(targetAbs, "utf8") : null;
    if (!had) actions.push({ rel: key, kind: "create" });
    else if (current !== text) actions.push({ rel: key, kind: "merge" });
    else actions.push({ rel: key, kind: "unchanged" });
    manifest[key] = sha256(text);
    if (!dryRun) {
      fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
      fs.writeFileSync(targetAbs, text, "utf8");
    }
  }

  // Merge the canonical search-ignore set (`.ignore`): idempotent begin/end
  // block, project entries preserved, replaced in place on every update. This is
  // the file ripgrep/fd read; the project's `.gitignore` stays project-owned.
  {
    const text = mergeIgnoreFile(target);
    const key = ".ignore";
    const targetAbs = path.join(target, ".ignore");
    const had = fs.existsSync(targetAbs);
    const current = had ? fs.readFileSync(targetAbs, "utf8") : null;
    if (!had) actions.push({ rel: key, kind: "create" });
    else if (current !== text) actions.push({ rel: key, kind: "merge" });
    else actions.push({ rel: key, kind: "unchanged" });
    manifest[key] = sha256(text);
    if (!dryRun) {
      fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
      fs.writeFileSync(targetAbs, text, "utf8");
    }
  }

  // ADR 0001: the BACKLOG.md merge driver is retired (the board is in the
  // service). Remove any stale per-clone registration so a leftover pointer
  // cannot dangle, and refresh the clone-local exclude file.
  if (!dryRun) {
    unregisterBacklogMergeDriver(target, projectName);
    mergeGitInfoExclude(target);
  }

  for (const { abs, rel } of listFiles(TEMPLATES_DIR)) {
    const key = relKey(rel);
    const targetAbs = path.join(target, rel);

    // `.ignore` is a merged file (see mergeIgnoreFile above), not a plain copy.
    if (isIgnoreFile(rel)) continue;

    if (isOpencodeJson(rel)) {
      const merged = mergeOpencodeJson(target, VARIABLES);
      const current = fs.existsSync(targetAbs) ? fs.readFileSync(targetAbs, "utf8") : null;
      if (current == null) actions.push({ rel: key, kind: "create" });
      else if (current !== merged) actions.push({ rel: key, kind: "merge" });
      else actions.push({ rel: key, kind: "unchanged" });
      manifest[key] = sha256(merged);
      if (!dryRun) {
        fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
        fs.writeFileSync(targetAbs, merged, "utf8");
      }
      // The managed `mcp.use: "*"` hard-deny removes any configured server that
      // has no later allow. Warn here as well as in `doctor`, with the exact
      // opt-in, so an update cannot silently disable a project's MCP servers.
      {
        const denied = deniedMcpServers(safeJson(merged, null));
        if (denied.length) {
          console.warn(
            `  WARNING: MCP server(s) ${denied.join(", ")} are hard-denied by the managed \`policies\`.\n` +
              `           Append ${denied
                .map((name) => `{ "action": "mcp.use", "resource": "${name}", "effect": "allow" }`)
                .join(", ")} to opencode.json to opt in.`
          );
        }
      }
      continue;
    }

    if (isCreateIfMissing(rel)) {
      // ADR 0001: a service-backed project (its `.harness.json` carries a
      // `board` block) has its board in the service, so a legacy BACKLOG.md is
      // neither scaffolded nor recreated — and a stale one is left untouched.
      if (isBacklogFile(rel) && existing.board) {
        if (fs.existsSync(targetAbs)) actions.push({ rel: key, kind: "preserve" });
        else actions.push({ rel: key, kind: "skipped (service board)" });
        continue;
      }
      if (fs.existsSync(targetAbs)) {
        actions.push({ rel: key, kind: "preserve" });
      } else {
        actions.push({ rel: key, kind: "create" });
        if (!dryRun) {
          fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
          fs.writeFileSync(targetAbs, substitute(fs.readFileSync(abs, "utf8"), VARIABLES), "utf8");
        }
      }
      continue; // project data: never tracked in the manifest
    }

    // harness-owned file
    const content = substitute(fs.readFileSync(abs, "utf8"), VARIABLES);
    if (fs.existsSync(targetAbs)) {
      const current = fs.readFileSync(targetAbs, "utf8");
      // Compare canonically so a line-ending-only difference (a CRLF `*.ps1`
      // that git checked out per `.gitattributes`) is not mistaken for a change
      // and rewritten to LF — which would leave the working tree dirty.
      // The root AGENTS.md also ignores its `next dev` marker block: rewriting
      // the file only makes `next dev` re-append it (F-349).
      const nextDevOnly =
        key === "AGENTS.md" &&
        harnessAgentsComparable(current) === harnessAgentsComparable(content);
      if (normalizeEol(current) !== normalizeEol(content) && !nextDevOnly) {
        const deployedHash = previousFiles[key];
        const currentHash = key === "AGENTS.md" ? sha256(harnessAgentsOwned(current)) : sha256(current);
        const locallyModified = !!deployedHash && deployedHash !== currentHash;
        // An untracked pre-existing harness-owned file (a first `init` into a
        // repo that already has one, or a copy without .harness.json) is backed
        // up too: an overwrite must never be the only copy of project content.
        const untrackedExisting = !deployedHash;
        const backupFirst = locallyModified || untrackedExisting;
        actions.push({ rel: key, kind: backupFirst ? "overwrite (backup)" : "overwrite" });
        if (backupFirst && !dryRun) backup(target, rel, current);
      } else {
        actions.push({ rel: key, kind: "unchanged" });
        harnessOwnedPresent.push(key);
        // Record what is actually on disk (== content), not the stale hash from a
        // prior deploy: an F-289-style local restore can have left .harness.json
        // pointing at an older template, which would falsely flag the file as
        // locally-modified on the NEXT update.
        manifest[key] = key === "AGENTS.md" ? sha256(harnessAgentsOwned(content)) : sha256(content);
        continue;
      }
    } else {
      actions.push({ rel: key, kind: "create" });
    }
    manifest[key] = key === "AGENTS.md" ? sha256(harnessAgentsOwned(content)) : sha256(content);
    if (!dryRun) {
      fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
      fs.writeFileSync(targetAbs, content, "utf8");
      // POSIX helper scripts must be runnable after a fresh deploy (the
      // auto-commit records the mode); `.sh` is pinned to LF via .gitattributes.
      if (key.endsWith(".sh")) {
        try {
          fs.chmodSync(targetAbs, 0o755);
        } catch (_) {
          /* best-effort */
        }
      }
    }
  }

  // V1 -> V2 cleanup: drop the stale `.opencode/tools/*` and legacy
  // `.opencode/command/*` files the harness used to ship (now `.opencode/plugins/`
  // and `.opencode/commands/`), so an old command cannot shadow the new one.
  for (const rel of pruneObsoleteHarnessFiles(target, dryRun)) {
    actions.push({ rel, kind: "remove-obsolete" });
  }

  // Present-but-untracked harness files. An "unchanged" file is never in
  // `changedRels`, so a deploy that left it untracked (a skipped commit, or a
  // file restored by the freshness plugin) would NEVER bring it into git — and a
  // linked worktree is a fresh checkout, so it silently misses the file. That is
  // exactly how `scripts/qa/mobile-e2e/apk-cache.js` went missing from every
  // LibraryOS worktree and disabled the APK build cache (a 7-11 min cold Gradle
  // build instead of a ~7-30 s overlay). Sweep in any untracked, non-ignored
  // harness file so the auto-commit records it. Ignored paths are left alone here
  // (the force-add below still commits them when their content actually changes).
  if (!dryRun && harnessOwnedPresent.length > 0 && isGitRepo(target)) {
    const others = runGit(target, ["ls-files", "--others", "--exclude-standard", "--", ...harnessOwnedPresent]);
    if (others.ok) {
      for (const rel of (others.out || "").split(/\r?\n/).filter(Boolean).map(relKey)) {
        actions.push({ rel, kind: "add-untracked" });
      }
    }

    // Tracked harness files whose working bytes already equal the release but are
    // still uncommitted against HEAD. A prior deploy can write them and skip them
    // in its commit (or a restore re-applies them), after which `.harness.json`
    // records the worktree hash and the drift is invisible to every later update —
    // the LibraryOS 0.3.8 case (board-service.sh, finalize.js, run-gates.js,
    // wsl-tune.sh needed a manual commit). They are "unchanged" here, so they never
    // enter changedRels on their own; absorb the ones ONLY the working tree
    // modified. A path with staged bytes of its own ("MM" — another session's
    // work) is left in the index, exactly like the untracked sweep above.
    const hasHead = runGit(target, ["rev-parse", "--verify", "--quiet", "HEAD"]).ok;
    const unstaged = runGit(target, ["diff", "--name-only", "--", ...harnessOwnedPresent]);
    if (unstaged.ok) {
      const stagedSet = new Set(
        (hasHead ? runGit(target, ["diff", "--cached", "--name-only", "--", ...harnessOwnedPresent]).out : "")
          .split(/\r?\n/)
          .filter(Boolean)
          .map(relKey)
      );
      for (const rel of (unstaged.out || "").split(/\r?\n/).filter(Boolean).map(relKey)) {
        if (stagedSet.has(rel)) continue; // staged bytes belong to someone else's index state
        actions.push({ rel, kind: "adopt" });
      }
    }
  }

  // Nothing-to-update detection: an update that made no effective change to any
  // harness-owned file and was already running this exact version is a no-op —
  // report it clearly instead of printing a zero-delta "Updated", and leave the
  // target byte-for-byte untouched (no .harness.json timestamp churn, no commit).
  const changedRelsAll = actions
    .filter((a) => ["create", "overwrite", "overwrite (backup)", "merge", "add-untracked", "adopt", "remove-obsolete"].includes(a.kind))
    .map((a) => a.rel);
  const nothingToUpdate =
    !!isUpdate && changedRelsAll.length === 0 && compareVersions(existing.version || "0", PKG.version) === 0;

  const config = {
    ...existing,
    version: PKG.version,
    projectName,
    projectDomain,
    initializedAt: existing.initializedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    files: manifest,
  };
  if (!dryRun && !nothingToUpdate) {
    fs.writeFileSync(path.join(target, CONFIG_FILE), JSON.stringify(config, null, 2) + "\n", "utf8");
  }

  // Hardening for an accepted overwrite: a clobber that breaks the target's own
  // suite must never be committed. Run the target's mechanical gate BEFORE the
  // harness auto-commit; on red, restore the clobbered bytes + .harness.json and
  // abort, leaving the working tree holding the project's own content.
  if (divergent.length && acceptHarness && !dryRun && commit && !nothingToUpdate) {
    const gate = runTargetQuickGate(target);
    if (gate.ran && !gate.ok) {
      for (const d of divergent) fs.writeFileSync(d.targetAbs, d.prev, "utf8");
      if (configPrev != null) fs.writeFileSync(configPath, configPrev, "utf8");
      else if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
      const tail = gate.output.split(/\r?\n/).slice(-25).join("\n");
      throw new Error(
        `"${projectName}" failed \`npm run test:quick\` after accepting the overwrite of locally-modified ` +
          `harness file(s): ${divergent.map((d) => d.rel).join(", ")}. The clobber was rolled back and the ` +
          `harness commit aborted — upstream the local fix into templates/ instead.\n${tail}`
      );
    }
  }

  // Auto-commit the files this run created/changed so nothing the harness
  // deploys is left untracked. Runs for both `init` and `update`. Excludes only
  // rollback artifacts; freshly-scaffolded project-data files (memory/features/
  // BACKLOG) are committed so they start tracked, while pre-existing project
  // data is never touched (a "preserve" never enters `changedRelsAll`).
  let commitResult = null;
  const shouldCommit = !dryRun && (!isUpdate || !nothingToUpdate);
  if (shouldCommit) {
    const changedRels = changedRelsAll.filter((r) => !r.startsWith(".harness-backup/"));
    changedRels.push(CONFIG_FILE); // .harness.json reflects the new deployed version
    commitResult = commitHarnessChanges(target, changedRels, {
      commit,
      push,
      priorVersion: existing.version || null,
    });
  }

  return {
    projectName,
    projectDomain,
    actions,
    dryRun: !!dryRun,
    commitResult,
    syncResult,
    branchGuard,
    isUpdate: !!isUpdate,
    nothingToUpdate,
    priorVersion: existing.version || null,
  };
  };

  // A dry-run must write nothing — not even the lock dir.
  return dryRun ? runDeploy() : withDeployLock(target, runDeploy);
}

function summarize(actions) {
  const counts = {};
  for (const a of actions) counts[a.kind] = (counts[a.kind] || 0) + 1;
  return counts;
}

function printSummary(result, isUpdate) {
  const { projectName, actions, dryRun } = result;

  if (isUpdate && result.nothingToUpdate) {
    console.log(
      `\n[Nothing-to-Update] agent-harness v${PKG.version}: "${projectName}" is already at ` +
        `v${result.priorVersion || PKG.version} and no harness-owned file changed.`
    );
    return;
  }

  const verb = isUpdate
    ? (dryRun ? "Would update" : "Updated")
    : (dryRun ? "Would initialize" : "Initialized");
  console.log(`\nagent-harness v${PKG.version} ${verb.toLowerCase()} "${projectName}"` + (dryRun ? " (dry run)" : ""));
  if (isUpdate && result.priorVersion && result.priorVersion !== PKG.version) {
    console.log(`  harness: v${result.priorVersion} -> v${PKG.version}`);
  }
  for (const a of actions) console.log(`  [${a.kind}] ${a.rel}`);
  const counts = summarize(actions);
  console.log(
    `\n  ${counts.create || 0} created, ${counts.overwrite || 0} overwritten, ` +
      `${counts["overwrite (backup)"] || 0} backed up (locally modified), ` +
      `${counts.merge || 0} merged, ${counts.adopt || 0} adopted (uncommitted drift), ` +
      `${counts["remove-obsolete"] || 0} removed (obsolete), ` +
      `${counts.preserve || 0} preserved, ${counts.unchanged || 0} unchanged.`
  );
}

/* Best-effort warning: when this CLI's version is not the latest published on
 * the registry, flag it. This catches the "bumped + ran update from a local
 * checkout, but never published" silent gap. Publish guidance stays inline so a
 * failed `npm publish` (401/404 auth/permission) never leaves the developer
 * staring at a raw npm error — it points them at `npm login`. */
function printUnpublishedWarning() {
  // The authoritative workflow (AGENTS.md) deploys from a local git checkout of
  // this repo, where being ahead of the registry is expected and publishing is
  // optional — warning there is noise (and costs a blocking `npm view`). Only an
  // installed (npm/npx) copy is expected to match the latest published version.
  try {
    if (fs.existsSync(path.join(__dirname, "..", ".git"))) return;
  } catch (_) {
    /* treat as installed */
  }
  const published = publishedLatestVersion();
  if (published == null || published === "" || published === PKG.version) return;
  const cmp = compareVersions(PKG.version, published);
  if (cmp <= 0) return;
  console.log(
    `\n  WARNING: this CLI is v${PKG.version}, but the latest version published on ` +
      `npm is v${published}. If you ran this from a local checkout, the changes were ` +
      `NOT published — Publish first, then \`update\` other projects, or they will ` +
      `branch off an older harness.`
  );
  console.log(
    `    To publish: run \`npm publish\` from the harness repo. If it fails with ` +
      `E401/E404 (auth or permission), you are not logged in as the package owner ` +
      `(\`npm owner ls ${PKG.name}\` shows who owns it) — run \`npm login\` first, ` +
      `then publish again. Login: https://www.npmjs.com/login`
  );
}

function printNextSteps() {
  console.log("  Next steps:");
  console.log("   1. Fill in `.agents/memory/domain-map.md`, `.agents/memory/stack-versions.md`,");
  console.log("      `.agents/memory/product-principles.md` (actors, product concepts, UX");
  console.log("      heuristics — the planner reads this to lead planning product-first),");
  console.log("      `.agents/memory/flow-map.md` (register cross-surface flows so");
  console.log("      test:qa-plan enforces their sibling-surface/variant closure), and");
  console.log("      `.agents/memory/environments.md` (the dev/uat/prod registry — URLs, DB");
  console.log("      env vars, deploy + seed commands; the DoD deploy-to-UAT step reads it).");
  console.log("   2. Harness gate scripts (`test:dispatch`, `test:governance`, `test:qa-plan`,");
  console.log("      `test:backlog`, `test:product`, `test:docs`, `test:quality`, `test:wiring`,");
  console.log("      `test:linger`, `test:capacity`, `test:prefix`) were auto-wired into package.json \"scripts\".");
  console.log("   3. Capture found items as one light row in the canonical `BACKLOG.md` (repo root);");
  console.log("      dispatch the `features` persona to author the per-feature doc chain when one is picked up.");
  console.log("   4. The CI/CD release scaffold was seeded create-if-missing:");
  console.log("      `.github/workflows/{ci,deploy-uat,uat-health}.yml`,");
  console.log("      `.husky/pre-push`, `.vercelignore`, `docs/ci-cd-pipeline.md`. A feature");
  console.log("      lands by a direct fast-forward push to main; CI gates the landed SHA and");
  console.log("      the deploy runs after CI. Fill the repository secrets/variables it names");
  console.log("      and run `agent-harness doctor` to confirm the ship -> land -> CI cycle is ready.");
  console.log("   5. Restart your agent CLI (config is read once at startup).\n");
}

function printUsage() {
  console.log(
    `agent-harness v${PKG.version}\n\n` +
      `Usage:\n` +
      `  agent-harness init   [--target <dir>] [--name <project>] [--domain <desc>] [--yes] [--dry-run] [--commit] [--push]\n` +
      `  agent-harness update [--target <dir>] [--dry-run] [--allow-dirty-templates] [--no-push] [--accept-harness]\n` +
      `  agent-harness migrate-backlog [--target <dir>]\n` +
      `\n` +
      `  init writes files but does NOT commit or push by default: pass --commit to\n` +
      `  commit the harness files it creates/changes, and --push to also push. update\n` +
      `  auto-commits (chore(harness): ...) and pushes by default. A real deploy\n` +
      `  refuses --no-commit (preview with --dry-run) and an uncommitted templates/\n` +
      `  tree (--allow-dirty-templates for harness development only), so a release\n` +
      `  can never land downstream as untracked project WIP. Your unrelated\n` +
      `  uncommitted work is never staged. The\n` +
      `  target must be on its canonical\n` +
      `  branch (origin/HEAD, else main/master) or the commit is refused, so a\n` +
      `  harness update can never be stranded off main — pass --allow-branch to\n` +
      `  override deliberately. A locally-modified harness-owned file makes\n` +
      `  update FAIL CLOSED (port the fix into templates/ instead); pass\n` +
      `  --accept-harness to overwrite it deliberately (a backup is kept, and the\n` +
      `  target's test:quick must stay green or the clobber is rolled back).\n` +
      `\n` +
      `  migrate-backlog consolidates any live \`.agents/features/INDEX.md\` F-rows and\n` +
      `  \`.agents/memory/todo.md\` into the canonical BACKLOG.md, then rewrites those\n` +
      `  files as pointers. Idempotent: re-running never duplicates rows or deletes a\n` +
      `  source before BACKLOG.md is written and verified.\n` +
      `\n` +
      `  run chains bounded orchestration contexts for end-to-end delivery: it runs\n` +
      `  the next-item workflow, then relaunches a fresh opencode session that resumes\n` +
      `  from the checkpoint whenever a phase ends before the feature is landed. A\n` +
      `  resumed phase whose checkpoint shows implementation complete goes straight to\n` +
      `  \`npm run finalize -- --feature <id>\` (one call: archive + commit + ship, and\n` +
      `  ship lands the branch on main and confirms green CI). It stops on landed\n` +
      `  (archived / shipped outcome), the phase cap, an empty queue, or a failed phase\n` +
      `  that did not land. --dry-run prints the phase plan.\n` +
      `\n` +
      `  agent-harness list\n` +
      `  agent-harness doctor [--target <dir>]   # readiness of the ship/deploy cycle\n` +
      `  agent-harness install-global [--dry-run] [--force] [--dir <dir>]\n` +
      `                     # link contrib/global-plugins/* into ~/.config/opencode/plugins/\n` +
      `                     # (machine-level, version-independent harness checks; restart opencode)\n` +
      `  agent-harness install-nightly [--target <dir>] [--time HH:MM] [--force] [--dry-run]\n` +
      `                     # install the off-hours E2E cycle as a systemd --user timer\n` +
      `                     # (scripts/setup-nightly.sh; Persistent=true, linger enabled)\n` +
      `  agent-harness dogfood [--target <dir>] [--remove] [--dry-run]\n` +
      `                     # let the harness SOURCE checkout run its own guard/tools:\n` +
      `                     # symlinks templates/ into the repo root; restart opencode\n` +
      `  agent-harness explain <gate>            # what a gate enforces + how to satisfy/waive it\n` +
      `  agent-harness run [--target <dir>] [--feature <id>] [--prompt <text>]\n` +
      `                     [--max-phases <n>] [--max-context-resets <n>] [--opencode <path>] [--dry-run] [--feedback]\n` +
      `  agent-harness --version | -v\n` +
      `  agent-harness --help | -h\n`
  );
}

function printPersonas(templatesDir) {
  const agents = path.join(templatesDir, ".opencode", "agents");
  console.log("Personas (model routing):\n");
  for (const f of fs.readdirSync(agents).sort()) {
    const src = fs.readFileSync(path.join(agents, f), "utf8");
    const model = (src.match(/^model:\s*(.+)$/m) || [])[1] || "?";
    console.log(`  ${f.replace(/\.md$/, "").padEnd(22)} -> ${model}`);
  }
}

// ---------------------------------------------------------------- explain

/* `explain <gate>` — print the matching section of `templates/docs/gates.md`.
 * Deterministic (no LLM): agents read the contract instead of reverse-
 * engineering the check script (the 2026-09 recon: backlog.js read 45x,
 * check-qa-plan.js 16x). Returns the section body, or null when not found. */
function explainSection(name) {
  const key = String(name || "").replace(/^npm\s+run\s+/, "").trim();
  const doc = path.join(TEMPLATES_DIR, "docs", "gates.md");
  if (!fs.existsSync(doc)) return null;
  const lines = fs.readFileSync(doc, "utf8").split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+`([^`]+)`/);
    if (m && m[1] === key) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

function explain(name) {
  const section = explainSection(name);
  if (!section) {
    console.error(`No gate named "${name}". Run \`agent-harness explain --list\` to see the gates.`);
    process.exitCode = 1;
    return;
  }
  console.log(section);
}

function explainList() {
  const doc = path.join(TEMPLATES_DIR, "docs", "gates.md");
  if (!fs.existsSync(doc)) return;
  for (const line of fs.readFileSync(doc, "utf8").split(/\r?\n/)) {
    const m = line.match(/^##\s+`([^`]+)`/);
    if (m) console.log(`  ${m[1]}`);
  }
}

// ---------------------------------------------------------------- doctor

/* Read the `name:` of each workflow file under `.github/workflows` (best-effort). */
function workflowNamesIn(target) {
  const dir = path.join(target, ".github", "workflows");
  const names = [];
  if (!fs.existsSync(dir)) return names;
  for (const file of fs.readdirSync(dir)) {
    if (!/\.ya?ml$/i.test(file)) continue;
    try {
      const src = fs.readFileSync(path.join(dir, file), "utf8");
      const m = src.match(/^name:\s*(.+)$/m);
      names.push({ file, name: m ? m[1].trim().replace(/^["']|["']$/g, "") : file });
    } catch (_) {
      names.push({ file, name: file });
    }
  }
  return names;
}

/* CI budget (advisory): estimate this repo's GitHub Actions burn from `gh` and
 * compare it to the plan's included minutes (or `.harness.json` `ciBudget`). The
 * estimate is a FLOOR (one Linux minute per completed run) so it never
 * under-reports; when usage cannot be read the honest state is `unknown`, never
 * `ok`. Never fails the doctor — the operator acts on it. See ci-usage-lib.js. */
function ciBudgetLines(target) {
  const dir = path.join(target, ".github", "workflows");
  if (!fs.existsSync(dir)) return [];
  const cfg = safeJson(fs.readFileSync(path.join(target, ".harness.json"), "utf8"), null);
  const budgetCfg = (cfg && cfg.ciBudget) || {};
  if (budgetCfg.enabled === false) return [{ level: "ok", label: "ci budget", detail: "disabled in .harness.json" }];
  const { ghJson, has } = require(path.join(TEMPLATES_DIR, "scripts", "qa", "ci-wait-lib.js"));
  if (!has("gh")) {
    return [
      {
        level: "ok",
        label: "ci budget",
        detail: "unknown — `gh` unavailable, so Actions usage cannot be read (never assumed healthy)",
      },
    ];
  }
  const res = ghJson(target, ["run", "list", "--limit", "100", "--json", "databaseId,conclusion,createdAt,name"]);
  if (!res.ok) return [{ level: "ok", label: "ci budget", detail: `unknown — ${res.error}` }];
  const usage = require(path.join(TEMPLATES_DIR, "scripts", "qa", "ci-usage-lib.js"));
  const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const runs = (res.data || []).filter((r) => Date.parse(r.createdAt || "") >= since);
  const est = usage.estimateUsage(runs);
  const state = usage.budgetState(est, {
    allowanceMinutes: Number(budgetCfg.includedMinutes) || undefined,
    warnAtPct: Number(budgetCfg.warnAtPct) || undefined,
  });
  const level = state.status === "fail" ? "fail" : state.status === "warn" ? "warn" : "ok";
  const limit = Number(budgetCfg.spendingLimitUsd);
  const spendNote = Number.isFinite(limit) && limit > 0 ? ` · spending limit $${limit}` : "";
  const spentNote = state.status !== "unknown" && state.remainingMinutes === 0 ? " — quota spent: workflows will bill or block" : "";
  const out = [
    {
      level,
      label: "ci budget",
      detail:
        `${state.status} — ~${state.minutes} of ${state.allowanceMinutes} included min (${state.pct}%), ` +
        `~$${Number(est.usd).toFixed(2)} floor over ${runs.length} run(s)/30d${spendNote}${spentNote}`,
    },
  ];
  if (state.status === "fail") {
    out.push({
      level: "warn",
      label: "ci budget",
      detail: "over the included allowance — trim scheduled jobs / expensive runners (`npm run test:ci-policy`) and set a spending limit",
    });
  }
  return out;
}

/* Run a binary and capture its version banner (or other probe output). */
function whichBin(cmd, args) {
  const r = spawnSync(cmd, args || ["--version"], { encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

/* Parse the `opencode --version` banner ("opencode v2.0.29" / "2.0.29"). */
function parseOpencodeVersion(out) {
  const m = String(out || "").match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null;
}

/* Judge a version banner against the harness's V2 floor. The harness is
 * OpenCode V2-only (V1 plugin implementations do not run), so a machine still on
 * V1 silently loads no plugins while everything else reports "ok". Pure so both
 * `doctor` and the unit tests can call it without a real binary. */
function checkOpencodeVersion(out) {
  const v = parseOpencodeVersion(out);
  if (!v) {
    return {
      level: "warn",
      label: "opencode",
      detail: `unrecognized version "${String(out || "").trim() || "(empty)"}" — cannot verify the runtime`,
    };
  }
  const shown = `v${v.major}.${v.minor}.${v.patch}`;
  if (v.major < 2) {
    return {
      level: "fail",
      label: "opencode",
      detail: `${shown} — the harness requires OpenCode V2 (>= 2.0.0); V1 does not load V2 plugins`,
    };
  }
  return { level: "ok", label: "opencode", detail: shown };
}

/* Warn (never fail) at deploy time when the local `opencode` is V1 — a deploy
 * target on V1 would get the V2-native harness and silently load no plugins.
 * Cached: one probe per process, since `deploy` runs many times in the suite. */
let opencodeVersionCache = null;
function warnOpencodeVersion() {
  if (opencodeVersionCache === null) {
    const oc = whichBin("opencode", ["--version"]);
    opencodeVersionCache = oc.ok ? checkOpencodeVersion(oc.out) : { level: "ok" };
  }
  if (opencodeVersionCache.level === "fail") {
    console.warn(
      `  WARNING: ${opencodeVersionCache.detail}. Install OpenCode V2 before starting a ` +
        "session in this target (`opencode upgrade`)."
    );
  }
}

/* ------------------------------------------------------- runtime activation
 * `update` writes files, but a running opencode keeps the OLD plugins/config
 * until it restarts — so a "successful" deploy can be completely inert
 * (F-19/H-44). These helpers compare the live opencode processes for a target
 * against the last harness write (`.harness.json` mtime) and name the exact pid
 * + version to restart into. Never auto-restarts while a session is live. */

/* Pure: which of `procs` ({pid, startedAt}) started before the last harness
 * write. Exported for a fixture unit test. */
function staleProcs(procs, wroteAtMs) {
  if (!wroteAtMs) return [];
  return (procs || []).filter((p) => Number(p.startedAt) < Number(wroteAtMs));
}

/* Pure: the fail-loud warning naming the stale pids + the version to load. */
function formatStaleRuntime(stale, wroteAtMs, version) {
  if (!stale || !stale.length) return null;
  const v = version ? `v${version}` : "the deployed harness";
  return (
    `opencode (pid ${stale.map((p) => p.pid).join(", ")}) started before the last harness write ` +
    `${new Date(Number(wroteAtMs)).toISOString()} — restart opencode to load ${v} ` +
    `(a deploy is inert until then).`
  );
}

/* The last time this target's harness was written (the deploy's `.harness.json`). */
function harnessWriteTime(target) {
  try {
    return fs.statSync(path.join(target, CONFIG_FILE)).mtimeMs;
  } catch {
    return null;
  }
}

/* Live opencode processes whose working tree is `target`. Best-effort via Linux
 * `/proc`; [] when ps/proc is unavailable (macOS/CI). */
function opencodeProcsFor(target) {
  const want = path.resolve(target);
  let out = "";
  try {
    const r = spawnSync("ps", ["-eo", "pid=,etimes=,args="], { encoding: "utf8" });
    if (r.status !== 0) return [];
    out = String(r.stdout || "");
  } catch (_) {
    return [];
  }
  const now = Date.now();
  const procs = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const etimes = Number(m[2]);
    const args = m[3];
    if (!/(^|[\/\s])opencode(\s|$)/.test(args)) continue;
    if (/--version|--help/.test(args)) continue;
    let cwd = null;
    try {
      cwd = fs.readlinkSync("/proc/" + pid + "/cwd");
    } catch (_) {
      cwd = null;
    }
    if (cwd) {
      if (path.resolve(cwd) !== want) continue;
    } else if (!args.includes(want)) {
      continue;
    }
    procs.push({ pid, startedAt: now - etimes * 1000, args });
  }
  return procs;
}

/* A warning string when a live opencode for `target` predates the last harness
 * write, else null. */
function staleRuntimeWarning(target) {
  const wrote = harnessWriteTime(target);
  if (!wrote) return null;
  const cfg = readConfig(target);
  return formatStaleRuntime(staleProcs(opencodeProcsFor(target), wrote), wrote, cfg && cfg.version);
}

/* `doctor` — a deterministic (no-LLM) readiness report for the self-contained
 * agent release cycle. It answers, before a session starts, whether the pieces
 * `ship` depends on actually exist: gh + auth, the CI/deploy workflows, the
 * pre-push gate, the Vercel link, and the local-only ignores. Missing
 * infrastructure is a `warn` (a project may not use that tier yet); missing
 * prerequisites for the cycle the harness promises are `fail`. */

function doctor(target) {
  const results = [];
  const add = (level, label, detail) => results.push({ level, label, detail });

  if (!isGitRepo(target)) {
    add("fail", "git repository", "not a git repo — run this in a project checkout");
    return reportDoctor(results);
  }
  const git = whichBin("git");
  add(git.ok ? "ok" : "fail", "git", git.ok ? git.out : "git not on PATH");

  const config = readConfig(target);
  add(
    config.version ? "ok" : "warn",
    "harness deployed",
    config.version ? `v${config.version} (${config.projectName || "?"})` : "no .harness.json — run `agent-harness init`"
  );

  // "Is my harness stale?" — compare the deployed version with the newest
  // harness this CLI can see: its own version (a local checkout may lead the
  // registry) and the registry's latest (F-023). Best-effort: an unreachable
  // registry is not a failure, it only makes the answer unknowable.
  if (config.version) {
    const published = publishedLatestVersion();
    const newest = published && compareVersions(published, PKG.version) > 0 ? published : PKG.version;
    if (compareVersions(config.version, newest) < 0) {
      add(
        "warn",
        "harness update",
        `v${config.version} -> v${newest} available — run: npx ${PKG.name}@latest update (then restart opencode)`
      );
    } else {
      add("ok", "harness update", `v${config.version} is current`);
    }

    // One truthful update-state report (F-045): deployed, what the probe knows,
    // the last evaluation, its cause, and the exact next command. These are the
    // same `.serve` files the footer badge reads, so `doctor` and the TUI cannot
    // tell different stories.
    const readServe = (name) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(target, ".serve", name), "utf8"));
      } catch {
        return null;
      }
    };
    const probe = readServe("harness-update.json");
    const probeLatest = typeof probe?.latest === "string" ? probe.latest : null;
    const probeAt = typeof probe?.checkedAt === "string" ? probe.checkedAt : "never";
    const sources = ["npm", "local", "checkout"]
      .map((k) => (typeof probe?.[k] === "string" ? `${k} ${probe[k]}` : null))
      .filter(Boolean)
      .join(", ");
    add(
      probeLatest ? "ok" : "warn",
      "update probe",
      probeLatest
        ? `latest v${probeLatest} (checked ${probeAt}${sources ? `; ${sources}` : ""})`
        : "no cached probe — run: node scripts/harness-update.js refresh"
    );

    const verdict = readServe("harness-freshness.json");
    const verdictStatus =
      verdict && (!verdict.have || verdict.have === config.version) && typeof verdict.status === "string"
        ? verdict.status
        : "none";
    const cause =
      verdictStatus === "blocked"
        ? ` — ${String(verdict.detail || "").split(/\r?\n/)[0] || verdict.reason || "update blocked"}`
        : "";
    const next =
      verdictStatus === "blocked"
        ? `next: npx ${PKG.name}@latest update`
        : verdictStatus === "restart-needed"
          ? "next: restart the opencode service"
          : "next: none";
    add(
      verdictStatus === "blocked" ? "warn" : "ok",
      "freshness verdict",
      verdictStatus === "none" ? "no verdict recorded (not evaluated yet)" : `${verdictStatus}${cause}; ${next}`
    );

    // A stale global plugin is the one failure a project cannot self-heal: the
    // applier would run old logic forever. Verify the symlink names this build.
    const bundledPlugin = path.join(GLOBAL_PLUGINS_SRC, "harness-freshness.ts");
    const installedPlugin = path.join(opencodeGlobalPluginsDir(), "harness-freshness.ts");
    let installedTarget = null;
    try {
      installedTarget = fs.realpathSync(installedPlugin);
    } catch {
      installedTarget = null;
    }
    const pluginCurrent =
      installedTarget !== null && path.resolve(installedTarget) === path.resolve(bundledPlugin);
    add(
      pluginCurrent ? "ok" : "warn",
      "global plugin",
      pluginCurrent
        ? `harness-freshness.ts -> ${bundledPlugin}`
        : installedTarget
          ? `stale link -> ${installedTarget} — run: agent-harness install-global --force`
          : "not installed — run: agent-harness install-global"
    );
  }

  // The harness is OpenCode V2-only: on a V1 runtime every plugin/tool this
  // deploy writes is silently inert. Assert the floor rather than assume it.
  const opencode = whichBin("opencode", ["--version"]);
  if (!opencode.ok) {
    add("ok", "opencode", "not on PATH — runtime version unverified (fine in CI)");
  } else {
    const v = checkOpencodeVersion(opencode.out);
    add(v.level, v.label, v.detail);
  }

  // deploy != activate: a live opencode started before the last harness write
  // keeps the old plugins/config (F-19/H-44). Name the pid + version to restart.
  const staleRuntime = staleRuntimeWarning(target);
  add(
    staleRuntime ? "warn" : "ok",
    "runtime activation",
    staleRuntime || "no live opencode predates the last harness write"
  );

  const remote = runGit(target, ["remote", "get-url", "origin"]);
  add(remote.ok ? "ok" : "warn", "git remote", remote.ok ? remote.out : "no origin remote");

  const branch = currentBranch(target);
  const def = defaultBranch(target);
  add(
    branch && (!def || branch === def) ? "ok" : "warn",
    "canonical branch",
    branch ? `${branch}${def && branch !== def ? ` (canonical is ${def})` : ""}` : "detached HEAD"
  );

  // A checkout behind its upstream holds a stale BACKLOG.md (a row archived on
  // origin still shows Open locally) — the shape that let a mutation resurrect a
  // shipped row. Surface it so it is fixed before a session trusts the board.
  const ust = upstreamState(target);
  if (ust.known && ust.behind > 0) {
    add(
      "warn",
      "board sync",
      `checkout is ${ust.behind} behind ${ust.upstream} — the board may be stale; run: node scripts/backlog.js sync`
    );
  } else if (ust.known) {
    add("ok", "board sync", `level with ${ust.upstream}`);
  } else {
    add("ok", "board sync", "no upstream tracking branch (offline / no remote)");
  }

  const workflows = workflowNamesIn(target);
  const ci = workflows.find((w) => /^ci$/i.test(w.name));
  const deploy = workflows.find((w) => /deploy/i.test(w.name));
  add(ci ? "ok" : "warn", "CI workflow", ci ? ci.file : "none — a landing's green CI is never confirmed");
  add(deploy ? "ok" : "warn", "deploy workflow", deploy ? deploy.file : "none — landed changes will not deploy");

  const gh = whichBin("gh", ["--version"]);
  if (!gh.ok) {
    add("fail", "gh CLI", "not on PATH — `ship` cannot confirm CI after landing");
  } else {
    const auth = whichBin("gh", ["auth", "status"]);
    add(auth.ok ? "ok" : "warn", "gh auth", auth.ok ? "authenticated" : "not authenticated (`gh auth login`)");
  }

  const hooksPath = runGit(target, ["config", "core.hooksPath"]);
  const hookFile = runGit(target, ["rev-parse", "--git-path", "hooks/pre-push"]);
  const hookAbs = hookFile.ok ? path.resolve(target, hookFile.out) : "";
  const hasPrePush =
    fs.existsSync(path.join(target, ".husky", "_", "pre-push")) ||
    fs.existsSync(path.join(target, ".husky", "pre-push")) ||
    (hookAbs && fs.existsSync(hookAbs));
  add(
    hasPrePush ? "ok" : "warn",
    "pre-push gate",
    hasPrePush ? (hooksPath.out || hookAbs) : "not installed — project test gates run only in CI"
  );

  add(fs.existsSync(path.join(target, ".vercelignore")) ? "ok" : "warn", ".vercelignore", fs.existsSync(path.join(target, ".vercelignore")) ? "present" : "missing — worktree deploys can fail (ENOTDIR pruned/generated)");
  add(
    fs.existsSync(path.join(target, ".vercel", "project.json")) ? "ok" : "warn",
    "Vercel link",
    fs.existsSync(path.join(target, ".vercel", "project.json")) ? ".vercel/project.json present" : "not linked in this checkout (CI links from secrets)"
  );

  if (config.shipCiWorkflow) add("ok", "CI workflow (ship)", String(config.shipCiWorkflow));
  add(
    fs.existsSync(path.join(target, "scripts", "finalize.js")) ? "ok" : "warn",
    "finalize command",
    fs.existsSync(path.join(target, "scripts", "finalize.js"))
      ? "`npm run finalize` available (archive + commit + land + confirm CI)"
      : "missing — re-run `agent-harness update` to deploy scripts/finalize.js"
  );

  // Session-orientation + bounded-wait tooling (harness-shipped): `orient` collapses
  // the resume/claim prologue (measured avg 24 calls before real work), `wait-for`
  // replaces hand-rolled polling, and `docs/gates.md` documents each gate.
  add(
    fs.existsSync(path.join(target, "scripts", "orient.js")) ? "ok" : "warn",
    "orient",
    fs.existsSync(path.join(target, "scripts", "orient.js"))
      ? "one-call orientation available (`node scripts/orient.js`)"
      : "missing — re-run `agent-harness update`"
  );
  add(
    fs.existsSync(path.join(target, "scripts", "wait-for.js")) ? "ok" : "warn",
    "wait",
    fs.existsSync(path.join(target, "scripts", "wait-for.js"))
      ? "bounded waiter available (`npm run wait -- --health <url>`)"
      : "missing — re-run `agent-harness update`"
  );
  add(
    fs.existsSync(path.join(target, ".opencode", "plugins", "job-notify.ts")) ? "ok" : "warn",
    "job-notify plugin",
    fs.existsSync(path.join(target, ".opencode", "plugins", "job-notify.ts"))
      ? "detached device runs push progress/completion"
      : "missing — mobile E2E progress will not be pushed"
  );
  add(
    fs.existsSync(path.join(target, "docs", "gates.md")) ? "ok" : "warn",
    "gate reference",
    fs.existsSync(path.join(target, "docs", "gates.md"))
      ? "docs/gates.md present (`agent-harness explain <gate>`)"
      : "missing — re-run `agent-harness update`"
  );
  add(
    fs.existsSync(path.join(target, "scripts", "qa", "check-diagnosis.js")) ? "ok" : "warn",
    "diagnosis gate",
    fs.existsSync(path.join(target, "scripts", "qa", "check-diagnosis.js"))
      ? "inquiry loop available (`npm run test:diagnosis`, warn mode AGENT_HARNESS_DIAGNOSIS=warn)"
      : "missing — re-run `agent-harness update`"
  );

  // Persona dispatch activation (F-025): a deployed persona is inert unless its
  // paired skill exists, its model pin is present, and the dispatch tooling is
  // deployed. Advisory only — a project may deliberately hand-build its agents.
  {
    const agentsDir = path.join(target, ".opencode", "agents");
    const skillsDir = path.join(target, ".agents", "skills");
    const namesIn = (dir, keep) => {
      try {
        return fs.readdirSync(dir).filter(keep).sort();
      } catch {
        return [];
      }
    };
    const agents = namesIn(agentsDir, (n) => n.endsWith(".md")).map((n) => n.slice(0, -3));
    const skills = namesIn(skillsDir, (n) => fs.existsSync(path.join(skillsDir, n, "SKILL.md")));
    if (!agents.length) {
      add("warn", "persona dispatch", "no .opencode/agents/*.md — personas are not deployed; run `agent-harness update`");
    } else {
      const missingSkills = agents.filter((a) => !skills.includes(a));
      const orphanSkills = skills.filter((s) => !agents.includes(s));
      const parity = [];
      if (missingSkills.length) parity.push(`agent without skill: ${missingSkills.join(", ")}`);
      if (orphanSkills.length) parity.push(`skill without agent: ${orphanSkills.join(", ")}`);
      add(
        parity.length ? "warn" : "ok",
        "persona dispatch",
        parity.length
          ? `persona/skill drift — ${parity.join("; ")} (run \`agent-harness update\`)`
          : `${agents.length} personas, agent<->skill parity`
      );
      let unpinned = [];
      try {
        const dp = require(path.join(TEMPLATES_DIR, "scripts", "qa", "dispatch-persona.js"));
        unpinned = agents.filter((a) => {
          try {
            return !dp.parsePersona(fs.readFileSync(path.join(agentsDir, `${a}.md`), "utf8")).model;
          } catch {
            return false;
          }
        });
      } catch {
        unpinned = []; // older CLI: pin check skipped, parity still reported
      }
      if (unpinned.length) {
        add("warn", "persona model pins", `${unpinned.join(", ")} has no model: pin — dispatch dies at creation (F-081/F-095)`);
      }
    }
    const dispatchFiles = [
      path.join(target, "scripts", "qa", "dispatch-persona.js"),
      path.join(target, "scripts", "qa", "dispatch-tier.js"),
      path.join(target, ".opencode", "plugins", "dispatch.ts"),
    ];
    const missingDispatch = dispatchFiles.filter((p) => !fs.existsSync(p)).map((p) => path.relative(target, p));
    add(
      missingDispatch.length ? "warn" : "ok",
      "dispatch plugin",
      missingDispatch.length
        ? `missing ${missingDispatch.join(", ")} — dispatch preflight/tiering is inert; re-run \`agent-harness update\``
        : "dispatch_persona + tier classifier + plugin present"
    );
  }

  // MCP per-agent gating (G1): V2 has no `tools` field, so a project still
  // declaring the V1 `tools` map (a top-level disable and/or `agents.<name>.tools`
  // enable) has that gating silently ignored — the server connects but no agent
  // can call its tools. `update` migrates both maps into ordered `permissions`.
  {
    const ocPath = path.join(target, "opencode.json");
    const doc = fs.existsSync(ocPath) ? safeJson(fs.readFileSync(ocPath, "utf8"), null) : null;
    if (doc && typeof doc === "object") {
      const top = doc.tools && typeof doc.tools === "object" ? Object.keys(doc.tools) : [];
      const perAgent = Object.entries(doc.agents && typeof doc.agents === "object" ? doc.agents : {})
        .filter(([, a]) => a && typeof a === "object" && a.tools && typeof a.tools === "object")
        .map(([n]) => n);
      if (top.length || perAgent.length) {
        const parts = [];
        if (top.length) parts.push(`top-level ${top.join(", ")}`);
        if (perAgent.length) parts.push(`per-agent ${perAgent.join(", ")}`);
        add(
          "warn",
          "MCP gating",
          `V1 \`tools\` map is ignored by V2 (${parts.join("; ")}) — run \`agent-harness update\` to migrate to \`permissions\``
        );
      }
      // A configured MCP server that the managed `policies` still deny is
      // invisible at runtime (a denied server is removed, not prompted). The
      // harness ships `mcp.use: "*"` deny as the default, so an existing project
      // needs an explicit allow appended after it; name every affected server
      // with the exact statement rather than letting it disappear silently.
      const denied = deniedMcpServers(doc);
      if (denied.length) {
        add(
          "warn",
          "MCP policies",
          `hard-denied by \`policies\` (${denied.join(", ")}) — append ${denied
            .map((name) => `{ "action": "mcp.use", "resource": "${name}", "effect": "allow" }`)
            .join(", ")} to \`opencode.json\` to opt in`
        );
      }
      // `experimental.todo` is the V2 capability flag for the built-in
      // `todowrite` tool. The harness todo discipline depends on it, so a
      // deployed config missing it shows no panel and the guard nudges into a
      // tool that does not exist.
      const todoFlag = doc.experimental && typeof doc.experimental === "object" ? doc.experimental.todo : undefined;
      add(
        todoFlag === true ? "ok" : "warn",
        "todo panel",
        todoFlag === true
          ? "`experimental.todo` enabled (`todowrite` available)"
          : "`experimental.todo` is not enabled — the todo panel stays empty; run `agent-harness update`"
      );
    }
  }
  add(
    fs.existsSync(path.join(target, "scripts", "qa", "check-opencode-compat.js")) ? "ok" : "warn",
    "opencode compat gate",
    fs.existsSync(path.join(target, "scripts", "qa", "check-opencode-compat.js"))
      ? "`npm run test:opencode-compat` available (V2 config + plugin surface)"
      : "missing — re-run `agent-harness update` to deploy the compatibility gate"
  );

  // Session store (W1): the telemetry tooling (`report:cost`, `report:recon`,
  // `session_info`) reads the local opencode store. V2 moved the tables
  // (`session_v2`/`session_message`) and removed the `opencode db` subcommand, so
  // a stale reader silently returned empty aggregates. Assert the store resolves
  // and its table generation is readable, so the failure is visible here instead
  // of in a wrong report.
  try {
    const storeLib = require(path.join(TEMPLATES_DIR, "scripts", "qa", "store-lib.js"));
    const dbPath = storeLib.resolveDbPath();
    if (!fs.existsSync(dbPath)) {
      add("ok", "session store", "no local store yet (nothing to read)");
    } else {
      const store = storeLib.openStore();
      add("ok", "session store", `${store.flavour} tables readable (${store.dbPath})`);
    }
  } catch (err) {
    add(
      "warn",
      "session store",
      `unreadable — \`report:cost\`/\`report:recon\` would be empty (${err && err.message ? err.message : "unavailable"}); check \`opencode debug paths\``
    );
  }

  // Nightly E2E cycle: the orchestrator + config, whether a systemd --user
  // timer is installed, and the last verdict (advisory — the day loop still
  // ships on cheap gates; nightly is the full-E2E authority).
  {
    const hasScript = fs.existsSync(path.join(target, "scripts", "nightly.js"));
    add(
      hasScript ? "ok" : "warn",
      "nightly runner",
      hasScript ? "scripts/nightly.js present (`npm run nightly`)" : "missing — re-run `agent-harness update`"
    );
    const cfg = fs.existsSync(path.join(target, ".agents", "nightly.json"));
    add(cfg ? "ok" : "warn", "nightly config", cfg ? ".agents/nightly.json present" : "missing — run `agent-harness update`");
    const unitDir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "systemd", "user");
    let timer = null;
    try {
      timer = fs.readdirSync(unitDir).find((f) => /^agent-nightly-.*\.timer$/.test(f)) || null;
    } catch (_) {
      timer = null;
    }
    add(
      timer ? "ok" : "warn",
      "nightly timer",
      timer ? `${timer} installed` : "not installed — run `agent-harness install-nightly --target .`"
    );
    const latestPath = path.join(target, ".agents", "qa-runs", "nightly", "latest.json");
    if (fs.existsSync(latestPath)) {
      try {
        const doc = JSON.parse(fs.readFileSync(latestPath, "utf8"));
        const failed = Array.isArray(doc.failures) ? doc.failures.length : 0;
        const reopened = Array.isArray(doc.reconcile) ? doc.reconcile.filter((a) => a.kind === "reopen").length : 0;
        add(
          doc.verdict === "pass" ? "ok" : "warn",
          "last nightly",
          `${doc.verdict || "?"} @ ${doc.stamp || "?"} — ${failed} failing, ${reopened} reopened`
        );
      } catch (_) {
        add("warn", "last nightly", "report unreadable");
      }
    } else {
      add("warn", "last nightly", "no run recorded — `npm run nightly -- run`");
    }
  }

  // Machine capacity (advisory only): free RAM/swap/load, live `.serve/`
  // processes, the RAM-backed tmpfs, and Windows-side `.wslconfig` advice. This
  // is the preflight for the WSL2 freeze class (2026-09-29) — it never fails the
  // cycle, it tells the operator what to change before a heavy tier tips the box.
  try {
    const capacity = require(path.join(TEMPLATES_DIR, "scripts", "qa", "capacity-lib.js"));
    const s = capacity.sample(target);
    if (s.mem) {
      const ev = capacity.evaluate(s);
      add(ev.ok ? "ok" : "warn", "capacity", capacity.formatSummary(s));
      for (const r of ev.reasons) add("warn", "capacity", r);
      for (const w of ev.warnings) add("warn", "capacity", w);
    } else {
      add("ok", "capacity", "host memory not readable (non-Linux)");
    }
    if (s.psi && s.psi.mem && s.psi.mem.some10 != null) {
      add("ok", "pressure (PSI)", `memory some avg10=${s.psi.mem.some10.toFixed(2)} full avg10=${(s.psi.mem.full10 || 0).toFixed(2)}`);
    }
    const host = capacity.readHost(); // powershell, best-effort — doctor only, never the hot path
    const wsl = capacity.readWslConfig();
    if (wsl) {
      add("ok", "wslconfig", wsl.path);
      for (const a of capacity.wslConfigAdvice(wsl, host)) add("warn", "wslconfig", a);
    } else if (process.platform === "linux") {
      add("ok", "wslconfig", "no .wslconfig found (not WSL, or Windows user dir unreadable)");
    }
    // Windows-side stray dev listeners (F-13): a Metro/emulator/dev server started
    // from a Windows terminal is invisible to `.serve/` but holds the port the WSL
    // session needs. Advisory — the operator stops it on the Windows side.
    const strays = capacity.readWindowsStrays();
    if (strays.length) {
      add(
        "warn",
        "windows strays",
        `the Windows host is listening on ${strays.join(", ")} — a dev server/emulator may be running from Windows; stop it there and start it through scripts/serve.js`
      );
    }
    // One-time in-WSL tuning (scripts/wsl-tune.sh apply). Detect rather than
    // assume so doctor can point at the single command that finishes setup.
    const tuning = capacity.readTuning();
    if (tuning.swappiness != null && tuning.swappiness > 20) {
      add("warn", "wsl tuning", `vm.swappiness=${tuning.swappiness} — run \`sudo scripts/wsl-tune.sh apply\` (targets 10)`);
    }
    if (!tuning.workloadCapped && capacity.isWsl()) {
      add(
        "warn",
        "wsl tuning",
        "no MemoryHigh/MemoryMax on init.scope — the cgroup agents/emulators actually run in " +
          "(a ceiling on user.slice is inert here). Run `sudo scripts/wsl-tune.sh apply`"
      );
    } else if (!tuning.sliceApplied) {
      add("warn", "wsl tuning", "no user.slice resource ceiling — run `sudo scripts/wsl-tune.sh apply`");
    } else if (tuning.swappiness != null && tuning.swappiness <= 20) {
      add("ok", "wsl tuning", `swappiness + user.slice ceiling + init.scope backstop applied`);
    }
    // WSL GPU passthrough: /dev/dxg present but no DRM render node means the
    // `vgem` module isn't loaded, so Mesa falls back to llvmpipe and the
    // Android emulator renders several times slower than it needs to (F-296).
    try {
      if (fs.existsSync("/dev/dxg")) {
        const render = fs.existsSync("/dev/dri")
          ? fs.readdirSync("/dev/dri").some((n) => n.startsWith("renderD"))
          : false;
        if (render) add("ok", "wsl gpu", "GPU passthrough available (/dev/dri render node present)");
        else
          add(
            "warn",
            "wsl gpu",
            "GPU passthrough present but /dev/dri is missing (vgem not loaded) — run `bash scripts/wsl-gpu.sh apply`"
          );
      }
    } catch {
      /* device probing is best-effort */
    }
  } catch (err) {
    add("ok", "capacity", `not sampled (${err && err.message ? err.message : "unavailable"})`);
  }

  // CI budget (advisory): the GitHub Actions burn vs the plan's included
  // minutes. The 2026-10 outage was a budget nobody could see; the honest state
  // is `unknown` when it cannot be read, never a silent `ok`.
  try {
    for (const line of ciBudgetLines(target)) add(line.level, line.label, line.detail);
  } catch (err) {
    add("ok", "ci budget", `not read (${err && err.message ? err.message : "unavailable"})`);
  }

  return reportDoctor(results);
}

function reportDoctor(results) {
  console.log("agent-harness doctor\n");
  const icon = { ok: "ok  ", warn: "warn", fail: "FAIL" };
  for (const r of results) console.log(`  [${icon[r.level]}] ${r.label}: ${r.detail}`);
  const fails = results.filter((r) => r.level === "fail").length;
  const warns = results.filter((r) => r.level === "warn").length;
  console.log(`\n  ${fails} failure(s), ${warns} warning(s).`);
  process.exitCode = fails > 0 ? 1 : 0;
  return fails;
}

// ---------------------------------------------------------------- backlog migration

/* Split a markdown table row on unescaped `|` (respects `\|` inside cells). */
function splitCells(row) {
  const cells = [];
  let cur = "";
  let esc = false;
  for (const ch of row) {
    if (esc) {
      cur += ch;
      esc = false;
    } else if (ch === "\\") {
      esc = true;
      cur += ch;
    } else if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

/* Parse markdown table data rows, skipping headers and separator/empty rows. */
function parseTableRows(src) {
  const rows = [];
  for (const raw of String(src || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!/^\|.*\|$/.test(line)) continue;
    const cells = splitCells(line.slice(1, -1));
    if (cells.every((c) => /^[-:|\s]*$/.test(c))) continue; // separator
    if (cells.every((c) => c.trim() === "")) continue; // empty row
    if (
      cells.some((c) =>
        /^(ID|[Ii]d|P|Task|Item|Priority|Context|Status|Evidence|Why frozen|Closed|Why frozen \/ reopen when|Epic|Handoff|Key|Label|Goal)$/.test(c)
      )
    )
      continue; // header
    rows.push(cells);
  }
  return rows;
}

/* Parse markdown list items (bullets / checkboxes), preserving the text. */
function parseListItems(src) {
  const items = [];
  for (const raw of String(src || "").split(/\r?\n/)) {
    const m = raw.match(/^\s*[-*]\s+(?:\[[ x]\]\s*)?(.+)$/);
    if (m && m[1].trim()) items.push(m[1].trim());
  }
  return items;
}

/* Map an old INDEX.md F-row (ID | Item | Priority | Context | Status) into the
 * BACKLOG schema. Returns null for rows that carry no usable identity. */
function mapIndexRow(cells) {
  const id = (cells[0] || "").trim();
  if (!id) return null;
  const task = (cells[1] || "").trim() || id;
  const rawPriority = (cells[2] || "").trim();
  const context = (cells[3] || "").trim();
  const status = (cells[4] || "").trim().toLowerCase();

  // Reconcile the priority direction: old `P0` (blocking) == new `P1`.
  let priority = rawPriority;
  if (priority === "P0") priority = "P1";
  if (!/^P[1-4]$/.test(priority)) priority = "?";

  const evidence = context || "?";
  const base = { id, task, priority, evidence };

  if (/^(shipped|archived|done|closed)$/.test(status)) {
    return { ...base, section: "archive", closed: status };
  }
  if (status === "frozen") {
    return { ...base, section: "frozen", reopen: context || "frozen (migrated); reopen when evidence recurs" };
  }
  if (/^(in-progress|in progress|testing)$/.test(status)) {
    return { ...base, section: "inprogress", handoff: context || "?" };
  }
  return { ...base, section: "open" };
}

/* Ensure the canonical BACKLOG.md exists (create-if-missing from the template),
 * then — ONLY when it is still empty — consolidate a live INDEX.md F-rows list
 * and a live todo.md list into it, and rewrite both as pointers. Idempotent:
 * a re-run finds BACKLOG.md already populated and leaves it untouched. */
function migrateBacklog(target) {
  const backlogPath = path.join(target, "BACKLOG.md");
  const indexPath = path.join(target, ".agents", "features", "INDEX.md");
  const todoPath = path.join(target, ".agents", "memory", "todo.md");
  const templatePath = path.join(TEMPLATES_DIR, "BACKLOG.md");

  const summary = { open: 0, inprogress: 0, frozen: 0, archived: 0, sources: [], createdBacklog: false, rewritten: [] };

  // 1. Scaffold BACKLOG.md if missing (never overwrite an existing board).
  if (!fs.existsSync(backlogPath)) {
    if (!fs.existsSync(templatePath)) {
      throw new Error("templates/BACKLOG.md not found next to this CLI.");
    }
    fs.mkdirSync(path.dirname(backlogPath), { recursive: true });
    fs.writeFileSync(backlogPath, fs.readFileSync(templatePath, "utf8"), "utf8");
    summary.createdBacklog = true;
  }

  // 2. Only merge into an empty board — idempotency guard against duplicates.
  const existing = fs.readFileSync(backlogPath, "utf8");
  const alreadyHasRows = parseTableRows(existing).length > 0;
  if (alreadyHasRows) {
    summary.skipped = "BACKLOG.md already has rows — nothing merged";
    return summary;
  }

  // 3. Read the two sources.
  const open = [];
  const inProgress = [];
  const frozen = [];
  const archive = [];
  const seenIds = new Set();

  const push = (row) => {
    if (!row || seenIds.has(row.id)) return;
    seenIds.add(row.id);
    if (row.section === "archive") archive.push(row);
    else if (row.section === "inprogress") inProgress.push(row);
    else if (row.section === "frozen") frozen.push(row);
    else open.push(row);
  };

  if (fs.existsSync(indexPath)) {
    const indexSrc = fs.readFileSync(indexPath, "utf8");
    const isPointer = /BACKLOG\.md/.test(indexSrc);
    if (!isPointer) {
      summary.sources.push(".agents/features/INDEX.md");
      for (const row of parseTableRows(indexSrc)) push(mapIndexRow(row));
    }
  }

  let tCounter = 0;
  if (fs.existsSync(todoPath)) {
    const todoSrc = fs.readFileSync(todoPath, "utf8");
    const isPointer = /BACKLOG\.md/.test(todoSrc);
    if (!isPointer) {
      summary.sources.push(".agents/memory/todo.md");
      for (const item of parseListItems(todoSrc)) {
        tCounter += 1;
        push({
          id: `T-${String(tCounter).padStart(3, "0")}`,
          task: item,
          priority: "?",
          evidence: ".agents/memory/todo.md",
          section: "open",
        });
      }
    }
  }

  // 4. Emit BACKLOG.md only if there was something to migrate.
  const total = open.length + inProgress.length + frozen.length + archive.length;
  if (total === 0) {
    summary.skipped = "no live rows found in INDEX.md / todo.md";
    return summary;
  }

  const toRow = (r) => `| ${r.id} | ${r.priority} | ? | ${r.task} | ${r.evidence} |`;
  const inProgressRow = (r) => `| ${r.id} | ? | ${r.task} | ${r.handoff || "?"} |`;
  const frozenRow = (r) => `| ${r.id} | ? | ${r.task} | ${r.reopen} |`;
  const archiveRow = (r) => `| ${r.id} | ? | ${r.task} | ${r.closed} |`;

  const table = (headers, rows) =>
    [`| ${headers.join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`, ...rows].join("\n");

  const openBlock =
    open.length === 0
      ? ""
      : `## Open\n\nSorted by priority (P1 → P4).\n\n${table(["ID", "P", "Epic", "Task", "Evidence"], open.map(toRow))}`;
  const inProgressBlock =
    inProgress.length === 0
      ? ""
      : `## In progress\n\nActive work — picked up, not yet shipped.\n\n${table(
          ["ID", "Epic", "Task", "Handoff"],
          inProgress.map(inProgressRow)
        )}`;
  const queuedBlock =
    "## Queued\n\nSorted by priority (P1 → P4).\n\n| ID | P | Epic | Task | Evidence |\n|----|---|------|------|----------|";
  const frozenBlock =
    frozen.length === 0
      ? ""
      : `## Frozen\n\nParked, not deleted. Reopen only when the stated condition recurs.\n\n${table(
          ["ID", "Epic", "Task", "Why frozen / reopen when"],
          frozen.map(frozenRow)
        )}`;
  const archiveBlock =
    archive.length === 0
      ? ""
      : `## Archive (shipped · done)\n\n${table(["ID", "Epic", "Task", "Closed"], archive.map(archiveRow))}`;

  // Rebuild the board: keep the template's usage header, replace the body.
  const header = existing.split(/^## Active \/ next/m)[0].trim();
  const body = [header, "## Active / next\n", inProgressBlock, queuedBlock, openBlock, frozenBlock, archiveBlock, "## Not tracking (leave-in-place, no action)\n"]
    .filter((b) => b.length > 0)
    .join("\n\n") + "\n";

  fs.writeFileSync(backlogPath, body, "utf8");

  // 5. Verify BACKLOG.md is written and non-empty BEFORE rewriting sources.
  const verify = fs.readFileSync(backlogPath, "utf8");
  if (parseTableRows(verify).length === 0) {
    throw new Error("refusing to rewrite sources: BACKLOG.md was not written with rows");
  }

  // 6. Rewrite sources as pointers (never before the board is verified).
  const pointerFor = (name) =>
    `# ${name}\n\nThe backlog lives in \`BACKLOG.md\` (repo root). Per-feature docs still\nlive in \`.agents/features/<slug>/\`. This file is a pointer, not a list.\n`;
  if (fs.existsSync(indexPath) && !/BACKLOG\.md/.test(fs.readFileSync(indexPath, "utf8"))) {
    fs.writeFileSync(indexPath, pointerFor("Features"), "utf8");
    summary.rewritten.push(".agents/features/INDEX.md");
  }
  if (fs.existsSync(todoPath) && !/BACKLOG\.md/.test(fs.readFileSync(todoPath, "utf8"))) {
    fs.writeFileSync(todoPath, pointerFor("Todo"), "utf8");
    summary.rewritten.push(".agents/memory/todo.md");
  }

  summary.open = open.length;
  summary.inprogress = inProgress.length;
  summary.frozen = frozen.length;
  summary.archived = archive.length;
  return summary;
}

// ---------------------------------------------------------------- commands

async function init(target, flags) {
  if (!fs.existsSync(TEMPLATES_DIR)) {
    console.error("templates/ directory not found next to this CLI.");
    process.exit(1);
  }
  const result = await deploy(target, {
    name: flags["--name"],
    domain: flags["--domain"],
    yes: !!flags["--yes"],
    dryRun: !!flags["--dry-run"],
    isUpdate: false,
    // First-run safety: an `init` in someone's existing repo never commits or
    // pushes unless asked. `update` (a harness-owned maintenance step) keeps its
    // auto-commit default. --push implies --commit.
    commit: !!flags["--commit"] || !!flags["--push"],
    push: !!flags["--push"],
    allowBranch: !!flags["--allow-branch"],
    acceptHarness: !!flags["--accept-harness"],
  });
  printSummary(result, false);
  printCommitResult(result);
  if (!result.dryRun) printNextSteps();
}

/* ---------------------------------------------------- worktree freshness sweep
 * `update` writes only the MAIN checkout; each linked `git worktree` is a
 * separate checkout with its own (stale) harness copy, so a resumed feature
 * silently misses the fix (F-25/H-48). Fast-forward every linked worktree to
 * `origin/main` after an update — warn, never fail (a dirty or diverged worktree
 * is the operator's to resolve). Never `update --target <worktree>`: the harness
 * rewrites `opencode.json`'s `{{WORKSPACE_ROOT}}`, which for a worktree resolves
 * to the worktree's parent and narrows the external-directory allowlist. */

/* Pure: the linked worktree dirs in `git worktree list --porcelain` output, the
 * main checkout excluded. Exported for a fixture test. */
function parseWorktreeDirs(text, main) {
  const want = main ? path.resolve(main) : null;
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.match(/^worktree\s+(.+)$/);
    if (!m) continue;
    const dir = m[1].trim();
    if (want && path.resolve(dir) === want) continue;
    out.push(dir);
  }
  return out;
}

/* The linked worktrees of `target` (the main checkout excluded). Best-effort:
 * [] when not a repo or git is unavailable. */
function linkedWorktrees(target) {
  const r = runGit(target, ["worktree", "list", "--porcelain"]);
  if (!r.ok) return [];
  return parseWorktreeDirs(r.out, target);
}

/* Fast-forward each linked worktree to `origin/main`; never throws. Returns
 * `[{ dir, ok, branch, reason }]`; `reason` is set only when not refreshed. */
function refreshLinkedWorktrees(target) {
  const results = [];
  for (const wt of linkedWorktrees(target)) {
    const branch = currentBranch(wt);
    const dirty = runGit(wt, ["status", "--porcelain"]);
    if (dirty.ok && dirty.out) {
      results.push({ dir: wt, ok: false, branch, reason: "uncommitted changes" });
      continue;
    }
    runGit(wt, ["fetch", "--quiet", "origin"]);
    const r = runGit(wt, ["merge", "--ff-only", "origin/main"]);
    if (r.ok) results.push({ dir: wt, ok: true, branch });
    else
      results.push({
        dir: wt,
        ok: false,
        branch,
        reason: (r.err || r.out || "").split(/\r?\n/).filter(Boolean).pop() || "not a fast-forward",
      });
  }
  return results;
}

async function update(target, flags) {
  if (!fs.existsSync(TEMPLATES_DIR)) {
    console.error("templates/ directory not found next to this CLI.");
    process.exit(1);
  }
  // A real deploy must be atomic: the deployed files and their `chore(harness)`
  // commit are one unit. `--no-commit` split them once (2026-11-20: 0.3.6 landed
  // in LibraryOS as untracked WIP and the updater later reverted two fixes), so
  // it is now preview-only; use --dry-run to inspect without writing.
  if (flags["--no-commit"] && !flags["--dry-run"]) {
    console.error(
      "update: refusing --no-commit for a real deploy — the harness files would sit uncommitted in the target.\n" +
        "  They would look like project WIP and the next update could revert them (a release must be atomic).\n" +
        "  Use --dry-run to preview the writes, or drop --no-commit to land one chore(harness) commit."
    );
    process.exit(1);
  }
  const result = await deploy(target, {
    yes: true,
    dryRun: !!flags["--dry-run"],
    isUpdate: true,
    commit: !flags["--no-commit"],
    push: !flags["--no-commit"] && !flags["--no-push"],
    allowBranch: !!flags["--allow-branch"],
    acceptHarness: !!flags["--accept-harness"],
    requireCleanTemplates: true,
    allowDirtyTemplates: !!flags["--allow-dirty-templates"],
  });
  printSummary(result, true);
  printUnpublishedWarning();
  printCommitResult(result);
  // deploy != activate: warn when a live opencode for this target predates the
  // write, so the operator restarts to load the new plugins/config (never
  // auto-restart while a session is live). F-19/H-44.
  const staleRuntime = staleRuntimeWarning(target);
  if (staleRuntime) console.log(`\n  WARNING: ${staleRuntime}`);
  // `update` writes only the main checkout; fast-forward every linked worktree
  // so a resumed feature does not run the old harness (F-25/H-48). Warn, never
  // fail, and never `update --target <worktree>`.
  if (!flags["--dry-run"]) {
    const wts = refreshLinkedWorktrees(target);
    if (wts.length) {
      const stale = wts.filter((w) => !w.ok);
      console.log(`\n  worktrees: ${wts.length - stale.length}/${wts.length} fast-forwarded to origin/main`);
      for (const w of stale) console.log(`    WARNING: ${w.dir} not refreshed (${w.reason}) — merge origin/main by hand`);
    }
  }
  maybePrewarm(target);
}

/* Opt-in (AGENT_HARNESS_PREWARM=1): after an update, warm the device-tier APK
 * cache in the background off the critical path, so the next `device-up.sh` is
 * a fast cache hit/overlay instead of a 7-11 min cold Gradle build. Best-effort
 * and non-blocking; a project without the mobile device tier is a no-op. */
function maybePrewarm(target) {
  if (!process.env.AGENT_HARNESS_PREWARM) return;
  const script = path.join(target, "scripts", "qa", "mobile-e2e", "prewarm.sh");
  if (!fs.existsSync(script)) return;
  try {
    const { spawn } = require("child_process");
    const child = spawn("bash", [script, "--detach"], { cwd: target, detached: true, stdio: "ignore" });
    child.unref();
    console.log("  prewarm: device-tier APK cache warming in the background");
  } catch (_) {
    /* prewarm is an accelerator — never fail an update for it */
  }
}

// ---------------------------------------------------------------- run (E2E auto-resume)

/* Chain bounded orchestration contexts for one work unit: run the next-item
 * workflow, and whenever a phase ends with the feature not landed, relaunch a
 * fresh opencode session that resumes from the checkpoint only — the automatic
 * half of the "prefer a fresh bounded context" policy. Stops on landed, the
 * phase cap, an empty queue, or a failed phase that did not land. The decision
 * core is pure (`templates/scripts/qa/run-loop.js`) and unit-tested; this
 * function owns only IO + the subprocess. */
/* `run --feedback`: work exactly one eligible feedback item in bounded phases.
 * The item is the spec; the runner seeds its diagnosis scaffold, verifies the
 * same signal, and stops at the high-risk human-approval boundary. */
function runFeedbackLoop(target, flags, opts) {
  const { loop, opencode, maxPhases, dryRun } = opts;
  const script = path.join(target, "scripts", "feedback.js");
  if (!fs.existsSync(script)) {
    console.error(`run --feedback: ${script} not found — deploy the feedback CLI first.`);
    process.exitCode = 1;
    return;
  }
  const call = (args) =>
    spawnSync(process.execPath, [script, ...args, "--root", target], {
      cwd: target,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    });
  const asJson = (args) => {
    const r = call([...args, "--json"]);
    if (r.status !== 0 && r.status !== 1) return null;
    try {
      return JSON.parse(r.stdout || "null");
    } catch (_) {
      return null;
    }
  };

  console.log(`agent-harness run --feedback — target ${target} (max ${maxPhases} phase(s))`);
  const first = asJson(["next"]);
  if (!first || !first.eligible || !first.item) {
    console.log("run --feedback: done — the inbox has no eligible item.");
    return;
  }
  const itemId = first.item.id;
  const prepared = call(["prepare", itemId]);
  if (prepared.status !== 0) {
    console.error(`run --feedback: could not seed the diagnosis scaffold: ${(prepared.stderr || "").trim() || `exit ${prepared.status}`}`);
    process.exitCode = 1;
    return;
  }
  console.log(`  item ${itemId}: ${first.item.severity} ${first.item.class}/${first.item.risk} — scaffold seeded`);

  let item = first.item;
  let phasesRun = 0;
  let lastExit = null;
  while (true) {
    const decision = loop.decideFeedbackRun({ item, phasesRun, maxPhases, lastExit });
    if (decision.action !== "resume") {
      console.log(`\nrun --feedback: ${decision.action} — ${decision.reason}`);
      if (decision.action === "stop" && !dryRun) process.exitCode = 1;
      break;
    }
    const phase = phasesRun + 1;
    console.log(`\n── feedback phase ${phase}/${maxPhases}: ${decision.reason} ──`);
    if (dryRun) {
      console.log(`  [dry-run] would run: ${opencode || "opencode"} run <prompt>`);
      console.log(`  [dry-run] prompt: ${decision.prompt}`);
    } else {
      const r = spawnSync(opencode, ["run", decision.prompt], { cwd: target, stdio: "inherit" });
      lastExit = r.status == null ? 1 : r.status;
    }
    const shown = asJson(["show", itemId]);
    if (shown && shown.item) item = shown.item;
    phasesRun = phase;
  }
}

function runCommand(target, flags) {
  const loop = require(path.join(TEMPLATES_DIR, "scripts", "qa", "run-loop.js"));
  // F-067: the runner is an observed phase boundary too — it writes the fallback
  // checkpoint and a logical-failure stop marker, and classifies a technical
  // failure so a broken provider/network is never relaunched.
  const fallback = require(path.join(TEMPLATES_DIR, "scripts", "qa", "checkpoint-fallback.js"));
  const featureResolver = require(path.join(TEMPLATES_DIR, "scripts", "qa", "feature-resolver.js"));
  const { resolveOpencode } = require(path.join(TEMPLATES_DIR, "scripts", "qa", "provider-stats.js"));
  const backlogPath = path.join(target, "BACKLOG.md");
  const handoffDir = path.join(target, ".agents", "handoffs");
  const maxPhases = parseInt(flags["--max-phases"], 10) || 4;
  const resetsRaw = parseInt(flags["--max-context-resets"], 10);
  const maxContextResets =
    Number.isFinite(resetsRaw) && resetsRaw >= 0 ? resetsRaw : loop.DEFAULT_MAX_CONTEXT_RESETS;
  const dryRun = !!flags["--dry-run"];
  const opencode = flags["--opencode"] || resolveOpencode();
  if (!dryRun && !opencode) {
    console.error("run: opencode CLI not found — install it, or pass --opencode <path>.");
    process.exitCode = 1;
    return;
  }
  const readIf = (p) => {
    try {
      return fs.readFileSync(p, "utf8");
    } catch (_) {
      return "";
    }
  };
  const readHandoff = (feature) => (feature ? readIf(path.join(handoffDir, feature + ".md")) : "");
  // Auto clear-resume handshake (F-051): the guard writes this marker when a
  // primary session in a feature worktree crosses the `intervene` request level.
  // The runner reads it after a phase and deletes it once consumed.
  const markerPath = path.join(target, ".agents", "context-resume.json");
  const readMarker = () => {
    try {
      return JSON.parse(fs.readFileSync(markerPath, "utf8"));
    } catch (_) {
      return null;
    }
  };
  const consumeMarker = () => {
    try {
      fs.unlinkSync(markerPath);
    } catch (_) {
      /* absent marker is the normal case */
    }
  };
  // A logical failure has no context-band marker, so the runner writes one as
  // the observable claim "this stop is resumable"; a technical failure never
  // gets one (the classifier gate must stop the loop).
  const writeMarker = (doc) => {
    try {
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(markerPath, JSON.stringify(doc, null, 2) + "\n", "utf8");
    } catch (_) {
      /* best-effort handshake */
    }
  };
  const handoffPathFor = (feature) => {
    try {
      const resolved = featureResolver.resolveFeature(target, feature);
      return resolved && resolved.file ? resolved.file : undefined;
    } catch (_) {
      return undefined;
    }
  };

  if (flags["--feedback"]) {
    runFeedbackLoop(target, flags, { loop, opencode, maxPhases, dryRun });
    return;
  }

  console.log(`agent-harness run — target ${target} (max ${maxPhases} phase(s), max ${maxContextResets} context reset(s))`);
  let feature = flags["--feature"] || null;
  let prompt = flags["--prompt"] || null;
  let phasesRun = 0;
  let lastExit = null;
  let contextResets = 0;
  let phaseStartedAt = 0;
  let priorCheckpointCount = null;
  let technicalFailure = false;

  while (true) {
    const marker = phasesRun > 0 ? readMarker() : null;
    const decision = loop.decideRunLoop({
      backlogText: readIf(backlogPath),
      handoffText: readHandoff(feature),
      feature,
      phasesRun,
      maxPhases,
      lastExit,
      marker,
      phaseStartedAt,
      priorCheckpointCount,
      technicalFailure,
      contextResets,
      maxContextResets,
    });
    if (phasesRun > 0) consumeMarker();
    if (decision.action !== "resume") {
      console.log(`\nrun: ${decision.action} — ${decision.reason}`);
      // A dry-run that reaches the phase cap is a plan, not a failure.
      if (decision.action === "stop" && !dryRun) process.exitCode = 1;
      break;
    }
    const phase = phasesRun + 1;
    const phaseFeature = decision.feature || feature;
    // The first phase uses the explicit /next-style prompt; later phases resume.
    const message = phasesRun === 0 && prompt ? prompt : decision.prompt;
    console.log(`\n── phase ${phase}/${maxPhases}: ${decision.reason} ──`);
    // The freshness + progress baseline for a guard marker written DURING this
    // phase: anything older, or a checkpoint that did not advance, is not a
    // resumable context boundary.
    phaseStartedAt = Date.now();
    priorCheckpointCount = loop.checkpointCount(readHandoff(phaseFeature));
    if (dryRun) {
      console.log(`  [dry-run] would run: ${opencode || "opencode"} run <prompt>`);
      console.log(`  [dry-run] prompt: ${message}`);
    } else {
      const r = spawnSync(opencode, ["run", message], {
        cwd: target,
        stdio: ["inherit", "inherit", "pipe"],
        maxBuffer: 4 * 1024 * 1024,
      });
      lastExit = r.status == null ? 1 : r.status;
      // F-067: the phase stderr is the only oracle for a technical failure; it
      // still reaches the operator, bounded so a huge log cannot bloat the run.
      const errText = String(r.stderr || "") + (r.error ? "\n" + String(r.error.message || r.error) : "");
      if (errText) process.stderr.write(errText);
      technicalFailure = !!r.error || (lastExit !== 0 && loop.isTechnicalFailure(errText));
      // Every phase boundary leaves a resume state, even when the model never
      // checkpointed. A logical failure additionally writes the stop marker so
      // the next iteration can resume it within the existing reset cap.
      try {
        const fb = fallback.writeFallbackCheckpoint({
          root: target,
          feature: phaseFeature,
          handoffPath: handoffPathFor(phaseFeature),
          sessionID: `agent-harness-run:phase-${phase}`,
          stopReason: lastExit === 0 ? "phase-exit" : technicalFailure ? "failed-technical" : "failed",
          baselineCount: priorCheckpointCount,
          sessionStartedAt: phaseStartedAt,
          filesChanged: fallback.gitFilesChanged(target),
        });
        if (lastExit !== 0 && !technicalFailure) {
          writeMarker({
            schema: 1,
            feature: phaseFeature,
            sessionID: "agent-harness-run",
            at: new Date().toISOString(),
            checkpoint_count: fb.count,
            reason: "auto-checkpoint",
          });
        }
      } catch (error) {
        process.stderr.write(`run: fallback checkpoint failed: ${error && error.message ? error.message : error}\n`);
      }
    }
    contextResets = decision.contextReset ? contextResets + 1 : 0;
    feature = phaseFeature;
    phasesRun = phase;
    prompt = decision.prompt;
  }
}

function printCommitResult(result) {
  const c = result.commitResult;
  if (!c) return;
  console.log("");
  if (c.committed) {
    console.log("  committed harness files: " + c.staged.join(", "));
    if (c.forceAdded.length) {
      console.log(
        "  force-added (gitignored in this project, but harness-owned): " +
          c.forceAdded.join(", ")
      );
    }
    console.log(
      c.pushed === true
        ? "  pushed to origin."
        : c.pushed === null
          ? "  push skipped (no --push / no remote)."
          : "  WARNING: commit made but push FAILED."
    );
  } else {
    console.log("  no harness auto-commit: " + (c.skipped.join("; ") || "no-op"));
  }
}

function parseArgs(argv) {
  const flags = {};
  const valueFlags = new Set([
    "--target",
    "--name",
    "--domain",
    "--feature",
    "--prompt",
    "--max-phases",
    "--max-context-resets",
    "--opencode",
    "--dir",
    "--time",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valueFlags.has(a)) flags[a] = argv[++i];
    else if (a === "--dry-run" || a === "--yes" || a === "-y" || a === "--force" || a === "--feedback") flags[a] = true;
    else if (a === "--remove") flags[a] = true;
    else if (a === "--no-commit" || a === "--no-push" || a === "--allow-branch" || a === "--accept-harness" || a === "--commit" || a === "--push" || a === "--allow-dirty-templates")
      flags[a] = true;
  }
  return flags;
}

/* ---------------------------------------------------------------- install-global
 *
 * The global opencode plugin dir (`~/.config/opencode/plugins/`, auto-loaded for
 * EVERY project/session) is machine config, not something `update` can deploy
 * into a project. To keep it reproducible and current, the sources live here in
 * `contrib/global-plugins/`, and this command links them into that global dir.
 * A symlink means the installed plugin always reflects this checkout's latest
 * source (a copy is the fallback where symlinks are unavailable, e.g. Windows
 * without privilege — re-run `install-global` after harness updates there).
 *
 * The headline plugin is `harness-freshness.ts`: on every session start it
 * compares a checkout's `.harness.json` to the local harness and refreshes the
 * checkout ONLY when that is safe for the active branch (a fast-forward worktree,
 * or the sanctioned main-checkout `update`); otherwise it blocks and tells the
 * agent to wait. It must be global because a stale project or worktree loads its
 * OWN (stale) harness — a check shipped inside it could never fire. */
function opencodeGlobalPluginsDir() {
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdg, "opencode", "plugins");
}

function installGlobal(flags) {
  const dryRun = !!flags["--dry-run"];
  const force = !!flags["--force"];
  const destDir = path.resolve(flags["--dir"] || opencodeGlobalPluginsDir());

  if (!fs.existsSync(GLOBAL_PLUGINS_SRC)) {
    console.error(`install-global: no bundled global plugins at ${GLOBAL_PLUGINS_SRC}`);
    process.exitCode = 1;
    return;
  }
  const files = fs.readdirSync(GLOBAL_PLUGINS_SRC).filter((f) => /\.(ts|js)$/.test(f));
  console.log(`install-global → ${destDir}${dryRun ? "  (dry-run)" : ""}`);

  const counts = { linked: 0, updated: 0, current: 0, skipped: 0 };
  for (const f of files) {
    const src = path.join(GLOBAL_PLUGINS_SRC, f);
    const dest = path.join(destDir, f);
    let st = null;
    try {
      st = fs.lstatSync(dest);
    } catch {
      /* not present */
    }

    if (st && st.isSymbolicLink()) {
      const resolved = path.resolve(path.dirname(dest), fs.readlinkSync(dest));
      if (resolved === path.resolve(src)) {
        counts.current++;
        console.log(`  [current] ${f}`);
        continue;
      }
    } else if (st && !force) {
      // A regular file: only treat as current if identical, else refuse.
      let same = false;
      try {
        same = fs.readFileSync(dest, "utf8") === fs.readFileSync(src, "utf8");
      } catch {
        /* unreadable */
      }
      if (same) {
        counts.current++;
        console.log(`  [current] ${f}`);
      } else {
        counts.skipped++;
        console.log(`  [skip]    ${f} exists (not a managed link) — pass --force to replace`);
      }
      continue;
    }

    const existed = !!st;
    if (dryRun) {
      counts[existed ? "updated" : "linked"]++;
      console.log(`  [would ${existed ? "update" : "link"}] ${dest} -> ${src}`);
      continue;
    }
    fs.mkdirSync(destDir, { recursive: true });
    let linked = false;
    try {
      if (st) fs.rmSync(dest, { force: true });
      fs.symlinkSync(src, dest);
      linked = true;
    } catch {
      linked = false;
    }
    if (!linked) fs.copyFileSync(src, dest); // symlinks unavailable -> copy
    counts[existed ? "updated" : "linked"]++;
    console.log(`  [${linked ? "link" : "copy"}]    ${f}${linked ? "" : " (symlink unavailable — copied)"}`);
  }

  console.log(
    `\n  ${counts.linked} linked, ${counts.updated} updated, ${counts.current} current, ${counts.skipped} skipped.`
  );
  if (!dryRun && counts.linked + counts.updated > 0) {
    console.log("  Restart opencode to load the plugin(s).");
  }
  if (counts.skipped > 0) process.exitCode = 1;
}

/* dogfood — make the harness's OWN source checkout run the harness it ships.
 *
 * The harness repo keeps its source under `templates/` and has no root
 * `.opencode/`, so an opencode session rooted there loads no guard, no lease and
 * none of the harness tools (`orient`, `backlog_*`, `session_info`, …) — it only
 * gets them when some deployed project's plugin instance is co-loaded in the same
 * server (F-16, harness-field-review-2026-10-16-round2). `dogfood` symlinks the
 * template tree into the repo root so the checkout dogfoods itself with NO copy
 * to drift:
 *
 *   .opencode/{agents,commands,plugins,skills} -> ../templates/.opencode/*
 *   scripts                                    -> templates/scripts
 *   opencode.json                              (template, {{WORKSPACE_ROOT}} filled)
 *   .harness-dogfood                           marker (relaxes the main-checkout block)
 *
 * The plugins' relative imports (`../../scripts/qa/*`) resolve through the real
 * template path once `.opencode` is a directory of symlinks, and the `scripts`
 * symlink makes the runtime `scripts/...` spawns resolve too. The marker keeps
 * `templates/**` editable on main (that IS the harness workflow); every other
 * checkout is unchanged. `--remove` reverses the links; `--dry-run` prints the plan. */
function dogfood(target, flags) {
  const dryRun = !!flags["--dry-run"];
  const remove = !!flags["--remove"];
  const src = TEMPLATES_DIR;
  const dotOpencode = path.join(src, ".opencode");
  if (!fs.existsSync(dotOpencode)) {
    console.error(`dogfood: ${dotOpencode} not found — run from (or --target) the harness source checkout.`);
    process.exitCode = 1;
    return;
  }
  const root = path.resolve(target);
  const subs = fs
    .readdirSync(dotOpencode)
    .filter((n) => fs.statSync(path.join(dotOpencode, n)).isDirectory());
  console.log(`dogfood ${remove ? "--remove " : ""}→ ${root}${dryRun ? "  (dry-run)" : ""}`);

  const sameLink = (linkPath, linkTarget) => {
    try {
      const st = fs.lstatSync(linkPath);
      if (!st.isSymbolicLink()) return false;
      return (
        path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath)) ===
        path.resolve(path.dirname(linkPath), linkTarget)
      );
    } catch {
      return false;
    }
  };
  const lstat = (p) => {
    try {
      return fs.lstatSync(p);
    } catch {
      return null;
    }
  };
  const link = (linkPath, linkTarget) => {
    const rel = path.relative(root, linkPath);
    if (remove) {
      if (lstat(linkPath)) {
        if (!dryRun) fs.rmSync(linkPath, { force: true });
        console.log(`  [removed] ${rel}`);
      }
      return;
    }
    if (sameLink(linkPath, linkTarget)) {
      console.log(`  [current] ${rel}`);
      return;
    }
    if (lstat(linkPath)) {
      console.error(`  [skip]    ${rel} exists and is not our symlink`);
      process.exitCode = 1;
      return;
    }
    if (dryRun) {
      console.log(`  [link]    ${rel} -> ${linkTarget}`);
      return;
    }
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.symlinkSync(linkTarget, linkPath);
    console.log(`  [link]    ${rel} -> ${linkTarget}`);
  };

  const ocDir = path.join(root, ".opencode");
  for (const name of subs) link(path.join(ocDir, name), path.join("..", "templates", ".opencode", name));
  link(path.join(root, "scripts"), path.join("templates", "scripts"));

  const marker = path.join(root, ".harness-dogfood");
  const ocJson = path.join(root, "opencode.json");
  if (remove) {
    if (lstat(marker)) {
      if (!dryRun) fs.rmSync(marker, { force: true });
      console.log("  [removed] .harness-dogfood");
    }
    if (!dryRun && lstat(ocDir) && fs.readdirSync(ocDir).length === 0) fs.rmdirSync(ocDir);
    console.log("\ndogfood removed. Restart opencode to drop the guard/tools.");
    return;
  }
  const tpl = fs.readFileSync(path.join(src, "opencode.json"), "utf8");
  const conf = substitute(tpl, {
    PROJECT_DIR: path.basename(path.resolve(root)),
    WORKSPACE_ROOT: workspaceRootFor(root),
  });
  if (dryRun) {
    console.log(`  [write]   opencode.json (template, WORKSPACE_ROOT=${workspaceRootFor(root)})`);
    console.log("  [write]   .harness-dogfood");
  } else {
    fs.writeFileSync(ocJson, conf.endsWith("\n") ? conf : conf + "\n");
    fs.writeFileSync(
      marker,
      "# dogfood install — this harness source checkout runs its own guard.\n" +
        "# `templates/**` stays editable on main; remove with `agent-harness dogfood --remove`.\n"
    );
    console.log("  [write]   opencode.json + .harness-dogfood");
  }
  console.log("\nRestart opencode to load the guard/tools, then edit `templates/**` as usual.");
}

/* install-nightly — install the off-hours E2E cycle as a systemd --user timer by
 * delegating to the deployed project's `scripts/setup-nightly.sh` (the script
 * owns the unit contents + linger handling, so it stays correct per project and
 * is reused when run by hand). */
function installNightly(target, flags) {
  const script = path.join(target, "scripts", "setup-nightly.sh");
  if (!fs.existsSync(script)) {
    console.error(`install-nightly: ${script} not found — run \`agent-harness update --target ${target}\` first.`);
    process.exitCode = 1;
    return;
  }
  const args = [script, "install"];
  if (flags["--time"]) args.push("--time", flags["--time"]);
  if (flags["--force"]) args.push("--force");
  if (flags["--dry-run"]) args.push("--dry-run");
  const r = spawnSync("bash", args, {
    cwd: target,
    stdio: "inherit",
    env: { ...process.env, AGENT_NIGHTLY_ROOT: target },
  });
  if (r.status !== 0) process.exitCode = r.status == null ? 1 : r.status;
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (cmd === "--version" || cmd === "-v") return console.log(PKG.version);
  if (cmd === "--help" || cmd === "-h" || !cmd || cmd === "help") return printUsage();

  const flags = parseArgs(args.slice(1));
  const target = path.resolve(flags["--target"] || process.cwd());

  switch (cmd) {
    case "init":
      init(target, flags).catch((e) => {
        console.error(e);
        process.exit(1);
      });
      break;
    case "update":
      update(target, flags).catch((e) => {
        console.error(e);
        process.exit(1);
      });
      break;
    case "migrate-backlog":
      try {
        const s = migrateBacklog(target);
        if (s.skipped) {
          console.log(`\n[migrate-backlog] ${s.skipped}`);
        } else {
          console.log(
            `\n[migrate-backlog] consolidated ${s.open} open · ${s.inprogress} in progress · ${s.frozen} frozen · ${s.archived} archived`
          );
          if (s.sources.length) console.log(`  read from: ${s.sources.join(", ")}`);
          if (s.rewritten.length) console.log(`  rewritten as pointers: ${s.rewritten.join(", ")}`);
          if (s.createdBacklog) console.log("  created BACKLOG.md from the template");
        }
      } catch (e) {
        console.error(e);
        process.exit(1);
      }
      break;
    case "list":
      printPersonas(TEMPLATES_DIR);
      break;
    case "explain": {
      const name = args.slice(1).find((a) => !a.startsWith("-"));
      if (!name || name === "--list" || args.includes("--list")) explainList();
      else explain(name);
      break;
    }
    case "doctor":
      doctor(target);
      break;
    case "install-global":
      installGlobal(flags);
      break;
    case "install-nightly":
      installNightly(target, flags);
      break;
    case "dogfood":
      dogfood(target, flags);
      break;
    case "run":
      runCommand(target, flags);
      break;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      printUsage();
      process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  listFiles,
  substitute,
  isMemoryFile,
  isOpencodeJson,
  isWindowsMount,
  currentBranch,
  defaultBranch,
  detectIndent,
  mergePackageJson,
  mergeGitattributes,
  stripGitattributesBlock,
  stripManagedBlock,
  mergeIgnoreFile,
  isIgnoreFile,
  withDeployLock,
  sha256,
  harnessAgentsOwned,
  collectLocalHarnessDivergences,
  dirtyTemplateEntries,
  readConfig,
  resolveVars,
  workspaceRootFor,
  mergeOpencodeJson,
  convertV1Permission,
  convertV1Tools,
  mergeMcp,
  mergeExperimental,
  policyEffect,
  deniedMcpServers,
  deploy,
  assertNoTemplateHandoffs,
  parseWorktreeDirs,
  linkedWorktrees,
  refreshLinkedWorktrees,
  staleProcs,
  formatStaleRuntime,
  opencodeProcsFor,
  harnessWriteTime,
  staleRuntimeWarning,
  migrateBacklog,
  splitCells,
  parseTableRows,
  parseListItems,
  mapIndexRow,
  printPersonas,
  doctor,
  parseOpencodeVersion,
  checkOpencodeVersion,
  explain,
  explainSection,
  explainList,
  installGlobal,
  dogfood,
  opencodeGlobalPluginsDir,
  GLOBAL_PLUGINS_SRC,
  HARNESS_SCRIPTS,
  filterHarnessScripts,
  runCommand,
  TEMPLATES_DIR,
  CONFIG_FILE,
  BACKUP_DIR,
  PKG,
};
