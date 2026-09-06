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
 * recorded escalations, and a per-feature trace (`--json`). Token/cost is
 * intentionally NOT fabricated here — the handoff records dispatch intent, not
 * per-token telemetry; that lives in the provider's own session stats.
 *
 * Usage:
 *   node scripts/agent-report.js            # human-readable report
 *   node scripts/agent-report.js --json     # machine-readable trace
 */

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const json = process.argv.includes("--json");

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

/* Extract the body of a `## <heading>` section (until the next heading). */
function section(src, heading) {
  const re = new RegExp("^#{1,6}\\s*" + heading + "\\s*$", "im");
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

const files = handoffFiles();

if (files.length === 0) {
  console.log("No handoffs found under .agents/handoffs/ — nothing to report.");
  process.exit(0);
}

const perFeature = {};
const personaCount = {};
const modelCount = {};
let totalDispatches = 0;
let totalRetries = 0;
let totalEscalations = 0;

for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  const feature = path.basename(file, ".md");
  const entries = parseDispatchEntries(section(src, "Dispatch log"));
  const retries = parseListItems(section(src, "Retries"));
  const escalations = parseListItems(section(src, "Escalations"));

  perFeature[feature] = { dispatches: entries, retries, escalations };
  totalRetries += retries.length;
  totalEscalations += escalations.length;

  for (const e of entries) {
    totalDispatches += 1;
    personaCount[e.persona] = (personaCount[e.persona] || 0) + 1;
    modelCount[e.model] = (modelCount[e.model] || 0) + 1;
  }
}

/* Deterministic, defensible suggestions only — never a speculative "could have". */
const suggestions = [];
for (const [feature, f] of Object.entries(perFeature)) {
  const seen = new Set();
  for (const e of f.dispatches) {
    if (seen.has(e.persona)) {
      suggestions.push(
        `${feature}: dispatched \`${e.persona}\` more than once — absorb-before-spawn candidate`
      );
    }
    seen.add(e.persona);
  }
}

function sortCounts(obj) {
  return Object.entries(obj).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

if (json) {
  console.log(
    JSON.stringify(
      { features: perFeature, personaCount, modelCount, totalDispatches, totalRetries, totalEscalations, suggestions },
      null,
      2
    )
  );
} else {
  console.log("Agent efficiency report\n");
  console.log(`Features (handoffs): ${files.length}`);
  console.log(`Total dispatches:   ${totalDispatches}`);
  console.log(`Retries recorded:   ${totalRetries}`);
  console.log(`Escalations:        ${totalEscalations}\n`);

  console.log("Dispatches by persona:");
  for (const [p, c] of sortCounts(personaCount)) console.log(`  ${p.padEnd(22)} ${c}`);
  console.log("\nDispatches by model:");
  for (const [m, c] of sortCounts(modelCount)) console.log(`  ${m.padEnd(40)} ${c}`);

  console.log("\nPer-feature:");
  for (const [feature, f] of Object.entries(perFeature)) {
    const personas = f.dispatches.map((e) => `${e.persona} \u2192 ${e.model}`).join(", ") || "(none)";
    console.log(`  ${feature.padEnd(28)} ${f.dispatches.length} dispatch(es): ${personas}`);
    for (const r of f.retries) console.log(`    retry: ${r}`);
    for (const e of f.escalations) console.log(`    escalation: ${e}`);
  }

  if (suggestions.length) {
    console.log("\nPotential savings (deterministic heuristics):");
    for (const s of suggestions) console.log(`  - ${s}`);
  } else {
    console.log("\nPotential savings: none flagged.");
  }

  console.log(
    "\nNote: token/cost is not fabricated here — the handoff records dispatch intent, " +
      "not per-token telemetry. For per-session token/cost, see the provider/opencode session stats."
  );
}
