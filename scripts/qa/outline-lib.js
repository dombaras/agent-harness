#!/usr/bin/env node
"use strict";
/*
 * outline-lib — progressive disclosure for markdown, plus the oversized-read
 * guard for `.agents/**` state docs (F-059).
 *
 * The 2026-11 LibraryOS recon measured a 52,020 B `FINDINGS-REGISTER.md` read
 * whole (context 32,880 -> 47,382 tokens) when the first edit landed only at
 * 72,577; a headings-first read would have saved ~10-15K tokens. Two pieces fix
 * that class:
 *
 *   - `parseHeadings` / `renderOutline`: a fence-aware heading outline with the
 *     line range of every section, so an agent can open one section with
 *     `read` offset/limit instead of the whole file.
 *   - `stateDocReadDecision` / `stateDocReadText`: the pre-read guard the
 *     context-guard plugin applies to an UNRANGED read of a large `.agents/**`
 *     markdown file. It is a decision + text pair only; the plugin owns `stat`
 *     and the abort, so this module stays dependency-free and unit-testable.
 *
 * A heading inside a fenced code block is not a section (registers commonly
 * quote markdown), and the fence tracking is shared by both functions.
 */

const path = require("path");

const DEFAULT_STATE_DOC_BYTES = 12000;
const DEFAULT_MAX_HEADINGS = 40;

const FENCE = /^\s*(`{3,}|~{3,})/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/* The section extents a resumer needs: `line` is the heading's 1-based line and
 * `endLine` is the line before the next heading at the same or a higher level
 * (the file's last line for the final section). Fence-aware; never throws. */
function parseHeadings(text) {
  const lines = String(text || "").split(/\r?\n/);
  const found = [];
  let fence = null; // { char, size } while inside a fenced block
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = line.match(FENCE);
    if (f) {
      const char = f[1][0];
      const size = f[1].length;
      if (!fence) fence = { char, size };
      else if (char === fence.char && size >= fence.size) fence = null;
      continue;
    }
    if (fence) continue;
    const h = line.match(HEADING);
    if (!h) continue;
    found.push({ level: h[1].length, name: h[2].trim(), line: i + 1, endLine: lines.length });
  }
  for (let i = 0; i < found.length; i++) {
    const level = found[i].level;
    for (let j = i + 1; j < found.length; j++) {
      if (found[j].level <= level) {
        found[i].endLine = found[j].line - 1;
        break;
      }
    }
  }
  return found;
}

function indent(level) {
  return "  ".repeat(Math.max(0, Number(level || 1) - 1));
}

/* One outline line per section: a fixed-width line range so the caller can copy
 * it straight into `read` offset/limit. `##`-level depth is indented. */
function formatHeading(h) {
  const start = String(h.line).padStart(5);
  const end = String(h.endLine).padStart(5);
  return `  L${start}-${end}  ${indent(h.level)}${"#".repeat(h.level)} ${h.name}`;
}

/* Render the human/agent outline. `file` is display-only (keep it repo-relative
 * so the text is byte-stable across checkouts). `max` bounds the line count so
 * a 500-heading register cannot itself become a context dump. */
function renderOutline(file, text, opts) {
  const o = opts || {};
  const headings = parseHeadings(text);
  const maxLevel = Math.max(1, Number(o.maxLevel) || 6);
  const max = Math.max(1, Number(o.max) || DEFAULT_MAX_HEADINGS);
  const visible = headings.filter((h) => h.level <= maxLevel);
  const lines = visible.slice(0, max).map(formatHeading);
  const hidden = visible.length - lines.length;
  const bytes = o.bytes != null ? Number(o.bytes) : Buffer.byteLength(String(text || ""), "utf8");
  const lineCount = String(text || "").split(/\r?\n/).length;
  const header = `state-doc outline — ${file || "(stdin)"} (${bytes.toLocaleString("en-US")} B, ${lineCount} lines)`;
  const notes = [];
  if (hidden > 0) notes.push(`  … ${hidden} more heading(s); raise --max or lower --max-level`);
  if (!lines.length) notes.push("  (no markdown headings)");
  return [header, ...lines, ...notes].join("\n");
}

function jsonOutline(file, text, opts) {
  const o = opts || {};
  const bytes = o.bytes != null ? Number(o.bytes) : Buffer.byteLength(String(text || ""), "utf8");
  return JSON.stringify(
    {
      file: file || null,
      bytes,
      lines: String(text || "").split(/\r?\n/).length,
      headings: parseHeadings(text),
    },
    null,
    2
  );
}

/* Normalize a tool argument to a repo-relative POSIX path. Absolute paths are
 * accepted (an agent may pass one) and are only a state doc when they resolve
 * inside `root`; a `..` escape therefore fails. */
function relativePath(filePath, root) {
  const p = String(filePath || "").trim();
  if (!p) return "";
  const norm = path.normalize(p.replace(/\\/g, "/"));
  if (path.isAbsolute(norm)) {
    const base = path.resolve(root || process.cwd());
    const rel = path.relative(base, norm);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return "";
    return rel.split(path.sep).join("/");
  }
  const rel = norm.replace(/^\.\//, "");
  if (rel.startsWith("../") || rel === "..") return "";
  return rel.split(path.sep).join("/");
}

/* Is this path a state doc the guard owns: a markdown file under `.agents/`?
 * Review registers, handoffs, qa plans, and memory all live there; code,
 * CHANGELOG, and project docs are deliberately outside. */
function isStateDocPath(filePath, root) {
  const rel = relativePath(filePath, root);
  if (!rel) return "";
  if (!/^\.agents\/.+\.md$/i.test(rel)) return "";
  return rel;
}

function limitBytesFromEnv(env) {
  const raw = Number(env && env.AGENT_STATE_READ_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STATE_DOC_BYTES;
}

/* The pre-read decision. Pure: the caller supplies the file's byte size and the
 * tool args; this returns whether to abort an unranged read of a large state
 * doc. An explicit `offset`/`limit` is always allowed (that is the fix, not the
 * violation); `AGENT_GUARD_STATEDOC=0` disables the block deliberately. */
function stateDocReadDecision(input) {
  const o = input || {};
  const env = o.env || process.env;
  const rel = isStateDocPath(o.filePath, o.root);
  const bytes = Number(o.bytes) || 0;
  const limitBytes = Number(o.limitBytes) || limitBytesFromEnv(env);
  const ranged = o.args && (o.args.offset != null || o.args.limit != null);
  const disabled = String(env.AGENT_GUARD_STATEDOC || "") === "0";
  if (!rel || ranged || disabled || bytes < limitBytes) {
    return { block: false, reason: null, relPath: rel || "", bytes, limitBytes };
  }
  return { block: true, reason: "oversized-state-doc", relPath: rel, bytes, limitBytes };
}

/* The abort text: bounded (first `max` headings), names the exact ranged call to
 * make next, and points at the `outline` tool for the full list. */
function stateDocReadText(decision, text, opts) {
  const o = opts || {};
  const d = decision || {};
  const rel = d.relPath || String(o.filePath || "");
  const max = Math.max(1, Number(o.max) || DEFAULT_MAX_HEADINGS);
  const headings = parseHeadings(text);
  const visible = headings.slice(0, max);
  const hidden = headings.length - visible.length;
  const first = visible.find((h) => h.level > 1 && h.endLine >= h.line) || visible[0];
  const lines = [
    `TOOL GUARD — \`${rel}\` is a large state doc (${Number(d.bytes || 0).toLocaleString("en-US")} B > ` +
      `${Number(d.limitBytes || 0).toLocaleString("en-US")} B). Do not read it whole: ` +
      "open one section with `read` offset/limit (or run the `outline` tool first).",
  ];
  if (visible.length) lines.push("", "Outline (L<start>-<end>):", ...visible.map(formatHeading));
  if (hidden > 0) lines.push(`  … ${hidden} more heading(s); run \`outline\` for the full list`);
  if (!headings.length) lines.push("", "The file has no markdown headings — read a bounded range (e.g. offset: 1, limit: 80).");
  else if (first) {
    lines.push("", `Next call: read(filePath: "${rel}", offset: ${first.line}, limit: ${Math.max(1, first.endLine - first.line + 1)}).`);
  }
  lines.push("(Disable this block with AGENT_GUARD_STATEDOC=0.)");
  return lines.join("\n");
}

module.exports = {
  DEFAULT_STATE_DOC_BYTES,
  DEFAULT_MAX_HEADINGS,
  parseHeadings,
  formatHeading,
  renderOutline,
  jsonOutline,
  relativePath,
  isStateDocPath,
  stateDocReadDecision,
  stateDocReadText,
};
