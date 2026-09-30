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
#   MOBILE_E2E_LOG=/tmp/opencode/run6.log scripts/qa/mobile-e2e/run-detached.sh --flows all
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
mkdir -p "$JOB_DIR"
EVENTS="$JOB_DIR/$JOB_ID.events.jsonl"
RECORD="$JOB_DIR/$JOB_ID.json"
LOG="${MOBILE_E2E_LOG:-$JOB_DIR/$JOB_ID.log}"
: >"$EVENTS"

# Pull `--wait` out of the args (it is harness-side, not a run-maestro option).
WAIT=0
ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--wait" ]; then WAIT=1; else ARGS+=("$arg"); fi
done

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
