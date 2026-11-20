#!/usr/bin/env node
"use strict";
/*
 * where — a bounded symbol/owner lookup for agents.
 *
 * The 2026-10 LibraryOS recon measured `grep` as the single most common shell
 * command (1,081 / 14 days) and 95 failed reads on guessed paths. Agents hunt
 * for a symbol by shell-grepping, then read the whole file it lands in. This
 * returns a BOUNDED `file:line: text` hit list for a term, annotated with the
 * feature row(s) that own the hit file (from `.agents/memory/owned-files.md` and
 * the live session leases), and an inverse `--owner <glob>` mode. Index-first
 * (`git grep`, tracked files only), so it never walks node_modules or build
 * trees; a non-git fallback uses ripgrep with default ignore rules.
 *
 * Usage:
 *   node scripts/qa/where.js <term> [--files] [--limit N] [--json] [--root <dir>]
 *   node scripts/qa/where.js --owner <glob>
 *
 * Dependency-free and injectable (`opts.search`) so parsing, glob matching, and
 * output bounding are unit-testable.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const DEFAULT_LIMIT = 40;
const MAX_LINE = 200;

/* Parse `.agents/memory/owned-files.md`: `- <ID>: glob[, glob]`. Returns
 * [{ id, globs: [] }]. Pure. */
function parseOwners(src) {
  const owners = [];
  for (const line of String(src || "").split(/\r?\n/)) {
    const m = line.match(/^\s*[-*]\s+([A-Za-z]+-\d+)\s*:\s*(.+?)\s*$/);
    if (!m) continue;
    const globs = m[2]
      .split(/,|\s+and\s+/)
      .map((g) => g.trim().replace(/`/g, ""))
      .filter(Boolean);
    if (globs.length) owners.push({ id: m[1].toUpperCase(), globs });
  }
  return owners;
}

/* Glob → RegExp over a repo-relative POSIX path. `**` matches across dirs, `*`
 * within one segment. A glob with no wildcard matches the path or a path under
 * it (so `mobile` covers `mobile/app/x.ts`). Pure. */
function globToRegExp(glob) {
  const g = String(glob).replace(/\\/g, "/").replace(/^\.\//, "");
  if (!/[*?]/.test(g)) {
    const esc = g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\/+$/, "");
    return new RegExp(`^${esc}(?:/.*)?$`);
  }
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

/* Features whose globs cover `file`. Pure. */
function ownersForFile(owners, file) {
  const rel = String(file).replace(/\\/g, "/").replace(/^\.\//, "");
  const out = [];
  for (const o of owners) {
    if (o.globs.some((g) => globToRegExp(g).test(rel))) out.push(o.id);
  }
  return out;
}

function readOwners(root) {
  try {
    return parseOwners(fs.readFileSync(path.join(root, ".agents", "memory", "owned-files.md"), "utf8"));
  } catch (_) {
    return [];
  }
}

/* Default search: `git grep` the tracked index; fall back to ripgrep with the
 * project ignore rules. Returns [{ file, line, text }]. Injectable for tests. */
function defaultSearch(root, term, opts = {}) {
  const limit = opts.limit || DEFAULT_LIMIT;
  if (opts.files) {
    const ls = spawnSync("git", ["-C", root, "ls-files"], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const re = new RegExp(String(term).replace(/[.+^${}()|[\]\\]/g, "\\$&"), "i");
    return (ls.stdout || "")
      .split(/\r?\n/)
      .filter((f) => f && re.test(f))
      .slice(0, limit)
      .map((f) => ({ file: f.replace(/\\/g, "/"), line: 0, text: "" }));
  }
  const tryGit = spawnSync("git", ["-C", root, "grep", "-n", "-I", "--no-color", "-e", term, "--", "."], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  let raw = tryGit.status === 0 || tryGit.status === 1 ? tryGit.stdout || "" : "";
  if (!raw && tryGit.status !== 0 && tryGit.status !== 1) {
    const rg = spawnSync("rg", ["-n", "--no-heading", "--color", "never", "--max-count", "200", "-e", term], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    raw = rg.stdout || "";
  }
  const hits = [];
  for (const l of raw.split(/\r?\n/)) {
    if (!l.trim()) continue;
    const m = l.match(/^(.+?):(\d+):(.*)$/);
    if (!m) continue;
    hits.push({ file: m[1].replace(/\\/g, "/"), line: Number(m[2]), text: m[3].trim().slice(0, MAX_LINE) });
    if (hits.length >= limit) break;
  }
  return hits;
}

function parseArgs(argv) {
  const out = { term: null, owner: null, files: false, limit: DEFAULT_LIMIT, json: false, root: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--owner") out.owner = argv[++i];
    else if (a.startsWith("--owner=")) out.owner = a.slice("--owner=".length);
    else if (a === "--files") out.files = true;
    else if (a === "--json") out.json = true;
    else if (a === "--limit") out.limit = Number(argv[++i]) || DEFAULT_LIMIT;
    else if (a.startsWith("--limit=")) out.limit = Number(a.slice("--limit=".length)) || DEFAULT_LIMIT;
    else if (a === "--root") out.root = argv[++i];
    else if (a.startsWith("--root=")) out.root = a.slice("--root=".length);
    else if (a === "--help" || a === "-h") out.help = true;
    else if (!a.startsWith("-")) out.term = a;
  }
  return out;
}

function filesMode(root, term, limit, search) {
  const hits = (search || defaultSearch)(root, term, { limit, files: true });
  return hits.map((h) => h.file);
}

function run(opts) {
  const root = path.resolve(opts.root || process.cwd());
  const owners = readOwners(root);
  if (opts.owner) {
    const matched = owners.filter((o) => o.globs.some((g) => globToRegExp(g).test(String(opts.owner).replace(/\\/g, "/"))));
    return { schema: "where/1", mode: "owner", query: opts.owner, owners: matched.map((o) => o.id) };
  }
  const term = String(opts.term || "");
  if (opts.files) {
    const files = filesMode(root, term, opts.limit, opts.search);
    return { schema: "where/1", mode: "files", query: term, files: files.slice(0, opts.limit) };
  }
  const hits = (opts.search || defaultSearch)(root, term, { limit: opts.limit });
  const annotated = hits.map((h) => ({ ...h, owners: ownersForFile(owners, h.file) }));
  return { schema: "where/1", mode: "content", query: term, hits: annotated };
}

function printHuman(res) {
  if (res.mode === "owner") {
    console.log(`owners of ${res.query}: ${res.owners.join(", ") || "(none registered)"}`);
    return;
  }
  if (res.mode === "files") {
    for (const f of res.files) console.log(f);
    return;
  }
  for (const h of res.hits) {
    const own = h.owners.length ? `  [${h.owners.join(",")}]` : "";
    console.log(`${h.file}:${h.line}: ${h.text}${own}`);
  }
  if (!res.hits.length) console.log("(no matches)");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.term && !args.owner)) {
    console.log(
      "Usage: node scripts/qa/where.js <term> [--files] [--limit N] [--json] [--root <dir>]\n" +
        "       node scripts/qa/where.js --owner <glob>"
    );
    process.exit(args.help ? 0 : 2);
  }
  const res = run(args);
  if (args.json) console.log(JSON.stringify(res, null, 2));
  else printHuman(res);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error("where: " + (e && e.message ? e.message : e));
    process.exit(1);
  }
}

module.exports = { parseOwners, globToRegExp, ownersForFile, defaultSearch, parseArgs, run, filesMode, DEFAULT_LIMIT };
