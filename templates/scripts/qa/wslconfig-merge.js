#!/usr/bin/env node
"use strict";
/*
 * wslconfig-merge — set/overwrite keys in a `[section]` INI file (a Windows
 * `.wslconfig`) WITHOUT clobbering the user's other settings. `scripts/wsl-tune.sh`
 * uses it to apply the recommended `[wsl2]`/`[experimental]` tuning idempotently.
 *
 * Why a merged file, not a managed block: `.wslconfig` is INI, so a second
 * `[wsl2]` section would be invalid. This updates keys in place, inserts a
 * missing key at the end of its section, and appends a whole section only when
 * it is absent — comments, blank lines, ordering, and unknown keys survive.
 *
 * Usage:
 *   node scripts/qa/wslconfig-merge.js --file <path> --set wsl2.processors=8 \
 *        --set wsl2.swap=4GB [--set experimental.autoMemoryReclaim=gradual] \
 *        [--write] [--backup] [--dry-run]
 *
 * Without --write it prints the merged content to stdout (nothing is changed).
 * Exit 1 on an invalid key / unreadable file.
 */
const fs = require("fs");

const KEY_RE = /^[A-Za-z0-9_.-]+$/;

function validate(section, key) {
  if (!KEY_RE.test(section) || !KEY_RE.test(key)) {
    throw new Error(`invalid section/key: [${section}] ${key}`);
  }
}

function detectEol(text) {
  return /\r\n/.test(text) ? "\r\n" : "\n";
}

/* Pure merge: returns the new content. `sets` is [{section,key,value}]. */
function mergeConfig(text, sets) {
  const eol = detectEol(text);
  // Normalize to \n for processing, restore at the end.
  const lines = String(text == null ? "" : text).replace(/\r\n/g, "\n").split("\n");
  const pending = new Map(); // section(lower) -> [{key,value}]
  for (const s of sets) {
    validate(s.section, s.key);
    const sec = s.section.toLowerCase();
    if (!pending.has(sec)) pending.set(sec, []);
    // Last write wins within a section.
    const list = pending.get(sec);
    const idx = list.findIndex((x) => x.key.toLowerCase() === s.key.toLowerCase());
    if (idx === -1) list.push({ key: s.key, value: s.value });
    else list[idx] = { key: s.key, value: s.value };
  }

  const out = [];
  let current = null;
  const flush = () => {
    if (current && pending.has(current)) {
      for (const { key, value } of pending.get(current)) out.push(`${key}=${value}`);
      pending.delete(current);
    }
  };
  for (const line of lines) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      flush();
      current = header[1].trim().toLowerCase();
      out.push(line);
      continue;
    }
    const kv = line.match(/^([ \t]*)([A-Za-z0-9_.-]+)([ \t]*)=([ \t]*)(.*)$/);
    if (kv && current && pending.has(current)) {
      const list = pending.get(current);
      const idx = list.findIndex((x) => x.key.toLowerCase() === kv[2].toLowerCase());
      if (idx !== -1) {
        out.push(`${kv[1]}${list[idx].key}=${list[idx].value}`);
        list.splice(idx, 1);
        continue;
      }
    }
    out.push(line);
  }
  flush();
  for (const [section, list] of pending) {
    if (!list.length) continue;
    out.push("", `[${section}]`, ...list.map((x) => `${x.key}=${x.value}`));
  }
  // Collapse an accidental leading blank when the file started empty.
  let result = out.join("\n");
  if (!result.endsWith("\n")) result += "\n";
  return result.replace(/\n/g, eol);
}

function parseArgs(argv) {
  const out = { sets: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file") out.file = argv[++i];
    else if (a === "--set") out.sets.push(argv[++i]);
    else if (a === "--write") out.write = true;
    else if (a === "--backup") out.backup = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a.startsWith("--set=")) out.sets.push(a.slice(6));
    else if (a.startsWith("--file=")) out.file = a.slice(7);
  }
  return out;
}

function parseSet(spec) {
  const m = String(spec).match(/^([A-Za-z0-9_.-]+)\.([A-Za-z0-9_.-]+)=(.*)$/);
  if (!m) throw new Error(`--set must be <section>.<key>=<value>, got "${spec}"`);
  return { section: m[1], key: m[2], value: m[3] };
}

function run(argv) {
  const args = parseArgs(argv);
  if (!args.file) {
    console.error("usage: node scripts/qa/wslconfig-merge.js --file <path> --set section.key=value [--set ...] [--write] [--backup] [--dry-run]");
    return 2;
  }
  let sets;
  try {
    sets = args.sets.map(parseSet);
  } catch (e) {
    console.error("wslconfig-merge: " + e.message);
    return 1;
  }
  if (!sets.length) {
    console.error("wslconfig-merge: at least one --set is required");
    return 1;
  }
  let current = "";
  try {
    current = fs.readFileSync(args.file, "utf8");
  } catch (_) {
    current = ""; // create the file
  }
  const merged = mergeConfig(current, sets);
  if (args.dryRun || !args.write) {
    process.stdout.write(merged);
    return 0;
  }
  if (merged === current) {
    console.log(`wslconfig-merge: ${args.file} already up to date`);
    return 0;
  }
  if (args.backup && current) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.writeFileSync(`${args.file}.bak-${stamp}`, current, "utf8");
  }
  fs.writeFileSync(args.file, merged, "utf8");
  console.log(`wslconfig-merge: updated ${args.file}`);
  return 0;
}

if (require.main === module) {
  process.exitCode = run(process.argv.slice(2));
}

module.exports = { mergeConfig, parseSet, parseArgs, detectEol };
