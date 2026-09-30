#!/usr/bin/env node
"use strict";
/*
 * test:prefix — cache-prefix stability gate.
 *
 * The always-loaded leading context (the root dispatcher, the rulebook, the
 * operating-rules summary, and the session-start memory reads) is the prompt
 * prefix every turn is billed against. At ~97% cache-read share, one volatile
 * byte in that prefix (a clock timestamp, a machine-specific path, a session
 * id) breaks cache locality for every following turn — a silent, recurring
 * cost. This gate fails when a volatile value is found in a prefix file.
 *
 * Scoped to the prefix files only: project memory that legitimately records
 * historical dates, feature docs, handoffs, and the live BACKLOG.md are out of
 * scope, so the check never flags honest history. A date alone is stable; a
 * timestamp with a clock time, an absolute user/home path, or a session id is
 * per-run content and fails.
 *
 * Usage: node scripts/qa/check-prefix-stability.js [--root <dir>]
 */

const fs = require("fs");
const path = require("path");
const argv = process.argv.slice(2);
const rootFlag = argv.indexOf("--root");
const root = path.resolve(rootFlag !== -1 && argv[rootFlag + 1] ? argv[rootFlag + 1] : path.resolve(__dirname, "..", ".."));

/* The always-loaded prefix: root dispatcher -> rulebook -> rules summary, then
 * the memory files the operating rules name as session-start reads. BACKLOG.md
 * is deliberately excluded — it is a live board that changes every session.
 * `locations.md` is the locations map: absolute machine paths are its whole
 * purpose, so machine paths are allowed there (clock timestamps and session ids
 * are still flagged). */
const PREFIX_FILES = [
  { rel: "AGENTS.md" },
  { rel: ".agents/AGENTS.md" },
  { rel: ".agents/rules/00-operating.md" },
  { rel: ".agents/memory/locations.md", allowMachinePaths: true },
  { rel: ".agents/memory/model-routing.md" },
  { rel: ".agents/memory/orchestration.md" },
  { rel: ".agents/memory/product-principles.md" },
  { rel: ".agents/memory/environments.md" },
];

/* Volatile-value patterns. Each is per-run content, never legitimate stable
 * guidance: clock timestamps (a bare date stays allowed), machine-specific
 * absolute paths (Windows drive letters, POSIX user/home dirs, WSL `/mnt/<drive>/`
 * mounts, and `\\wsl.localhost\` / `\\wsl$\` UNC paths — the `\b` keeps URL
 * schemes like `https://` from matching), and opencode session ids. */
const PATTERNS = [
  { name: "clock timestamp", re: /\b\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}/ },
  {
    name: "machine-specific absolute path",
    re: /(?:\b[A-Za-z]:[\\/]|\/(?:Users|home)\/[A-Za-z0-9._-]+\/|\/mnt\/[a-z]\/|wsl(?:\.localhost|\$)[\\/])/i,
    machinePath: true,
  },
  { name: "opencode session id", re: /\bses_[A-Za-z0-9]{6,}\b/ },
];

const findings = [];
const warnings = [];
const checked = [];

for (const entry of PREFIX_FILES) {
  const rel = entry.rel;
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) {
    warnings.push(`missing prefix file: ${rel}`);
    continue;
  }
  const src = fs.readFileSync(abs, "utf8");
  checked.push(rel);
  src.split(/\r?\n/).forEach((line, i) => {
    for (const p of PATTERNS) {
      if (p.machinePath && entry.allowMachinePaths) continue;
      if (p.re.test(line)) {
        findings.push(`${rel}:${i + 1} — ${p.name}: ${line.trim().slice(0, 120)}`);
      }
    }
  });
}

console.log("cache-prefix stability \u2014 always-loaded files carry no per-run content");
for (const rel of checked) {
  const bytes = fs.statSync(path.join(root, rel)).size;
  console.log(`  \u2713 ${rel} (${bytes} bytes)`);
}
for (const w of warnings) console.log(`  \u26a0 ${w}`);

if (findings.length) {
  console.log("\nVolatile values found in the always-loaded prefix:");
  for (const f of findings) console.log(`  \u2717 ${f}`);
  console.log(
    "\nA per-run value in the prefix breaks prompt-cache locality every turn. Move it to a" +
      "\nnon-prefix file (a handoff, memory note, or state file) or remove it."
  );
  process.exit(1);
}
console.log(`\nRESULT: ${checked.length} prefix file(s) byte-stable, 0 volatile values.`);
