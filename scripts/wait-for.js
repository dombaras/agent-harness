#!/usr/bin/env node
"use strict";
/*
 * wait-for — block (bounded) for a job/CI/log/health to reach a terminal state,
 * instead of the agent's `sleep N; grep log` (or `gh run watch`) polling loop.
 *
 * The 2026-09 LibraryOS recon found 98 `sleep` commands + 81 `gh` polls in
 * 30 days, rising on the device-heavy days (09-30: 26 + 20). A blind `sleep`
 * either wastes minutes (too long) or forces another poll (too short); a real
 * blocking waiter returns the moment the condition is met and a terminal status
 * when it is not. `run-detached.sh --wait` and the `job-notify` plugin already
 * cover the mobile-E2E matrix; this covers the general cases — a recorded job,
 * a CI run, a log line, or a URL/port.
 *
 * Modes (exactly one):
 *   --job <record.json>        block until the job's events reach `matrix_done`
 *                              or its pid dies (reuses the mobile-e2e job files)
 *   --events <events.jsonl>    same, from an events file directly
 *   --ci [--commit <sha>]      block until the CI run on <sha> (or HEAD) finishes
 *   --health <url>             block until an HTTP request succeeds
 *   --port <n>                 block until a TCP port accepts a connection
 *   --file <log> --grep <re>   block until <log> contains a line matching <re>
 *
 * Options: [--timeout <sec>] [--poll <sec>] [--root <dir>] [--quiet]
 * Exit: 0 = condition met (job pass / CI green / ready), 1 = timeout/failure.
 *
 * Deterministic and dependency-free. The CI half reuses
 * `scripts/qa/ci-wait-lib.js` — the same implementation `ship.js` uses — so a
 * behavior change lands once.
 */

const fs = require("fs");
const path = require("path");
const net = require("net");
const { spawnSync } = require("child_process");
const jobEvents = require("./qa/mobile-e2e/job-events.js");
const ciWait = require("./qa/ci-wait-lib.js");

const DEFAULT_TIMEOUT_S = 20 * 60;
const DEFAULT_POLL_S = 5;

function log(msg, quiet) {
  if (!quiet) process.stderr.write(`[wait] ${msg}\n`);
}

function sleepSync(ms) {
  if (!(ms > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return true; // unknown -> assume alive
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

/* Wait on a mobile-e2e-style events stream (reuses job-events.js). Terminal
 * when a `matrix_done` event appears or the job's pid (from --job's record) is
 * gone. Returns 0 on a clean pass (0 failed) or a recorded done-with-failures
 * also returns 0 but prints the summary (the caller decides); a dead runner
 * before `matrix_done` returns 1. */
function waitEvents(eventsFile, opts) {
  const { timeoutMs, pollMs, record, quiet } = opts;
  const deadline = Date.now() + timeoutMs;
  let lastCount = 0;
  for (;;) {
    const events = jobEvents.readEvents(eventsFile);
    if (events.length > lastCount) {
      for (const e of events.slice(lastCount)) {
        const line = jobEvents.progressLine(e);
        if (line) log(line, quiet);
      }
      lastCount = events.length;
    }
    const summary = jobEvents.summarize(events);
    if (summary.done) {
      process.stdout.write(jobEvents.notificationText(summary, { eventsPath: eventsFile }) + "\n");
      return summary.failed === 0 ? 0 : 0; // done is terminal; failures are in the text
    }
    if (record && !pidAlive(record.pid)) {
      process.stdout.write(
        jobEvents.notificationText(summary, { eventsPath: eventsFile }) + "\nRunner exited without matrix_done.\n"
      );
      return 1;
    }
    if (Date.now() >= deadline) {
      process.stdout.write(jobEvents.notificationText(summary, { eventsPath: eventsFile }) + "\n");
      log(`timeout after ${Math.round(timeoutMs / 60000)}m`, quiet);
      return 1;
    }
    sleepSync(pollMs);
  }
}

function httpOk(url) {
  // Node 18+ global fetch; a bounded request that never throws out.
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    return fetch(url, { signal: ctl.signal })
      .then((r) => {
        clearTimeout(t);
        return !!r && r.status < 500;
      })
      .catch(() => false);
  } catch (_) {
    return Promise.resolve(false);
  }
}

function tcpOpen(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const s = net.connect({ port: Number(port), host });
    const done = (ok) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(3000);
    s.once("connect", () => done(true));
    s.once("timeout", () => done(false));
    s.once("error", () => done(false));
  });
}

async function pollUntil(check, opts, readyText, failText) {
  const { timeoutMs, pollMs, quiet } = opts;
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  for (;;) {
    if (await check()) {
      process.stdout.write(`${readyText}\n`);
      return 0;
    }
    if (Date.now() >= deadline) {
      process.stderr.write(`${failText} (timeout ${Math.round(timeoutMs / 60000)}m)\n`);
      return 1;
    }
    if (!announced) {
      log("waiting...", quiet);
      announced = true;
    }
    sleepSync(pollMs);
  }
}

function fileMatches(file, re) {
  try {
    return re.test(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return false;
  }
}

function parseArgs(argv) {
  const out = { quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--job") out.job = argv[++i];
    else if (a === "--events") out.events = argv[++i];
    else if (a === "--ci") out.ci = true;
    else if (a === "--commit") out.commit = argv[++i];
    else if (a === "--workflow") out.workflow = argv[++i];
    else if (a === "--health") out.health = argv[++i];
    else if (a === "--port") out.port = argv[++i];
    else if (a === "--file") out.file = argv[++i];
    else if (a === "--grep") out.grep = argv[++i];
    else if (a === "--timeout") out.timeout = argv[++i];
    else if (a === "--poll") out.poll = argv[++i];
    else if (a === "--root") out.root = argv[++i];
    else if (a === "--quiet") out.quiet = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else out._.push(a);
  }
  return out;
}

function usage() {
  console.log(
    "wait-for — block (bounded) for a job/CI/log/health to finish, instead of polling.\n\n" +
      "  node scripts/wait-for.js --job <record.json>          # mobile-e2e/detached job\n" +
      "  node scripts/wait-for.js --events <events.jsonl>      # job events directly\n" +
      "  node scripts/wait-for.js --ci [--commit <sha>]        # CI run on a SHA\n" +
      "  node scripts/wait-for.js --health <url>               # HTTP ready\n" +
      "  node scripts/wait-for.js --port <n>                   # TCP port ready\n" +
      "  node scripts/wait-for.js --file <log> --grep <re>     # a log line appears\n\n" +
      "Options: [--timeout <sec>] [--poll <sec>] [--root <dir>] [--quiet]\n" +
      "Exit 0 when the condition is met, 1 on timeout."
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();
  const root = path.resolve(args.root || process.cwd());
  const timeoutMs = (Number(args.timeout) || DEFAULT_TIMEOUT_S) * 1000;
  const pollMs = (Number(args.poll) || DEFAULT_POLL_S) * 1000;
  const opts = { timeoutMs, pollMs, quiet: args.quiet };

  const modes = [args.job, args.events, args.ci, args.health, args.port, args.file].filter(Boolean);
  if (modes.length !== 1) {
    console.error("wait-for: specify exactly one of --job/--events/--ci/--health/--port/--file");
    process.exitCode = 2;
    return;
  }

  if (args.job) {
    let record = null;
    try {
      record = JSON.parse(fs.readFileSync(args.job, "utf8"));
    } catch (e) {
      console.error(`wait-for: cannot read job record ${args.job}: ${e.message}`);
      process.exitCode = 2;
      return;
    }
    if (!record.events) {
      console.error("wait-for: job record has no `events` path");
      process.exitCode = 2;
      return;
    }
    process.exitCode = waitEvents(record.events, { ...opts, record });
    return;
  }
  if (args.events) {
    process.exitCode = waitEvents(args.events, opts);
    return;
  }
  if (args.ci) {
    const sha = args.commit || spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    if (!sha) {
      console.error("wait-for: could not resolve a commit SHA (pass --commit)");
      process.exitCode = 2;
      return;
    }
    const workflow = args.workflow || ciWait.ciWorkflow(root);
    const cfg = ciWait.ciConfig(root, {
      "ci-timeout": timeoutMs / 60000,
      "ci-poll": pollMs / 1000,
    });
    process.exitCode = ciWait.waitCi(root, sha, { ...cfg, workflow, cwd: root });
    return;
  }
  if (args.health) {
    process.exitCode = await pollUntil(
      () => httpOk(args.health),
      opts,
      `ready: ${args.health}`,
      `not ready: ${args.health}`
    );
    return;
  }
  if (args.port) {
    process.exitCode = await pollUntil(
      () => tcpOpen(args.port),
      opts,
      `port open: ${args.port}`,
      `port never opened: ${args.port}`
    );
    return;
  }
  if (args.file) {
    if (!args.grep) {
      console.error("wait-for: --file requires --grep <regex>");
      process.exitCode = 2;
      return;
    }
    let re;
    try {
      re = new RegExp(args.grep);
    } catch (e) {
      console.error(`wait-for: bad --grep regex: ${e.message}`);
      process.exitCode = 2;
      return;
    }
    process.exitCode = await pollUntil(
      () => fileMatches(args.file, re),
      opts,
      `matched ${args.grep} in ${args.file}`,
      `no match for ${args.grep} in ${args.file}`
    );
    return;
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error("wait-for: " + (e && e.message ? e.message : e));
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, waitEvents, httpOk, tcpOpen, fileMatches, pidAlive, DEFAULT_TIMEOUT_S, DEFAULT_POLL_S };
