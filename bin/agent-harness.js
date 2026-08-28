#!/usr/bin/env node
"use strict";
/*
 * agent-harness — deploy the agent harness (personas, skills, rules, model
 * routing, QA gates) into a target project.
 *
 * Commands:
 *   init   [--target <dir>] [--name <project>] [--domain <desc>] [--yes] [--dry-run]
 *   update [--target <dir>] [--dry-run]
 *   list
 *   --version | -v
 *   --help | -h
 *
 * `init`/`update` materialize templates/ into the target and substitute {{
 * PROJECT_NAME }} / {{ PROJECT_DOMAIN }}.
 *
 * Ownership model:
 *   - `.agents/memory/*` is project data -> create-if-missing (never overwrite).
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

const PKG = require("../package.json");
const TEMPLATES_DIR = path.resolve(__dirname, "..", "templates");
const CONFIG_FILE = ".harness.json";
const BACKUP_DIR = ".harness-backup";

// ---------------------------------------------------------------- helpers

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

function isMemoryFile(rel) {
  const parts = rel.split(path.sep);
  return parts.includes(".agents") && parts.includes("memory");
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

// ---------------------------------------------------------------- deploy

function backup(target, rel, content) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(target, BACKUP_DIR, stamp, relKey(rel));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content, "utf8");
}

async function deploy(target, opts) {
  const { name, domain, yes, dryRun, isUpdate } = opts || {};
  const existing = readConfig(target);
  const projectName = name || existing.projectName || path.basename(target);
  let projectDomain = domain || existing.projectDomain || "";
  if (!projectDomain && !isUpdate && !yes && process.stdin.isTTY) {
    projectDomain = await ask(`Project domain (one line) for "${projectName}": `, "");
  }
  const VARIABLES = { PROJECT_NAME: projectName, PROJECT_DOMAIN: projectDomain };

  const previousFiles = existing.files || {};
  const actions = [];
  const manifest = {};

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

    if (isMemoryFile(rel)) {
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

  const config = {
    version: PKG.version,
    projectName,
    projectDomain,
    initializedAt: existing.initializedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    files: manifest,
  };
  if (!dryRun) {
    fs.writeFileSync(path.join(target, CONFIG_FILE), JSON.stringify(config, null, 2) + "\n", "utf8");
  }

  return { projectName, projectDomain, actions, dryRun: !!dryRun };
}

function summarize(actions) {
  const counts = {};
  for (const a of actions) counts[a.kind] = (counts[a.kind] || 0) + 1;
  return counts;
}

function printSummary(result, isUpdate) {
  const { projectName, actions, dryRun } = result;
  const verb = isUpdate
    ? (dryRun ? "Would update" : "Updated")
    : (dryRun ? "Would initialize" : "Initialized");
  console.log(`\nagent-harness v${PKG.version} ${verb.toLowerCase()} "${projectName}"` + (dryRun ? " (dry run)" : ""));
  for (const a of actions) console.log(`  [${a.kind}] ${a.rel}`);
  const counts = summarize(actions);
  console.log(
    `\n  ${counts.create || 0} created, ${counts.overwrite || 0} overwritten, ` +
      `${counts["overwrite (backup)"] || 0} backed up (locally modified), ` +
      `${counts.merge || 0} merged, ${counts.preserve || 0} preserved, ${counts.unchanged || 0} unchanged.`
  );
}

function printNextSteps() {
  console.log("  Next steps:");
  console.log("   1. Fill in `.agents/memory/domain-map.md` and `.agents/memory/stack-versions.md`.");
  console.log("   2. Add QA gate scripts to package.json:");
  console.log('      "test:dispatch": "node scripts/qa/check-dispatch-config.js",');
  console.log('      "test:governance": "node scripts/qa/governance.js"');
  console.log("   3. Restart your agent CLI (config is read once at startup).\n");
}

function printUsage() {
  console.log(
    `agent-harness v${PKG.version}\n\n` +
      `Usage:\n` +
      `  agent-harness init   [--target <dir>] [--name <project>] [--domain <desc>] [--yes] [--dry-run]\n` +
      `  agent-harness update [--target <dir>] [--dry-run]\n` +
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
  });
  printSummary(result, false);
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
  });
  printSummary(result, true);
}

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--target" || a === "--name" || a === "--domain") flags[a] = argv[++i];
    else if (a === "--dry-run" || a === "--yes" || a === "-y") flags[a] = true;
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
  printPersonas,
  TEMPLATES_DIR,
  CONFIG_FILE,
  BACKUP_DIR,
  PKG,
};
