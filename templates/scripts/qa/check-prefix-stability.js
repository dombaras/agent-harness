#!/usr/bin/env node
"use strict";
/*
 * test:prefix — cache-prefix stability gate.
 *
 * The intended leading context is the root `AGENTS.md` (the always-loaded
 * dispatcher under V2), the discovered rulebook + operating-rules summary, and
 * the session-start memory reads — the prompt prefix every turn is billed
 * against. Under V2 only the root `AGENTS.md` is auto-loaded:
 * `.agents/AGENTS.md` is discovered lazily (it is an `AGENTS.md`), and
 * `.agents/rules/00-operating.md` is never auto-loaded (the root file links it).
 * So this set is a budget proxy for the context the rules *deliberately* pull
 * in, not a byte-for-byte copy of the live prefix. At ~97% cache-read share, one
 * volatile byte in that context (a clock timestamp, a machine-specific path, a
 * session id) breaks cache locality for every following turn — a silent,
 * recurring cost. This gate fails when a volatile value is found in a prefix file.
 *
 * Scoped to the prefix files only: project memory that legitimately records
 * historical dates, feature docs, handoffs, and the live BACKLOG.md are out of
 * scope, so the check never flags honest history. A date alone is stable; a
 * timestamp with a clock time, an absolute user/home path, or a session id is
 * per-run content and fails.
 *
 * It also enforces a SIZE budget on the harness-owned prefix files (the
 * rulebook + operating summary). The prefix is billed every turn, so unchecked
 * growth silently raises the floor cost of every session; the budget is set a
 * little above the current size and forces a deliberate check before it grows
 * again. Project-owned memory files are unbounded (they legitimately vary).
 * `AGENT_PREFIX_STRICT=0` disables the size check; `AGENT_PREFIX_MAX_BYTES`
 * overrides the combined harness-owned ceiling.
 *
 * Usage: node scripts/qa/check-prefix-stability.js [--root <dir>] [--json]
 */

const fs = require("fs");
const path = require("path");
const argv = process.argv.slice(2);
const rootFlag = argv.indexOf("--root");
const root = path.resolve(rootFlag !== -1 && argv[rootFlag + 1] ? argv[rootFlag + 1] : path.resolve(__dirname, "..", ".."));
const jsonOut = argv.includes("--json");
const strict = process.env.AGENT_PREFIX_STRICT !== "0";

/* Per-file size ceilings (bytes) for the harness-owned prefix files. Set just
 * above the shipped size so a real growth must be a deliberate bump, not a
 * quiet accumulation. Memory files are project-owned and deliberately absent. */
const SIZE_BUDGET = {
  "AGENTS.md": 10240,
  ".agents/AGENTS.md": 48128,
  ".agents/rules/00-operating.md": 30720,
};
/* Combined harness-owned ceiling; `AGENT_PREFIX_MAX_BYTES` overrides. */
const DEFAULT_TOTAL_BUDGET = 89088; // ≈ 87 KB
const totalBudget = (() => {
  const n = Number(process.env.AGENT_PREFIX_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TOTAL_BUDGET;
})();

/* The intended always-on prefix: root dispatcher -> rulebook -> rules summary,
 * then the memory files the operating rules name as session-start reads. Under
 * V2 only the root `AGENTS.md` is auto-loaded; the rest are discovered lazily or
 * read on demand, so this list is the deliberate-context budget proxy, not the
 * literal live prefix. BACKLOG.md is deliberately excluded — it is a live board
 * that changes every session.
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
let budgetedTotal = 0;
const sizes = [];

for (const entry of PREFIX_FILES) {
  const rel = entry.rel;
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) {
    warnings.push(`missing prefix file: ${rel}`);
    continue;
  }
  const bytes = fs.statSync(abs).size;
  sizes.push({ rel, bytes, maxBytes: SIZE_BUDGET[rel] || null });
  if (SIZE_BUDGET[rel]) budgetedTotal += bytes;
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

const sizeFindings = [];
if (strict) {
  for (const s of sizes) {
    if (s.maxBytes && s.bytes > s.maxBytes) {
      sizeFindings.push(`${s.rel}: ${s.bytes} bytes exceeds the ${s.maxBytes}-byte budget (+${s.bytes - s.maxBytes})`);
    }
  }
  if (budgetedTotal > totalBudget) {
    sizeFindings.push(`harness-owned prefix total: ${budgetedTotal} bytes exceeds the ${totalBudget}-byte budget (+${budgetedTotal - totalBudget})`);
  }
}

if (jsonOut) {
  console.log(
    JSON.stringify(
      {
        schema: "prefix-stability/1",
        strict,
        files: sizes,
        budgetedTotal,
        totalBudget,
        volatile: findings,
        size: sizeFindings,
        warnings,
      },
      null,
      2
    )
  );
  process.exit(findings.length || sizeFindings.length ? 1 : 0);
}

console.log("cache-prefix stability \u2014 always-loaded files carry no per-run content");
for (const s of sizes) {
  const budget = s.maxBytes ? ` / ${s.maxBytes} budget` : "";
  console.log(`  \u2713 ${s.rel} (${s.bytes}${budget} bytes)`);
}
for (const w of warnings) console.log(`  \u26a0 ${w}`);
if (strict && budgetedTotal) {
  console.log(`  harness-owned prefix total: ${budgetedTotal} / ${totalBudget} bytes`);
}

if (findings.length) {
  console.log("\nVolatile values found in the always-loaded prefix:");
  for (const f of findings) console.log(`  \u2717 ${f}`);
  console.log(
    "\nA per-run value in the prefix breaks prompt-cache locality every turn. Move it to a" +
      "\nnon-prefix file (a handoff, memory note, or state file) or remove it."
  );
  process.exit(1);
}
if (sizeFindings.length) {
  console.log("\nPrefix size budget exceeded:");
  for (const f of sizeFindings) console.log(`  \u2717 ${f}`);
  console.log(
    "\nThe always-loaded prefix is billed every turn. Trim it, or bump the budget in" +
      "\ntemplates/scripts/qa/check-prefix-stability.js deliberately if the growth is intended."
  );
  process.exit(1);
}
console.log(`\nRESULT: ${checked.length} prefix file(s) byte-stable, 0 volatile values, within size budget.`);
