#!/usr/bin/env bash
#
# F-291 — run the device matrix DETACHED, so a 15–40 min run never blocks the
# tool and its progress is observable by tailing the log.
#
# Why a script: the device tier is a long-lived process. Launching it inline (or
# piping it through a buffering filter) makes a healthy run look frozen, which is
# how a full matrix gets aborted mid-flight. This wraps run-maestro.js with its
# own session and stdio — the launching shell sees EOF immediately and returns —
# and points you at the log file for live progress. run-maestro.js already prints
# a `Running flow (i/n): …` line per invocation, so the tail is meaningful.
#
# It also records a machine-readable JOB so the run is NOTIFYABLE instead of
# polled: `.serve/jobs/`-style dir under MOBILE_E2E_JOB_DIR holds
#   <id>.events.jsonl  one JSON line per scenario (run-maestro.js writes it)
#   <id>.json          { pid, log, events, cmd, startedAt, sessionID }
# The `job-notify` opencode plugin watches the events file and pushes per-scenario
# updates + a completion (and first-failure) notification. With `--wait` the
# launch blocks here until the run finishes, streaming each scenario line —
# use it when no plugin is watching (returns the run's exit code).
#
# Usage:
#   scripts/qa/mobile-e2e/run-detached.sh --flows all --reuse-session
#   scripts/qa/mobile-e2e/run-detached.sh --flows all --wait            # block + stream
#   scripts/qa/mobile-e2e/run-detached.sh --list                        # live/recent jobs
#   scripts/qa/mobile-e2e/run-detached.sh --stop <job-id|record.json>   # kill + matrix_aborted
#   MOBILE_E2E_LOG=/tmp/opencode/run6.log scripts/qa/mobile-e2e/run-detached.sh --flows all
#
# `--list` and `--stop` are the deterministic "what is running / stop it" verbs:
# --list prints each job's pid, running/dead state, age and seconds since its
# last event; --stop kills the job's process group (the setsid run + its Maestro
# JVM), force-stops the app, and appends a `matrix_aborted` event so every
# `wait-for --job` returns immediately instead of being guessed at.
#
# Env:
#   MOBILE_E2E_LOG          log path (default <jobdir>/<id>.log)
#   MOBILE_E2E_JOB_DIR      job dir (default /tmp/opencode/mobile-e2e-jobs)
#   MOBILE_E2E_JOB          job id (default timestamp)
#   MOBILE_E2E_JOB_SESSION  owning opencode session id (recorded for the plugin)
#   MOBILE_E2E_WAIT_HEARTBEAT  --wait progress interval seconds (default 20)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

JOB_DIR="${MOBILE_E2E_JOB_DIR:-/tmp/opencode/mobile-e2e-jobs}"
JOB_ID="${MOBILE_E2E_JOB:-mobile-e2e-$(date +%Y%m%d-%H%M%S)}"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Harness-side verbs: `--wait` (block + stream), `--list` (show jobs),
# `--stop <id>` (kill a run deterministically + write `matrix_aborted`).
WAIT=0; LIST=0; STOP=""; HELP=0; ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --wait) WAIT=1; shift;;
    --list) LIST=1; shift;;
    --stop)
      STOP="${2:-}"
      if [ -z "$STOP" ]; then echo "run-detached: --stop needs a job id or record path" >&2; exit 2; fi
      shift 2;;
    -h|--help) HELP=1; shift;;
    *) ARGS+=("$1"); shift;;
  esac
done

if [ "$HELP" = "1" ]; then
  cat <<'EOF'
run-detached.sh — launch/observe/stop a detached mobile-E2E matrix run.
  run-detached.sh --flows all --reuse-session     # launch (returns immediately)
  run-detached.sh --flows all --wait              # launch + block, streaming progress
  run-detached.sh --list                          # live/recent jobs (pid, state, last event)
  run-detached.sh --stop <job-id|record.json>     # kill a run + write matrix_aborted
EOF
  exit 0
fi

if [ "$LIST" = "1" ]; then
  node - "$JOB_DIR" <<'NODE'
const fs = require("fs"), path = require("path");
const dir = process.argv[2];
let files = [];
try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch {}
const rows = files
  .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { return null; } })
  .filter((r) => r && (r.id || r.events))
  .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
if (!rows.length) { console.log("no jobs in " + dir); process.exit(0); }
const alive = (p) => { try { process.kill(Number(p), 0); return true; } catch (e) { return e && e.code === "EPERM"; } };
console.log("job".padEnd(30) + "pid".padEnd(9) + "state".padEnd(9) + "age".padEnd(9) + "last-event");
for (const r of rows) {
  let evAge = "-";
  try { evAge = Math.round((Date.now() - fs.statSync(r.events).mtimeMs) / 1000) + "s"; } catch {}
  const age = r.startedAt ? Math.round((Date.now() - Date.parse(r.startedAt)) / 1000) + "s" : "-";
  console.log(
    String(r.id || "?").padEnd(30) + String(r.pid || "-").padEnd(9) +
    (alive(r.pid) ? "running" : "dead").padEnd(9) + age.padEnd(9) + evAge
  );
}
NODE
  exit 0
fi

if [ -n "$STOP" ]; then
  RECORD="$STOP"
  case "$STOP" in */* | *.json) ;; *) RECORD="$JOB_DIR/$STOP.json";; esac
  if [ ! -f "$RECORD" ]; then echo "run-detached: no such job record: $RECORD" >&2; exit 2; fi
  node - "$RECORD" "$SELF_DIR" <<'NODE'
const fs = require("fs"), path = require("path");
const { spawnSync } = require("child_process");
const rec = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const selfDir = process.argv[3];
const pid = Number(rec.pid);
const alive = (p) => { try { process.kill(Number(p), 0); return true; } catch (e) { return e && e.code === "EPERM"; } };
let signalled = false;
if (pid && alive(pid)) {
  try { process.kill(-pid, "SIGTERM"); signalled = true; } catch {}
  if (!signalled) { try { process.kill(pid, "SIGTERM"); signalled = true; } catch {} }
  const until = Date.now() + 3000;
  while (Date.now() < until && alive(pid)) {
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); } catch {}
  }
  if (alive(pid)) {
    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
  }
}
let appId = process.env.MOBILE_E2E_APP_ID || "com.example.app";
let localCfg = {};
try { localCfg = JSON.parse(fs.readFileSync(path.join(selfDir, "local.json"), "utf8")); } catch {}
if (localCfg.appId) appId = localCfg.appId;
// Platform: env MOBILE_E2E_PLATFORM > local.json `platform` > android. On iOS
// stop the app via `xcrun simctl terminate <bundle> <udid>`; on Android the
// historical `adb shell am force-stop` is unchanged.
const platform = String(process.env.MOBILE_E2E_PLATFORM || localCfg.platform || "android").toLowerCase();
if (platform === "ios") {
  const bundleId = process.env.MOBILE_E2E_IOS_BUNDLE_ID || (localCfg.ios && localCfg.ios.bundleId) || appId;
  const udid = process.env.MOBILE_E2E_IOS_UDID || "";
  try { spawnSync("xcrun", ["simctl", "terminate", bundleId].concat(udid ? [udid] : []), { timeout: 5000, stdio: "ignore" }); } catch {}
} else {
  try { spawnSync("adb", ["shell", "am", "force-stop", appId], { timeout: 5000, stdio: "ignore" }); } catch {}
}
if (rec.events) {
  try {
    fs.appendFileSync(rec.events, JSON.stringify({
      type: "matrix_aborted", at: new Date().toISOString(),
      by: "run-detached --stop", reason: "operator stop",
    }) + "\n");
  } catch {}
}
console.log("stop: pid " + (pid || "?") + (signalled ? " signalled" : " (already exited)") +
  " · matrix_aborted written" + (rec.events ? " -> " + rec.events : ""));
NODE
  exit 0
fi

mkdir -p "$JOB_DIR"
EVENTS="$JOB_DIR/$JOB_ID.events.jsonl"
RECORD="$JOB_DIR/$JOB_ID.json"
LOG="${MOBILE_E2E_LOG:-$JOB_DIR/$JOB_ID.log}"
: >"$EVENTS"

# `setsid` gives the run its own session; the inner redirection is on the actual
# command, so the wrapper's own fds stay closed and the tool returns at once.
# This is the correct form of the anti-pattern called out in docs/mobile-testing.md.
MOBILE_E2E_EVENTS="$EVENTS" setsid node scripts/qa/mobile-e2e/run-maestro.js "${ARGS[@]}" >"$LOG" 2>&1 </dev/null &
PID=$!

node -e "
const fs=require('fs');
fs.writeFileSync(process.argv[1], JSON.stringify({
  id: process.argv[2], pid: Number(process.argv[3]), log: process.argv[4], events: process.argv[5],
  cmd: 'run-maestro.js ' + process.argv.slice(6).join(' '),
  sessionID: process.env.MOBILE_E2E_JOB_SESSION || null,
  startedAt: new Date().toISOString()
}, null, 2));
" "$RECORD" "$JOB_ID" "$PID" "$LOG" "$EVENTS" "${ARGS[@]}"

echo "started run-maestro (pid $PID)"
echo "job:    $JOB_ID"
echo "record: $RECORD"
echo "events: $EVENTS"
echo "log:    $LOG"
echo "tail:   tail -f $LOG"
echo "exit:   wait $PID; or check \`kill -0 $PID\`"

if [ "$WAIT" != "1" ]; then
  exit 0
fi

# --wait blocks THIS shell for the whole run. From an agent, prefer detached +
# the job-notify plugin (or the async `wait` tool): a blocking bash call leaves
# the tool "running" and the transcript blind for the entire matrix (F-296).
echo "run-detached: --wait blocks this shell until the run finishes." >&2
echo "  In an agent session prefer detached + job-notify, or the async \`wait\` tool;" >&2
echo "  use --wait only headless. Progress every ${MOBILE_E2E_WAIT_HEARTBEAT:-20}s below." >&2

# --wait: block here, streaming each new scenario line, then return the run's
# exit code. A zombie (exited, not yet reaped) must not read as "running".
is_running() {
  [ -d "/proc/$PID" ] || return 1
  local state
  state="$(awk '{print $3}' "/proc/$PID/stat" 2>/dev/null || true)"
  [ "$state" != "Z" ]
}
printed=0
emit_new() {
  local total
  total="$(wc -l <"$EVENTS" 2>/dev/null | tr -d ' ' || echo 0)"
  [ -z "$total" ] && total=0
  if [ "$total" -gt "$printed" ]; then
    node scripts/qa/mobile-e2e/job-events.js --render "$EVENTS" --skip "$printed" || true
    printed="$total"
  fi
}
HB="${MOBILE_E2E_WAIT_HEARTBEAT:-20}"
while is_running; do
  sleep "$HB"
  emit_new
done
wait "$PID" && code=0 || code=$?
emit_new
node scripts/qa/mobile-e2e/job-events.js --summary "$EVENTS" || true
exit "$code"
