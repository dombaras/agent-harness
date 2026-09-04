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
 *   - `opencode.json` is MERGED: harness manages $schema/model/small_model/
 *     instructions; every other key the project adds is preserved.
 *   - all other harness-owned files are overwritten. If a harness-owned file was
 *     modified locally since the last deploy (tracked by checksum in
 *     `.harness.json`), it is backed up to `.harness-backup/<timestamp>/` first.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");
const { spawnSync } = require("child_process");

const PKG = require("../package.json");
const TEMPLATES_DIR = path.resolve(__dirname, "..", "templates");
const CONFIG_FILE = ".harness.json";
const BACKUP_DIR = ".harness-backup";

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

/* `.agents/memory/*` (session memory), `.agents/features/*` (feature doc tree),
 * `.agents/qa-plans/*` (one QA plan file per change) and `.agents/handoffs/*`
 * (one session handoff file per session) are project data — scaffolded
 * create-if-missing, never overwritten, and never tracked in the manifest.
 * qa-plans and handoffs are sharded per change/session so concurrent sessions
 * never collide on a single shared file.
 * Note: the check matches the directory DIRECTLY under `.agents` (not any
 * segment), so `.agents/skills/features/SKILL.md` stays harness-owned. */
function isProjectScaffold(rel) {
  const parts = rel.split(path.sep);
  const idx = parts.indexOf(".agents");
  if (idx === -1) return false;
  const sub = parts[idx + 1];
  return (
    sub === "memory" ||
    sub === "features" ||
    sub === "qa-plans" ||
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
/* Combined: any file that must be scaffolded create-if-missing rather than
 * overwritten. */
function isCreateIfMissing(rel) {
  return isProjectScaffold(rel) || isBacklogFile(rel);
}
/* Back-compat alias (kept for any external caller referencing the old name). */
function isMemoryFile(rel) {
  return isProjectScaffold(rel);
}

function isOpencodeJson(rel) {
  return relKey(rel) === "opencode.json";
}

function sha256(str) {
  return crypto.createHash("sha256").update(str, "utf8").digest("hex");
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

function resolveVars(target, args) {
  const existing = readConfig(target);
  const projectName = args["--name"] || existing.projectName || path.basename(target);
  const projectDomain = args["--domain"] || existing.projectDomain || "";
  return {
    projectName,
    projectDomain,
    existing,
    VARIABLES: { PROJECT_NAME: projectName, PROJECT_DOMAIN: projectDomain },
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
  const harness = safeJson(
    substitute(fs.readFileSync(path.join(TEMPLATES_DIR, "opencode.json"), "utf8"), variables),
    {}
  );
  const p = path.join(target, "opencode.json");
  const existing = fs.existsSync(p) ? safeJson(fs.readFileSync(p, "utf8"), {}) : {};

  const merged = { ...existing, ...harness };
  if (Array.isArray(harness.instructions)) {
    const prior = Array.isArray(existing.instructions) ? existing.instructions : [];
    merged.instructions = [...new Set([...prior, ...harness.instructions])];
  }
  return JSON.stringify(merged, null, 2) + "\n";
}

// Harness-shipped npm scripts auto-wired into the target project's package.json
// scripts (merged, not clobbered). Every other script the project has is preserved.
// These gates ship with the harness, so a deploy wires them up like opencode.json.
const HARNESS_SCRIPTS = {
  backlog: "node scripts/backlog.js",
  "test:dispatch": "node scripts/qa/check-dispatch-config.js",
  "test:governance": "node scripts/qa/governance.js",
  "test:qa-plan": "node scripts/qa/check-qa-plan.js",
  "test:backlog": "node scripts/qa/check-backlog.js",
  "test:product": "node scripts/qa/check-product.js",
  "test:docs": "node scripts/qa/check-docs.js",
  "test:concurrency": "node scripts/qa/check-concurrency.js",
  "test:integrate": "node scripts/qa/check-integrate.js",
};

// Merge harness gate scripts into the project's existing package.json, preserving
// every other script. ADD-ONLY: an existing script is never overwritten, so a
// project's deliberate customization of a gate survives re-deploys. Returns
// { text, hadPkg }.
function mergePackageJson(target) {
  const p = path.join(target, "package.json");
  const hadPkg = fs.existsSync(p);
  const existing = hadPkg ? safeJson(fs.readFileSync(p, "utf8"), {}) : {};
  const scripts = Object.assign({}, existing.scripts || {});
  for (const [name, cmd] of Object.entries(HARNESS_SCRIPTS)) {
    if (!(name in scripts)) scripts[name] = cmd;
  }
  const merged = { ...existing, scripts };
  return { text: JSON.stringify(merged, null, 2) + "\n", hadPkg };
}

// Harness-managed .gitignore entries. These are LOCAL-ONLY artifacts (never
// committed): everything else the harness deploys is tracked by git. Entries
// live in a marked section so `update` can re-merge them (and pick up new
// entries) without touching the project's own ignores.
const GITIGNORE_MARKER = "# agent-harness (managed below)";
const HARNESS_IGNORE_ENTRIES = [".harness-backup/"];

function mergeGitignore(target) {
  const p = path.join(target, ".gitignore");
  const existing = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  const lines = existing.split(/\r?\n/);
  const idx = lines.findIndex((l) => l === GITIGNORE_MARKER);
  const kept = idx === -1 ? lines : lines.slice(0, idx);
  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
  const managed = [GITIGNORE_MARKER, ...HARNESS_IGNORE_ENTRIES, ""];
  const out = kept.length ? [...kept, "", ...managed] : [...managed];
  return out.join("\n");
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

function slugify(s) {
  const slug = String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "project";
}

function backlogDriverName(projectName) {
  return `backlog-${slugify(projectName)}`;
}

function mergeGitattributes(target, driverName) {
  const p = path.join(target, ".gitattributes");
  const existing = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  const lines = existing.split(/\r?\n/);
  const idx = lines.findIndex((l) => l === GITATTRIBUTES_MARKER);
  const kept = idx === -1 ? lines : lines.slice(0, idx);
  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
  const managed = [GITATTRIBUTES_MARKER, `BACKLOG.md merge=${driverName}`, ""];
  const out = kept.length ? [...kept, "", ...managed] : [...managed];
  return out.join("\n");
}

/* Register the row-aware merge driver in the target's LOCAL git config (never
 * committed — merge drivers are per-clone). Git runs it as
 * `node <abs>/scripts/qa/merge-backlog.js %O %A %B`. The driver script is
 * committed; only the config pointer is local. The driver name is per-project,
 * so nested projects in one repo each keep their own registration. */
function registerBacklogMergeDriver(target, driverName) {
  if (!isGitRepo(target)) return;
  const driverScript = path.join(target, "scripts", "qa", "merge-backlog.js").split(path.sep).join("/");
  const driver = `node "${driverScript}" %O %A %B`;
  runGit(target, ["config", `merge.${driverName}.name`, "BACKLOG.md row merge"]);
  runGit(target, ["config", `merge.${driverName}.driver`, driver]);
}

// ---------------------------------------------------------------- git helpers

function runGit(target, args) {
  const result = require("child_process").spawnSync("git", args, {
    cwd: target,
    encoding: "utf8",
  });
  return { ok: result.status === 0, status: result.status, out: (result.stdout || "").trim(), err: (result.stderr || "").trim() };
}

function isGitRepo(target) {
  const r = runGit(target, ["rev-parse", "--is-inside-work-tree"]);
  return r.ok;
}

// Auto-commit ONLY the harness-owned files an update just changed, so the target
// project's next session never sees "unexplained" modified harness files. Scoped
// to this run's changed harness files (never `git add -A`) so unrelated uncommitted
// work is NEVER swept in. Memory/backup files are excluded (project data / rollback).
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
  const diffCached = runGit(target, ["diff", "--cached", "--name-only"]);
  const staged = (diffCached.out || "").split(/\r?\n/).filter(Boolean).map(relKey);
  if (staged.length === 0) {
    out.skipped.push("no harness changes staged");
    return out;
  }
  out.staged = staged;
  const prior = opts.priorVersion ? opts.priorVersion + " -> " : "";
  const message = `chore(harness): @dombaras/agent-harness ${prior}${PKG.version}`;
  const commitR = runGit(target, ["commit", "-m", message]);
  if (!commitR.ok) {
    out.skipped.push("commit failed: " + firstGitErrorLine(commitR.err));
    return out;
  }
  out.committed = true;
  if (opts.push) {
    const hasRemote = runGit(target, ["remote"]).ok && runGit(target, ["remote"]).out;
    if (hasRemote) {
      const pushR = runGit(target, ["push", "origin", "HEAD"]);
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

// ---------------------------------------------------------------- deploy

function backup(target, rel, content) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(target, BACKUP_DIR, stamp, relKey(rel));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content, "utf8");
}

async function deploy(target, opts) {
  const { name, domain, yes, dryRun, isUpdate, commit, push } = opts || {};
  const existing = readConfig(target);
  const projectName = name || existing.projectName || path.basename(target);
  const driverName = backlogDriverName(projectName);
  let projectDomain = domain || existing.projectDomain || "";
  if (!projectDomain && !isUpdate && !yes && process.stdin.isTTY) {
    projectDomain = await ask(`Project domain (one line) for "${projectName}": `, "");
  }
  const VARIABLES = { PROJECT_NAME: projectName, PROJECT_DOMAIN: projectDomain };

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

  const previousFiles = existing.files || {};
  const actions = [];
  const manifest = {};

  // Auto-wire harness gate scripts into the target package.json (merged, add-only).
  {
    const { text, hadPkg } = mergePackageJson(target);
    const key = "package.json";
    const targetAbs = path.join(target, "package.json");
    const current = hadPkg ? fs.readFileSync(targetAbs, "utf8") : null;
    if (!hadPkg) actions.push({ rel: key, kind: "create" });
    else if (current !== text) actions.push({ rel: key, kind: "merge" });
    else actions.push({ rel: key, kind: "unchanged" });
    manifest[key] = sha256(text);
    if (!dryRun) {
      fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
      fs.writeFileSync(targetAbs, text, "utf8");
    }
  }

  // Merge harness-managed gitignore entries (add-only, marked section).
  {
    const text = mergeGitignore(target);
    const key = ".gitignore";
    const targetAbs = path.join(target, ".gitignore");
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

  // Merge harness-managed .gitattributes (BACKLOG.md row-aware merge driver).
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

  // Register the row-aware BACKLOG.md merge driver in the target's local git
  // config (the script is committed; the driver pointer is per-clone).
  if (!dryRun) registerBacklogMergeDriver(target, driverName);

  for (const { abs, rel } of listFiles(TEMPLATES_DIR)) {
    const key = relKey(rel);
    const targetAbs = path.join(target, rel);

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
      continue;
    }

    if (isCreateIfMissing(rel)) {
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
      if (current !== content) {
        const deployedHash = previousFiles[key];
        const locallyModified = !!deployedHash && deployedHash !== sha256(current);
        actions.push({ rel: key, kind: locallyModified ? "overwrite (backup)" : "overwrite" });
        if (locallyModified && !dryRun) backup(target, rel, current);
      } else {
        actions.push({ rel: key, kind: "unchanged" });
        manifest[key] = previousFiles[key] || sha256(content);
        continue;
      }
    } else {
      actions.push({ rel: key, kind: "create" });
    }
    manifest[key] = sha256(content);
    if (!dryRun) {
      fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
      fs.writeFileSync(targetAbs, content, "utf8");
    }
  }

  // Nothing-to-update detection: an update that made no effective change to any
  // harness-owned file and was already running this exact version is a no-op —
  // report it clearly instead of printing a zero-delta "Updated", and leave the
  // target byte-for-byte untouched (no .harness.json timestamp churn, no commit).
  const changedRelsAll = actions
    .filter((a) => ["create", "overwrite", "overwrite (backup)", "merge"].includes(a.kind))
    .map((a) => a.rel);
  const nothingToUpdate =
    !!isUpdate && changedRelsAll.length === 0 && compareVersions(existing.version || "0", PKG.version) === 0;

  const config = {
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
    isUpdate: !!isUpdate,
    nothingToUpdate,
    priorVersion: existing.version || null,
  };
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
      `${counts.merge || 0} merged, ${counts.preserve || 0} preserved, ${counts.unchanged || 0} unchanged.`
  );
}

/* Best-effort warning: when this CLI's version is not the latest published on
 * the registry, flag it. This catches the "bumped + ran update from a local
 * checkout, but never published" silent gap. Publish guidance stays inline so a
 * failed `npm publish` (401/404 auth/permission) never leaves the developer
 * staring at a raw npm error — it points them at `npm login`. */
function printUnpublishedWarning() {
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
  console.log("      and `.agents/memory/flow-map.md` (register cross-surface flows so");
  console.log("      test:qa-plan enforces their sibling-surface/variant closure).");
  console.log("   2. Harness gate scripts (`test:dispatch`, `test:governance`, `test:qa-plan`,");
  console.log("      `test:backlog`, `test:product`, `test:docs`) were auto-wired into package.json \"scripts\".");
  console.log("   3. Capture found items as one light row in the canonical `BACKLOG.md` (repo root);");
  console.log("      dispatch the `features` persona to author the per-feature doc chain when one is picked up.");
  console.log("   4. Restart your agent CLI (config is read once at startup).\n");
}

function printUsage() {
  console.log(
    `agent-harness v${PKG.version}\n\n` +
      `Usage:\n` +
      `  agent-harness init   [--target <dir>] [--name <project>] [--domain <desc>] [--yes] [--dry-run] [--no-commit] [--no-push]\n` +
      `  agent-harness update [--target <dir>] [--dry-run] [--no-commit] [--no-push]\n` +
      `  agent-harness migrate-backlog [--target <dir>]\n` +
      `\n` +
      `  init and update auto-commit only the harness files they create/change\n` +
      `  (chore(harness): ...) and push to origin by default. Use --no-commit to\n` +
      `  skip commit+push, or --no-push to commit but not push. Your unrelated\n` +
      `  uncommitted work is never staged.\n` +
      `\n` +
      `  migrate-backlog consolidates any live \`.agents/features/INDEX.md\` F-rows and\n` +
      `  \`.agents/memory/todo.md\` into the canonical BACKLOG.md, then rewrites those\n` +
      `  files as pointers. Idempotent: re-running never duplicates rows or deletes a\n` +
      `  source before BACKLOG.md is written and verified.\n` +
      `\n` +
      `  agent-harness list\n` +
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
    commit: !flags["--no-commit"],
    push: !flags["--no-commit"] && !flags["--no-push"],
  });
  printSummary(result, false);
  printCommitResult(result);
  if (!result.dryRun) printNextSteps();
}

async function update(target, flags) {
  if (!fs.existsSync(TEMPLATES_DIR)) {
    console.error("templates/ directory not found next to this CLI.");
    process.exit(1);
  }
  const result = await deploy(target, {
    yes: true,
    dryRun: !!flags["--dry-run"],
    isUpdate: true,
    commit: !flags["--no-commit"],
    push: !flags["--no-commit"] && !flags["--no-push"],
  });
  printSummary(result, true);
  printUnpublishedWarning();
  printCommitResult(result);
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
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--target" || a === "--name" || a === "--domain") flags[a] = argv[++i];
    else if (a === "--dry-run" || a === "--yes" || a === "-y") flags[a] = true;
    else if (a === "--no-commit" || a === "--no-push") flags[a] = true;
  }
  return flags;
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
  sha256,
  readConfig,
  resolveVars,
  mergeOpencodeJson,
  deploy,
  migrateBacklog,
  splitCells,
  parseTableRows,
  parseListItems,
  mapIndexRow,
  printPersonas,
  TEMPLATES_DIR,
  CONFIG_FILE,
  BACKUP_DIR,
  PKG,
};
