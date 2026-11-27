#!/usr/bin/env node
"use strict";

/* Test entrypoint: run the requested node:test files under a scoped TMPDIR.
 *
 * The suites create many `mkdtemp` fixtures and few of them clean up, so on a
 * long-lived machine `/tmp` fills with `agent-harness-*` directories and an
 * ENOSPC starts masking the real gate failure. Every test file inherits this
 * process's TMPDIR (spawned children and git worktrees included), and the whole
 * scope is removed once the runner exits — pass or fail. */

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node tests/run.js <test-file...>");
  process.exit(2);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-harness-tests-"));
const env = { ...process.env, TMPDIR: tmpRoot, TMP: tmpRoot, TEMP: tmpRoot };

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch (err) {
    // A failed cleanup must never turn a green suite red; report it so a future
    // ENOSPC is traceable to the leftover path instead of a mystery.
    console.error(`tests/run.js: could not remove scoped TMPDIR ${tmpRoot}: ${err.message}`);
  }
}

process.on("exit", cleanup);

const child = spawn(process.execPath, ["--test", ...files], { stdio: "inherit", env });

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    try {
      child.kill(signal);
    } catch {
      /* child already exited */
    }
  });
}

child.on("error", (err) => {
  console.error(`tests/run.js: could not start the test runner: ${err.message}`);
  cleanup();
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  cleanup();
  process.exitCode = signal ? 1 : code == null ? 1 : code;
});
