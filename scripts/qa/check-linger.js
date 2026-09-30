#!/usr/bin/env node
"use strict";
/*
 * check-linger — process-vs-tests linger detector (harness-shipped).
 *
 * The exit-contract half of the test-design rubric (T1/T6/T9). A suite can report
 * every test passing in milliseconds and still hold the process open for a
 * minute on a pool/socket/timer — the measured F-132 case: 22 tests in 76 ms,
 * process exit at 60.4 s. Nothing in a normal green run surfaces that, so it
 * silently taxes every push. This wrapper runs a tier command, measures the real
 * wall-clock, parses the runner's self-reported duration, and fails when the
 * process lingers after the tests are done.
 *
 *   node scripts/qa/check-linger.js                         # wraps `npm run test:quick`
 *   node scripts/qa/check-linger.js -- npm run test:api     # wraps an explicit tier
 *   node scripts/qa/check-linger.js --max-linger 3 --ratio 0.25 -- <command...>
 *
 * Fail condition: `linger > max-linger seconds` AND `linger > ratio * test-time`
 * (the ratio keeps long legitimate suites from failing on a proportional teardown).
 * The child's own exit code is always propagated; a linger finding adds exit 1.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..", "..");
const argv = process.argv.slice(2);

function parseArgs(args) {
  let maxLinger = 5;
  let ratio = 0.5;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (a === "--max-linger") maxLinger = parseFloat(args[++i]);
    else if (a.startsWith("--max-linger=")) maxLinger = parseFloat(a.split("=")[1]);
    else if (a === "--ratio") ratio = parseFloat(args[++i]);
    else if (a.startsWith("--ratio=")) ratio = parseFloat(a.split("=")[1]);
    else rest.push(a);
  }
  return {
    maxLinger: Number.isFinite(maxLinger) ? maxLinger : 5,
    ratio: Number.isFinite(ratio) ? ratio : 0.5,
    commandArgs: rest,
  };
}

const { maxLinger: maxLingerSec, ratio, commandArgs } = parseArgs(argv);

function resolveCommand() {
  if (commandArgs.length) return commandArgs.join(" ");
  // No explicit command: wrap the project's pre-push tier (the one that pays the
  // linger cost on every push) when it exists.
  const pkgPath = path.join(root, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (pkg.scripts && pkg.scripts["test:quick"]) return "npm run test:quick";
    } catch (_) {
      /* fall through to usage */
    }
  }
  return null;
}

const command = resolveCommand();
if (!command) {
  console.error(
    "usage: node scripts/qa/check-linger.js [--max-linger <sec>] [--ratio <x>] [--] <command...>\n" +
      "       (no command given and no `test:quick` script exists to wrap)"
  );
  process.exit(2);
}

console.log(`linger gate \u2014 process wall-clock vs runner-reported test duration (T1/T6/T9)`);
console.log(`  command: ${command}`);
console.log(`  thresholds: linger > ${maxLingerSec}s and > ${ratio}\u00d7 test time\n`);

const started = process.hrtime.bigint();
const r = spawnSync(command, {
  cwd: root,
  shell: true,
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
  env: process.env,
  windowsHide: true,
});
const wallMs = Number(process.hrtime.bigint() - started) / 1e6;

const out = (r.stdout || "") + (r.stderr || "");
if (out.trim()) process.stdout.write(out.endsWith("\n") ? out : out + "\n");

/* Runner-reported test duration. node:test prints `duration_ms 76.4` in its spec
 * footer (TAP: `# duration_ms 76`); jest prints `Time: 1.234 s`; vitest prints
 * `Duration  1.23s`. Prefer the LAST match (totals come last). */
function parseTestMs(text) {
  const patterns = [
    /duration_ms[:\s]+([0-9.]+)/gi,
    /(?:^|\n)[^\S\n]*Time:[^\S\n]+([0-9.]+)\s*s/gi,
    /(?:^|\n)[^\S\n]*Duration[^\S\n]+([0-9.]+)\s*s/gi,
  ];
  const found = [];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text))) {
      const n = parseFloat(m[1]);
      if (Number.isFinite(n)) found.push(n);
    }
  }
  if (!found.length) return null;
  return found[found.length - 1];
}

function parseTests(text) {
  const m = text.match(/(?:^|\n)[#\u2139\s]*tests[:\s]+(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

const testMs = parseTestMs(out);
const tests = parseTests(out);
const lingerMs = testMs == null ? null : wallMs - testMs;

const secs = (ms) => (ms / 1000).toFixed(1) + "s";
console.log("\nlinger analysis:");
if (testMs == null) {
  console.log(`  \u26a0 runner-reported duration not parseable \u2014 wall-clock only: ${secs(wallMs)}`);
  console.log("    (supported: node:test `duration_ms`, jest `Time:`, vitest `Duration`)");
} else {
  console.log(`  runner-reported tests: ${tests == null ? "?" : tests} in ${secs(testMs)}`);
  console.log(`  process wall-clock:    ${secs(wallMs)}`);
  console.log(`  linger after tests:    ${secs(lingerMs)}`);
}

const lingered = testMs != null && lingerMs > maxLingerSec * 1000 && lingerMs > ratio * testMs;
if (lingered) {
  console.log(
    `  \u2717 LINGER \u2014 the process held ${secs(lingerMs)} after the runner finished ` +
      `(budget ${maxLingerSec}s). Close pools/sockets/timers in after(), or pin the runner's ` +
      `force-exit (node:test: --test-force-exit). Record the suite's wall-clock + teardown in the ` +
      "QA plan's `## Test budget` (T1/T6/T9)."
  );
} else if (testMs != null) {
  console.log("  \u2713 exit contract holds \u2014 process terminated within budget after the tests");
}

const childCode = r.status == null ? 1 : r.status;
const code = lingered ? 1 : childCode;
console.log(
  "\nRESULT: " +
    (lingered
      ? "FAILURE \u2014 passing-but-idling suite (linger > budget)"
      : childCode === 0
        ? "green \u2014 command passed and no linger detected"
        : `command failed (exit ${childCode}) \u2014 no linger finding`)
);
process.exit(code);
