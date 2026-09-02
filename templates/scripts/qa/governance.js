#!/usr/bin/env node
"use strict";
/*
 * test:governance — session-governance gate (repo guard).
 *
 * Mechanically enforces the two Step Zero reporting rules that keep dispatch
 * predictable:
 *   1. Every session handoff MUST open a `## Dispatch log` section that
 *      contains at least one entry (subagent result, waiver, or degrade).
 *   2. Every `waived:` entry MUST cite a `reason:` on the same line — a waiver
 *      without a reason is itself a rules violation.
 *
 * Handoffs are SHARDED (like QA plans): one file per session under
 * `.agents/handoffs/` (e.g. `F-003.md`, `return-no-condition.md`), so concurrent
 * sessions never collide on a single shared file. The gate reads EVERY `.md`
 * under that directory — plus the legacy single `.agents/memory/handoff.md` for
 * backward compatibility — and requires each to open with a `## Dispatch log`
 * section containing at least one entry.
 */
const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "..", "..");

const failures = [];
const check = (ok, msg) => {
  console.log(`  ${ok ? "\u2713" : "\u2717"} ${msg}`);
  if (!ok) failures.push(msg);
};

console.log("governance gate \u2014 wrap-up dispatch log");

/* All handoff files to check: every `.md` under `.agents/handoffs/` (recursive),
 * plus the legacy single `.agents/memory/handoff.md` if present (backward compat
 * for projects deployed before sharding). `README.md` files are documentation,
 * not handoffs, so they are skipped. Sorted for deterministic output. */
function handoffFiles(root) {
  const files = [];
  const collect = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) collect(abs);
      else if (
        entry.name.toLowerCase().endsWith(".md") &&
        entry.name.toLowerCase() !== "readme.md"
      )
        files.push(abs);
    }
  };
  collect(path.join(root, ".agents", "handoffs"));
  const legacy = path.join(root, ".agents", "memory", "handoff.md");
  if (fs.existsSync(legacy)) files.push(legacy);
  return files.sort();
}

const files = handoffFiles(root);

if (files.length === 0) {
  console.error(
    "FATAL: missing session handoff \u2014 add one under .agents/handoffs/<feature-id>.md"
  );
  process.exit(2);
}

console.log(
  "  checked against: " + files.map((f) => path.relative(root, f)).join(", ")
);

const waivers = [];
for (const file of files) {
  const rel = path.relative(root, file);
  const src = fs.readFileSync(file, "utf8");

  const heading = src.match(/^#{1,6}\s*Dispatch log\s*$/im);
  check(!!heading, `${rel} opens a \`## Dispatch log\` section`);
  if (heading) {
    const after = src.slice(heading.index + heading[0].length);
    const sectionTail = after.match(/^#{1,6}\s/m);
    const section = (sectionTail ? after.slice(0, sectionTail.index) : after).trim();
    const entry = section.match(/^\s*[-*]\s*\S/m);
    check(
      !!entry,
      `${rel} dispatch log contains at least one entry line (subagent result, waived:, or degraded:)`
    );
  }

  for (const w of src.matchAll(/\bwaived:\s*([^\n,]+)/gi)) {
    const line = src.split(/\r?\n/)[src.slice(0, w.index).split(/\r?\n/).length - 1];
    waivers.push({ line: line.trim(), rel });
  }
}

for (const w of waivers) {
  check(
    /\breason:\s*\S/.test(w.line),
    `every waived entry cites a reason (${w.rel}): \`${w.line}\``
  );
}

console.log(
  `\nRESULT: ${failures.length ? `${failures.length} FAILURE(S)` : "governance green"}`
);
process.exit(failures.length ? 1 : 0);
