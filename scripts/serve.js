#!/usr/bin/env node
"use strict";
/*
 * serve.js — start/stop a long-running dev server WITHOUT freezing the agent shell.
 *
 * Why: the agent tool on Windows waits for a launched process tree to release the
 * tool's console/output handles. A foreground server — or a Node `spawn(..., {
 * detached: true, shell: true })`, which only sets CREATE_NEW_PROCESS_GROUP, not
 * DETACHED_PROCESS/CREATE_NEW_CONSOLE — keeps the whole `cmd → dev server` tree
 * attached to that console, so the tool call stays "running" for the server's
 * whole lifetime and only a manual interrupt ends it. The detach that works on
 * this stack is to give the server its OWN hidden console.
 *
 * How (win32): serve.js writes a small `<name>.cmd` launcher (it runs the dev
 * command and redirects stdout/stderr to the log files), then starts it via
 * PowerShell `Start-Process -WindowStyle Hidden` (CREATE_NEW_CONSOLE — the server
 * gets a hidden console of its own and cannot hold this tool call's console).
 * The real PID is captured from `-PassThru` and recorded; the process env + cwd
 * are inherited, so `next dev`/`npm` resolve exactly as they do in the agent
 * shell. Non-win32 keeps the plain detached `spawn` (setsid), which is sufficient.
 *
 * serve.js then polls --url (HTTP GET, any response) or --port (TCP connect)
 * until ready or --timeout (default 60000ms), printing a heartbeat every few
 * seconds so the tool shows live output instead of looking frozen. It prints the
 * PID + log path and exits 0; exits 1 (after printing the log tail) if the
 * server never became ready.
 *
 * Usage:
 *   node scripts/serve.js start --cmd "<dev command>" [--url <health url>] [--port <n>] [--name <label>] [--group <tier>] [--timeout <ms>] [--heavy] [--force] [--no-cap] [--mem-max 4G] [--cpu-max 250%]
 *   node scripts/serve.js run   --cmd "<one-shot command>" [--name <label>] [--group <tier>] [--force] [--no-cap] [--mem-max 4G] [--cpu-max 250%]
 *   node scripts/serve.js stop  [--name <label>] [--port <n>] [--session <ses_...>]
 *   node scripts/serve.js stop-all
 *   node scripts/serve.js list
 *   node scripts/serve.js prune [--worktrees]
 *   node scripts/serve.js reap [--json] [--quiet]
 *
 * - start: runs <cmd> detached (own hidden console on win32); polls --url/--port
 *   until ready or --timeout. Exits 0 on ready; exits 1 (after printing the log
 *   tail) on timeout. Always prints a "launching" line first + heartbeats while
 *   waiting, so an in-progress start is never silent.
 * - A heavy command (emulator, Metro/Next dev, live tier) is capped BY DEFAULT:
 *   it runs as a transient `systemd-run --user` unit (under `user.slice`) with
 *   MemoryMax from the envelope (`heavy_mem_max_mb`, default 5 GB — above the
 *   observed peak, so normal E2E is never throttled), so a runaway is
 *   throttled/OOM-killed *inside its cgroup* instead of taking the whole WSL VM
 *   into swap-thrash (the 2026-09-29 freeze). `--no-cap` opts out, `--mem-max`
 *   overrides. Graceful no-op where systemd is absent; `stop` tears the unit down.
 * - --mem-max / --cpu-max (systemd user bus available): MemoryMax/CPUQuota on
 *   that transient unit. Passes the caller's cwd + env through.
 * - stop: kills the recorded PID and its process tree, removes the PID file.
 * - prune: removes `.serve/*.pid` records whose process is gone (`--worktrees`
 *   also clears sibling agent worktrees), so a stale record cannot misreport a
 *   live heavy tier. Live servers are never touched.
 * - reap: auto-close a serve "after use" — STOP one whose owning session lease is
 *   gone/stale (or an untagged one older than `idle_reap_minutes` with no recent
 *   log activity), and reconcile an untracked `agent-serve-*` unit left by a
 *   killed session. A live owner's serve is never touched. Runs automatically at
 *   `start` and when the context-guard plugin sees `session.deleted`, so a
 *   dev server/emulator is not kept alive and orphaned.
 * - PID files + logs + the generated launcher live in <project>/.serve/
 *   (excluded clone-locally by the harness).
 * - A child's stdout is buffered while it runs; the log flushes on exit, so a
 *   startup crash is fully visible in the log after the fact.
 *
 * Always pair a start with a stop once the tier that needed the server is done.
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const net = require("net");
const { spawn, spawnSync } = require("child_process");
const capacity = require("./qa/capacity-lib.js");
const leaseLib = require("./qa/lease-lib.js");

const SERVE_DIR = path.join(process.cwd(), ".serve");
const READY_INTERVAL = 500;
const HEARTBEAT_INTERVAL = 5000;
const DEFAULT_TIMEOUT = 60000;
/* The opencode session id env var handed to tools that invoke scripts (the
 * backlog tools set it). serve.js records it as the serve's owner so a serve can
 * be reaped when the session that started it is gone. */
const SESSION_ENV = "HARNESS_SESSION_ID";

function powershellExe() {
  const known = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "";
  return known && fs.existsSync(known) ? known : "powershell.exe";
}

function parseArgs(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (
      a === "--cmd" ||
      a === "--url" ||
      a === "--port" ||
      a === "--name" ||
      a === "--group" ||
      a === "--timeout" ||
      a === "--mem-max" ||
      a === "--cpu-max" ||
      a === "--session"
    ) {
      flags[a] = argv[++i];
    } else if (
      a === "--heavy" ||
      a === "--force" ||
      a === "--no-cap" ||
      a === "--worktrees" ||
      a === "--json" ||
      a === "--quiet"
    ) {
      flags[a] = true;
    } else {
      flags._.push(a);
    }
  }
  return flags;
}

function deriveName(flags) {
  if (flags["--name"]) return flags["--name"];
  if (flags["--port"]) return "port-" + flags["--port"];
  return "default";
}

function pidFile(name, dir = SERVE_DIR) {
  return path.join(dir, name + ".pid");
}

function logPath(name, stream, dir = SERVE_DIR) {
  return path.join(dir, name + "." + stream + ".log");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function checkUrl(url) {
  const lib = String(url).startsWith("https://") ? https : http;
  return new Promise((resolve) => {
    const req = lib.get(url, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function checkPort(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port: Number(port) }, () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
    s.setTimeout(2000, () => {
      s.destroy();
      resolve(false);
    });
  });
}

function killTree(pid) {
  if (process.platform === "win32") {
    const r = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8" });
    return r.status === 0;
  }
  try {
    process.kill(-pid, "SIGTERM");
    return true;
  } catch (_) {
    try {
      process.kill(pid, "SIGTERM");
      return true;
    } catch (_) {
      return false;
    }
  }
}

/* Bounded synchronous pause (ms) — used between SIGTERM and SIGKILL. */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* fallback busy-wait */
    }
  }
}

/* Tear a process tree down and VERIFY it is gone: SIGTERM the group, wait, then
 * SIGKILL, then confirm the pid no longer exists. Returns true only when the
 * process is actually gone, so a caller never records a false teardown. Guards
 * pid<=1 so it can never issue `kill(-1)` (which signals every process). */
function terminateTree(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return true; // nothing to kill
  // Never issue kill(-1) (which would signal every process): a pid <= 1 is not
  // ours to teardown — report "not gone" so its record is retained, not orphaned.
  if (n <= 1) return false;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(n), "/T", "/F"], { encoding: "utf8" });
    return !isAlive(n);
  }
  try {
    process.kill(-n, "SIGTERM");
  } catch (_) {
    try {
      process.kill(n, "SIGTERM");
    } catch (_) {
      /* already gone */
    }
  }
  for (let i = 0; i < 20 && isAlive(n); i++) sleepSync(100);
  if (isAlive(n)) {
    try {
      process.kill(-n, "SIGKILL");
    } catch (_) {
      try {
        process.kill(n, "SIGKILL");
      } catch (_) {
        /* already gone */
      }
    }
    for (let i = 0; i < 10 && isAlive(n); i++) sleepSync(100);
  }
  return !isAlive(n);
}

/* The opencode session that owns a serve started from this checkout: the
 * explicit `HARNESS_SESSION_ID` when the caller set it, else the nearest
 * ancestor pid whose process wrote a `.serve/sessions/<id>.json` lease (the
 * context-guard plugin records the opencode server pid). Linux-only; null when
 * untagged (an older harness, a hand launch, or a non-Linux host). */
function ppidOf(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close === -1) return null;
    const ppid = parseInt(stat.slice(close + 2).split(" ")[1], 10);
    return Number.isFinite(ppid) ? ppid : null;
  } catch (_) {
    return null;
  }
}

function ownerSessionID() {
  const explicit = process.env[SESSION_ENV];
  if (explicit) return String(explicit);
  if (process.platform !== "linux") return null;
  const byPid = new Map();
  for (const root of allServeDirs()) {
    for (const rec of safeReadLeases(root)) {
      if (rec.pid && rec.sessionID) byPid.set(Number(rec.pid), rec.sessionID);
    }
  }
  if (byPid.size === 0) return null;
  let pid = process.pid;
  for (let i = 0; i < 64 && pid && pid !== 1; i++) {
    pid = ppidOf(pid);
    if (pid && byPid.has(pid)) return byPid.get(pid);
  }
  return null;
}

/* All leases recorded directly under a `.serve/` dir's `sessions/` (best-effort).
 * `serveDir` is the `.serve` directory itself (as returned by allServeDirs). */
function safeReadLeases(serveDir) {
  const sdir = path.join(serveDir, "sessions");
  const out = [];
  let names;
  try {
    names = fs.readdirSync(sdir);
  } catch (_) {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(sdir, name), "utf8")));
    } catch (_) {
      /* unreadable lease */
    }
  }
  return out;
}

/* Active `agent-serve-*` transient units, with the `.out.log` path parsed out of
 * the unit's ExecStart so an untracked legacy orphan can be judged idle. */
function activeServeUnits() {
  if (!systemdUserAvailable()) return [];
  const r = spawnSync(
    "systemctl",
    ["--user", "list-units", "agent-serve-*", "--all", "--no-legend", "--no-pager"],
    { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] }
  );
  const units = [];
  for (const raw of (r.stdout || "").split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(/^(agent-serve-\S+?\.service)\s+loaded\s+active\s+running\s+(.*)$/);
    if (!m) continue;
    const logM = m[2].match(/([^\s"]+\.out\.log)/);
    units.push({ unit: m[1], outLog: logM ? logM[1] : null });
  }
  return units;
}

function unitStartedAt(unit) {
  const m = String(unit).match(/-(\d{10,})\.service$/);
  return m ? Number(m[1]) : null;
}

function unitGone(unit) {
  if (!unit) return true;
  try {
    const r = spawnSync("systemctl", ["--user", "is-active", unit], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const state = (r.stdout || "").trim();
    return state === "" || state === "inactive" || state === "failed" || state === "unknown";
  } catch (_) {
    return false;
  }
}

/* Stop a unit and verify it is inactive (a stop that "succeeds" but leaves the
 * unit active must NOT be treated as a teardown). */
function terminateUnit(unit) {
  if (!unit) return true;
  spawnSync("systemctl", ["--user", "stop", unit], { encoding: "utf8", timeout: 15000 });
  for (let i = 0; i < 20 && !unitGone(unit); i++) sleepSync(100);
  return unitGone(unit);
}

/* Newest mtime among a record's log files (its activity signal). The record
 * stores absolute out/err log paths; fall back to `<serveDir>/<name>.*.log`. */
function lastActivityMs(info, dir) {
  const paths = [info.outLog, info.errLog];
  const name = info.name;
  if (name) {
    paths.push(logPath(name, "out", dir), logPath(name, "err", dir));
  }
  let newest = null;
  for (const p of paths) {
    if (!p) continue;
    try {
      const m = fs.statSync(p).mtimeMs;
      if (newest == null || m > newest) newest = m;
    } catch (_) {
      /* no log yet */
    }
  }
  return newest;
}

/* Whether the systemd *user* manager can host a transient unit (Linux only).
 * `--mem-max`/`--cpu-max` use it to cap a heavy process tree in its own cgroup;
 * everywhere else the flags are ignored with a warning. */
function systemdUserAvailable() {
  if (process.platform !== "linux") return false;
  if (process.env.AGENT_SERVE_NO_SYSTEMD === "1") return false;
  try {
    const r = spawnSync("systemctl", ["--user", "is-system-running"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (r.error) return false;
    return r.status === 0 || /running|degraded|starting|maintenance/.test(r.stdout || "");
  } catch (_) {
    return false;
  }
}

/* MainPID of a transient unit, once systemd has forked it. Bounded retry because
 * there is a small race between `systemd-run` returning and the exec landing. */
function mainPidOf(unit) {
  for (let i = 0; i < 20; i++) {
    const r = spawnSync("systemctl", ["--user", "show", "-p", "MainPID", "--value", unit], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const pid = parseInt((r.stdout || "").trim(), 10);
    if (pid) return pid;
    const end = Date.now() + 150;
    while (Date.now() < end) {
      /* brief busy-wait; the pid is needed before the pid file is written */
    }
  }
  return null;
}

function stopUnit(unit) {
  if (!unit) return false;
  try {
    const r = spawnSync("systemctl", ["--user", "stop", unit], { encoding: "utf8", timeout: 15000 });
    if (r.status === 0) return true;
    // `--collect` may have already GC'd a unit whose command exited: stopping a
    // gone unit is success, not failure.
    const s = spawnSync("systemctl", ["--user", "is-active", unit], { encoding: "utf8", timeout: 5000 });
    const state = (s.stdout || "").trim();
    return (
      state === "" ||
      state === "inactive" ||
      state === "failed" ||
      state === "unknown" ||
      /not-found/.test(s.stderr || "")
    );
  } catch (_) {
    return false;
  }
}

function logTail(p) {
  try {
    const lines = fs.readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean);
    return lines.slice(-15).join("\n");
  } catch (_) {
    return "";
  }
}

function launcherPath(name, dir = SERVE_DIR) {
  return path.join(dir, name + ".cmd");
}

// win32 detach: give the server its OWN hidden console so its process tree can
// never hold this tool call's console/output handles. Node's
// spawn(..., { detached: true, shell: true }) only sets CREATE_NEW_PROCESS_GROUP
// (the tree stays in the tool's console and the call blocks for its whole
// lifetime); a ShellExecute-launched process gets a fresh console instead. cmd.exe
// parsing is sidestepped by generating a .cmd launcher that runs the command and
// redirects stdout/stderr to the log files. The real PID comes back from -PassThru.
function launchDetachedWin32(fullCmd, name) {
  const launcher = launcherPath(name);
  fs.writeFileSync(launcher, "@echo off\r\n" + fullCmd + "\r\n", "utf8");
  const script =
    "$psi = New-Object System.Diagnostics.ProcessStartInfo;" +
    "$psi.FileName = $env:ComSpec;" +
    "$psi.Arguments = $env:SERVE_ARGS;" +
    "$psi.UseShellExecute = $true;" +
    "$psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden;" +
    "$psi.WorkingDirectory = $env:SERVE_CWD;" +
    "$p = [System.Diagnostics.Process]::Start($psi);" +
    "Write-Output $p.Id";
  const r = spawnSync(
    powershellExe(),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      windowsHide: true,
      env: Object.assign({}, process.env, {
        SERVE_ARGS: `/d /c ""${launcher}""`,
        SERVE_CWD: process.cwd(),
      }),
    }
  );
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`serve launch failed (powershell exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
  }
  const pid = parseInt((r.stdout || "").trim(), 10);
  if (!pid || Number.isNaN(pid)) {
    throw new Error(`serve launch returned no PID: ${JSON.stringify(r.stdout || "")}`);
  }
  return pid;
}

async function start(flags) {
  if (!flags["--cmd"]) {
    console.error("serve start: --cmd \"<command>\" is required");
    process.exit(1);
  }
  const name = deriveName(flags);
  const timeout = Number(flags["--timeout"]) || DEFAULT_TIMEOUT;
  const tierGroup = flags["--group"] || null;
  const outLog = logPath(name, "out");
  const errLog = logPath(name, "err");

  fs.mkdirSync(SERVE_DIR, { recursive: true });
  // Auto-close orphaned/idle serves first: a serve left by a killed session
  // otherwise pins RAM and blocks this very launch (an untracked emulator refuses
  // a same-AVD boot). A live owner's serve is never touched (see `reap`).
  const _exit = process.exitCode;
  try {
    reap({ "--quiet": true });
  } catch (_) {
    /* auto-reap is best-effort and must never break a launch */
  }
  process.exitCode = _exit;
  // Reap records whose process is gone before doing anything else: a stale
  // entry must never make a fresh start (or the capacity preflight) act on a
  // phantom server.
  removeDeadRecords(SERVE_DIR);

  // Capacity preflight: a heavy long-lived process (emulator, Metro/Next dev,
  // live tier) is what froze the box on 2026-09-29. Check the project envelope
  // and the machine-wide heavy lock BEFORE spawning, and refuse (naming what is
  // already up) rather than silently oversubscribing RAM/CPU. `--force`
  // overrides; a trivial process is never gated.
  const heavyLabel = flags["--heavy"]
    ? capacity.classifyHeavy(flags["--cmd"]) || "heavy process"
    : capacity.classifyHeavy(flags["--cmd"]);
  const capacityDisabled = process.env.AGENT_CAPACITY_DISABLE === "1";
  const holdLock = !!heavyLabel && !flags["--force"] && !capacityDisabled;
  if (holdLock) {
    const sample = capacity.sample(process.cwd());
    const ev = capacity.evaluate(sample, { pendingHeavy: 1, pendingLive: 1, pendingGroup: tierGroup });
    if (!ev.ok) {
      console.error(capacity.formatSummary(sample));
      console.error(capacity.heavyBlockText(heavyLabel, ev, sample));
      process.exit(2);
    }
    // A sibling member of the same tier group (the emulator's dev server) joins
    // the already-held group lock instead of being refused: the pair is ONE
    // budgeted mobile tier, not two competing heavy tiers.
    const existing = capacity.readLock();
    const joinsGroup =
      !!tierGroup &&
      !!existing &&
      existing.group === tierGroup &&
      !capacity.lockIsStale(existing, sample.envelope.heavyLockTtlMinutes);
    if (!joinsGroup) {
      const lock = capacity.acquireHeavyLock(name, sample.envelope, tierGroup);
      if (!lock.ok && lock.held) {
        const held = lock.lock || {};
        const members = capacity.lockMembers(held);
        const who = members.length ? members.map((m) => m.name).join(", ") : held.name || "?";
        console.error(
          `refused: the machine-wide heavy lock is held by "${who}"` +
            `${held.group ? ` [group ${held.group}]` : ""} ` +
            `(since ${held.since || "?"}) — only one emulator/live tier ` +
            `runs at a time. Stop it (node scripts/serve.js stop --name ${held.name || "<name>"}) ` +
            `or re-run with --force.`
        );
        process.exit(2);
      }
      if (!lock.ok) {
        console.warn(`serve start: heavy lock unavailable (${lock.error || "unknown"}) — continuing`);
      }
    }
  }

  const fullCmd = `${flags["--cmd"]} > "${outLog}" 2> "${errLog}"`;

  // Resource caps: heavy tiers are capped BY DEFAULT and run as a transient
  // systemd user unit (under `user.slice`), so a runaway is throttled/OOM-killed
  // inside its cgroup instead of dragging the whole VM into swap-thrash. This is
  // also what makes the `user.slice` ceiling installed by `wsl-tune.sh` actually
  // bind heavy work: WSL's `wsl.exe` session lives in `init.scope`, which that
  // ceiling does NOT cover, so a heavy tree launched inline would escape it.
  // Non-heavy processes are left alone; `--no-cap` opts a heavy tier out;
  // `--mem-max` overrides the default envelope cap. Without a systemd user bus
  // the cap degrades to a warning (Linux+systemd only).
  const capDisabled = process.env.AGENT_SERVE_NO_CAP === "1";
  const shouldCap =
    !flags["--no-cap"] &&
    !capDisabled &&
    (!!flags["--mem-max"] || !!flags["--cpu-max"] || !!heavyLabel);
  let memMax = flags["--mem-max"] || null;
  if (!memMax && heavyLabel && shouldCap) {
    const envelope = capacity.readEnvelope(process.cwd());
    if (envelope.heavyMemMaxMb > 0) memMax = `${envelope.heavyMemMaxMb}M`;
  }
  // Combined tier-group budget. Each member's per-process cap is generous (a
  // 2048 MB AVD peaks ~4.4 GB RSS), so an emulator + dev server could each take
  // 5 GB and fill a 10 GB VM all by themselves (the 2026-09-30 freeze). Tighten
  // this member's cap to the group's remaining budget so the pair stays inside
  // ONE budgeted tier; a near-exhausted budget refuses rather than launching a
  // member that will be OOM-killed on arrival. An explicit `--mem-max` wins.
  if (shouldCap && heavyLabel && tierGroup && !flags["--mem-max"]) {
    const envelope = capacity.readEnvelope(process.cwd());
    if (envelope.groupMemMaxMb > 0) {
      const budget = capacity.groupBudget(capacity.readServes(process.cwd()), tierGroup, envelope);
      const desired = capacity.parseMemMb(memMax) || envelope.heavyMemMaxMb;
      if (budget.remainingMb != null && desired > budget.remainingMb) {
        if (budget.remainingMb < 512 && !flags["--force"]) {
          console.error(
            `refused: tier group "${tierGroup}" has only ${budget.remainingMb} MB left of its ` +
              `${budget.totalMb} MB budget (group_mem_max_mb) — stop a member ` +
              `(node scripts/serve.js stop --name <name>) or re-run with --force`
          );
          process.exit(2);
        }
        memMax = `${Math.max(512, budget.remainingMb)}M`;
        console.log(
          `serve start: tier group "${tierGroup}" has ${budget.remainingMb} MB left — capping ${name} at ${memMax}`
        );
      }
    }
  }
  let unit = null;
  let pid = null;
  if (shouldCap) {
    if (systemdUserAvailable()) {
      const safe = String(name).replace(/[^a-zA-Z0-9_.-]/g, "_");
      unit = `agent-serve-${safe}-${Date.now()}`;
      const args = ["--user", "--unit", unit, "--collect"];
      if (memMax) args.push("-p", `MemoryMax=${memMax}`);
      if (flags["--cpu-max"]) args.push("-p", `CPUQuota=${flags["--cpu-max"]}`);
      // A transient unit gets the user manager's env + cwd, not the caller's.
      // Pass both through so the command resolves and behaves exactly as it
      // would in the agent shell (PATH, node managers, exported project vars).
      args.push("-p", `WorkingDirectory=${process.cwd()}`);
      for (const [k, v] of Object.entries(process.env)) {
        if (typeof v !== "string" || v.includes("\n")) continue;
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
        args.push(`--setenv=${k}=${v}`);
      }
      args.push("--", "sh", "-c", fullCmd);
      const r = spawnSync("systemd-run", args, {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 15000,
      });
      if (r.status !== 0) {
        console.warn(
          `serve start: systemd-run failed (${((r.stderr || r.stdout || "") + "").trim()}) — ` +
            `launching without resource caps`
        );
        unit = null;
      } else {
        pid = mainPidOf(unit);
      }
    } else {
      console.warn(
        "serve start: resource caps ignored — no systemd user bus (Linux+systemd only)"
      );
    }
  }

  if (!unit && !pid) {
    if (process.platform === "win32") {
      pid = launchDetachedWin32(fullCmd, name);
    } else {
      // POSIX: a detached spawn (setsid) is enough to leave the tool's terminal.
      const child = spawn(fullCmd, {
        cwd: process.cwd(),
        shell: true,
        detached: true,
        windowsHide: true,
        stdio: "ignore",
      });
      pid = child.pid;
      child.unref();
    }
  }

  // Record the cap only when it was actually applied (a transient unit). An
  // uncapped fallback (no systemd, systemd-run failed) must not claim mem≤N.
  const appliedMemMax = unit ? memMax : null;
  const appliedCpuMax = unit ? flags["--cpu-max"] || null : null;

  // Point the heavy lock at the REAL server pid (the `start` CLI exits now, so
  // its pid would read as stale at once). A same-group sibling is appended, not
  // clobbered. Best-effort: a lock write must never break a launch.
  if (holdLock) {
    try {
      capacity.updateHeavyMember({ name, group: tierGroup, pid, unit: unit || null });
    } catch (_) {
      /* lock bookkeeping is best-effort */
    }
  }

  fs.writeFileSync(
    pidFile(name),
    JSON.stringify(
      {
        pid,
        name,
        group: tierGroup,
        cmd: flags["--cmd"],
        port: flags["--port"] || null,
        url: flags["--url"] || null,
        heavy: !!heavyLabel,
        unit: unit || null,
        memMax: appliedMemMax,
        cpuMax: appliedCpuMax,
        sessionID: ownerSessionID(),
        outLog,
        errLog,
        startedAt: new Date().toISOString(),
      },
      null,
      2
    ),
    "utf8"
  );

  console.log(
    `serve start: launching ${name} (pid ${pid || "?"}${unit ? `, unit ${unit}` : ""}` +
      `${appliedMemMax ? `, mem≤${appliedMemMax}` : ""}) → ${outLog}`
  );
  if (process.platform === "win32") console.log(`  launcher: ${launcherPath(name)}`);

  const readyCheck = flags["--url"]
    ? () => checkUrl(flags["--url"])
    : flags["--port"]
      ? () => checkPort(flags["--port"])
      : null;

  if (!readyCheck) {
    console.log(`started ${name} (pid ${pid}) — no readiness check; logs: ${outLog}`);
    return;
  }

  const target = flags["--url"] || "port " + flags["--port"];
  const deadline = Date.now() + timeout;
  let lastBeat = 0;
  while (Date.now() < deadline) {
    if (await readyCheck()) {
      console.log(`started ${name} (pid ${pid}) — ready on ${target}`);
      return;
    }
    const elapsed = timeout - (deadline - Date.now());
    if (elapsed - lastBeat >= HEARTBEAT_INTERVAL) {
      console.log(`  …waiting for ${target} (${Math.round(elapsed / 1000)}s elapsed)`);
      lastBeat = elapsed;
    }
    await sleep(READY_INTERVAL);
  }
  const tail = logTail(outLog) || logTail(errLog);
  console.error(`started ${name} (pid ${pid}) but NOT ready on ${target} within ${timeout}ms.`);
  if (tail) console.error(`\n--- last log lines (${outLog}) ---\n${tail}\n---`);
  else console.error(`(no output captured yet — see ${outLog} / ${errLog})`);
  process.exit(1);
}

function stop(flags, dir) {
  const name = deriveName(flags);
  // Resolve which `.serve/` holds this record: the caller's dir, else the
  // current checkout, else any other serve dir on the machine (a server started
  // in the MAIN checkout before a mid-session worktree reroot lives outside the
  // worktree's `.serve/`).
  if (!dir) {
    dir = SERVE_DIR;
    if (!fs.existsSync(pidFile(name, dir))) {
      const found = allServeDirs().find((d) => fs.existsSync(pidFile(name, d)));
      if (found) dir = found;
    }
  }
  const p = pidFile(name, dir);
  if (!fs.existsSync(p)) {
    // No record: release this name's own lock (covers a lock left after a crash).
    capacity.releaseHeavyLock(name);
    console.log(`${name}: not running`);
    return true;
  }
  let info;
  try {
    info = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (_) {
    info = { pid: fs.readFileSync(p, "utf8").trim() };
  }
  const pid = info.pid;
  const group = info.group || null;
  // Teardown, then VERIFY. A capped launch lives in a transient systemd unit
  // (the unit, not the MainPID, tears down the whole cgroup); an uncapped one is
  // a detached process tree. A stop that does not actually remove the process
  // MUST NOT delete the record — deleting it is exactly how a live unit became
  // an untracked orphan (invisible to list/stop-all/prune).
  const gone = info.unit ? terminateUnit(info.unit) : terminateTree(pid);
  if (!gone) {
    console.error(
      `stop: ${name} (${info.unit ? `unit ${info.unit}` : `pid ${pid}`}) is STILL running after teardown — ` +
        `keeping the record so it is not orphaned. Retry, or inspect: ` +
        `${info.unit ? `systemctl --user status ${info.unit}` : `ps -p ${pid}`}`
    );
    process.exitCode = 1;
    return false;
  }
  console.log(info.unit ? `stopped ${name} (unit ${info.unit})` : `stopped ${name} (pid ${pid})`);
  try {
    fs.unlinkSync(p);
  } catch (_) {}
  try {
    fs.unlinkSync(launcherPath(name, dir));
  } catch (_) {}
  // Remove this member from the heavy lock; the lock file itself is deleted only
  // when the last member is gone, so a shared group (emulator + dev server)
  // releases exactly once.
  capacity.releaseHeavyLock(name, group);
  return true;
}

/* Stop every recorded serve owned by a session (used when that session ends). */
function stopSession(sessionID) {
  let stopped = 0;
  for (const dir of allServeDirs()) {
    for (const name of listNames(dir)) {
      let info = {};
      try {
        info = JSON.parse(fs.readFileSync(pidFile(name, dir), "utf8"));
      } catch (_) {
        continue;
      }
      if (info.sessionID && info.sessionID === sessionID) {
        if (stop({ "--name": name }, dir)) stopped++;
      }
    }
  }
  console.log(`stop --session ${sessionID}: ${stopped} serve(s) stopped`);
  return stopped;
}

function listNames(dir = SERVE_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".pid")).map((f) => f.slice(0, -4));
}

/* The MAIN worktree root (where a device tier started before a mid-session
 * worktree reroot left its `.serve/`), or null outside a git repo. */
function mainWorktreeRoot() {
  try {
    const r = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    if (r.status === 0 && r.stdout && r.stdout.trim()) {
      const common = r.stdout.trim();
      if (path.basename(common) === ".git") return path.dirname(common);
    }
    const r2 = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd(), encoding: "utf8" });
    if (r2.status === 0 && r2.stdout && r2.stdout.trim()) return r2.stdout.trim();
  } catch (_) {
    /* not a git checkout */
  }
  return null;
}

/* Every `.serve/` dir this machine's sessions may have written: the current
 * checkout's, the MAIN worktree's, and sibling feature worktrees'. `list` and
 * `stop-all` must span all of them — a server started in the MAIN checkout is
 * invisible to a session that re-rooted into its worktree, so a worktree-scoped
 * `stop-all` reported "no servers running" while the dev server survived and
 * pinned RAM for hours (the F-302 leak that starved F-304/F-305 device runs). */
function allServeDirs() {
  const dirs = new Set();
  const add = (d) => {
    if (d && fs.existsSync(d)) dirs.add(path.resolve(d));
  };
  add(SERVE_DIR);
  const main = mainWorktreeRoot();
  if (main) add(path.join(main, ".serve"));
  for (const d of siblingServeDirs()) add(d);
  return [...dirs];
}

/* Stop every recorded server across every serve dir, then reconcile the
 * machine-wide heavy lock (an orphaned member whose server record was lost in
 * another tree would otherwise wedge the capacity guard). */
function stopAll() {
  const entries = [];
  for (const dir of allServeDirs()) for (const name of listNames(dir)) entries.push({ dir, name });
  if (entries.length === 0) console.log("no servers running");
  else for (const { dir, name } of entries) stop({ "--name": name }, dir);

  const lock = capacity.readLock();
  if (lock) {
    const members = capacity.lockMembers(lock);
    let killed = 0;
    for (const m of members) {
      if (!m.pid || !capacity.isAlive(m.pid)) continue;
      if (m.unit ? stopUnit(m.unit) : killTree(m.pid)) killed++;
    }
    capacity.clearHeavyLock();
    console.log(
      `stop-all: cleared heavy lock "${lock.name}" (${members.length} member(s)${killed ? `, ${killed} stopped` : ""})`
    );
  }
}

/* Sibling worktree `.serve/` dirs, when this checkout lives under the harness
 * layout `<repo>/../.worktrees/<repo>/<id>`. Dead pid files there are invisible
 * to a `prune` run in the main checkout, yet they misreport live serves and hide
 * which heavy tiers were left behind — so `prune --worktrees` clears them. */
function siblingServeDirs() {
  const m = process.cwd().match(/^(.*[\\/])\.worktrees[\\/]([^\\/]+)[\\/][^\\/]+/);
  if (!m) return [];
  const base = path.join(m[1], ".worktrees", m[2]);
  const out = [];
  try {
    for (const id of fs.readdirSync(base)) {
      const dir = path.join(base, id, ".serve");
      if (fs.existsSync(dir)) out.push(dir);
    }
  } catch (_) {
    /* no worktrees — nothing to add */
  }
  return out;
}

/* Remove the dead `.serve/*.pid` records in one dir. Shared by the explicit
 * `prune` command and the silent auto-prune that `list`/`start` perform, so a
 * stale record (e.g. an adb-server/emulator left over from a previous session)
 * is reaped the moment anyone looks at or launches a server instead of lingering
 * to misreport the machine. Dead records cost no RAM, but they hide a stopped
 * emulator and let a stale `list` mislead an operator. Live servers are never
 * touched. `onRemove` (optional) receives each pruned pid-file path. */
function removeDeadRecords(dir, onRemove) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".pid"));
  } catch (_) {
    return { removed: 0, kept: 0 };
  }
  let removed = 0;
  let kept = 0;
  for (const f of files) {
    const p = path.join(dir, f);
    const name = f.slice(0, -4);
    let info = {};
    try {
      info = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (_) {
      info = {};
    }
    // A record is dead only when BOTH its pid is gone AND (if capped) its unit is
    // inactive. A failed stop or a MainPID that changed must never be pruned into
    // an untracked orphan while the unit is still running.
    if (isAlive(info.pid) || (info.unit && !unitGone(info.unit))) {
      kept++;
      continue;
    }
    try {
      fs.unlinkSync(p);
      fs.unlinkSync(path.join(dir, name + ".cmd"));
    } catch (_) {
      /* already gone */
    }
    removed++;
    if (onRemove) onRemove(p);
  }
  return { removed, kept };
}

function prune(flags) {
  const dirs = [SERVE_DIR];
  if (flags["--worktrees"]) dirs.push(...siblingServeDirs());
  let removed = 0;
  let kept = 0;
  for (const dir of dirs) {
    const result = removeDeadRecords(dir, (p) => console.log(`pruned stale ${p}`));
    removed += result.removed;
    kept += result.kept;
  }
  console.log(`prune: removed ${removed} stale record(s), kept ${kept} live`);
}

/* reap — the mechanical auto-close for long-lived serves.
 *
 * A serve is STOPPED when it is provably no longer managed:
 *   - its owning session's lease is gone or stale (heartbeat older than the idle
 *     window) — the session ended without stopping it; or
 *   - it is untagged (no owner) AND older than `idle_reap_minutes` AND its log
 *     shows no recent activity.
 * A serve is KEPT when its owner is a live session, or its log was written
 * within the idle window. This is what closes a dev server/emulator "after use"
 * without killing a live session's long-running tier — the leak where a
 * crashed/killed session left `agent-serve-*` units running for hours (an
 * untracked unit blocks the next boot: "multiple emulators with the same AVD").
 * It also reconciles a legacy untracked unit (a record lost by the old
 * unverified-stop bug) when that unit is old and idle. */
function reap(flags = {}) {
  const envelope = capacity.readEnvelope(process.cwd());
  const idleMs = (envelope.idleReapMinutes || 90) * 60000;
  const now = Date.now();

  const units = activeServeUnits();
  // Scan records in every known serve dir PLUS the dir behind each active unit's
  // log, so a worktree unit's record (and its owner lease) is seen even when reap
  // runs from the main checkout.
  const dirs = new Set(allServeDirs());
  for (const u of units) if (u.outLog) dirs.add(path.dirname(u.outLog));

  const leasesBySession = new Map();
  for (const dir of dirs) {
    for (const rec of safeReadLeases(dir)) {
      if (rec.sessionID) leasesBySession.set(rec.sessionID, rec);
    }
  }
  const ownerLive = (sessionID) => {
    if (!sessionID) return false;
    const rec = leasesBySession.get(sessionID);
    if (!rec) return false;
    try {
      return leaseLib.leaseStatus(rec, { now, maxAgeMs: idleMs }).live;
    } catch (_) {
      return false;
    }
  };

  const reaped = [];
  const kept = [];
  const trackedUnits = new Set();
  for (const dir of dirs) {
    for (const name of listNames(dir)) {
      let info = {};
      try {
        info = JSON.parse(fs.readFileSync(pidFile(name, dir), "utf8"));
      } catch (_) {
        continue;
      }
      if (info.unit) trackedUnits.add(info.unit);
      const alive = isAlive(info.pid) || (info.unit ? !unitGone(info.unit) : false);
      if (!alive) continue; // dead record — `prune` owns that
      if (ownerLive(info.sessionID)) {
        kept.push(`${name} (owner live)`);
        continue;
      }
      const activity = lastActivityMs(info, dir);
      if (activity != null && now - activity < idleMs) {
        kept.push(`${name} (active ${Math.round((now - activity) / 1000)}s ago)`);
        continue;
      }
      const started = info.startedAt ? Date.parse(info.startedAt) : null;
      const ageMs = started ? now - started : null;
      if (!info.sessionID && ageMs != null && ageMs <= idleMs) {
        kept.push(`${name} (untagged, ${Math.round(ageMs / 60000)}m — under idle ${envelope.idleReapMinutes}m)`);
        continue;
      }
      const why = info.sessionID ? "owner gone" : `idle ${ageMs == null ? "?" : Math.round(ageMs / 60000) + "m"}`;
      if (stop({ "--name": name }, dir)) reaped.push(`${name} (${why})`);
      else kept.push(`${name} (stop failed)`);
    }
  }

  // Untracked legacy units: a `.pid` record lost to the old unverified stop.
  for (const u of units) {
    if (trackedUnits.has(u.unit)) continue;
    const startedAt = unitStartedAt(u.unit);
    const ageMs = startedAt ? now - startedAt : null;
    let activity = null;
    if (u.outLog) {
      try {
        activity = fs.statSync(u.outLog).mtimeMs;
      } catch (_) {
        /* no log */
      }
    }
    if (activity != null && now - activity < idleMs) {
      kept.push(`${u.unit} (untracked, active)`);
      continue;
    }
    if (ageMs != null && ageMs <= idleMs) {
      kept.push(`${u.unit} (untracked, ${Math.round(ageMs / 60000)}m)`);
      continue;
    }
    if (terminateUnit(u.unit)) reaped.push(`${u.unit} (untracked orphan)`);
    else kept.push(`${u.unit} (stop failed)`);
  }

  if (flags["--json"]) {
    console.log(JSON.stringify({ reaped, kept }));
  } else if (!flags["--quiet"] || reaped.length) {
    for (const r of reaped) console.log(`reaped ${r}`);
    if (!flags["--quiet"]) for (const k of kept) console.log(`kept   ${k}`);
    console.log(`reap: ${reaped.length} reaped, ${kept.length} kept (idle ${envelope.idleReapMinutes}m)`);
  }
  return reaped.length;
}

function isAlive(pid) {
  if (!pid || pid === "?") return false;
  try {
    process.kill(pid, 0);
  } catch (_) {
    return false;
  }
  // A zombie still answers kill(0) but is not running. Treat it as gone, or a
  // confirmed teardown reads as "still running" and its record is never removed.
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const state = close === -1 ? "" : stat.slice(close + 2).split(" ")[0];
      if (state === "Z") return false;
    } catch (_) {
      /* /proc entry gone → not alive */
    }
  }
  return true;
}

function list() {
  // Auto-prune first, so `list` never reports a record whose process is gone
  // (e.g. an adb-server/emulator left over from a killed session). Prune every
  // serve dir the machine may have written, not just the current checkout's.
  const dirs = allServeDirs();
  for (const dir of dirs) removeDeadRecords(dir);
  // Capacity first: free RAM/swap/load + live-serve count, so `list` is the
  // one place an operator sees the whole machine state and can spot an idle
  // emulator/dev server to reap before it freezes the box.
  try {
    const sample = capacity.sample(process.cwd());
    console.log(capacity.formatSummary(sample));
  } catch (_) {
    /* capacity is best-effort */
  }
  const lock = capacity.readLock();
  if (lock) {
    const members = capacity.lockMembers(lock);
    const who = members.map((m) => `${m.name}(pid ${m.pid})`).join(", ") || "none";
    const stale = capacity.lockIsStale(lock) ? " [stale]" : "";
    console.log(`heavy lock: "${lock.name}" [${who}] since ${lock.since}${stale}`);
  }
  const entries = [];
  for (const dir of dirs) for (const name of listNames(dir)) entries.push({ dir, name });
  const recordedPids = new Set();
  if (entries.length === 0) {
    console.log("no servers running");
  }
  for (const { dir, name } of entries) {
    let info;
    try {
      info = JSON.parse(fs.readFileSync(pidFile(name, dir), "utf8"));
    } catch (_) {
      info = { pid: "?", name };
    }
    if (info.pid && info.pid !== "?") recordedPids.add(String(info.pid));
    const started = info.startedAt ? Date.parse(info.startedAt) : NaN;
    const age = Number.isFinite(started) ? ` · up ${Math.round((Date.now() - started) / 60000)}m` : "";
    const heavy = info.heavy ? " [heavy]" : "";
    const group = info.group ? ` [group ${info.group}]` : "";
    const caps = [info.memMax ? `mem≤${info.memMax}` : null, info.cpuMax ? `cpu≤${info.cpuMax}` : null]
      .filter(Boolean)
      .join(" ");
    const capped = caps ? ` {${caps}${info.unit ? `, ${info.unit}` : ""}}` : "";
    const where = path.resolve(dir) === path.resolve(SERVE_DIR) ? "" : ` @ ${dir}`;
    console.log(
      `${name}: pid ${info.pid} (${isAlive(info.pid) ? "running" : "stale"})${heavy}${group}${capped}${age}${where} — ${info.cmd || "?"}`
    );
  }
  // Warn about a lock member with no backing serve record anywhere — the leaked
  // tier that a worktree-scoped stop-all used to miss. `stop-all` clears it.
  if (lock) {
    const orphans = capacity
      .lockMembers(lock)
      .filter((m) => m.pid && capacity.isAlive(m.pid) && !recordedPids.has(String(m.pid)));
    if (orphans.length) {
      console.log(
        `heavy lock: ${orphans.length} orphan member(s) with no serve record (${orphans
          .map((m) => `${m.name}(pid ${m.pid})`)
          .join(", ")}) — reaping with \`node scripts/serve.js stop-all\``
      );
    }
  }
}

/* Run an UNCAPPED heavy command extractor through a stable name. */
function runDirect(cmd) {
  const r = spawnSync(cmd, { cwd: process.cwd(), shell: true, stdio: "inherit" });
  if (r.error) {
    console.error(`serve run: ${r.error.message}`);
    return 1;
  }
  return r.status == null ? 1 : r.status;
}

/* run — execute a SYNCHRONOUS one-shot heavy command inside a capped cgroup.
 *
 * `start` handles long-lived servers; a build or a heavy test tier is a
 * one-shot that must still be contained. This is the 2026-09-30 fix: the APK
 * build ran inline as `bash .../build-dev-apk.sh` (no serve.js), so its Gradle
 * daemon + Kotlin daemon + R8/D8 job had no MemoryMax and dragged the whole VM
 * into swap-thrash. `run` executes the command in a transient systemd scope with
 * `MemoryMax` from the envelope (or `--mem-max`), streams its output, and returns
 * its exit code — so a runaway is OOM-killed inside its own cgroup instead of
 * freezing every terminal. `--no-cap` opts out; a non-systemd host degrades to a
 * plain run with a warning. A heavy ONE-SHOT is not a long-lived tier, but it
 * still needs several GB: sharing the box with a live emulator+dev group OOMs
 * the build AND gets the emulator killed on a small VM (F-296, 2026-09-30). So
 * `run` joins the live heavy group (or an explicit `--group`), caps the one-shot
 * to the group's remaining budget, and refuses when the remainder is below the
 * one-shot floor — a build must run BEFORE the group boots, or not at all.
 */
function runCommand(flags) {
  const cmd = flags["--cmd"];
  if (!cmd) {
    console.error('serve run: --cmd "<command>" is required');
    process.exit(1);
  }
  const name = flags["--name"] || "run";
  const label = capacity.classifyHeavy(cmd);
  const capacityDisabled = process.env.AGENT_CAPACITY_DISABLE === "1";

  const noCap = !!flags["--no-cap"] || process.env.AGENT_SERVE_NO_CAP === "1";
  const envelope = capacity.readEnvelope(process.cwd());
  let memMax = flags["--mem-max"] || null;
  if (!memMax && !noCap && envelope.heavyMemMaxMb > 0) memMax = `${envelope.heavyMemMaxMb}M`;

  if (label && !flags["--force"] && !capacityDisabled) {
    const sample = capacity.sample(process.cwd());
    const longLived = capacity.isLongLivedHeavy(cmd);
    // If exactly one heavy group is live, the one-shot joins it (one budgeted
    // tier) so `evaluate` does not wrongly count two live members as two tiers.
    const liveGroups = [
      ...new Set(sample.serves.filter((x) => x.alive && x.heavy && x.group).map((x) => x.group)),
    ];
    const joinGroup = flags["--group"] || (liveGroups.length === 1 ? liveGroups[0] : null);
    const ev = capacity.evaluate(sample, {
      pendingHeavy: longLived ? 1 : 0,
      pendingLive: longLived ? 1 : 0,
      pendingGroup: joinGroup,
    });
    if (!ev.ok) {
      console.error(capacity.formatSummary(sample));
      console.error(capacity.heavyBlockText(label, ev, sample));
      process.exit(2);
    }
    for (const w of ev.warnings) console.error(`capacity warning: ${w}`);

    // A heavy one-shot must also fit the live tier group's remaining budget. The
    // free-RAM floor above only catches an already-empty box; a live emulator+dev
    // group (each capped generously) plus a 5-6 GB build exceeds a 10 GB VM even
    // while free RAM still looks healthy. Join the one live heavy group (or an
    // explicit --group), cap to the remainder, and refuse when it is too small.
    if (!longLived && envelope.groupMemMaxMb > 0 && joinGroup) {
      const budget = capacity.groupBudget(sample.serves, joinGroup, envelope);
      const minOneShotMb = Number(process.env.AGENT_ONESHOT_MIN_MB) || 2048;
      const requested = capacity.parseMemMb(memMax) || envelope.heavyMemMaxMb || minOneShotMb;
      if (budget.remainingMb != null && budget.remainingMb < minOneShotMb) {
        const members = sample.serves
          .filter((x) => x.alive && x.group === joinGroup)
          .map((x) => x.name)
          .join(", ");
        console.error(capacity.formatSummary(sample));
        console.error(
          `refused: one-shot "${label}" needs ≥ ${minOneShotMb} MB, but tier group "${joinGroup}" ` +
            `has only ${budget.remainingMb} MB left of ${budget.totalMb} MB (${members}). ` +
            `Build BEFORE booting the group, or stop one member ` +
            `(node scripts/serve.js stop --name <name>).`
        );
        process.exit(2);
      }
      if (budget.remainingMb != null && requested > budget.remainingMb) {
        console.error(
          `capacity warning: tightening one-shot "${name}" to the "${joinGroup}" group remainder (${budget.remainingMb} MB)`
        );
        memMax = `${budget.remainingMb}M`;
      }
    }
  }

  const started = Date.now();
  let status;
  if (!noCap && systemdUserAvailable()) {
    const args = [
      "--user",
      "--scope",
      "--quiet",
      "--expand-environment=no",
      `--working-directory=${process.cwd()}`,
    ];
    if (memMax) args.push("-p", `MemoryMax=${memMax}`);
    if (flags["--cpu-max"]) args.push("-p", `CPUQuota=${flags["--cpu-max"]}`);
    args.push("--", "sh", "-c", cmd);
    console.log(`serve run: ${name}${memMax ? ` (mem≤${memMax})` : ""} — capped one-shot, streaming output`);
    const r = spawnSync("systemd-run", args, { cwd: process.cwd(), stdio: "inherit" });
    if (r.error) {
      console.warn(`serve run: systemd-run failed (${r.error.message}) — running without caps`);
      status = runDirect(cmd);
    } else {
      status = r.status;
    }
  } else {
    if (!noCap) console.warn("serve run: resource caps ignored — no systemd user bus (Linux+systemd only)");
    status = runDirect(cmd);
  }

  const secs = Math.round((Date.now() - started) / 1000);
  console.log(`serve run: ${name} exited ${status == null ? "?" : status} after ${secs}s`);
  process.exit(status == null ? 1 : status);
}

function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  const flags = parseArgs(argv.slice(1));
  switch (sub) {
    case "start":
      start(flags).catch((e) => {
        console.error(e);
        process.exit(1);
      });
      break;
    case "run":
      runCommand(flags);
      break;
    case "stop":
      if (flags["--session"]) stopSession(flags["--session"]);
      else stop(flags);
      break;
    case "stop-all":
      stopAll();
      break;
    case "list":
      list();
      break;
    case "prune":
      prune(flags);
      break;
    case "reap":
      reap(flags);
      break;
    default:
      console.error(
        'usage: node scripts/serve.js <start|run|stop|stop-all|list|prune|reap> [--cmd "..."] [--url <url>] [--port <n>] [--name <label>] [--group <tier>] [--timeout <ms>] [--heavy] [--force] [--no-cap] [--worktrees] [--mem-max 4G] [--cpu-max 250%] [--session <ses_...>] [--json] [--quiet]'
      );
      process.exitCode = 1;
  }
}

main();
