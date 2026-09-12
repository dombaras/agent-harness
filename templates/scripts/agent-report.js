#!/usr/bin/env node
"use strict";
/*
 * agent-report — deterministic agent-dispatch efficiency report.
 *
 * Reads every session handoff (`.agents/handoffs/*.md`, plus the legacy
 * `.agents/memory/handoff.md`) and aggregates the wrap-up dispatch log so a
 * session can answer "why did we spend this inference budget?" without reading
 * every transcript. No LLM in the loop — pure Node, deterministic.
 *
 * Aggregates: dispatches per feature / persona / model, recorded retries,
 * recorded escalations, structured session metadata (work_type / outcome /
 * termination_reason / checkpoint_count), and a per-feature trace (`--json`).
 * Token/cost is intentionally NOT fabricated here — the handoff records dispatch
 * intent, not per-token telemetry. With `--cost` the observed provider data
 * (opencode store, via `scripts/qa/provider-stats.js`) is joined in through the
 * handoff `session:` metadata, giving cost per feature / per shipped feature.
 *
 * Usage:
 *   node scripts/agent-report.js                     # human-readable report
 *   node scripts/agent-report.js --json              # machine-readable trace
 *   node scripts/agent-report.js --cost --since=14d  # + observed provider cost
 *   node scripts/agent-report.js --cost --export provider.json   # write fixture
 *   node scripts/agent-report.js --cost --fixture provider.json  # read fixture
 */

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const out = {
    json: false,
    cost: false,
    since: null,
    fixture: null,
    exportFile: null,
    opencode: null,
    root,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--cost") out.cost = true;
    else if (a === "--since") out.since = argv[++i];
    else if (a.startsWith("--since=")) out.since = a.slice("--since=".length);
    else if (a === "--fixture") out.fixture = argv[++i];
    else if (a === "--export") out.exportFile = argv[++i];
    else if (a === "--opencode") out.opencode = argv[++i];
    else if (a === "--root") out.root = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const json = args.json;

/* All handoff files: every `.md` under `.agents/handoffs/` (recursive), plus the
 * legacy single `.agents/memory/handoff.md` if present. `README.md` files are
 * documentation, not handoffs, so they are skipped. Sorted for deterministic
 * output (mirrors scripts/qa/governance.js). */
function handoffFiles() {
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

/* Extract the body of a `## <heading>` section (until the next heading).
 * A trailing qualifier is allowed (`## Session metadata (structured — ...)`
 * is the template heading), so both bare and suffixed forms parse. */
function section(src, heading) {
  const re = new RegExp("^#{1,6}\\s*" + heading + "\\b.*$", "im");
  const m = src.match(re);
  if (!m) return "";
  const after = src.slice(m.index + m[0].length);
  const tail = after.match(/^#{1,6}\s/m);
  return (tail ? after.slice(0, tail.index) : after).trim();
}

/* Strip surrounding backticks / whitespace and normalize a "(per routing)"
 * placeholder to "?" (the handoff did not record a concrete model). */
function cleanCell(s) {
  return String(s == null ? "" : s).replace(/^`+|`+$/g, "").trim();
}
function normModel(s) {
  const m = cleanCell(s);
  return m && !/^\(per routing\)$/i.test(m) ? m : "?";
}

/* Parse dispatch-log entries. Accepted shapes (mirror governance.js, plus the
 * table variants seen in the wild):
 *   bullet:  - <persona> -> <model> -> <shipped/deferred>
 *   table:   | subagent | model | shipped/deferred |      (header + separator)
 *   table:   | # | Subagent | Model | Shipped | Deferred |  (indexed table)
 * Tables are parsed by their HEADER row, so column order never matters. */
function parseDispatchEntries(sectionText) {
  const entries = [];
  const lines = sectionText.split(/\r?\n/);
  let header = null;
  let seenSeparator = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // bullet form: - persona -> model -> status
    const bullet = line.match(/^[-*]\s+(.+?)\s*->\s*([^\s>]+)\s*->\s*(.+)$/);
    if (bullet) {
      entries.push({ persona: cleanCell(bullet[1]), model: normModel(bullet[2]), status: bullet[3].trim() });
      continue;
    }

    // table form
    if (/^\|.*\|$/.test(line)) {
      if (/^\|(\s*:?-+:?\s*\|)+\s*$/.test(line)) {
        seenSeparator = true;
        continue;
      }
      const cells = line.slice(1, -1).split("|").map((c) => c.trim());
      if (!header) {
        // First data-looking row is the header: map column roles by keyword.
        header = cells.map((c, idx) => ({ idx, text: c.toLowerCase() }));
        continue;
      }
      if (!seenSeparator) continue;
      const findIdx = (re) => header.findIndex((h) => re.test(h.text));
      const modelIdx = findIdx(/model/);
      const statusIdx = findIdx(/shipped|deferred|status/);
      let personaIdx = findIdx(/subagent|persona|agent/);
      if (personaIdx === -1) {
        // No named persona column: first column that isn't a bare `#` index and
        // isn't the model/status column.
        personaIdx = cells.findIndex((c, i) => c && !/^#?$/.test(c) && i !== modelIdx && i !== statusIdx);
      }
      if (personaIdx === -1 || !cells[personaIdx]) continue;
      entries.push({
        persona: cleanCell(cells[personaIdx]),
        model: modelIdx !== -1 ? normModel(cells[modelIdx]) : "?",
        status: statusIdx !== -1 ? cells[statusIdx] : "shipped",
      });
    }
  }
  return entries;
}

/* Parse a bulleted list section (`## Retries` / `## Escalations`) into strings. */
function parseListItems(sectionText) {
  const items = [];
  for (const raw of sectionText.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^[-*]\s+\S/.test(line)) items.push(line.replace(/^[-*]\s+/, "").trim());
  }
  return items;
}

/* Parse the `## Session metadata` block: bullet `- key: value` lines into a
 * plain object. Values are kept verbatim (never normalized/inferred); absent
 * keys stay undefined so "not recorded" is distinguishable from "unknown". */
function parseSessionMetadata(sectionText) {
  const meta = {};
  for (const raw of sectionText.split(/\r?\n/)) {
    const m = raw.trim().match(/^[-*]\s+([a-z_]+)\s*:\s*(.+)$/i);
    if (m) meta[m[1].toLowerCase()] = m[2].trim();
  }
  return meta;
}

/* Controlled vocabularies (mirror .agents/skills/handoff/SKILL.md). */
const WORK_TYPES = [
  "feature", "bugfix", "investigation", "architecture", "planning", "qa",
  "security", "maintenance", "process", "conversation", "other",
];
const OUTCOMES = [
  "shipped", "resolved", "deferred", "investigation-complete", "abandoned",
  "superseded", "conversation-only",
];

const files = handoffFiles();

if (files.length === 0) {
  console.log("No handoffs found under .agents/handoffs/ — nothing to report.");
  process.exit(0);
}

const perFeature = {};
const personaCount = {};
const modelCount = {};
const workTypeCount = {};
const outcomeCount = {};
const terminationCount = {};
const VALIDATION_WARNINGS = [];
let totalDispatches = 0;
let totalRetries = 0;
let totalEscalations = 0;
let totalCheckpoints = 0;

function bump(map, key) {
  if (!key) return;
  map[key] = (map[key] || 0) + 1;
}

for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  const feature = path.basename(file, ".md");
  const entries = parseDispatchEntries(section(src, "Dispatch log"));
  const retries = parseListItems(section(src, "Retries"));
  const escalations = parseListItems(section(src, "Escalations"));
  const meta = parseSessionMetadata(section(src, "Session metadata"));

  perFeature[feature] = { dispatches: entries, retries, escalations, meta };
  totalRetries += retries.length;
  totalEscalations += escalations.length;

  const workType = meta.work_type;
  const outcome = meta.outcome;
  const termination = meta.termination_reason;
  if (workType && !WORK_TYPES.includes(workType))
    VALIDATION_WARNINGS.push(`${feature}: metadata work_type \`${workType}\` is not in the controlled vocabulary`);
  if (outcome && !OUTCOMES.includes(outcome))
    VALIDATION_WARNINGS.push(`${feature}: metadata outcome \`${outcome}\` is not in the controlled vocabulary`);
  bump(workTypeCount, workType);
  bump(outcomeCount, outcome);
  bump(terminationCount, termination);
  const checkpoints = parseInt(meta.checkpoint_count, 10);
  if (!Number.isNaN(checkpoints)) totalCheckpoints += checkpoints;

  for (const e of entries) {
    totalDispatches += 1;
    personaCount[e.persona] = (personaCount[e.persona] || 0) + 1;
    modelCount[e.model] = (modelCount[e.model] || 0) + 1;
  }
}

/* Deterministic, defensible suggestions only — never a speculative "could have".
 * Fan-out / repeated-dispatch thresholds mirror .agents/memory/orchestration.md
 * (5+ dispatches = planner justification, 8+ = explicit fan-out review). */
const FAN_OUT_REVIEW = 8;
const FAN_OUT_JUSTIFY = 5;
const suggestions = [];
for (const [feature, f] of Object.entries(perFeature)) {
  const seen = new Set();
  let duplicates = 0;
  for (const e of f.dispatches) {
    if (seen.has(e.persona)) duplicates += 1;
    seen.add(e.persona);
  }
  if (duplicates > 0) {
    suggestions.push(
      `${feature}: ${duplicates} duplicate persona dispatch(es) — absorb-before-spawn candidate`
    );
  }
  if (f.dispatches.length >= FAN_OUT_REVIEW) {
    suggestions.push(
      `${feature}: ${f.dispatches.length} dispatches (\u2265${FAN_OUT_REVIEW}) — requires explicit fan-out review (see orchestration.md)`
    );
  } else if (f.dispatches.length >= FAN_OUT_JUSTIFY) {
    suggestions.push(
      `${feature}: ${f.dispatches.length} dispatches (\u2265${FAN_OUT_JUSTIFY}) — planner should carry decomposition justification`
    );
  }
  const retried = f.retries.filter((r) => /attempt|same|identical|re[- ]?ran/i.test(r));
  if (retried.length >= 2) {
    suggestions.push(
      `${feature}: ${retried.length} retries with no stated change — a retry must change instructions/context/model/decomposition/diagnostics`
    );
  }
}

/* Join observed provider sessions to handoff `session:` metadata: the primary
 * orchestrator session id mapped to its provider group (primary + subagent
 * child sessions) gives real cost per feature / per shipped feature. Handoffs
 * without a recorded session, or whose session is outside the window, are
 * reported as unmatched — never guessed. When a primary session observed on a
 * declared escalation model has no recorded reason (`model_escalation_evidence`
 * metadata or an `## Escalations` bullet), it is flagged — never assumed. */
function escalationEvidenceOf(f) {
  const meta = f.meta.model_escalation_evidence;
  if (meta && !/^(none|no|n\/a|\?|unknown)$/i.test(meta.trim())) return meta.trim();
  if (f.escalations && f.escalations.length) return f.escalations.join("; ");
  return null;
}

function providerJoin(features, providerStats, escalationIds) {
  const byId = new Map(providerStats.sessions.map((s) => [s.id, s]));
  const groups = providerStats.aggregates.groups || {};
  const byFeature = {};
  let matched = 0;
  for (const [feature, f] of Object.entries(features)) {
    const sid = f.meta.session;
    if (!sid) continue;
    const s = byId.get(sid);
    if (!s) {
      byFeature[feature] = { session: sid, status: "not in provider window" };
      continue;
    }
    let cur = s;
    const seen = new Set();
    while (cur.parentId && byId.has(cur.parentId) && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = byId.get(cur.parentId);
    }
    const g = groups[cur.id] || { cost: s.cost, turns: s.turns, totalTurns: s.turns, sessions: 1 };
    byFeature[feature] = {
      session: sid,
      rootId: cur.id,
      rootModel: g.rootModel || s.model || null,
      cost: g.cost,
      turns: g.turns,
      totalTurns: g.totalTurns,
      sessions: g.sessions,
      outcome: f.meta.outcome || null,
      escalated: !!escalationIds && escalationIds.has(cur.id),
      escalationEvidence: escalationEvidenceOf(f),
    };
    matched += 1;
  }
  const entries = Object.values(byFeature);
  const successful = entries.filter(
    (h) => typeof h.cost === "number" && (h.outcome === "shipped" || h.outcome === "resolved")
  );
  const shippedCost = successful.reduce((a, h) => a + h.cost, 0);
  const matchedSessions = new Set(entries.map((h) => h.session));
  const roots = providerStats.sessions.filter((s) => !s.parentId || !byId.has(s.parentId));

  const escalated = Object.entries(byFeature).filter(([, h]) => h.escalated && !h.status);
  const withEvidence = escalated.filter(([, h]) => h.escalationEvidence);
  const withoutEvidence = escalated.filter(([, h]) => !h.escalationEvidence);
  const matchedRoots = new Set(entries.filter((h) => !h.status).map((h) => h.rootId));
  const escalation = {
    models: (providerStats.aggregates.escalation && providerStats.aggregates.escalation.models) || [],
    proSessions: (providerStats.aggregates.escalation && providerStats.aggregates.escalation.count) || 0,
    matchedProSessions: escalated.length,
    withEvidence: withEvidence.length,
    withoutEvidence: withoutEvidence.map(([feature, h]) => ({
      feature,
      model: h.rootModel,
      session: h.rootId,
    })),
    unobservable: ((providerStats.aggregates.escalation && providerStats.aggregates.escalation.rootIds) || []).filter(
      (id) => !matchedRoots.has(id)
    ),
  };

  return {
    matched,
    handoffsWithSession: Object.values(features).filter((f) => f.meta.session).length,
    unmatchedHandoffs: entries.filter((h) => h.status).length,
    unmatchedSessions: roots.filter((s) => !matchedSessions.has(s.id)).length,
    shippedCount: successful.length,
    shippedCost,
    costPerShippedFeature: successful.length ? shippedCost / successful.length : null,
    escalation,
    byFeature,
  };
}

function sortCounts(obj) {
  return Object.entries(obj).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/* `--cost`: observed provider telemetry, joined to the handoffs. Fails loudly
 * when the store is unreachable instead of printing fabricated numbers. */
let provider = null;
if (args.cost) {
  const ps = require("./qa/provider-stats.js");
  const stats = args.fixture
    ? ps.readFixture(args.fixture)
    : ps.collectStats({ root: args.root, since: args.since, opencode: args.opencode });
  const thresholds = ps.readThresholds(args.root);
  const tiers = stats.meta.modelTiers || ps.readModelTiers(args.root);
  const aggregates = ps.aggregateSessions(stats.sessions, {
    stuck: stats.meta.stuck || thresholds.stuck,
    softTurnBudget: stats.meta.softTurnBudget,
    opportunisticModels: tiers.opportunistic,
    escalationModels: tiers.escalation,
  });
  if (args.exportFile) ps.writeFixture(args.exportFile, stats);
  provider = {
    meta: stats.meta,
    aggregates,
    join: providerJoin(perFeature, { sessions: stats.sessions, aggregates }, new Set(aggregates.escalation.rootIds)),
  };
}

if (json) {
  const payload = {
    schema: "agent-report/1",
    features: perFeature,
    personaCount,
    modelCount,
    totalDispatches,
    totalRetries,
    totalEscalations,
    totalCheckpoints,
    workTypeCount,
    outcomeCount,
    terminationCount,
    validationWarnings: VALIDATION_WARNINGS,
    suggestions,
  };
  if (provider) payload.provider = provider;
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log("Agent efficiency report\n");
  console.log(`Features (handoffs): ${files.length}`);
  console.log(`Total dispatches:   ${totalDispatches}`);
  console.log(`Retries recorded:   ${totalRetries}`);
  console.log(`Escalations:        ${totalEscalations}`);
  console.log(`Checkpoints:        ${totalCheckpoints}\n`);

  console.log("Work type (recorded):");
  for (const [k, c] of sortCounts(workTypeCount)) console.log(`  ${k.padEnd(22)} ${c}`);
  console.log("\nOutcome (recorded):");
  for (const [k, c] of sortCounts(outcomeCount)) console.log(`  ${k.padEnd(22)} ${c}`);
  console.log("\nTermination reason (recorded):");
  for (const [k, c] of sortCounts(terminationCount)) console.log(`  ${k.padEnd(22)} ${c}`);

  console.log("\nDispatches by persona:");
  for (const [p, c] of sortCounts(personaCount)) console.log(`  ${p.padEnd(22)} ${c}`);
  console.log("\nDispatches by model:");
  for (const [m, c] of sortCounts(modelCount)) console.log(`  ${m.padEnd(40)} ${c}`);

  console.log("\nPer-feature:");
  for (const [feature, f] of Object.entries(perFeature)) {
    const personas = f.dispatches.map((e) => `${e.persona} \u2192 ${e.model}`).join(", ") || "(none)";
    console.log(`  ${feature.padEnd(28)} ${f.dispatches.length} dispatch(es): ${personas}`);
    for (const r of f.retries) console.log(`    retry: ${r}`);
    for (const e of f.escalations) console.log(`    escalation: ${e}`);
    const metaBits = [];
    if (f.meta.work_type) metaBits.push(`work_type: ${f.meta.work_type}`);
    if (f.meta.outcome) metaBits.push(`outcome: ${f.meta.outcome}`);
    if (f.meta.termination_reason) metaBits.push(`termination_reason: ${f.meta.termination_reason}`);
    if (metaBits.length) console.log(`    metadata: ${metaBits.join(" · ")}`);
  }

  if (VALIDATION_WARNINGS.length) {
    console.log("\nValidation warnings (metadata outside the controlled vocabulary):");
    for (const w of VALIDATION_WARNINGS) console.log(`  - ${w}`);
  }

  if (suggestions.length) {
    console.log("\nPotential savings (deterministic heuristics):");
    for (const s of suggestions) console.log(`  - ${s}`);
  } else {
    console.log("\nPotential savings: none flagged.");
  }

  if (provider) {
    const t = provider.aggregates.totals;
    const since = provider.meta.since ? provider.meta.since.arg : "all time";
    console.log(`\nCost telemetry (observed provider data — ${provider.meta.root}, ${since}):`);
    if (t.sessions === 0) {
      console.log(`  No provider sessions: ${provider.meta.note || "none in this window"}.`);
    } else {
      console.log(
        `  ${t.sessions} sessions (${t.primarySessions} primary + ${t.subagentSessions} subagent) · ${"$" + t.cost.toFixed(4)} total`
      );
      console.log(
        `  Cache-read share: ${t.cacheReadShare == null ? "n/a" : (t.cacheReadShare * 100).toFixed(1) + "% of input tokens"}` +
          ` · turns/primary P50 ${provider.aggregates.percentiles.primaryTurns.p50 == null ? "n/a" : provider.aggregates.percentiles.primaryTurns.p50}` +
          ` / P90 ${provider.aggregates.percentiles.primaryTurns.p90 == null ? "n/a" : provider.aggregates.percentiles.primaryTurns.p90}`
      );
      console.log(
        `  Primary sessions over ${provider.aggregates.sessionsOverTurnBudget.threshold} turns: ${provider.aggregates.sessionsOverTurnBudget.count}` +
          ` · identical-call loops (>= ${provider.aggregates.loopCandidates.threshold}x): ${provider.aggregates.loopCandidates.count}`
      );
      if (provider.aggregates.topSessions.length) {
        console.log("  Top primary sessions by cost:");
        for (const s of provider.aggregates.topSessions) {
          console.log(`    ${("$" + s.cost.toFixed(4)).padStart(10)}  ${s.id}  ${s.title.slice(0, 50)}`);
        }
      }
    }
    const j = provider.join;
    if (j.handoffsWithSession > 0 || j.unmatchedSessions > 0) {
      console.log(
        `  Session join: ${j.matched}/${j.handoffsWithSession} handoffs with a recorded session matched` +
          (j.unmatchedHandoffs ? ` · ${j.unmatchedHandoffs} outside the provider window` : "") +
          (j.unmatchedSessions ? ` · ${j.unmatchedSessions} primary session(s) with no handoff in window` : "")
      );
      for (const [feature, h] of Object.entries(j.byFeature)) {
        if (h.status) console.log(`    ${feature.padEnd(24)} (${h.status})`);
        else
          console.log(
            `    ${feature.padEnd(24)} ${("$" + h.cost.toFixed(4)).padStart(10)}  ${h.totalTurns} turn(s) · ${h.sessions} session(s) · outcome: ${h.outcome || "unknown"}`
          );
      }
      console.log(
        `  Cost per shipped feature: ${
          j.costPerShippedFeature == null
            ? "n/a (no shipped/resolved handoff with a session)"
            : "$" + j.costPerShippedFeature.toFixed(4) + " (" + j.shippedCount + " feature(s))"
        }`
      );
      const esc = j.escalation;
      if (esc && esc.proSessions > 0) {
        console.log(
          `  Escalation evidence: ${esc.proSessions} primary session(s) on a pro model (${esc.models.join(", ")}) — ` +
            `${esc.withEvidence} with a recorded reason, ${esc.withoutEvidence.length} without` +
            (esc.unobservable.length ? ` · ${esc.unobservable.length} with no handoff in window` : "")
        );
        for (const u of esc.withoutEvidence)
          console.log(`    ${u.feature.padEnd(24)} ${u.model} (no model_escalation_evidence recorded)`);
      }
    }
  }

  console.log(
    provider
      ? "\nNote: dispatch intent and session metadata are recorded verbatim (absent = not counted,\n" +
          "distinct from `unknown`, which is counted). Cost/token/turn numbers above are observed\n" +
          "provider data from the opencode store — never inferred from text length."
      : "\nNote: token/cost is not fabricated here — the handoff records dispatch intent and\n" +
          "session metadata, not per-token telemetry. Run with --cost to join observed provider\n" +
          "data via the handoff `session:` metadata. Recorded values are verbatim; absent metadata\n" +
          "is simply not counted (distinct from `unknown`, which is counted)."
  );
}
