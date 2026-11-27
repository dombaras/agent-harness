#!/usr/bin/env node
"use strict";
/*
 * heal-act — the bounded action executor for the self-healing loop (F-076).
 *
 * The pure control plane (`heal-lib.js`) decides; this module is the only place
 * that runs a process or writes a worktree. It never derives a command from
 * evidence: a command must come from a project-owned playbook under
 * `.agents/playbooks/`, is parsed to an argv array, rejects shell
 * metacharacters, and is bounded by timeout + kill switch polling.
 *
 * `auto` executes allowlisted T0 playbooks. `assist` prepares an isolated T1
 * worktree + handoff and stops there; T1 is never auto-landed by this module.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const healLib = require("./heal-lib.js");
const store = require("./heal-store.js");

const MAX_OUTPUT = 64 * 1024;
const AUDIT_TAIL = 2000;

function sha256(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex");
}

function playbookDir(root, policy) {
  const rel = policy?.repair?.playbook_dir || path.join(".agents", "playbooks");
  return path.resolve(root, rel);
}

/* Load every `<action>.md` playbook. A malformed or duplicate playbook is an
 * error the caller can refuse on; it is never silently replaced. */
function loadPlaybooks(root, policy) {
  const dir = playbookDir(root, policy);
  const result = { dir, byAction: {}, playbooks: [], errors: [] };
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && !/^readme/i.test(f)).sort();
  } catch (_) {
    return result;
  }
  for (const file of files) {
    const full = path.join(dir, file);
    try {
      const playbook = healLib.parsePlaybook(fs.readFileSync(full, "utf8"), { name: file.replace(/\.md$/, "") });
      if (result.byAction[playbook.action]) {
        result.errors.push({ file, error: `duplicate action ${playbook.action} (already ${result.byAction[playbook.action].name})` });
        continue;
      }
      result.byAction[playbook.action] = playbook;
      result.playbooks.push({ ...playbook, file });
    } catch (e) {
      result.errors.push({ file, error: e.message });
    }
  }
  return result;
}

function tail(text) {
  return String(text || "").slice(-MAX_OUTPUT);
}

/* Run an argv array. No shell. Stops on timeout or when `shouldAbort()` says the
 * kill switch flipped (polled every `pollMs`, default 2s; a SIGTERM is followed
 * by SIGKILL after 2s). */
function executeCommand(argv, opts = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || 600000);
    const pollMs = Math.max(500, Number(opts.pollMs) || 2000);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let timer = null;
    let poll = null;
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: opts.root,
        env: { ...process.env, ...(opts.env || {}), AGENT_HARNESS_HEAL_ATTEMPT: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({ ok: false, exit_code: null, signal: null, timed_out: false, aborted: false, error: e.message, stdout: "", stderr: "", duration_ms: 0 });
      return;
    }
    const finish = (code, signal, error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
      resolve({
        ok: code === 0 && !timedOut && !aborted && !error,
        exit_code: code,
        signal: signal || null,
        timed_out: timedOut,
        aborted,
        error: error ? error.message : null,
        stdout: tail(stdout),
        stderr: tail(stderr),
        duration_ms: Date.now() - started,
      });
    };
    const kill = (signal) => {
      try {
        child.kill(signal);
      } catch (_) {
        /* already gone */
      }
    };
    child.stdout.on("data", (chunk) => {
      stdout = tail(stdout + chunk.toString());
    });
    child.stderr.on("data", (chunk) => {
      stderr = tail(stderr + chunk.toString());
    });
    child.on("error", (e) => finish(null, null, e));
    child.on("close", (code, signal) => finish(code, signal, null));
    timer = setTimeout(() => {
      timedOut = true;
      kill("SIGKILL");
    }, timeoutMs);
    if (typeof opts.shouldAbort === "function") {
      poll = setInterval(() => {
        if (aborted) return;
        if (opts.shouldAbort()) {
          aborted = true;
          kill("SIGTERM");
          setTimeout(() => kill("SIGKILL"), 2000);
        }
      }, pollMs);
    }
  });
}

function finishAttempt(item, attempt, state, outcome, reason) {
  const next = {
    ...item,
    state,
    outcome,
    reason: reason || null,
    attempts: [...(item.attempts || []), attempt],
    last_seen: attempt.finished_at || item.last_seen,
  };
  if (state === "closed") next.closed_at = attempt.finished_at;
  return next;
}

/* One attempt. The item is persisted as `attempting` before the command starts,
 * so a crash mid-attempt leaves evidence; the final snapshot and audit entry are
 * written whatever happens. */
async function attempt(root, item, playbook, policy, opts = {}) {
  const now = opts.now || Date.now();
  const startedAt = new Date(now).toISOString();
  const attempt = {
    id: `att-${item.sig8 || sha256(item.signature || item.id).slice(0, 8)}-${now}`,
    action: playbook.action,
    playbook: playbook.name,
    playbook_sha256: playbook.sha256,
    argv: playbook.command,
    started_at: startedAt,
    finished_at: null,
    ok: null,
    exit_code: null,
    signal: null,
    timed_out: false,
    aborted: false,
    duration_ms: null,
    reason: null,
  };

  if (typeof opts.shouldAbort === "function" && opts.shouldAbort()) {
    return { refused: "kill switch is engaged", item, attempt: null };
  }

  store.appendAudit(root, {
    kind: "attempt_start",
    item: item.id,
    signature: item.signature,
    tier: item.tier,
    action: playbook.action,
    playbook: playbook.name,
    playbook_sha256: playbook.sha256,
    prompt_sha256: sha256(item.repro || ""),
    argv: playbook.command,
    actor: "heal",
  }, opts);

  let running;
  try {
    running = healLib.advance(item.state || "classified", "attempting");
  } catch (e) {
    return { refused: e.message, item, attempt: null };
  }
  const attempting = { ...item, state: running[running.length - 1], attempts: [...(item.attempts || []), { ...attempt, running: true }] };
  store.updateItem(root, attempting, opts);

  const result = await executeCommand(playbook.command, {
    root,
    timeoutMs: Math.min(playbook.timeout_sec, policy?.repair?.max_runtime_sec || 900) * 1000,
    pollMs: (policy?.repair?.kill_poll_sec || 2) * 1000,
    shouldAbort: opts.shouldAbort,
  });

  attempt.finished_at = new Date(now + result.duration_ms).toISOString();
  attempt.exit_code = result.exit_code;
  attempt.signal = result.signal;
  attempt.timed_out = result.timed_out;
  attempt.aborted = result.aborted;
  attempt.duration_ms = result.duration_ms;
  attempt.ok = result.ok;
  attempt.reason = result.aborted ? "kill switch engaged mid-attempt" : result.timed_out ? "timeout" : result.ok ? "exit 0" : result.error || `exit ${result.exit_code}`;

  const outcome = result.ok ? "resolved" : result.aborted ? "aborted" : "failed";
  const moving = healLib.advance(attempting.state, result.ok ? "closed" : "escalated");
  const next = finishAttempt(attempting, attempt, moving[moving.length - 1], outcome, attempt.reason);

  /* Rebuild the losing attempt marker: the running copy must not remain. */
  next.attempts = (next.attempts || []).filter((a) => !a.running);
  store.updateItem(root, next, opts);

  const breaker = healLib.breakerNext(opts.state || store.readState(root, opts), policy, now + result.duration_ms, result.ok);
  store.recordBreaker(root, breaker, { ...opts, now: now + result.duration_ms });

  store.appendAudit(root, {
    kind: "attempt_end",
    item: item.id,
    signature: item.signature,
    action: playbook.action,
    state: next.state,
    outcome,
    ok: result.ok,
    exit_code: result.exit_code,
    signal: result.signal,
    timed_out: result.timed_out,
    aborted: result.aborted,
    duration_ms: result.duration_ms,
    output_sha256: sha256(result.stdout + result.stderr),
    output_tail: store.redactString(result.stdout + "\n" + result.stderr, AUDIT_TAIL),
    breaker,
    actor: "heal",
  }, opts);

  return { item: next, attempt, breaker, result };
}

function git(root, args) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000 });
}

/* Prepare a T1 item: an isolated git worktree plus a bounded handoff. No product
 * file in the main checkout is touched, and no agent is dispatched here. */
function prepareT1(root, item, policy, opts = {}) {
  const now = opts.now || Date.now();
  const main = store.mainCheckout(root);
  const id = String(item.id || `heal-${item.sig8 || "signal"}`).replace(/[^A-Za-z0-9._-]/g, "-");
  const branch = `heal/${id}`;
  const base = path.join(main, ".agents", "qa-runs", "heal");
  const worktree = path.join(base, "worktrees", id);
  const handoff = path.join(base, "handoffs", `${id}.md`);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  fs.mkdirSync(path.dirname(handoff), { recursive: true });

  let created = false;
  let worktreeError = null;
  if (!fs.existsSync(path.join(worktree, ".git"))) {
    let add = git(main, ["worktree", "add", "-b", branch, worktree, "HEAD"]);
    if (add.status !== 0 && /already exists/i.test(String(add.stderr || ""))) {
      add = git(main, ["worktree", "add", worktree, branch]);
    }
    if (add.status !== 0) worktreeError = String(add.stderr || add.stdout || `exit ${add.status}`).trim().slice(0, 500);
    else created = true;
  }

  const markdown = healLib.handoffMarkdown(item, { policy, worktree, branch });
  fs.mkdirSync(path.dirname(handoff), { recursive: true });
  const tmp = `${handoff}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, markdown + "\n", "utf8");
  fs.renameSync(tmp, handoff);

  const attempt = {
    id: `prep-${item.sig8 || "signal"}-${now}`,
    action: "patch",
    playbook: "assist",
    started_at: new Date(now).toISOString(),
    finished_at: new Date(now).toISOString(),
    ok: !worktreeError,
    prepared: !worktreeError,
    reason: worktreeError || "isolated worktree + handoff prepared",
  };
  let moving;
  try {
    moving = healLib.advance(item.state || "classified", "escalated");
  } catch (e) {
    return { refused: e.message, item, attempt: null };
  }
  const next = {
    ...item,
    state: moving[moving.length - 1],
    outcome: worktreeError ? "failed" : "handoff",
    reason: worktreeError ? `worktree failed: ${worktreeError}` : "T1 prepared for a human/agent (no auto-land)",
    worktree,
    handoff_path: handoff,
    attempts: [...(item.attempts || []), attempt],
    last_seen: attempt.finished_at,
  };
  store.updateItem(root, next, opts);
  store.appendAudit(root, {
    kind: "assist_prepare",
    item: item.id,
    signature: item.signature,
    tier: item.tier,
    branch,
    worktree,
    handoff,
    created,
    error: worktreeError,
    prompt_sha256: sha256(item.repro || ""),
    actor: "heal",
  }, opts);
  return { item: next, attempt, worktree, handoff, created, error: worktreeError };
}

function quarantine(root, item, reason, opts = {}) {
  const now = opts.now || Date.now();
  let moving;
  try {
    moving = healLib.advance(item.state || "classified", "quarantined");
  } catch (e) {
    return { refused: e.message, item };
  }
  const next = {
    ...item,
    state: moving[moving.length - 1],
    outcome: "quarantined",
    reason: reason || "deterministic quarantine",
    quarantined_at: new Date(now).toISOString(),
  };
  store.updateItem(root, next, opts);
  store.appendAudit(root, { kind: "quarantine", item: item.id, signature: item.signature, reason: next.reason, actor: "heal" }, opts);
  return { item: next };
}

module.exports = {
  MAX_OUTPUT,
  playbookDir,
  loadPlaybooks,
  executeCommand,
  attempt,
  prepareT1,
  quarantine,
  sha256,
};
