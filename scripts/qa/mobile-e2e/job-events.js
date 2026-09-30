#!/usr/bin/env node
"use strict";

/**
 * mobile E2E — job progress events (harness-owned).
 *
 * A detached device run is otherwise opaque to the agent: it can only guess a
 * finish time and poll a log. This module is the machine-readable progress bus
 * that makes the run OBSERVABLE without the agent polling:
 *
 *   * `run-maestro.js` appends one JSON line per scenario as it starts/finishes;
 *   * `run-detached.sh` records the job (pid + log + events path) and points the
 *     runner at the events file;
 *   * the `job-notify` opencode plugin tails the events file and pushes a TUI
 *     notification per scenario, waking the agent (session.promptAsync) on the
 *     first failure and at completion.
 *
 * Pure and dependency-free so both the runner and the plugin (and the tests)
 * can require it. Every write is best-effort: a missing events file must never
 * fail an otherwise valid run.
 */

const fs = require("fs");
const path = require("path");

/** Append one event as a JSON line. Best-effort (never throws). */
function appendEvent(file, event) {
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`, "utf8");
    return true;
  } catch (_) {
    return false;
  }
}

/** Parse a JSONL events file; corrupt/partial lines are skipped. */
function readEvents(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (_) {
    return [];
  }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      if (event && typeof event.type === "string") out.push(event);
    } catch (_) {
      /* a partially-written trailing line is expected while the run is live */
    }
  }
  return out;
}

/** One-line, ASCII progress text for a single event, or null if not notable. */
function progressLine(event) {
  if (!event || typeof event !== "object") return null;
  switch (event.type) {
    case "matrix_start":
      return `matrix start: ${event.total} journey(s) [${event.mode || "run"}]`;
    case "flow_start":
      return `flow start (${event.index}/${event.total}): ${event.name}${event.actor ? ` [actor=${event.actor}]` : ""}`;
    case "flow_result":
      return event.status === "pass"
        ? `flow pass: ${event.name}`
        : `flow FAIL: ${event.name} — ${event.reason || "unknown reason"}`;
    case "fail_fast":
      return `FAIL-FAST: ${event.count} flow(s) share a reason — ${event.signature || ""}`;
    case "matrix_done":
      return `matrix done: ${event.passed} passed / ${event.failed} failed (${event.total} total)`;
    default:
      return null;
  }
}

/** Reduce the event stream to a compact summary the notifier/agent can consume. */
function summarize(events) {
  const list = Array.isArray(events) ? events : [];
  const results = list.filter((e) => e.type === "flow_result");
  const start = list.find((e) => e.type === "matrix_start");
  const done = [...list].reverse().find((e) => e.type === "matrix_done");
  const failFast = list.find((e) => e.type === "fail_fast");
  const passes = results.filter((e) => e.status === "pass").map((e) => e.name);
  const failures = results
    .filter((e) => e.status !== "pass")
    .map((e) => ({ name: e.name, reason: e.reason || "unknown reason" }));
  return {
    total: start ? start.total : results.length,
    startedCount: results.length,
    passed: passes.length,
    failed: failures.length,
    passes,
    failures,
    failFast: failFast ? { count: failFast.count, signature: failFast.signature || "" } : null,
    done: !!done,
    reportPath: done && done.report ? done.report : null,
  };
}

/** The notification body injected into the session on completion / first failure. */
function notificationText(summary, opts) {
  const s = summary || {};
  const head = s.done
    ? `Mobile E2E finished: ${s.passed} passed / ${s.failed} failed (of ${s.total}).`
    : `Mobile E2E progress: ${s.passed} passed / ${s.failed} failed so far (of ${s.total}).`;
  const lines = [head];
  if (s.failFast) {
    lines.push(`Fail-fast stop: ${s.failFast.count} flow(s) share a reason — ${s.failFast.signature}`);
  }
  if (s.failures && s.failures.length) {
    lines.push("Failures:");
    for (const f of s.failures.slice(0, 12)) lines.push(`  - ${f.name}: ${f.reason}`);
    if (s.failures.length > 12) lines.push(`  … and ${s.failures.length - 12} more`);
  }
  const report = (opts && opts.reportPath) || s.reportPath;
  if (report) lines.push(`Report: ${report}`);
  if (opts && opts.eventsPath) lines.push(`Events: ${opts.eventsPath}`);
  lines.push(
    "Continue F-291: classify each failure (harness-side vs mobile/**) from the report + per-flow artifacts before editing."
  );
  return lines.join("\n");
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const file = argv[1];
  if (cmd === "--render") {
    const skipIdx = argv.indexOf("--skip");
    const skip = skipIdx >= 0 ? Number(argv[skipIdx + 1]) || 0 : 0;
    for (const event of readEvents(file).slice(skip)) {
      const line = progressLine(event);
      if (line) console.log(line);
    }
    return;
  }
  if (cmd === "--summary") {
    console.log(notificationText(summarize(readEvents(file))));
    return;
  }
  console.error("usage: job-events.js --render <events.jsonl> [--skip N] | --summary <events.jsonl>");
  process.exitCode = 2;
}

if (require.main === module) main();

module.exports = { appendEvent, readEvents, progressLine, summarize, notificationText };
