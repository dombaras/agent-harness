#!/usr/bin/env node
"use strict";
/*
 * diagnosis-lib — one parser/validator for the inquiry-loop artifacts.
 *
 * The diagnosis gate (`check-diagnosis.js`), `orient`, `checkpoint` and
 * `feature-scaffold` must agree on the shape of `meta.json` and `diagnosis.md`.
 * Duplicating that shape is how a "ritual" file passes one gate and fails the
 * next, so every reader imports this module and no script re-implements it.
 *
 * Pure functions take text/objects; only `featureDirs`/`readFeature` touch disk.
 * Nothing here mutates a diagnosis: orient/checkpoint may report it stale, never
 * rewrite it.
 *
 * Shape (see also `.agents/features/README.md`):
 *   meta.json      { id, kind, risk, requiresDiagnosis?, outcomeOracle? }
 *   diagnosis.md   status/symptom/confidence + Observed vs expected, Evidence,
 *                  Candidate causes, Ruled out, Falsification, Outcome oracle.
 */
const fs = require("fs");
const path = require("path");

const KINDS = ["bug", "incident", "fix", "feature", "investigate", "ops"];
const DIAGNOSIS_KINDS = new Set(["bug", "incident", "fix"]);
const STATUSES = ["open", "confirmed", "refuted"];
const CONFIDENCES = ["low", "medium", "high"];

const PLACEHOLDER = /^(?:\?+|_?TODO:?.*|tbd|n\/a|-+|\.{2,})$/i;

function isBlank(v) {
  const s = String(v == null ? "" : v).trim();
  return !s || PLACEHOLDER.test(s);
}

/* Normalize an id for comparison: F-040 == f-040 == F040. */
function normalizeId(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/* Does this feature need a diagnosis? Explicit `requiresDiagnosis` wins; a kind
 * that is unknown or absent is treated as a legacy feature (warn only). */
function needsDiagnosis(meta) {
  if (!meta || typeof meta !== "object") return false;
  if (typeof meta.requiresDiagnosis === "boolean") return meta.requiresDiagnosis;
  return DIAGNOSIS_KINDS.has(String(meta.kind || "").toLowerCase());
}

/* A legacy feature has no meta.json: the gate warns, never fails. */
function isLegacy(meta) {
  return !meta || typeof meta !== "object" || !meta.kind;
}

function featureDirs(root) {
  const base = path.join(root, ".agents", "features");
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ slug: e.name, dir: path.join(base, e.name) }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return null;
  }
}

function metaPath(dir) {
  return path.join(dir, "meta.json");
}

function diagnosisPath(dir) {
  return path.join(dir, "diagnosis.md");
}

/* Resolve a feature by meta id, then by directory slug prefix (f-040-*). */
function featureDir(root, id) {
  const want = normalizeId(id);
  if (!want) return null;
  for (const f of featureDirs(root)) {
    const meta = readJson(metaPath(f.dir));
    if (meta && normalizeId(meta.id) === want) return { ...f, meta };
    if (normalizeId(f.slug) === want || normalizeId(f.slug).startsWith(want)) {
      return { ...f, meta: meta || null };
    }
  }
  return null;
}

/* First heading id (`# F-040 — diagnosis`) when present. */
function headingId(text) {
  const m = String(text || "").match(/^#\s*([A-Za-z]+-\d+)\b/m);
  return m ? m[1] : null;
}

function sectionsOf(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    const h = line.match(/^#{2,6}\s*(.+?)\s*$/);
    if (h) {
      cur = { name: h[1].trim(), lines: [] };
      out.push(cur);
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  return out;
}

function section(sections, re) {
  return sections.find((s) => re.test(s.name)) || null;
}

/* Markdown table -> { header, rows } with trimmed cells; separator rows dropped. */
function parseTable(lines) {
  const rows = [];
  for (const raw of lines || []) {
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    const cells = line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === "")) continue;
    rows.push(cells);
  }
  if (!rows.length) return { header: [], rows: [] };
  return { header: rows[0].map((h) => h.toLowerCase()), rows: rows.slice(1) };
}

/* `key: value` scalars from the preamble (before the first `##`). */
function parseScalars(text) {
  const out = {};
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (/^#{2,6}\s/.test(line)) break;
    const m = line.match(/^([A-Za-z][A-Za-z0-9 _-]*):\s*(.*)$/);
    if (m) out[m[1].trim().toLowerCase().replace(/\s+/g, "-")] = m[2].trim();
  }
  return out;
}

/* `- Key: value` bullets from a section (Falsification / Outcome oracle). */
function parseBullets(lines) {
  const out = {};
  for (const raw of lines || []) {
    const m = raw.trim().match(/^[-*+]\s*([^:]+):\s*(.*)$/);
    if (m) out[m[1].trim().toLowerCase().replace(/\s+/g, "-")] = m[2].trim();
  }
  return out;
}

function candidateRows(table) {
  return table.rows.map((cells) => ({
    cause: cells[1] || "",
    likelihood: cells[2] || "",
    test: cells[3] || "",
    result: cells[4] || "",
  }));
}

/* Validate one feature's diagnosis. `meta` may be null (legacy). Returns
 * { ok, required, legacy, errors:[{code,message}], status, confidence, symptom }. */
function validateDiagnosis({ meta, diagnosisText, id } = {}) {
  const feature = String((meta && meta.id) || id || "?").toUpperCase();
  const errors = [];
  const add = (code, message) => errors.push({ code, message: `${feature} diagnosis: ${message}` });

  if (isLegacy(meta)) {
    return { ok: true, required: false, legacy: true, errors: [], status: null, confidence: null, symptom: null };
  }
  if (!KINDS.includes(String(meta.kind || "").toLowerCase())) {
    add("kind", `meta.json kind must be one of ${KINDS.join("|")} (got "${meta.kind}")`);
    return { ok: false, required: false, legacy: false, errors, status: null, confidence: null, symptom: null };
  }
  const required = needsDiagnosis(meta);
  if (!required) {
    return { ok: true, required: false, legacy: false, errors: [], status: null, confidence: null, symptom: null };
  }

  const text = String(diagnosisText || "");
  if (!text.trim()) {
    add("missing", "has no diagnosis.md — create .agents/features/<slug>/diagnosis.md");
    return { ok: false, required, legacy: false, errors, status: null, confidence: null, symptom: null };
  }

  const hid = headingId(text);
  if (hid && normalizeId(hid) !== normalizeId(feature)) {
    add("wrong-feature", `heading is ${hid}, expected ${feature} (a copied diagnosis never carries over)`);
  }

  const s = parseScalars(text);
  const status = String(s.status || "").toLowerCase();
  const confidence = String(s.confidence || "").toLowerCase();
  const symptom = s.symptom || "";
  if (!STATUSES.includes(status)) add("status", `status must be ${STATUSES.join("|")} (got "${s.status || ""}")`);
  if (isBlank(symptom)) add("symptom", "symptom is required (stable lowercase key)");
  if (confidence && !CONFIDENCES.includes(confidence)) add("confidence", `confidence must be ${CONFIDENCES.join("|")}`);
  if (meta.symptom && symptom && String(meta.symptom).toLowerCase() !== symptom.toLowerCase()) {
    add("symptom-mismatch", `symptom "${symptom}" does not match meta.json "${meta.symptom}"`);
  }

  const sections = sectionsOf(text);

  // Evidence: every row needs a pointer (source), not a re-derivation.
  const evidence = section(sections, /^Evidence\b/i);
  const evTable = evidence ? parseTable(evidence.lines) : { header: [], rows: [] };
  if (!evTable.rows.length) add("evidence", "## Evidence needs at least one row with a source pointer");
  for (const row of evTable.rows) {
    if (isBlank(row[1])) add("evidence", "an Evidence row has no evidence text");
    if (isBlank(row[2])) add("evidence", "an Evidence row has no source pointer (file:line / command / log)");
  }

  // Candidates: >=2, each with a discriminating test; placeholders rejected.
  const cand = section(sections, /^Candidate causes\b/i);
  const candTable = cand ? parseTable(cand.lines) : { header: [], rows: [] };
  const candidates = candidateRows(candTable);
  if (candidates.length < 2) {
    add("candidates", `## Candidate causes needs at least 2 candidates (found ${candidates.length})`);
  }
  candidates.forEach((c, i) => {
    if (isBlank(c.cause)) add("candidates", `candidate #${i + 1} has no cause`);
    if (isBlank(c.test)) add("candidates", `candidate #${i + 1} has no discriminating test`);
    for (const [label, v] of [["cause", c.cause], ["likelihood", c.likelihood], ["test", c.test]]) {
      if (/^\?+$/.test(String(v).trim()) || /_TODO:/.test(v)) {
        add("candidates", `candidate #${i + 1} ${label} is a placeholder`);
      }
    }
  });

  // Ruled out: >=1 with evidence once the diagnosis is not open.
  const ruled = section(sections, /^Ruled out\b/i);
  const ruledTable = ruled ? parseTable(ruled.lines) : { header: [], rows: [] };
  const ruledRows = ruledTable.rows.filter((r) => !r.every((c) => isBlank(c)));
  const ruledReason = ruled
    ? ruled.lines.some((l) => l && !l.startsWith("|") && !isBlank(l) && !/^Ruled out$/i.test(l))
    : false;
  if (status !== "open" && !ruledRows.length) {
    add("ruled-out", `no ruled-out cause with evidence and status=${status || "?"}`);
  }
  for (const row of ruledRows) {
    if (isBlank(row[0])) add("ruled-out", "a Ruled out row has no cause");
    if (isBlank(row[2])) add("ruled-out", "a Ruled out row has no evidence pointer");
  }
  if (status === "open" && !ruledRows.length && !ruledReason) {
    add("ruled-out", "## Ruled out must list a cause or explain why nothing is ruled out yet");
  }

  // Falsification: section + reviewer identity, full block when confirmed.
  const fals = section(sections, /^Falsification\b/i);
  const falsB = fals ? parseBullets(fals.lines) : {};
  if (!fals) add("falsification", "missing ## Falsification section (dispatch the falsifier persona)");
  else {
    if (isBlank(falsB.reviewer) && isBlank(s.falsifier)) {
      add("falsification", "no reviewer identity (set `falsifier:` or `- Reviewer:`)");
    }
    if (status === "confirmed") {
      for (const key of ["strongest-alternative", "test-that-separates-it", "outcome"]) {
        if (isBlank(falsB[key])) add("falsification", `confirmed diagnosis needs "- ${key.replace(/-/g, " ")}: <...>"`);
      }
    }
  }

  // Confirmed: exactly one candidate marked confirmed + a complete oracle.
  if (status === "confirmed") {
    const confirmed = candidates.filter((c) => /confirm/i.test(c.result));
    if (confirmed.length !== 1) {
      add("confirmed", `status=confirmed needs exactly one candidate with Result "confirmed" (found ${confirmed.length})`);
    }
  }
  const oracle = section(sections, /^Outcome oracle\b/i);
  const oracleB = oracle ? parseBullets(oracle.lines) : {};
  if (status === "confirmed") {
    for (const key of ["before-(red)", "after-(green)", "command-/-observation"]) {
      if (isBlank(oracleB[key])) {
        add("oracle", `confirmed diagnosis needs "- ${key.replace(/-/g, " ")}: <...>" in ## Outcome oracle`);
      }
    }
  }

  return { ok: !errors.length, required: true, legacy: false, errors, status: status || null, confidence: confidence || null, symptom: symptom || null };
}

/* One feature record for callers: meta, diagnosis text, validation. */
function readFeature(root, id) {
  const found = featureDir(root, id);
  if (!found) return null;
  const diagnosisText = fs.existsSync(diagnosisPath(found.dir)) ? fs.readFileSync(diagnosisPath(found.dir), "utf8") : "";
  const meta = found.meta;
  return {
    slug: found.slug,
    dir: found.dir,
    meta,
    diagnosisPath: diagnosisPath(found.dir),
    diagnosisText,
    ...validateDiagnosis({ meta, diagnosisText, id: found.slug }),
  };
}

/* A diagnosis records the evidence point it was proven at. When HEAD or the
 * harness version moved, the conclusion is stale until revalidated — it is
 * never silently trusted across a resume. */
function staleReason(validation, text, now = {}) {
  if (!validation || !validation.ok) return null;
  const s = parseScalars(text);
  const head = s.head || s["evidence-head"];
  const version = s.harness || s["harness-version"];
  if (head && now.head && String(head) !== String(now.head)) {
    return `diagnosis was proven at HEAD ${head}, now ${now.head}`;
  }
  if (version && now.harnessVersion && String(version).replace(/^v/, "") !== String(now.harnessVersion).replace(/^v/, "")) {
    return `diagnosis was proven on harness ${version}, now ${now.harnessVersion}`;
  }
  return null;
}

module.exports = {
  KINDS,
  DIAGNOSIS_KINDS,
  STATUSES,
  CONFIDENCES,
  normalizeId,
  needsDiagnosis,
  isLegacy,
  isBlank,
  featureDirs,
  featureDir,
  readFeature,
  readJson,
  metaPath,
  diagnosisPath,
  headingId,
  sectionsOf,
  parseTable,
  parseScalars,
  parseBullets,
  candidateRows,
  validateDiagnosis,
  staleReason,
};
