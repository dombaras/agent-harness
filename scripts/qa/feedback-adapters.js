#!/usr/bin/env node
"use strict";
/*
 * feedback-adapters — Phase 1 capture adapters for the feedback loop (F-050).
 *
 * Pure mapping only: a red signal artifact (triaged CI runs, a nightly report,
 * UAT deploy/health runs) becomes the signal object `feedback.js ingest`
 * captures, and a captured item becomes a board-row decision. No `gh`, no file
 * IO, no clock — the CLI owns transport and persistence, so every mapping here
 * is unit-testable offline and the same input always produces the same item.
 *
 * Board discipline (plan.md §Board and storage): one row per active signature,
 * marker `[feedback:<source>:<sig8>]`. A signal whose row already exists links
 * to it; a nightly journey failure links to the `[nightly:flow=...]` row the
 * nightly reconcile owns instead of filing a duplicate; a reopened signature
 * reopens its archived row.
 */

const lib = require("./feedback-lib.js");

/* Only a real verdict is worth an item. A green run is the healthy state and an
 * incomplete run has no failure to capture yet. */
const FAILING_VERDICTS = new Set(["failed", "infra-block"]);

function shortSha(sha) {
  return sha ? String(sha).slice(0, 7) : null;
}

function firstPointer(item) {
  const evidence = item && Array.isArray(item.evidence) ? item.evidence : [];
  const entry = evidence.find((e) => e && e.pointer);
  return entry ? String(entry.pointer) : null;
}

/* One triaged run (the `ci-triage.js` row shape) -> one signal. `opts.source`
 * lets the UAT adapter reuse the exact same run reader; only the source/kind and
 * environment differ, and the classifier then routes it as a deploy signal
 * (high risk, rollback-first) instead of a pre-production CI failure. */
function ciSignal(row, opts = {}) {
  if (!row || !FAILING_VERDICTS.has(row.verdict)) return null;
  const source = opts.source || "ci";
  const kind = opts.kind || (source === "uat" ? "uat-deploy" : "ci-run");
  const failed = Array.isArray(row.failedJobs) ? row.failedJobs.filter(Boolean) : [];
  const reason = row.reason || (failed.length ? `failed jobs: ${failed.join(", ")}` : `${row.name || "run"} ${row.verdict}`);
  const title = `${row.name || (source === "uat" ? "UAT" : "CI")} ${row.verdict}${
    row.sha ? ` @ ${shortSha(row.sha)}` : ""
  }`;
  return {
    source,
    environment: opts.environment || lib.DEFAULT_ENVIRONMENT[source],
    kind,
    title: title.slice(0, 200),
    error: [reason, row.fix].filter(Boolean).join(" — "),
    test: row.name || null,
    workflow: row.name || null,
    sha: row.sha || opts.sha || null,
    run: row.id == null ? null : String(row.id),
    url: row.url || null,
    verdict: row.verdict,
    repro: row.fix || null,
    evidence_pointer:
      row.url || (row.id != null ? `gh run view ${row.id} --log-failed` : null) || opts.evidencePointer || null,
  };
}

function ciSignals(rows, opts = {}) {
  return (Array.isArray(rows) ? rows : []).map((row) => ciSignal(row, opts)).filter(Boolean);
}

/* One nightly report failure -> one signal. `side: "harness"` is the
 * nightly.js classification for runner/plumbing failures: it becomes an infra
 * signal, which the plan routes to ops — never a product row and never a code
 * fix. A product journey keeps its journey name so the board planner can link it
 * to the reconcile-owned row. */
function nightlySignal(failure, opts = {}) {
  if (!failure || !failure.flow) return null;
  const side = String(failure.side || "").toLowerCase();
  const harness = side === "harness";
  return {
    source: "nightly",
    environment: "nightly",
    kind: harness ? "infra" : "journey",
    title: `${failure.flow} ${failure.phase || "e2e"} failed`.slice(0, 200),
    error: failure.reason || `${failure.flow} failed`,
    test: failure.flow,
    journey: failure.flow,
    side: side || null,
    verdict: harness ? "infra-block" : undefined,
    evidence_pointer: opts.evidencePointer || null,
  };
}

function nightlySignals(report, opts = {}) {
  const failures = Array.isArray(report) ? report : (report && report.failures) || [];
  const pointer = opts.evidencePointer || (report && report.reportRel) || null;
  return failures.map((failure) => nightlySignal(failure, { evidencePointer: pointer })).filter(Boolean);
}

/* Decide the board change for a captured item against the whole-board snapshot
 * (`backlog.js list --all --json` rows: { id, section, task, closed }). Pure. */
function boardActionFor(item, rows, opts = {}) {
  if (!item || !item.signature) return { action: "none", marker: null, reason: "no signature" };
  const marker = lib.boardMarker(item);
  const all = (Array.isArray(rows) ? rows : []).filter(Boolean);
  const taskOf = (r) => String(r.task || "");
  const open = all.filter((r) => r.section !== "archive");
  const archived = all.filter((r) => r.section === "archive");

  const marked = open.find((r) => taskOf(r).includes(marker));
  if (marked) return { action: "link", id: marked.id, marker, reason: "row already tracks this signature" };

  if (item.state === "ignored" || item.route === "off") {
    return { action: "none", marker, reason: "ignored signals get no row" };
  }

  // A product journey failure already has the reconcile-owned row. Filing a
  // second row for the same journey is the duplicate-row churn the plan forbids.
  // An infra/harness item must NOT link there: the ops signal is not evidence
  // about the product, so it gets its own escalated row.
  if (item.source === "nightly" && item.test && item.class !== "infra") {
    const tag = `[nightly:flow=${String(item.test).toLowerCase()}]`;
    const flowRow = open.find((r) => taskOf(r).toLowerCase().includes(tag));
    if (flowRow) {
      return { action: "link", id: flowRow.id, marker, reason: "nightly reconcile owns the journey row" };
    }
  }

  const wasArchived = archived.find((r) => taskOf(r).includes(marker));
  if (wasArchived) {
    return {
      action: "reopen",
      id: wasArchived.id,
      marker,
      priority: item.severity || "P1",
      reason: `recurrence of ${item.id} (${item.occurrences || 1} observation(s))`,
    };
  }

  const pointer = firstPointer(item);
  return {
    action: "add",
    marker,
    priority: /^P[1-4]$/.test(String(item.severity || "")) ? item.severity : "P2",
    task: `${marker} [${item.source}] ${item.title} (${item.class}/${item.risk})`,
    evidence: [item.id, `${item.class}/${item.risk}`, item.route, pointer].filter(Boolean).join(" · "),
    reason: opts.reason || "one row per active signature",
  };
}

module.exports = {
  FAILING_VERDICTS,
  ciSignal,
  ciSignals,
  nightlySignal,
  nightlySignals,
  boardActionFor,
};
