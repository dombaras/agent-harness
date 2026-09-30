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
 *   node scripts/serve.js run   --cmd "<one-shot command>" [--name <label>] [--force] [--no-cap] [--mem-max 4G] [--cpu-max 250%]
 *   node scripts/serve.js stop  [--name <label>] [--port <n>]
 *   node scripts/serve.js stop-all
 *   node scripts/serve.js list
 *   node scripts/serve.js prune [--worktrees]
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

const SERVE_DIR = path.join(process.cwd(), ".serve");
const READY_INTERVAL = 500;
const HEARTBEAT_INTERVAL = 5000;
const DEFAULT_TIMEOUT = 60000;

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
      a === "--cpu-max"
    ) {
      flags[a] = argv[++i];
    } else if (a === "--heavy" || a === "--force" || a === "--no-cap" || a === "--worktrees") {
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

function pidFile(name) {
  return path.join(SERVE_DIR, name + ".pid");
}

function logPath(name, stream) {
  return path.join(SERVE_DIR, name + "." + stream + ".log");
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

function launcherPath(name) {
  return path.join(SERVE_DIR, name + ".cmd");
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

function stop(flags) {
  const name = deriveName(flags);
  const p = pidFile(name);
  if (!fs.existsSync(p)) {
    // No record: release this name's own lock (covers a lock left after a crash).
    capacity.releaseHeavyLock(name);
    console.log(`${name}: not running`);
    return;
  }
  let info;
  try {
    info = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (_) {
    info = { pid: fs.readFileSync(p, "utf8").trim() };
  }
  const pid = info.pid;
  const group = info.group || null;
  // A capped launch lives in a transient systemd unit: stopping the unit tears
  // down the whole cgroup (the MainPID alone would miss reparented children).
  if (info.unit) {
    if (stopUnit(info.unit)) console.log(`stopped ${name} (unit ${info.unit})`);
    else console.log(`stopped ${name} (unit ${info.unit}) — systemctl reported failure; verify with list`);
  } else if (pid && killTree(pid)) {
    console.log(`stopped ${name} (pid ${pid})`);
  } else {
    console.log(`stopped ${name} (pid ${pid}) — kill reported failure; verify with list`);
  }
  try {
    fs.unlinkSync(p);
  } catch (_) {}
  try {
    fs.unlinkSync(launcherPath(name));
  } catch (_) {}
  // Remove this member from the heavy lock; the lock file itself is deleted only
  // when the last member is gone, so a shared group (emulator + dev server)
  // releases exactly once.
  capacity.releaseHeavyLock(name, group);
}

function listNames() {
  if (!fs.existsSync(SERVE_DIR)) return [];
  return fs.readdirSync(SERVE_DIR).filter((f) => f.endsWith(".pid")).map((f) => f.slice(0, -4));
}

function stopAll() {
  const names = listNames();
  if (names.length === 0) {
    console.log("no servers running");
    return;
  }
  for (const name of names) stop({ "--name": name });
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
    if (isAlive(info.pid)) {
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

function isAlive(pid) {
  if (!pid || pid === "?") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function list() {
  // Auto-prune first, so `list` never reports a record whose process is gone
  // (e.g. an adb-server/emulator left over from a killed session).
  removeDeadRecords(SERVE_DIR);
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
  if (lock) console.log(`heavy lock: "${lock.name}" pid ${lock.pid} since ${lock.since}`);
  const names = listNames();
  if (names.length === 0) {
    console.log("no servers running");
    return;
  }
  for (const name of names) {
    let info;
    try {
      info = JSON.parse(fs.readFileSync(pidFile(name), "utf8"));
    } catch (_) {
      info = { pid: "?", name };
    }
    const started = info.startedAt ? Date.parse(info.startedAt) : NaN;
    const age = Number.isFinite(started) ? ` · up ${Math.round((Date.now() - started) / 60000)}m` : "";
    const heavy = info.heavy ? " [heavy]" : "";
    const group = info.group ? ` [group ${info.group}]` : "";
    const caps = [info.memMax ? `mem≤${info.memMax}` : null, info.cpuMax ? `cpu≤${info.cpuMax}` : null]
      .filter(Boolean)
      .join(" ");
    const capped = caps ? ` {${caps}${info.unit ? `, ${info.unit}` : ""}}` : "";
    console.log(
      `${name}: pid ${info.pid} (${isAlive(info.pid) ? "running" : "stale"})${heavy}${group}${capped}${age} — ${info.cmd || "?"}`
    );
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
 * plain run with a warning. One-shot commands are not counted as an extra
 * concurrent tier (a build legitimately runs while the emulator is up), but the
 * free-RAM floor still refuses to start when the box is already out of memory.
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
  if (label && !flags["--force"] && !capacityDisabled) {
    const sample = capacity.sample(process.cwd());
    const longLived = capacity.isLongLivedHeavy(cmd);
    const ev = capacity.evaluate(sample, {
      pendingHeavy: longLived ? 1 : 0,
      pendingLive: longLived ? 1 : 0,
      pendingGroup: flags["--group"] || null,
    });
    if (!ev.ok) {
      console.error(capacity.formatSummary(sample));
      console.error(capacity.heavyBlockText(label, ev, sample));
      process.exit(2);
    }
    for (const w of ev.warnings) console.error(`capacity warning: ${w}`);
  }

  const noCap = !!flags["--no-cap"] || process.env.AGENT_SERVE_NO_CAP === "1";
  let memMax = flags["--mem-max"] || null;
  if (!memMax && !noCap) {
    const envelope = capacity.readEnvelope(process.cwd());
    if (envelope.heavyMemMaxMb > 0) memMax = `${envelope.heavyMemMaxMb}M`;
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
      stop(flags);
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
    default:
      console.error(
        'usage: node scripts/serve.js <start|run|stop|stop-all|list|prune> [--cmd "..."] [--url <url>] [--port <n>] [--name <label>] [--group <tier>] [--timeout <ms>] [--heavy] [--force] [--no-cap] [--worktrees] [--mem-max 4G] [--cpu-max 250%]'
      );
      process.exitCode = 1;
  }
}

main();
