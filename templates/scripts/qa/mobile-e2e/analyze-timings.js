#!/usr/bin/env node
"use strict";

/**
 * mobile E2E — Maestro timing analyzer (harness-owned).
 *
 * The full device matrix is a long sequence of Maestro commands whose cost is
 * invisible in the runner's wall-clock report: a command that does real work and
 * an *optional* assertion that silently waits out its full timeout look the same
 * in a per-flow duration. The difference matters — on the 2026-10-02 26-journey
 * run, optional waits that expired accounted for ~8.7 min of a 35.8 min matrix,
 * and 7.4 min of that was a single `dashboard-profile-button` wait repeated 30x.
 *
 * This module parses the per-invocation `maestro.log` files under
 * `~/.maestro/tests/<run>/` and reduces them to the two numbers that drive
 * optimization: per-command-kind latency, and *dead waits* (an `(Optional)`
 * command that ends WARNED, i.e. burned its whole timeout).
 *
 * Pure and dependency-free so the tests can require it. The CLI is read-only:
 *
 *   node scripts/qa/mobile-e2e/analyze-timings.js [--prefix 2026-10-02_]
 *   node scripts/qa/mobile-e2e/analyze-timings.js --dir ~/.maestro/tests/2026-10-02_080659 --json
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const LINE_RE =
  /^(\d\d):(\d\d):(\d\d)\.(\d+)\s+\[ INFO\]\s+.*?:\s+(.*?)\s+(RUNNING|COMPLETED|WARNED|FAILED|SKIPPED)$/;

/** Seconds-since-midnight for a Maestro log timestamp. */
function toSeconds(h, m, s, frac) {
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(`0.${frac}`);
}

/** Coarse command kind used to group latency (keeps the output stable). */
function classify(command) {
  const c = String(command || "").trim();
  if (/^Run\b/.test(c)) return "runFlow";
  if (/^Tap on\b/.test(c)) return "tapOn";
  if (/^Assert that\b/.test(c)) return "assert";
  if (/^Input text\b/.test(c)) return "inputText";
  if (/^Erase (text|Text)\b/.test(c)) return "eraseText";
  if (/^Hide Keyboard\b/.test(c)) return "hideKeyboard";
  if (/^(Press key|Press back|Back)\b/.test(c)) return "pressKey";
  if (/^(Scroll|Scrolling|Swiping|Swipe)\b/.test(c)) return "scroll";
  if (/^Launch app\b/.test(c)) return "launchApp";
  if (/^Open\b/.test(c)) return "openLink";
  if (/^(Take screenshot|Wait|Toggle|Set|Define|Apply)/.test(c)) return "misc";
  return "other";
}

/**
 * Parse one `maestro.log` body into command spans. Commands nest (a `runFlow`
 * container wraps its children), so starts are queued per command text and the
 * oldest open run is closed by the next terminal line of the same text (FIFO).
 */
function parseLog(text) {
  const spans = [];
  const open = new Map();
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const at = toSeconds(m[1], m[2], m[3], m[4]);
    const command = m[5].trim();
    const state = m[6];
    if (state === "RUNNING") {
      if (!open.has(command)) open.set(command, []);
      open.get(command).push(at);
      continue;
    }
    const queue = open.get(command);
    if (!queue || !queue.length) continue;
    const start = queue.shift();
    spans.push({ command, state, durationSec: Math.max(0, at - start) });
  }
  return spans;
}

/** Reduce spans to per-kind latency + dead-wait totals. */
function summarise(spans) {
  const byKind = {};
  const deadWaits = [];
  let deadWaitMs = 0;
  let totalMs = 0;
  for (const span of Array.isArray(spans) ? spans : []) {
    const kind = classify(span.command);
    if (!byKind[kind]) byKind[kind] = { count: 0, totalMs: 0 };
    byKind[kind].count += 1;
    const ms = span.durationSec * 1000;
    byKind[kind].totalMs += ms;
    totalMs += ms;
    if (span.state === "WARNED") {
      deadWaitMs += ms;
      deadWaits.push(span);
    }
  }
  deadWaits.sort((a, b) => b.durationSec - a.durationSec);
  return { byKind, deadWaits, deadWaitMs, totalMs, spanCount: spans.length };
}

/** Read one `<dir>/maestro.log` and summarise it (empty result when absent). */
function analyseDir(dir) {
  let text = "";
  try {
    text = fs.readFileSync(path.join(dir, "maestro.log"), "utf8");
  } catch (_) {
    text = "";
  }
  return summarise(parseLog(text));
}

/** Every immediate subdirectory of `base` whose name starts with `prefix`. */
function listRunDirs(base, prefix) {
  let entries = [];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && (!prefix || e.name.startsWith(prefix)))
    .map((e) => path.join(base, e.name))
    .sort();
}

/** Merge per-dir summaries into one across a whole run. */
function mergeSummaries(summaries) {
  const byKind = {};
  const deadWaits = [];
  let deadWaitMs = 0;
  let totalMs = 0;
  let spanCount = 0;
  for (const s of Array.isArray(summaries) ? summaries : []) {
    for (const [kind, v] of Object.entries(s.byKind || {})) {
      if (!byKind[kind]) byKind[kind] = { count: 0, totalMs: 0 };
      byKind[kind].count += v.count;
      byKind[kind].totalMs += v.totalMs;
    }
    deadWaits.push(...(s.deadWaits || []));
    deadWaitMs += s.deadWaitMs || 0;
    totalMs += s.totalMs || 0;
    spanCount += s.spanCount || 0;
  }
  deadWaits.sort((a, b) => b.durationSec - a.durationSec);
  return { byKind, deadWaits, deadWaitMs, totalMs, spanCount, runs: summaries.length };
}

function fmtSec(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function main() {
  const argv = process.argv.slice(2);
  const dirs = [];
  const prefixIdx = argv.indexOf("--prefix");
  const dirIdx = argv.indexOf("--dir");
  const json = argv.includes("--json");
  let prefix = "";
  if (prefixIdx >= 0) prefix = argv[prefixIdx + 1] || "";
  if (dirIdx >= 0) {
    for (let i = dirIdx; i < argv.length; i += 1) {
      if (argv[i] === "--dir" && argv[i + 1]) dirs.push(argv[i + 1]);
    }
  }
  const base = path.join(os.homedir(), ".maestro", "tests");
  const targets = dirs.length ? dirs : listRunDirs(base, prefix);
  const summary = mergeSummaries(targets.map(analyseDir));

  if (json) {
    console.log(JSON.stringify({ dirs: targets, ...summary }, null, 2));
    return;
  }
  console.log(`Maestro timing — ${targets.length} invocation(s)`);
  console.log(`  accounted command time: ${(summary.totalMs / 60000).toFixed(1)} min (${summary.spanCount} commands)`);
  console.log(`  dead waits (optional timeouts that expired): ${(summary.deadWaitMs / 60000).toFixed(1)} min`);
  console.log("  by kind:");
  for (const [kind, v] of Object.entries(summary.byKind).sort((a, b) => b[1].totalMs - a[1].totalMs)) {
    console.log(`    ${kind.padEnd(13)} n=${String(v.count).padStart(4)}  ${(v.totalMs / 60000).toFixed(2).padStart(6)} min  avg=${fmtSec(v.totalMs / Math.max(v.count, 1))}`);
  }
  if (summary.deadWaits.length) {
    console.log("  top dead waits:");
    for (const w of summary.deadWaits.slice(0, 12)) {
      console.log(`    ${fmtSec(w.durationSec * 1000).padStart(8)}  ${w.command.slice(0, 80)}`);
    }
  }
}

if (require.main === module) main();

module.exports = {
  classify,
  parseLog,
  summarise,
  analyseDir,
  listRunDirs,
  mergeSummaries,
  toSeconds,
};
