#!/usr/bin/env node
'use strict';

/**
 * mobile E2E — inspect a UI hierarchy, live on the device or from a saved
 * Maestro failure artifact. Harness-owned; project values come from `local.json`.
 *
 * Why this exists: diagnosing a failed Maestro step means reading the on-screen
 * hierarchy (which testIDs / text / bounds were actually present), but
 * hand-rolling that — `adb -s emulator-5554 shell uiautomator dump …`, `python3`
 * parsing `~/.maestro/tests/.../screen-hierarchy/*.json`, `ls ~/.maestro/...` —
 * trips two guards: the capacity classifier mis-read the device serial /
 * `.maestro` path as launching an emulator/Maestro, and the tool guard blocks
 * `ls`/`grep`/`find` inspection. This is the blessed, lightweight path: it never
 * launches a heavy tier, and it lists the artifacts for you (`--list-artifacts`)
 * so you never shell into `~/.maestro`.
 *
 * Usage:
 *   node scripts/qa/mobile-e2e/ui-dump.js --live [--serial <s>] [--filter <re>] [--json]
 *   node scripts/qa/mobile-e2e/ui-dump.js [--latest | --file <path>] [--flow <name>] [--step <substr>]
 *   node scripts/qa/mobile-e2e/ui-dump.js --list-artifacts [--flow <name>]
 *
 * Options:
 *   --live              dump the hierarchy from the running device (adb)
 *   --serial <s>        device serial for --live (default: first adb device)
 *   --file <path>       a Maestro screen-hierarchy JSON file
 *   --latest            newest Maestro screen-hierarchy JSON (default offline mode)
 *   --flow <name>       restrict artifacts to this flow dir
 *   --step <substr>     restrict artifacts to files containing this substring
 *   --list-artifacts    print candidate hierarchy/screenshot files and exit
 *   --filter <re>       only print nodes whose id/text/desc/class matches <re>
 *   --json              print the normalized tree as JSON
 *   --max <n>           cap printed lines (default 300)
 *   -h, --help          print this usage and exit 0
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');

const DEFAULT_MAX = 300;

function usage() {
  return [
    'mobile E2E — UI hierarchy dump (live device, or a Maestro failure artifact)',
    '',
    'Usage:',
    '  node scripts/qa/mobile-e2e/ui-dump.js --live [--serial <s>] [--filter <re>] [--json]',
    '  node scripts/qa/mobile-e2e/ui-dump.js [--latest|--file <path>] [--flow <name>] [--step <substr>]',
    '  node scripts/qa/mobile-e2e/ui-dump.js --list-artifacts [--flow <name>]',
    '',
    'This is the sanctioned, lightweight way to read a hierarchy — never shell',
    'into ~/.maestro or hand-roll an adb uiautomator probe.',
  ].join('\n');
}

function parseArgs(argv) {
  const o = { live: false, latest: false, file: null, flow: null, step: null, list: false, filter: null, json: false, max: DEFAULT_MAX, serial: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--live') o.live = true;
    else if (a === '--latest') o.latest = true;
    else if (a === '--list-artifacts') o.list = true;
    else if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--file' && argv[i + 1]) o.file = path.resolve(argv[++i]);
    else if (a.startsWith('--file=')) o.file = path.resolve(a.slice(7));
    else if (a === '--flow' && argv[i + 1]) o.flow = argv[++i];
    else if (a.startsWith('--flow=')) o.flow = a.slice(7);
    else if (a === '--step' && argv[i + 1]) o.step = argv[++i];
    else if (a.startsWith('--step=')) o.step = a.slice(7);
    else if (a === '--filter' && argv[i + 1]) o.filter = argv[++i];
    else if (a.startsWith('--filter=')) o.filter = a.slice(9);
    else if (a === '--serial' && argv[i + 1]) o.serial = argv[++i];
    else if (a.startsWith('--serial=')) o.serial = a.slice(9);
    else if (a === '--max' && argv[i + 1]) o.max = Number(argv[++i]) || DEFAULT_MAX;
    else if (a.startsWith('--max=')) o.max = Number(a.slice(6)) || DEFAULT_MAX;
  }
  return o;
}

/** Maestro's per-run artifact root (see run-maestro.js / docs/mobile-testing.md). */
function maestroTestsDir() {
  return process.env.MOBILE_E2E_MAESTRO_TESTS || path.join(os.homedir(), '.maestro', 'tests');
}

function listRuns(root) {
  try {
    return fs
      .readdirSync(root)
      .map((name) => path.join(root, name))
      .filter((p) => {
        try {
          return fs.statSync(p).isDirectory();
        } catch {
          return false;
        }
      })
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** Candidate `screen-hierarchy` JSON files (newest first), optionally scoped. */
function hierarchyFiles(opts) {
  const root = maestroTestsDir();
  const out = [];
  for (const run of listRuns(root)) {
    let flows = [];
    try {
      flows = fs.readdirSync(run).map((n) => path.join(run, n)).filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
    } catch {
      continue;
    }
    for (const flowDir of flows) {
      const flowName = path.basename(flowDir);
      if (opts && opts.flow && flowName !== opts.flow) continue;
      const hierDir = path.join(flowDir, 'screen-hierarchy');
      let files = [];
      try {
        files = fs.readdirSync(hierDir).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(hierDir, f));
      } catch {
        /* this flow has no hierarchy dump */
      }
      for (const f of files) {
        if (opts && opts.step && !path.basename(f).includes(opts.step)) continue;
        out.push({ run, flow: flowName, file: f });
      }
    }
  }
  return out;
}

/** Sibling screenshots for a hierarchy file (Maestro writes `<flow>/screenshots`). */
function screenshotsFor(hierarchyFile) {
  const flowDir = path.dirname(path.dirname(hierarchyFile));
  const dir = path.join(flowDir, 'screenshots');
  try {
    return fs.readdirSync(dir).filter((f) => /\.(png|jpg)$/i.test(f)).sort().map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/* --------------------------------------------------------------- parsers */
function node(id, text, desc, cls, bounds, children) {
  return { id: id || '', text: text || '', desc: desc || '', cls: cls || '', bounds: bounds || '', children: children || [] };
}

/** UIAutomator XML (`uiautomator dump`) -> normalized tree. `node` tags only. */
function parseUiAutomatorXml(xml) {
  const root = node('', '', '', 'hierarchy', '', []);
  const stack = [root];
  const tag = /<node\b([^>]*?)(\/?)>|<\/node>/g;
  let m;
  while ((m = tag.exec(xml)) !== null) {
    if (m[0].startsWith('</')) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const attrs = {};
    const attrRe = /([\w-]+)="([^"]*)"/g;
    let a;
    while ((a = attrRe.exec(m[1])) !== null) attrs[a[1]] = a[2];
    const child = node(
      attrs['resource-id'],
      attrs.text,
      attrs['content-desc'],
      attrs.class,
      attrs.bounds,
      []
    );
    stack[stack.length - 1].children.push(child);
    if (!m[2]) stack.push(child);
  }
  return root;
}

/** Maestro screen-hierarchy JSON -> normalized tree (tolerant of key shapes). */
function normalizeMaestro(n) {
  if (!n || typeof n !== 'object') return null;
  const id = n['resource-id'] != null ? n['resource-id'] : n.resourceId;
  const desc = n['content-desc'] != null ? n['content-desc'] : n.contentDescription;
  const rawChildren = Array.isArray(n.children) ? n.children : [];
  const kids = [];
  for (const c of rawChildren) {
    const k = normalizeMaestro(c);
    if (k) kids.push(k);
  }
  const self = node(id, n.text, desc, n.class || n.cls, n.bounds, kids);
  return self;
}

/* --------------------------------------------------------------- output */
function line(n, depth) {
  return `${'  '.repeat(depth)}${n.id || '-'} | ${n.text} | ${n.desc} | ${n.cls || ''} | ${n.bounds}`;
}

function printTree(root, opts) {
  const re = opts.filter ? new RegExp(opts.filter, 'i') : null;
  const lines = [];
  let truncated = false;
  const walk = (n, depth) => {
    const matches =
      !re || re.test(n.id || '') || re.test(n.text || '') || re.test(n.desc || '') || re.test(n.cls || '');
    if (matches) {
      if (lines.length >= opts.max) {
        truncated = true;
      } else {
        lines.push(line(n, depth));
      }
    }
    for (const c of n.children) walk(c, depth + 1);
  };
  walk(root, 0);
  console.log(lines.join('\n'));
  if (truncated) console.log(`… output capped at ${opts.max} lines (raise --max or narrow --filter)`);
}

function countNodes(n) {
  return 1 + n.children.reduce((sum, c) => sum + countNodes(c), 0);
}

/* --------------------------------------------------------------- live */
function resolveAdb() {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
  if (sdk) {
    const candidate = path.join(sdk, 'platform-tools', exe);
    if (fs.existsSync(candidate)) return candidate;
  }
  return exe;
}

function liveDump(serial) {
  const adb = resolveAdb();
  const base = serial ? [adb, '-s', serial] : [adb];
  if (!serial) {
    const devices = spawnSync(adb, ['devices'], { encoding: 'utf8', timeout: 10000 });
    const deviceLines = String((devices.stdout || '') + (devices.stderr || '')).match(/^\S+\s+device\b/gm) || [];
    if (deviceLines.length === 0) {
      console.error('FAIL — no ready adb device (run: bash scripts/qa/mobile-e2e/boot-emulator.sh).');
      process.exit(2);
    }
    serial = deviceLines[0].split(/\s+/)[0];
  }
  const dump = spawnSync(adb, ['-s', serial, 'shell', 'uiautomator', 'dump', '/sdcard/window_dump.xml'], { encoding: 'utf8', timeout: 30000 });
  if (dump.status !== 0) {
    console.error(`FAIL — uiautomator dump failed: ${(dump.stderr || dump.stdout || '').trim()}`);
    process.exit(2);
  }
  const cat = spawnSync(adb, ['-s', serial, 'exec-out', 'cat', '/sdcard/window_dump.xml'], { encoding: 'utf8', timeout: 30000 });
  const xml = cat.stdout || '';
  if (!xml.includes('<hierarchy')) {
    console.error('FAIL — could not read the dumped hierarchy (device offline?).');
    process.exit(2);
  }
  return parseUiAutomatorXml(xml);
}

/* --------------------------------------------------------------- main */
function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(usage());
    process.exit(0);
  }

  if (opts.list) {
    const files = hierarchyFiles(opts);
    if (files.length === 0) {
      console.log('No Maestro hierarchy artifacts found (run a device tier first).');
      process.exit(0);
    }
    console.log(`Maestro artifacts under ${maestroTestsDir()}:`);
    for (const f of files) {
      console.log(`  ${f.flow.padEnd(24)} ${f.file}`);
      for (const s of screenshotsFor(f.file)) console.log(`  ${''.padEnd(24)} ${s}`);
    }
    process.exit(0);
  }

  if (opts.live) {
    const root = liveDump(opts.serial);
    if (opts.json) console.log(JSON.stringify(root, null, 2));
    else printTree(root, opts);
    return;
  }

  let file = opts.file;
  if (!file) {
    const files = hierarchyFiles(opts);
    if (files.length === 0) {
      console.error('FAIL — no Maestro hierarchy artifact found. Use --live, or check --flow/--step.');
      console.error('  List candidates with: node scripts/qa/mobile-e2e/ui-dump.js --list-artifacts');
      process.exit(2);
    }
    file = files[0].file;
    console.error(`# ${file}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`FAIL — could not read ${file}: ${error.message}`);
    process.exit(2);
  }
  const root = normalizeMaestro(parsed) || node('', '', '', '', '', []);
  if (opts.json) console.log(JSON.stringify(root, null, 2));
  else {
    printTree(root, opts);
    console.error(`# ${countNodes(root)} nodes`);
  }
}

if (require.main === module) main();

module.exports = {
  parseArgs,
  parseUiAutomatorXml,
  normalizeMaestro,
  hierarchyFiles,
  maestroTestsDir,
};
