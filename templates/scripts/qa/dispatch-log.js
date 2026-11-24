#!/usr/bin/env node
"use strict";
/*
 * dispatch-log — derive the wrap-up dispatch log from observed child sessions
 * (F-025 S5).
 *
 * The gate exists because an empty log hides whether inference was spent. The
 * failure it does not catch is the honest empty log: a session that ran direct
 * (T0/T1) still has to say so, and a session that did dispatch should not retype
 * the rows from memory. This module derives the rows from the store (the same
 * child sessions `orient` prices) and writes one marker-bounded block into the
 * feature handoff. `finalize` calls it before staging, so the tail cannot ship
 * with the checkpoint placeholder still in place (F-358).
 *
 * It never overwrites a log that already has a parseable entry: a hand-authored
 * line is evidence too. Pure functions take the text/rows; the store is opt-in.
 */

const fs = require("fs");

const START = "<!-- dispatch-log:start -->";
const END = "<!-- dispatch-log:end -->";

const PLACEHOLDER = /^[-*]\s*\((?:checkpoint only|no dispatches|none)[^)]*\)\s*$/i;

/* Bullet or table entries (mirrors scripts/agent-report.js and governance.js). */
function parseEntries(text) {
  const section = sectionText(text);
  if (!section) return [];
  const out = [];
  for (const raw of section.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const bullet = line.match(/^[-*]\s+(.+?)\s*->\s*([^\s>]+)\s*->\s*(.+)$/);
    if (bullet) out.push({ persona: bullet[1].trim(), model: bullet[2].trim(), status: bullet[3].trim() });
  }
  return out;
}

function sectionText(text) {
  const src = String(text || "");
  const m = src.match(/^##\s*Dispatch log\b.*$/im);
  if (!m) return "";
  const after = src.slice(m.index + m[0].length);
  const next = after.match(/^##\s/m);
  return (next ? after.slice(0, next.index) : after).trim();
}

function hasEntries(text) {
  return parseEntries(text).length > 0;
}

function hasBlock(text) {
  return String(text || "").includes(START) && String(text || "").includes(END);
}

/* One honest line when no child session was observed. `->` keeps it parseable
 * by the governance/report readers, and the text says why it is alone. */
function directLine() {
  return "- none -> main -> direct (T0/T1, no persona dispatch observed in this session)";
}

function renderBlock(rows) {
  const lines = [START, "## Dispatch log"];
  if (Array.isArray(rows) && rows.length) {
    for (const r of rows) {
      const persona = String(r.persona || r.agent || "?").trim();
      const model = String(r.model || "?").trim();
      const status = String(r.status || r.outcome || "completed").trim();
      lines.push(`- ${persona} -> ${model} -> ${status}`);
    }
  } else {
    lines.push(directLine());
  }
  lines.push(END);
  return lines.join("\n");
}

/* Insert/replace the marker block. A non-marker `## Dispatch log` section is
 * replaced too (the derived block supersedes the placeholder), but a section
 * with a real entry is left untouched by `applyDerivedLog`. */
function replaceBlock(text, block) {
  const src = String(text || "");
  if (hasBlock(src)) {
    const re = new RegExp(`${escapeRe(START)}[\\s\\S]*?${escapeRe(END)}`);
    return src.replace(re, block);
  }
  const heading = src.match(/^##\s*Dispatch log\b.*$/im);
  if (heading) {
    const start = heading.index;
    const after = src.slice(start + heading[0].length);
    const next = after.match(/^##\s/m);
    const end = next ? start + heading[0].length + next.index : src.length;
    const before = src.slice(0, start).replace(/\s*$/, "\n\n");
    const rest = src.slice(end).replace(/^\s*/, "");
    return `${before}${block}\n\n${rest}`;
  }
  // No section: put it immediately before the checkpoint/title tail.
  const anchor = src.match(/^##\s/m);
  if (!anchor) return `${src.trimEnd()}\n\n${block}\n`;
  return `${src.slice(0, anchor.index)}${block}\n\n${src.slice(anchor.index)}`;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* Store rows -> dispatch rows. Tolerant of an older schema: `model` and `title`
 * are optional columns, and an unreachable store returns [] (never a fiction). */
function deriveRows(opts = {}) {
  const query = opts.query;
  if (typeof query !== "function") return [];
  let cols;
  try {
    cols = new Set((query("PRAGMA table_info(session_v2)") || []).map((r) => r.name));
  } catch {
    return [];
  }
  if (!cols.has("agent")) return [];
  const modelCol = cols.has("model") ? "model" : "NULL";
  const titleCol = cols.has("title") ? "title" : "NULL";
  const outcomeCol = cols.has("idle_outcome") ? "idle_outcome" : "NULL";
  const feature = String(opts.feature || "").replace(/'/g, "''");
  const limit = Math.max(1, Math.min(Number(opts.limit) || 30, 100));
  const where = ["parent_id IS NOT NULL", "agent IS NOT NULL"];
  if (feature && titleCol !== "NULL") where.push(`title LIKE '%${feature}%'`);
  let rows;
  try {
    rows = query(
      `SELECT agent, ${modelCol} AS model, ${outcomeCol} AS outcome, time_created
       FROM session_v2 WHERE ${where.join(" AND ")}
       ORDER BY time_created DESC LIMIT ${limit}`
    );
  } catch {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const r of rows || []) {
    const persona = String(r.agent || "").trim();
    if (!persona) continue;
    const model = String(r.model || "?").trim() || "?";
    const key = `${persona}|${model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const outcome = r.outcome ? ` (${r.outcome})` : "";
    out.push({ persona, model, status: `completed${outcome}` });
  }
  return out;
}

/* The one call finalize uses: derive rows, and only rewrite when the log is
 * empty or still the checkpoint placeholder. Returns { text, changed, reason }. */
function applyDerivedLog(text, rows, opts = {}) {
  const src = String(text || "");
  if (hasEntries(src)) return { text: src, changed: false, reason: "existing log kept" };
  const derived = Array.isArray(rows) && rows.length ? rows : [];
  const block = renderBlock(derived);
  const next = replaceBlock(src, block);
  return {
    text: next,
    changed: next !== src,
    reason: derived.length ? `derived ${derived.length} dispatch row(s)` : "no dispatch observed (direct lane)",
  };
}

function parseArgs(argv) {
  const out = { handoff: null, feature: null, check: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--handoff") out.handoff = argv[++i];
    else if (a === "--feature") out.feature = argv[++i];
    else if (a === "--check") out.check = true;
    else if (a === "--json") out.json = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = args.handoff || (args.feature ? `.agents/handoffs/${args.feature}.md` : null);
  if (!file || !fs.existsSync(file)) {
    console.error("dispatch-log: pass --handoff <file> or --feature <id> (file must exist)");
    process.exit(2);
  }
  const text = fs.readFileSync(file, "utf8");
  if (args.check) {
    const rows = parseEntries(text);
    if (args.json) console.log(JSON.stringify({ file, entries: rows }, null, 2));
    else console.log(`${file}: ${rows.length} dispatch entr${rows.length === 1 ? "y" : "ies"}`);
    process.exit(rows.length ? 0 : 1);
  }
  const out = applyDerivedLog(text, []);
  if (out.changed) fs.writeFileSync(file, out.text);
  console.log(`${file}: ${out.reason}`);
}

module.exports = {
  START,
  END,
  parseEntries,
  hasEntries,
  hasBlock,
  renderBlock,
  replaceBlock,
  deriveRows,
  applyDerivedLog,
};

if (require.main === module) main();
