#!/usr/bin/env node
"use strict";
/*
 * ci-wait-lib — bounded, blocking waits shared by `ship.js` (the CI watch on a
 * landed SHA) and `scripts/wait-for.js` (the general "block, don't poll" waiter
 * the agent uses instead of `sleep N; grep log`).
 *
 * Extracted from ship.js so the CI-watch implementation has ONE home: a
 * behavior change (a new conclusion, a cwd-vanished guard, a gh-failure warn)
 * lands once and is used by both the lander and the interactive waiter.
 *
 * Pure-ish and dependency-light: the only process spawns are `gh` (for the CI
 * watch) and the caller's own readiness probes. Every function is bounded by a
 * timeout and never throws into the caller.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

/* The billing/infra-block signature, kept inline so this module stays
 * dependency-light (its contract: the only imports are node builtins). A job
 * that completed with ZERO steps and no runner_name never provisioned a runner:
 * GitHub's answer when the account is out of Actions quota with no valid payment
 * method. `ci-usage-lib.js` owns the full cost model; this is just the detection
 * the CI waiter needs. */
function allJobsBlocked(jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0) return false;
  return jobs.every((job) => {
    if (!job) return false;
    const steps = Array.isArray(job.steps) ? job.steps.length : 0;
    const runner = job.runner_name == null ? "" : String(job.runner_name).trim();
    return steps === 0 && runner === "";
  });
}

/* The `gh` binary (overridable for tests). */
function ghBin() {
  return process.env.HARNESS_SHIP_GH_BIN || "gh";
}

/* Synchronous sleep — a poll loop must not need async/await. `Atomics.wait` is
 * a real blocking wait (setTimeout would not block the event loop). The test
 * seam skips it so the watch tests run instantly. */
function sleepSync(ms) {
  if (process.env.HARNESS_SHIP_CI_NO_SLEEP) return;
  if (!(ms > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function has(cmd) {
  return spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;
}

/* Run a `gh` command and parse its JSON stdout. Returns `{ ok, data, error }`:
 * `ok: false` on any failure (dead cwd, non-zero exit, no gh, malformed JSON)
 * with `error` carrying the real reason — the caller decides whether that is
 * fatal. Never prints, so poll loops stay quiet. The cwd is checked explicitly
 * because a deleted working directory (a feature worktree pruned mid-watch)
 * makes `spawnSync` fail with an opaque error and every poll silently return
 * nothing — the F-252 phantom CI timeout. */
function ghJson(cwd, args) {
  if (!fs.existsSync(cwd)) {
    return { ok: false, data: null, error: `working directory ${cwd} no longer exists` };
  }
  const res = spawnSync(ghBin(), args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    const lines = `${res.stderr || ""}\n${res.stdout || ""}`
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    return { ok: false, data: null, error: lines[lines.length - 1] || `gh exited ${res.status}` };
  }
  try {
    return { ok: true, data: JSON.parse(String(res.stdout || "null")), error: null };
  } catch {
    return { ok: false, data: null, error: "gh returned malformed JSON" };
  }
}

/* Consecutive `gh` failures tolerated before the watch says why it is stuck.
 * `gh` can hiccup transiently, so a single failed poll is not news; a run of
 * them means the watch is blind and the operator should know. */
const CI_GH_FAILURE_WARN = 4;

/* Wait for the CI workflow's run on `sha` to complete. Returns 0 when green
 * (success/skipped/neutral), 1 otherwise (failed, timeout, or a watch that went
 * blind — an unobserved gate is not a passed gate).
 *
 * Polls from `opts.cwd` (the MAIN worktree), not the feature checkout `root`:
 * CI is a property of the landed SHA on the remote, so the feature worktree is
 * not needed to observe it, and a concurrent `worktree-prune` removing that
 * checkout mid-watch must not blind the poll (the F-252 race). A vanished cwd
 * is reported immediately, never as a phantom timeout.
 *
 * `opts.onStatus(text)` (optional) receives each progress line instead of the
 * default `process.stdout.write` spinner, so a non-ship caller (wait-for.js)
 * can render its own. `opts.quiet` suppresses the default spinner. */
function waitCi(root, sha, opts) {
  const name = opts.workflow;
  const cwd = opts.cwd || root;
  const say = (line, end = "\r") => {
    if (opts.quiet) return;
    if (typeof opts.onStatus === "function") opts.onStatus(line);
    else process.stdout.write(`${line}${end}`);
  };
  if (!name) {
    console.warn(
      "ship: no CI workflow detected — landed, but cannot confirm CI. Add a `.github/workflows/ci.yml` (name: CI)."
    );
    return 0;
  }
  if (!has(ghBin())) {
    console.error(
      `ship: landed ${sha.slice(0, 7)}, but \`gh\` is unavailable — CI was NOT confirmed.\n` +
        `      Confirm manually: gh run list --workflow "${name}" --commit ${sha}`
    );
    return 1;
  }
  const deadline = Date.now() + opts.timeoutMs;
  let failures = 0;
  let warned = false;
  for (;;) {
    const res = ghJson(cwd, [
      "run",
      "list",
      "--workflow",
      name,
      "--commit",
      sha,
      "--limit",
      "10",
      "--json",
      "databaseId,status,conclusion,url,headSha,name",
    ]);
    if (!res.ok) {
      failures += 1;
      if (!fs.existsSync(cwd)) {
        console.error(
          `ship: landed ${sha.slice(0, 7)}, but the CI watch lost its working directory:\n` +
            `      ${res.error}\n` +
            "      The checkout was removed while CI was still being watched. Confirm CI from the main tree:\n" +
            `        gh run list --workflow "${name}" --commit ${sha}`
        );
        return 1;
      }
      if (failures >= CI_GH_FAILURE_WARN && !warned) {
        warned = true;
        console.warn(
          `ship: \`gh\` has failed ${failures} times while watching CI (${res.error}) — ` +
            `still waiting until the ${Math.round(opts.timeoutMs / 60000)}m deadline.`
        );
      }
      if (Date.now() >= deadline) {
        console.error(
          `ship: timed out after ${Math.round(opts.timeoutMs / 60000)}m waiting for ${name} on ${sha.slice(0, 7)}.\n` +
            `      The change LANDED; CI is not confirmed. Last \`gh\` error: ${res.error}\n` +
            "      Check:\n" +
            `        gh run list --workflow "${name}" --commit ${sha}`
        );
        return 1;
      }
      say(`[ci] waiting for ${name} on ${sha.slice(0, 7)}...`);
      sleepSync(opts.pollMs);
      continue;
    }
    failures = 0;
    const runs = res.data;
    const run = (runs || []).find((r) => !r.headSha || r.headSha === sha) || (runs || [])[0] || null;
    if (run && run.status === "completed") {
      if (["success", "skipped", "neutral"].includes(run.conclusion)) {
        console.log(`[ci] ${name} green on ${sha.slice(0, 7)}${run.url ? " — " + run.url : ""}`);
        return 0;
      }
      // A red run is not always a red TEST: a billing/infra block provisions no
      // runner at all (steps: 0, runner_name empty, ~4-6s). Name that state
      // explicitly instead of reporting "tests failed", and tell the operator
      // what to fix — this is the 2026-10 nine-day silent outage.
      if (run.databaseId) {
        const jobsRes = ghJson(cwd, [
          "api",
          `/repos/{owner}/{repo}/actions/runs/${run.databaseId}/jobs`,
          "--jq",
          ".jobs",
        ]);
        const jobs = jobsRes.ok ? jobsRes.data : null;
        if (allJobsBlocked(jobs)) {
          console.error(
            `ship: ${name} did NOT RUN on ${sha.slice(0, 7)} — GitHub Actions billing/infra block.\n` +
              `      The job(s) provisioned no runner (0 steps, no runner_name), so this is NOT a test failure.\n` +
              "      Fix: add/repair the account payment method or raise the spending limit, then re-dispatch.\n" +
              `        gh run view ${run.databaseId}\n` +
              `        gh auth refresh -h github.com -s user   # makes the billing state readable`
          );
          return 1;
        }
      }
      console.error(
        `ship: ${name} concluded "${run.conclusion}" on ${sha.slice(0, 7)}` +
          (run.url ? " — " + run.url : "") +
          (run.databaseId ? `\n      Failing logs: gh run view ${run.databaseId} --log-failed` : "") +
          "\n      The change landed but CI is red — fix forward on a new branch.\n" +
          "      Emergency rollback: re-deploy the previous good SHA\n" +
          "        gh workflow run deploy-uat.yml --ref main -f ref=<previous-good-sha>"
      );
      return 1;
    }
    if (Date.now() >= deadline) {
      console.error(
        `ship: timed out after ${Math.round(opts.timeoutMs / 60000)}m waiting for ${name} on ${sha.slice(0, 7)}.\n` +
          "      The change LANDED; CI is not confirmed. Check:\n" +
          `        gh run list --workflow "${name}" --commit ${sha}`
      );
      return 1;
    }
    say(`[ci] waiting for ${name} on ${sha.slice(0, 7)}...`);
    sleepSync(opts.pollMs);
  }
}

/* Read the `name:` of each workflow file under `.github/workflows`. Best-effort:
 * a file without a `name:` is skipped. Shared so wait-for.js can resolve the CI
 * workflow the same way ship does. */
function workflowNames(root) {
  const dir = path.join(root, ".github", "workflows");
  const names = [];
  if (!fs.existsSync(dir)) return names;
  for (const file of fs.readdirSync(dir)) {
    if (!/\.ya?ml$/i.test(file)) continue;
    try {
      const src = fs.readFileSync(path.join(dir, file), "utf8");
      const m = src.match(/^name:\s*(.+)$/m);
      if (m) names.push(m[1].trim().replace(/^["']|["']$/g, ""));
    } catch (_) {
      /* unreadable: skip */
    }
  }
  return names;
}

/* `shipCiWorkflow` from `.harness.json` when set, else the workflow named `CI`. */
function ciWorkflow(root) {
  const config = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, ".harness.json"), "utf8"));
    } catch {
      return null;
    }
  })();
  if (config && config.shipCiWorkflow) return String(config.shipCiWorkflow);
  return workflowNames(root).find((n) => /^ci$/i.test(n)) || null;
}

/* Resolve the CI wait timing (CLI flag > test-seam env > .harness.json >
 * default) into { timeoutMs, pollMs }. */
function ciConfig(root, args) {
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(path.join(root, ".harness.json"), "utf8")) || {};
  } catch {
    config = {};
  }
  const a = args || {};
  const envTimeout = Number(process.env.HARNESS_SHIP_CI_TIMEOUT_MS);
  const envPoll = Number(process.env.HARNESS_SHIP_CI_POLL_MS);
  const timeoutMinutes =
    a["ci-timeout"] !== undefined
      ? Number(a["ci-timeout"])
      : Number.isFinite(envTimeout) && envTimeout > 0
        ? envTimeout / 60000
        : Number(config.shipCiTimeoutMinutes) || 20;
  const pollSeconds =
    a["ci-poll"] !== undefined
      ? Number(a["ci-poll"])
      : Number.isFinite(envPoll) && envPoll > 0
        ? envPoll / 1000
        : Number(config.shipCiPollSeconds) || 15;
  return {
    timeoutMs: Math.max(1, Math.round(timeoutMinutes * 60 * 1000)),
    pollMs: Math.max(1, Math.round(pollSeconds * 1000)),
  };
}

module.exports = {
  CI_GH_FAILURE_WARN,
  ghBin,
  sleepSync,
  has,
  ghJson,
  waitCi,
  workflowNames,
  ciWorkflow,
  ciConfig,
};
