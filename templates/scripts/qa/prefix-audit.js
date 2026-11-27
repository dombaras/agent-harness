#!/usr/bin/env node
"use strict";
/*
 * prefix-audit — measure the fixed session-start floor.
 *
 * WHY THIS EXISTS (F-060): the first request of a session pays for the system
 * prompt, every tool schema, and the auto-loaded instruction files before the
 * user types anything. LibraryOS ses_de4b2caa0ffe measured input 9,474 + cache
 * read 1,920 = 11,394 tokens; the same floor here is ~11.2K. `test:prefix`
 * guards the *instruction bytes* but not the biggest bucket, and nothing reported
 * the split. This script turns the floor into three measured/derived buckets:
 *
 *   observed floor  — first assistant message usage from the opencode store
 *   instructions    — auto-loaded AGENTS.md files + `instructions` config entries
 *   system + tools  — the remainder (derived; includes the runtime system prompt
 *                     and every registered tool schema)
 *
 * It is an audit, not a gate: the store is a machine-local input and a missing
 * session must not fail CI. `--budget` makes it fail deliberately when a local
 * floor regression is being investigated.
 *
 * Usage:
 *   node scripts/qa/prefix-audit.js [--root <dir>] [--session <id>]
 *        [--budget <tokens>] [--no-store] [--json]
 *
 * Exit: 0 normally; 1 only when --budget is given and the observed floor exceeds
 * it. Missing store/session is a warning, never a failure.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_CHARS_PER_TOKEN = 3.8;

/* Token counts from a text heuristic are an estimate. Bytes are the fact; the
 * estimate exists only to compare against the provider's observed usage. */
function estimateTokens(bytes, charsPerToken = DEFAULT_CHARS_PER_TOKEN) {
  return Math.max(0, Math.round(Number(bytes || 0) / charsPerToken));
}

function sqlQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

/* Auto-loaded instruction files. Under OpenCode V2 the root dispatcher is the
 * only project file injected at session start; `.agents/AGENTS.md` is a shim
 * injected only when a `.agents/**` read happens, so it is deliberately not
 * counted here. The global file is user-owned: report it, never budget it. */
function instructionCandidates(root, opts = {}) {
  const home = opts.homedir || os.homedir();
  const configDir = opts.configDir || process.env.OPENCODE_CONFIG_DIR || path.join(home, ".config", "opencode");
  const out = [];
  const globalAgents = path.join(configDir, "AGENTS.md");
  if (fs.existsSync(globalAgents)) out.push({ rel: globalAgents, kind: "global", budgeted: false });
  const projectAgents = path.join(root, "AGENTS.md");
  if (fs.existsSync(projectAgents)) out.push({ rel: "AGENTS.md", kind: "project", budgeted: true });
  for (const rel of configInstructions(root)) {
    const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    if (path.resolve(abs) === path.resolve(projectAgents)) continue;
    out.push({ rel: path.isAbsolute(rel) ? rel : rel, kind: "config", budgeted: true });
  }
  return out;
}

/* `instructions` in opencode.json is a list of file/dir/glob entries. Keep the
 * parser dependency-free: a glob is resolved with Node's fs.globSync when the
 * runtime has it, otherwise skipped with a warning rather than guessed. */
function configInstructions(root, opts = {}) {
  const readFile = opts.readFile || ((p) => fs.readFileSync(p, "utf8"));
  let cfg = null;
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    const p = path.join(root, name);
    if (!fs.existsSync(p)) continue;
    try {
      const text = readFile(p).replace(/^\s*\/\/.*$/gm, "");
      cfg = JSON.parse(text);
    } catch (_) {
      return [];
    }
    break;
  }
  const entries = cfg && Array.isArray(cfg.instructions) ? cfg.instructions : [];
  const out = [];
  const globSync = fs.globSync ? fs.globSync.bind(fs) : null;
  for (const entry of entries) {
    if (typeof entry !== "string" || !entry.trim()) continue;
    const abs = path.isAbsolute(entry) ? entry : path.join(root, entry);
    if (fs.existsSync(abs)) {
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) {
        if (globSync) for (const m of globSync("**/*.md", { cwd: abs })) out.push(path.join(abs, m));
      } else if (stat.isFile()) {
        out.push(abs);
      }
    } else if (globSync && /[*?[]/.test(entry)) {
      for (const m of globSync(entry, { cwd: root })) out.push(m);
    }
  }
  return out;
}

/* The first assistant message of a session carries the first request's usage:
 * the fixed floor plus the user's first prompt. Return null when the session
 * has no assistant row yet (the audit then degrades to static mode). */
function firstAssistantUsage(store, sessionId) {
  const rows = store.query(
    `SELECT seq, data FROM session_message WHERE session_id = ${sqlQuote(sessionId)} AND type = 'assistant' ORDER BY seq ASC LIMIT 1`
  );
  if (!rows.length) return null;
  let data = {};
  try {
    data = JSON.parse(rows[0].data || "{}");
  } catch (_) {
    return null;
  }
  const t = data.tokens || {};
  const cache = t.cache || {};
  const input = Number(t.input) || 0;
  const cacheRead = Number(cache.read) || 0;
  const cacheWrite = Number(cache.write) || 0;
  return {
    seq: rows[0].seq,
    input,
    cacheRead,
    cacheWrite,
    total: input + cacheRead,
    model: data.model || null,
    agent: data.agent || null,
    time: data.time || null,
  };
}

function latestSession(store, root, sessionId) {
  if (sessionId) {
    const exact = store.query(
      `SELECT id, directory, time_created FROM session_v2 WHERE id = ${sqlQuote(sessionId)} LIMIT 1`
    );
    if (exact.length) return exact[0];
    const prefixed = store.query(
      `SELECT id, directory, time_created FROM session_v2 WHERE id LIKE ${sqlQuote(sessionId + "%")} ORDER BY time_created DESC LIMIT 1`
    );
    return prefixed[0] || null;
  }
  const exact = store.query(
    `SELECT id, directory, time_created FROM session_v2 WHERE directory = ${sqlQuote(root)} ORDER BY time_created DESC LIMIT 1`
  );
  if (exact.length) return exact[0];
  const nested = store.query(
    `SELECT id, directory, time_created FROM session_v2 WHERE directory LIKE ${sqlQuote(root + "/%")} ORDER BY time_created DESC LIMIT 1`
  );
  return nested[0] || null;
}

/* Harness-owned tool inventory. The count is exact (each plugin registers a
 * named tool); the schema bytes are not, so they stay inside the derived
 * system+tools bucket. */
function harnessTools(root) {
  const dir = path.join(root, ".opencode", "plugins");
  const plugins = [];
  if (!fs.existsSync(dir)) return { plugins, names: [], count: 0, bytes: 0 };
  const walk = (d, base = "") => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = path.join(base, entry.name);
      if (entry.isDirectory()) walk(path.join(d, entry.name), rel);
      else if (/\.(ts|tsx|js|mjs)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
        const abs = path.join(d, entry.name);
        if (abs.endsWith(path.join("plugins", "context-resume", "tui.tsx"))) continue;
        plugins.push(rel);
      }
    }
  };
  walk(dir);
  const names = [];
  let bytes = 0;
  for (const rel of plugins) {
    const src = fs.readFileSync(path.join(dir, rel), "utf8");
    bytes += Buffer.byteLength(src);
    for (const m of src.matchAll(/\bname:\s*["']([a-z][a-z0-9_]*)["']/g)) names.push(m[1]);
  }
  return { plugins, names: [...new Set(names)].sort(), count: new Set(names).size, bytes };
}

function composeAudit({ root, observed, instructions, tools, userBytes = 0 }) {
  const instructionBytes = instructions.files.reduce((n, f) => n + f.bytes, 0);
  const instructionTokens = estimateTokens(instructionBytes);
  const userTokens = estimateTokens(userBytes);
  const floor = observed ? observed.total : null;
  const derivedTokens = floor == null ? null : Math.max(0, floor - instructionTokens - userTokens);
  const sharePct = floor == null || !floor ? null : Math.round((derivedTokens / floor) * 100);
  return {
    schema: "prefix-audit/1",
    root,
    floor: observed ? { ...observed, userTokens, instructionTokens, derivedTokens, derivedSharePct: sharePct } : null,
    instructions: { files: instructions.files, bytes: instructionBytes, tokens: instructionTokens },
    tools: { plugins: tools.plugins.length, names: tools.names, count: tools.count, bytes: tools.bytes },
    estimate: { charsPerToken: DEFAULT_CHARS_PER_TOKEN, note: "token split is estimated from bytes; the floor is observed" },
  };
}

function readUserFirstPrompt(store, sessionId) {
  const rows = store.query(
    `SELECT data FROM session_message WHERE session_id = ${sqlQuote(sessionId)} AND type = 'user' ORDER BY seq ASC LIMIT 1`
  );
  if (!rows.length) return "";
  try {
    const d = JSON.parse(rows[0].data || "{}");
    return typeof d.text === "string" ? d.text : "";
  } catch (_) {
    return "";
  }
}

function human(report) {
  const lines = [`fixed session-start prefix — ${report.root}`, ""];
  if (report.floor) {
    lines.push(`observed floor (session ${report.floor.session}):`);
    lines.push(
      `  ${report.floor.total.toLocaleString()} tokens = ${report.floor.input.toLocaleString()} input + ${report.floor.cacheRead.toLocaleString()} cache read`
    );
  } else {
    lines.push("observed floor: unavailable (no session in the local store yet)");
  }
  lines.push(
    `instructions (auto-loaded): ${report.instructions.bytes.toLocaleString()} B ≈ ${report.instructions.tokens.toLocaleString()} tokens`
  );
  for (const f of report.instructions.files) {
    lines.push(`  ${f.bytes.toLocaleString().padStart(7)} B  ${f.rel}${f.budgeted ? "" : "  (user-owned)"}`);
  }
  if (report.floor) {
    const f = report.floor;
    lines.push(
      `system + tool schemas (derived): ≈ ${f.derivedTokens.toLocaleString()} tokens (${f.derivedSharePct}% of the floor)`
    );
    lines.push(`  first prompt: ≈ ${f.userTokens.toLocaleString()} tokens`);
  }
  lines.push(`harness tools: ${report.tools.count} registered names across ${report.tools.plugins} plugin file(s)`);
  if (report.tools.names.length) lines.push(`  ${report.tools.names.join(", ")}`);
  lines.push("", "The floor is billed before the first user token; trim instructions or tool schemas, not the task.");
  return lines.join("\n");
}

function main(argv = process.argv.slice(2)) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : null;
  };
  const root = path.resolve(flag("--root") || process.cwd());
  const jsonOut = argv.includes("--json");
  const noStore = argv.includes("--no-store");
  const budget = Number(flag("--budget"));
  const warnings = [];

  const files = instructionCandidates(root).map((f) => ({
    rel: f.rel,
    kind: f.kind,
    budgeted: f.budgeted,
    bytes: fs.statSync(f.rel).size,
  }));
  const tools = harnessTools(root);

  let observed = null;
  let sessionId = flag("--session");
  if (!noStore) {
    try {
      const { openStore } = require("./store-lib.js");
      const store = openStore();
      const session = latestSession(store, root, sessionId);
      if (session) {
        sessionId = session.id;
        const usage = firstAssistantUsage(store, session.id);
        if (usage) observed = { ...usage, session: session.id };
        else warnings.push(`session ${session.id} has no assistant message yet`);
      } else {
        warnings.push("no session found for this root in the local store");
      }
      if (observed) {
        const userText = readUserFirstPrompt(store, session.id);
        var userBytes = Buffer.byteLength(userText);
      }
    } catch (err) {
      warnings.push("store unavailable: " + String(err && err.message ? err.message : err).split("\n")[0]);
    }
  }

  const report = composeAudit({
    root,
    observed,
    instructions: { files },
    tools,
    userBytes: typeof userBytes === "number" ? userBytes : 0,
  });
  report.warnings = warnings;

  if (jsonOut) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(human(report));
    for (const w of warnings) console.log(`  ⚠ ${w}`);
  }
  if (Number.isFinite(budget) && budget > 0 && report.floor && report.floor.total > budget) {
    console.error(`\nprefix budget exceeded: ${report.floor.total} > ${budget} tokens`);
    return 1;
  }
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = {
  estimateTokens,
  sqlQuote,
  configInstructions,
  instructionCandidates,
  firstAssistantUsage,
  latestSession,
  harnessTools,
  composeAudit,
  readUserFirstPrompt,
  main,
};
