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
 *   node scripts/serve.js start --cmd "<dev command>" [--url <health url>] [--port <n>] [--name <label>] [--timeout <ms>]
 *   node scripts/serve.js stop  [--name <label>] [--port <n>]
 *   node scripts/serve.js stop-all
 *   node scripts/serve.js list
 *
 * - start: runs <cmd> detached (own hidden console on win32); polls --url/--port
 *   until ready or --timeout. Exits 0 on ready; exits 1 (after printing the log
 *   tail) on timeout. Always prints a "launching" line first + heartbeats while
 *   waiting, so an in-progress start is never silent.
 * - stop: kills the recorded PID and its process tree, removes the PID file.
 * - PID files + logs + the generated launcher live in <project>/.serve/
 *   (gitignored by the harness).
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
    if (a === "--cmd" || a === "--url" || a === "--port" || a === "--name" || a === "--timeout") {
      flags[a] = argv[++i];
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
  const outLog = logPath(name, "out");
  const errLog = logPath(name, "err");

  fs.mkdirSync(SERVE_DIR, { recursive: true });

  const fullCmd = `${flags["--cmd"]} > "${outLog}" 2> "${errLog}"`;

  let pid;
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

  fs.writeFileSync(
    pidFile(name),
    JSON.stringify(
      { pid, name, cmd: flags["--cmd"], port: flags["--port"] || null, url: flags["--url"] || null, startedAt: new Date().toISOString() },
      null,
      2
    ),
    "utf8"
  );

  console.log(`serve start: launching ${name} (pid ${pid}) → ${outLog}`);
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
    console.log(`${name}: not running`);
    return;
  }
  let pid;
  try {
    pid = JSON.parse(fs.readFileSync(p, "utf8")).pid;
  } catch (_) {
    pid = fs.readFileSync(p, "utf8").trim();
  }
  if (pid && killTree(pid)) {
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
    console.log(`${name}: pid ${info.pid} (${isAlive(info.pid) ? "running" : "stale"}) — ${info.cmd || "?"}`);
  }
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
    case "stop":
      stop(flags);
      break;
    case "stop-all":
      stopAll();
      break;
    case "list":
      list();
      break;
    default:
      console.error(
        'usage: node scripts/serve.js <start|stop|stop-all|list> [--cmd "..."] [--url <url>] [--port <n>] [--name <label>] [--timeout <ms>]'
      );
      process.exitCode = 1;
  }
}

main();
