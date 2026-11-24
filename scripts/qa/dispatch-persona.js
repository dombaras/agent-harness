#!/usr/bin/env node
"use strict";
/*
 * dispatch_persona — preflight + prompt assembly for persona delegation (F-025 S2).
 *
 * The main agent already knows the *objective*; everything else in a dispatch
 * spec it currently retypes from memory (tree, owned files, contracts, done
 * gate, out-of-scope) and gets subtly wrong. This module derives those fields
 * from ground truth and rejects the three failure classes the field recon found:
 *
 *   1. a persona that does not exist (typo / renamed agent),
 *   2. a model pin that does not resolve at all (F-081 dead model id; F-095),
 *   3. an objective that writes while the persona cannot write (F-074/F-095
 *      "shipped" dispatches with `edit: deny`).
 *
 * It is pure (no spawning): the plugin passes a models list and tree state, so
 * every branch is unit-testable. An unavailable models list is `unverified`
 * (a warning), never a block — the same rule as the store probes.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PERSONA_DIR = path.join(".opencode", "agents");
const WRITE_VERB =
  /\b(write|writes|edit|edits|implement|fix|fixed|add|adds|create|creates|update|updates|refactor|migrate|rename|patch|delete|remove)\b/i;

function parseFrontmatter(text) {
  const m = String(text || "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : "";
}

function unquote(value) {
  const v = String(value || "").trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

/* The `permissions:` block is a flat YAML list of { action, resource, effect }.
 * Only those three fields are read, so a tiny line parser is enough and it
 * cannot be confused by prose in the body. */
function parsePermissions(frontmatter) {
  const lines = String(frontmatter || "").split(/\r?\n/);
  const start = lines.findIndex((l) => /^permissions:\s*$/.test(l));
  if (start === -1) return [];
  const rules = [];
  let cur = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line)) break; // next top-level key
    const kv = line.match(/^\s*-?\s*(action|resource|effect):\s*(.+)$/);
    if (!kv) continue;
    if (kv[1] === "action") {
      if (cur) rules.push(cur);
      cur = { action: unquote(kv[2]), resource: "*", effect: "allow" };
    } else if (cur) {
      cur[kv[1]] = unquote(kv[2]);
    }
  }
  if (cur) rules.push(cur);
  return rules;
}

function personaNames(root) {
  try {
    return fs
      .readdirSync(path.join(root, PERSONA_DIR))
      .filter((n) => n.endsWith(".md"))
      .map((n) => n.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

function parsePersona(text) {
  const fm = parseFrontmatter(text);
  const field = (name) => {
    const m = fm.match(new RegExp(`^${name}:[ \\t]*(.+)$`, "m"));
    return m ? unquote(m[1]) : "";
  };
  const description = field("description");
  return {
    description,
    model: field("model"),
    mode: field("mode"),
    permissions: parsePermissions(fm),
    writes: writesFromDescription(description),
  };
}

/* `Writes: \`a/**\`, \`b/**\`.` -> ["a/**", "b/**"]; `Reads only` -> []. */
function writesFromDescription(description) {
  const d = String(description || "");
  if (/\bReads only\b/i.test(d) || (/\bruns tiers\b/i.test(d) && !/Writes:/i.test(d))) return [];
  const m = d.match(/Writes:\s*(.+)$/i);
  if (!m) return [];
  let tail = m[1].trim();
  if (tail.endsWith(".")) tail = tail.slice(0, -1).trim();
  const globs = [...tail.matchAll(/`([^`]+)`/g)].map((x) => x[1]);
  const out = globs.length ? globs : tail.split(",").map((s) => s.trim());
  return out.filter(Boolean);
}

/* Minimal glob matcher for permission resources and declared writes:
 *   **  any depth        *  one segment        ?  one char
 * Patterns are matched against repo-relative POSIX paths. */
function globToRegExp(glob) {
  let re = "";
  const g = String(glob || "").replace(/\\/g, "/");
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        re += ".*";
        i++;
        if (g[i + 1] === "/") i++; // `**/` also matches zero dirs
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function normalizeRel(p) {
  return String(p || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
}

/* Last matching rule wins (the planner's `deny *` then `allow plan.md` shape). */
function decide(permissions, action, resource) {
  const rel = normalizeRel(resource);
  let decision = "allow";
  for (const rule of permissions || []) {
    if (rule.action !== action && rule.action !== "*") continue;
    if (globToRegExp(normalizeRel(rule.resource)).test(rel)) decision = rule.effect;
  }
  return decision;
}

function canWriteAnywhere(persona) {
  const writes = persona.writes.length ? persona.writes : ["*"];
  return writes.some((w) => decide(persona.permissions, "edit", w.replace(/\/\*\*$/, "/x")) === "allow");
}

function modelKey(model) {
  return String(model || "").split("#")[0].trim();
}

function modelResolves(model, models) {
  if (!model) return false;
  const want = modelKey(model);
  return (models || []).some((m) => modelKey(m) === want || modelKey(m).endsWith(`/${want}`) || want.endsWith(`/${modelKey(m)}`));
}

function isWriteObjective(objective) {
  return WRITE_VERB.test(String(objective || ""));
}

/* Preflight. `opts`:
 *   { root, persona, objective, files?, models?: string[]|null,
 *     tree?: { path, branch?, expectedBranch?, dirty?, exists? } }
 * Returns { ok, errors[], warnings[], persona, personaFile }. `models === null`
 * means "could not verify" and must warn, never fail. */
function preflight(opts = {}) {
  const root = path.resolve(opts.root || ".");
  const personaName = String(opts.persona || "").trim();
  const errors = [];
  const warnings = [];
  const names = personaNames(root);
  const personaFile = path.join(root, PERSONA_DIR, `${personaName}.md`);

  if (!personaName) {
    errors.push({
      code: "persona",
      message: `missing persona — available: ${names.join(", ") || "(none; run agent-harness update)"}`,
    });
  } else if (!names.includes(personaName)) {
    errors.push({
      code: "persona",
      message: `unknown persona "${personaName}" — available: ${names.join(", ") || "(none)"}`,
    });
  }

  let persona = null;
  if (personaName && names.includes(personaName)) {
    try {
      persona = parsePersona(fs.readFileSync(personaFile, "utf8"));
    } catch (err) {
      errors.push({ code: "persona", message: `cannot read ${PERSONA_DIR}/${personaName}.md: ${err.message}` });
    }
  }

  if (persona) {
    if (!persona.model) {
      errors.push({
        code: "model",
        message: `${personaName} has no model: pin — add one to ${PERSONA_DIR}/${personaName}.md or dispatch another persona`,
      });
    } else if (opts.models == null) {
      warnings.push({
        code: "model-unverified",
        message: `could not list models; ${personaName}'s pin ${persona.model} was not verified`,
      });
    } else if (!modelResolves(persona.model, opts.models)) {
      errors.push({
        code: "model",
        message: `${personaName}'s model ${persona.model} does not resolve — fix the pin in ${PERSONA_DIR}/${personaName}.md (opencode models lists what resolves)`,
      });
    }

    const files = (opts.files || []).map(normalizeRel).filter(Boolean);
    const writes = isWriteObjective(opts.objective) || files.length > 0;
    if (writes) {
      if (!canWriteAnywhere(persona)) {
        errors.push({
          code: "write-scope",
          message: `${personaName} cannot write (edit is denied by its permission rules) but the objective writes — dispatch a builder persona or narrow the objective to read-only`,
        });
      }
      const denied = files.filter((f) => decide(persona.permissions, "edit", f) !== "allow");
      if (denied.length) {
        errors.push({
          code: "write-scope",
          message: `${personaName} may not edit ${denied.join(", ")} — narrow the objective or dispatch a persona whose writes cover it`,
        });
      }
    }
  }

  const tree = opts.tree;
  if (tree) {
    if (tree.exists === false) {
      errors.push({
        code: "tree",
        message: `working tree ${tree.path} does not exist — run \`backlog worktree <id>\` first`,
      });
    } else if (tree.expectedBranch && tree.branch && tree.branch !== tree.expectedBranch) {
      errors.push({
        code: "tree",
        message: `tree ${tree.path} is on ${tree.branch}, expected ${tree.expectedBranch} — switch to the feature branch before dispatching`,
      });
    } else if (tree.dirty) {
      warnings.push({
        code: "tree-dirty",
        message: `tree ${tree.path} has ${tree.dirty} dirty file(s) — the child must not revert work it does not own`,
      });
    }
  }

  return { ok: errors.length === 0, errors, warnings, persona, personaFile };
}

const DEFAULT_DONE =
  "Run the project tier that covers the changed path (dev-loop tier map), report the exact command + result. Never claim a command ran unless it did.";

/* Six-field dispatch spec. Every field has a ground-truth default so the caller
 * supplies only `objective`; explicit values win. Deterministic order. */
function buildPrompt(opts = {}) {
  const persona = String(opts.persona || "").trim();
  const description = String(opts.description || "").trim();
  const tree = opts.tree || {};
  const writes = opts.writes || [];
  const owned = (opts.owned || []).map(normalizeRel).filter(Boolean);
  const readOnly = (opts.readOnly || []).map(normalizeRel).filter(Boolean);
  const contracts = (opts.contracts || []).filter(Boolean);
  const outOfScope = (opts.outOfScope || []).filter(Boolean);
  const fields = [];

  fields.push(`You are the ${persona} persona. Read and follow .agents/skills/${persona}/SKILL.md, then carry out this dispatch.`);
  fields.push(`## Objective\n${String(opts.objective || "").trim() || "(missing objective — do not start)"}`);
  fields.push(
    `## Working tree\n${tree.path || opts.root || "(unknown)"}` +
      `${tree.branch ? ` (branch ${tree.branch}` : ""}${tree.dirty ? `, ${tree.dirty} dirty` : ""}${tree.branch ? ")" : ""}. ` +
      "Run every read/write with `workdir` set to this path; never edit the main checkout."
  );
  fields.push(
    `## Owned files\n${owned.length ? owned.join(", ") : writes.length ? writes.join(", ") : "(none declared — read-only dispatch)"}`
  );
  fields.push(
    `## Read-only files\nEverything outside the owned files is read-only.` +
      (readOnly.length ? ` Explicitly read-only: ${readOnly.join(", ")}.` : "") +
      (description ? ` Persona contract: ${description}` : "")
  );
  fields.push(
    `## Shared contracts\n${contracts.length ? contracts.join("\n") : "The feature plan.md owns/consumes list when present; otherwise the project rulebook (.agents/AGENTS.md)."}`
  );
  fields.push(`## Done =\n${opts.done || DEFAULT_DONE}`);
  fields.push(
    `## Out of scope\n${outOfScope.length ? outOfScope.join("\n") : "Do not touch files outside the owned set, do not change model pins/permissions, and do not expand the objective."}`
  );
  fields.push(
    "## Output contract\nReturn your final message in this exact order: **Result** (what shipped/decided) -> **Evidence** (files changed; commands run) -> **Deferred & risks** (follow-ups the orchestrator must handle). Keep it under ~15 lines."
  );

  const prompt = fields.join("\n\n");
  const hash = crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 12);
  return { prompt, hash, fields };
}

/* Compact human/machine summary returned by the plugin after a dispatch. */
function renderReceipt(info = {}) {
  const lines = [
    `dispatch: ${info.persona || "?"} → ${info.sessionID || "not created"}`,
    `model:    ${info.model || "?"}`,
    `tree:     ${info.tree || "?"}`,
    `prompt:   sha256:${info.hash || "?"} (${info.bytes || 0} bytes)`,
  ];
  if (info.note) lines.push(`note:     ${info.note}`);
  return lines.join("\n");
}

function parseArgs(argv) {
  const out = { persona: null, objective: null, root: null, files: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--persona") out.persona = argv[++i];
    else if (a === "--objective") out.objective = argv[++i];
    else if (a === "--root") out.root = argv[++i];
    else if (a === "--files") out.files = String(argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--json") out.json = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const pf = preflight({ root: args.root || process.cwd(), persona: args.persona, objective: args.objective, files: args.files });
  const built = pf.persona
    ? buildPrompt({
        persona: args.persona,
        objective: args.objective,
        root: path.resolve(args.root || "."),
        description: pf.persona.description,
        writes: pf.persona.writes,
        owned: args.files,
      })
    : null;
  const out = {
    schema: "dispatch-persona/1",
    ok: pf.ok,
    errors: pf.errors,
    warnings: pf.warnings,
    persona: args.persona,
    model: pf.persona && pf.persona.model,
    writes: pf.persona && pf.persona.writes,
    promptHash: built && built.hash,
    prompt: built && built.prompt,
  };
  if (args.json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(`dispatch_persona preflight: ${pf.ok ? "OK" : "REJECTED"}`);
    for (const e of pf.errors) console.log(`  ✗ ${e.message}`);
    for (const w of pf.warnings) console.log(`  ⚠ ${w.message}`);
    if (built && pf.ok) console.log(`\n--- prompt (sha256:${built.hash}) ---\n${built.prompt}`);
  }
  process.exit(pf.ok ? 0 : 1);
}

module.exports = {
  parseFrontmatter,
  parsePermissions,
  parsePersona,
  writesFromDescription,
  personaNames,
  globToRegExp,
  decide,
  canWriteAnywhere,
  modelKey,
  modelResolves,
  isWriteObjective,
  preflight,
  buildPrompt,
  renderReceipt,
};

if (require.main === module) main();
