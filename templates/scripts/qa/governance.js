#!/usr/bin/env node
"use strict";
/*
 * test:governance — session-governance gate (repo guard).
 *
 * Mechanically enforces the two Step Zero reporting rules that keep dispatch
 * predictable:
 *   1. `.agents/memory/handoff.md` MUST open a `## Dispatch log` section that
 *      contains at least one entry (subagent result, waiver, or degrade).
 *   2. Every `waived:` entry MUST cite a `reason:` on the same line — a waiver
 *      without a reason is itself a rules violation.
 */
const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "..", "..");
const handoff = path.join(root, ".agents", "memory", "handoff.md");

const failures = [];
const check = (ok, msg) => {
  console.log(`  ${ok ? "\u2713" : "\u2717"} ${msg}`);
  if (!ok) failures.push(msg);
};

console.log("governance gate \u2014 wrap-up dispatch log");

if (!fs.existsSync(handoff)) {
  console.error("FATAL: missing .agents/memory/handoff.md");
  process.exit(2);
}
const src = fs.readFileSync(handoff, "utf8");

const heading = src.match(/^#{1,6}\s*Dispatch log\s*$/im);
check(!!heading, "handoff.md opens a `## Dispatch log` section");
if (heading) {
  const after = src.slice(heading.index + heading[0].length);
  const sectionTail = after.match(/^#{1,6}\s/m);
  const section = (sectionTail ? after.slice(0, sectionTail.index) : after).trim();
  const entry = section.match(/^\s*[-*]\s*\S/m);
  check(
    !!entry,
    "dispatch log contains at least one entry line (subagent result, waived:, or degraded:)"
  );
}

const waivers = [...src.matchAll(/\bwaived:\s*([^\n,]+)/gi)];
for (const w of waivers) {
  const line = src.split(/\r?\n/)[src.slice(0, w.index).split(/\r?\n/).length - 1];
  check(
    /\breason:\s*\S/.test(line),
    `every waived entry cites a reason: \`${line.trim()}\``
  );
}

console.log(
  `\nRESULT: ${failures.length ? `${failures.length} FAILURE(S)` : "governance green"}`
);
process.exit(failures.length ? 1 : 0);