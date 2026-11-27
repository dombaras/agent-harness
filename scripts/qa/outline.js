#!/usr/bin/env node
"use strict";
/*
 * outline — print a markdown file's heading outline with line ranges (F-059).
 *
 * `read` is cheap only when it is bounded. For a large register, rulebook, or
 * handoff, read this first and then open just the section you need:
 *
 *   node scripts/qa/outline.js .agents/reviews/<id>/FINDINGS.md
 *   # then, in the agent: read(filePath, offset, limit)
 *
 * The parse/render/guard logic lives in `outline-lib.js` (shared with the
 * context-guard plugin); this file is argument handling + IO only.
 *
 * Usage:
 *   node scripts/qa/outline.js <file> [--max-level N] [--max N] [--json] [--root <dir>]
 *
 * Exit 0 on success; 2 on a missing/unreadable file or a bad argument.
 */

const fs = require("fs");
const path = require("path");
const lib = require("./outline-lib.js");

function fail(message) {
  process.stderr.write(`outline: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = { file: null, maxLevel: 6, max: lib.DEFAULT_MAX_HEADINGS, json: false, root: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") out.json = true;
    else if (arg === "--max-level") out.maxLevel = Number(argv[++i]);
    else if (arg === "--max") out.max = Number(argv[++i]);
    else if (arg === "--root") out.root = argv[++i];
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg.startsWith("-")) fail(`unknown option ${arg}`);
    else if (!out.file) out.file = arg;
    else fail(`unexpected argument ${arg}`);
  }
  if (!out.help && !out.file) fail("missing <file> (try --help)");
  if (!Number.isFinite(out.maxLevel) || out.maxLevel < 1) fail("--max-level must be a positive number");
  if (!Number.isFinite(out.max) || out.max < 1) fail("--max must be a positive number");
  return out;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(
      "usage: node scripts/qa/outline.js <file> [--max-level N] [--max N] [--json] [--root <dir>]\n"
    );
    return;
  }
  const root = path.resolve(args.root || process.cwd());
  const abs = path.isAbsolute(args.file) ? args.file : path.join(root, args.file);
  let text;
  let bytes;
  try {
    text = fs.readFileSync(abs, "utf8");
    bytes = fs.statSync(abs).size;
  } catch (e) {
    fail(`cannot read ${args.file}: ${e.code || e.message}`);
  }
  const display = lib.relativePath(abs, root) || args.file;
  if (args.json) {
    process.stdout.write(lib.jsonOutline(display, text, { bytes, maxLevel: args.maxLevel, max: args.max }) + "\n");
  } else {
    process.stdout.write(
      lib.renderOutline(display, text, { bytes, maxLevel: args.maxLevel, max: args.max }) + "\n"
    );
  }
}

main(process.argv.slice(2));
