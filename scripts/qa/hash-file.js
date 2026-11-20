#!/usr/bin/env node
"use strict";
/*
 * hash-file — deterministic file digests for QA evidence integrity.
 *
 * Prints `<sha256>  <path>` per file (sha256sum-style) so qa-runner can report
 * a tamper-evident hash of `.agents/qa-runs/<id>/evidence.txt` without inline
 * shell quoting hazards. Pure Node, no dependencies, cross-platform.
 *
 * Usage:
 *   node scripts/qa/hash-file.js <file> [<file>...]
 */
const fs = require("fs");
const crypto = require("crypto");

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node scripts/qa/hash-file.js <file> [<file>...]");
  process.exit(2);
}

let failed = false;
for (const file of files) {
  try {
    const digest = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    console.log(`${digest}  ${file}`);
  } catch (e) {
    console.error(`hash-file: ${file}: ${e.message}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
