#!/usr/bin/env node
"use strict";
/*
 * agent-harness — deploy the LibraryOS agent harness (personas, skills, rules,
 * model routing, QA gates) into a target project.
 *
 * Commands:
 *   init   [--target <dir>] [--name <project>] [--domain <desc>] [--yes]
 *   update [--target <dir>]
 *   list                                   (list personas + models)
 *
 * `init` materializes templates/ into the target and substitutes {{
 * PROJECT_NAME }} / {{ PROJECT_DOMAIN }}. `.agents/memory/*` files are only
 * created when absent (project data). Harness-owned files are overwritten.
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const PKG = require("../package.json");
const TEMPLATES_DIR = path.resolve(__dirname, "..", "templates");
const CONFIG_FILE = ".harness.json";

// Files the harness owns and overwrites on every run.
// `.agents/memory/*` is project data -> create-if-missing only.
function listFiles(dir, base = dir) {
  const out = [];
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
    out = out.split("{{" + key + "}}").join(value);
  }
  return out;
}

function isMemoryFile(rel) {
  return rel.split(path.sep).includes(".agents") &&
    rel.split(path.sep).includes("memory");
}

function writeFileIfAbsent(targetAbs, content) {
  if (fs.existsSync(targetAbs)) return "skip";
  fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
  fs.writeFileSync(targetAbs, content, "utf8");
  return "create";
}

function readConfig(target) {
  const p = path.join(target, CONFIG_FILE);
  if (fs.existsSync(p)) {
    try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { return {}; }
  }
  return {};
}

function ask(question, fallback) {
  if (process.argv.includes("--yes")) return Promise.resolve(fallback || "");
  if (!process.stdin.isTTY) return Promise.resolve(fallback || "");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

function resolveVars(target, args) {
  const existing = readConfig(target);
  const nameFlag = args["--name"];
  const domainFlag = args["--domain"];
  const projectName = nameFlag || existing.projectName || path.basename(target);
  return { projectName, domainFlag, existing, VARIABLES: { PROJECT_NAME: projectName, PROJECT_DOMAIN: domainFlag || existing.projectDomain || "" } };
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

async function init(target, args) {
  if (!fs.existsSync(TEMPLATES_DIR)) {
    console.error("templates/ directory not found next to this CLI.");
    process.exit(1);
  }
  const { projectName, domainFlag, VARIABLES } = resolveVars(target, args);

  let projectDomain = VARIABLES.PROJECT_DOMAIN;
  if (!domainFlag && !readConfig(target).projectDomain) {
    projectDomain = await ask(`Project domain (one line) for "${projectName}": `, "");
  }
  VARIABLES.PROJECT_DOMAIN = projectDomain;

  const stats = { overwritten: 0, created: 0, skipped: 0 };
  for (const { abs, rel } of listFiles(TEMPLATES_DIR)) {
    const content = substitute(fs.readFileSync(abs, "utf8"), VARIABLES);
    const targetAbs = path.join(target, rel);
    if (isMemoryFile(rel)) {
      const r = writeFileIfAbsent(targetAbs, content);
      if (r === "create") stats.created++; else stats.skipped++;
    } else {
      fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
      fs.writeFileSync(targetAbs, content, "utf8");
      stats.overwritten++;
    }
  }

  const config = {
    version: PKG.version,
    projectName,
    projectDomain,
    initializedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(target, CONFIG_FILE), JSON.stringify(config, null, 2) + "\n", "utf8");

  console.log(`\nagent-harness v${PKG.version} initialized "${projectName}" in ${target}`);
  console.log(`  ${stats.overwritten} harness files written, ${stats.created} memory files created, ${stats.skipped} existing memory files preserved.\n`);
  console.log("  Next steps:");
  console.log("   1. Fill in `.agents/memory/domain-map.md` and `.agents/memory/stack-versions.md`.");
  console.log("   2. Add QA gate scripts to package.json:");
  console.log('      "test:dispatch": "node scripts/qa/check-dispatch-config.js",');
  console.log('      "test:governance": "node scripts/qa/governance.js"');
  console.log("   3. Restart your agent CLI (config is read once at startup).\n");
}

function update(target) {
  const { projectName, VARIABLES } = resolveVars(target, {});
  console.log(`Updating harness in ${target} (project "${projectName}")...`);
  return init(target, { "--name": projectName, "--domain": VARIABLES.PROJECT_DOMAIN });
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || "help";
  const flags = {};
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--target" || args[i] === "--name" || args[i] === "--domain") {
      flags[args[i]] = args[i + 1]; i++;
    }
  }
  const target = path.resolve(flags["--target"] || process.cwd());

  switch (cmd) {
    case "init":
      init(target, flags).catch((e) => { console.error(e); process.exit(1); });
      break;
    case "update":
      update(target).catch((e) => { console.error(e); process.exit(1); });
      break;
    case "list":
      printPersonas(TEMPLATES_DIR);
      break;
    default:
      console.log(`agent-harness v${PKG.version}\n\nUsage:\n  agent-harness init   [--target <dir>] [--name <project>] [--domain <desc>] [--yes]\n  agent-harness update [--target <dir>]\n  agent-harness list`);
  }
}

main();
