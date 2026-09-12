#!/usr/bin/env node
"use strict";
/*
 * test:governance — session-governance gate (repo guard).
 *
 * Mechanically enforces the three Step Zero reporting rules that keep dispatch
 * predictable:
 *   1. Every session handoff MUST open a `## Dispatch log` section that
 *      contains at least one entry (subagent result, waiver, or degrade).
 *   2. Every `waived:` entry MUST cite a `reason:` on the same line — a waiver
 *      without a reason is itself a rules violation.
 *   3. A dispatch log with 5+ entries (the `orchestration.md` fan-out band where
 *      justification starts) MUST carry a `## Fan-out justification` section or
 *      a `dispatch_justification:` line citing why each dispatch is distinct —
 *      the planner's `§Fan-out review` names them. This rule is FORWARD-ONLY
 *      (`FANOUT_JUSTIFY_SINCE`): handoffs dated before it shipped, and undated
 *      legacy handoffs, are grandfathered — a gate never retroactively fails
 *      history.
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

/* Fan-out band 5–7 in `.agents/memory/orchestration.md` = "planner must provide
 * explicit decomposition justification"; this gate enforces that at wrap-up. */
const FANOUT_JUSTIFY_MIN = 5;
/* Forward-only: only handoffs dated this day or later are subject to the
 * justification check. Undated legacy handoffs are grandfathered. */
const FANOUT_JUSTIFY_SINCE = "2026-09-12";

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

/* A dispatch-log entry is either a bullet item (`- subagent -> model -> shipped`)
 * or a markdown table data row (`| subagent | model | shipped ... |`). The gate
 * accepts both so a session that renders its log as a table is not falsely
 * flagged as "empty". Table rows are recognized only AFTER a separator row
 * (`|---|---|`) so the header is never mistaken for an entry. */
function dispatchCount(section) {
  const lines = section.split(/\r?\n/);
  let seenSeparator = false;
  let count = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^[-*]\s+\S/.test(line)) {
      count++; // bullet entry
      continue;
    }
    if (/^\|.*\|$/.test(line)) {
      if (/^\|(\s*:?-+:?\s*\|)+\s*$/.test(line)) {
        seenSeparator = true;
        continue;
      }
      if (seenSeparator) count++; // data row after the separator
    }
  }
  return count;
}

/* A fan-out justification is a `## Fan-out justification` / `## Fan-out review`
 * section with content, or a `dispatch_justification: <why>` line anywhere in
 * the file — so a handoff that mirrors the planner's §Fan-out review passes. */
function hasFanoutJustification(src) {
  if (/^\s*(?:[-*]\s*)?dispatch_justification:\s*\S/im.test(src)) return true;
  const heading = src.match(/^#{1,6}\s*Fan-out\s+(?:review|justification)\s*$/im);
  if (!heading) return false;
  const after = src.slice(heading.index + heading[0].length);
  const tail = after.match(/^#{1,6}\s/m);
  return (tail ? after.slice(0, tail.index) : after).trim().length > 0;
}

/* The handoff's `Date: <YYYY-MM-DD>` line (sessions before the template had it
 * are undated). Used only for forward-only scope, never to fabricate order. */
function handoffDate(src) {
  const m = src.match(/^Date:\s*(\d{4}-\d{2}-\d{2})\s*$/im);
  return m ? m[1] : null;
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
    const count = dispatchCount(section);
    check(
      count >= 1,
      `${rel} dispatch log contains at least one entry (subagent result, waived:, or degraded: — bullet or table row)`
    );
    if (count >= FANOUT_JUSTIFY_MIN) {
      const date = handoffDate(src);
      const inScope = date !== null && date >= FANOUT_JUSTIFY_SINCE;
      if (inScope) {
        check(
          hasFanoutJustification(src),
          `${rel} dispatch log has ${count} entries (fan-out >= ${FANOUT_JUSTIFY_MIN}) but no \`## Fan-out justification\` section / \`dispatch_justification:\` line citing the plan's §Fan-out review`
        );
      }
    }
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
