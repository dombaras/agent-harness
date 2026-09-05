#!/usr/bin/env node
"use strict";
/*
 * serve.js — start/stop a long-running dev server WITHOUT freezing the agent shell.
 *
 * Why: a foreground server (or `Start-Process` on Windows, or a Node `spawn`
 * with `shell:true` + a file-descriptor stdio) inherits the shell's output
 * handles, so the agent tool waits for it to exit and hangs until the user
 * interrupts. This helper spawns the server fully detached (stdio ignored,
 * output redirected to log files by the shell, hidden window, unref'd), waits
 * for it to accept traffic, records its PID, and returns immediately.
 *
 * Usage:
 *   node scripts/serve.js start --cmd "<dev command>" [--url <health url>] [--port <n>] [--name <label>] [--timeout <ms>]
 *   node scripts/serve.js stop  [--name <label>] [--port <n>]
 *   node scripts/serve.js stop-all
 *   node scripts/serve.js list
 *
 * - start: runs <cmd> via the platform shell, detached; then polls --url (HTTP
 *   GET, any response) or --port (TCP connect) until ready or --timeout (default
 *   60000ms). Prints the PID + log path and exits 0; exits 1 (after printing the
 *   log tail) if the server never became ready.
 * - stop: kills the recorded PID and its process tree, removes the PID file.
 * - PID files + logs live in <project>/.serve/ (gitignored by the harness).
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
const DEFAULT_TIMEOUT = 60000;

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

  // Detach by ignoring the child's stdio entirely and redirecting output at the
  // shell level (never via a stdio file descriptor + shell:true — that holds the
  // shell's handles and freezes the agent tool on Windows).
  const fullCmd = `${flags["--cmd"]} > "${outLog}" 2> "${errLog}"`;
  const child = spawn(fullCmd, {
    cwd: process.cwd(),
    shell: true,
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  fs.writeFileSync(
    pidFile(name),
    JSON.stringify(
      { pid: child.pid, name, cmd: flags["--cmd"], port: flags["--port"] || null, url: flags["--url"] || null, startedAt: new Date().toISOString() },
      null,
      2
    ),
    "utf8"
  );
  child.unref();

  const readyCheck = flags["--url"]
    ? () => checkUrl(flags["--url"])
    : flags["--port"]
      ? () => checkPort(flags["--port"])
      : null;

  if (!readyCheck) {
    console.log(`started ${name} (pid ${child.pid}) — no readiness check; logs: ${outLog}`);
    return;
  }

  const target = flags["--url"] || "port " + flags["--port"];
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await readyCheck()) {
      console.log(`started ${name} (pid ${child.pid}) — ready on ${target}`);
      return;
    }
    await sleep(READY_INTERVAL);
  }
  const tail = logTail(outLog) || logTail(errLog);
  console.error(`started ${name} (pid ${child.pid}) but NOT ready on ${target} within ${timeout}ms.`);
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
