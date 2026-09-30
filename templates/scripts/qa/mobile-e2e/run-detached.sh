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
# Usage:
#   scripts/qa/mobile-e2e/run-detached.sh --flows all --reuse-session
#   MOBILE_E2E_LOG=/tmp/opencode/run6.log scripts/qa/mobile-e2e/run-detached.sh --flows all
#
# Env:
#   MOBILE_E2E_LOG  log path (default /tmp/opencode/mobile-e2e-<timestamp>.log)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

LOG_DIR="${MOBILE_E2E_LOG_DIR:-/tmp/opencode}"
mkdir -p "$LOG_DIR"
LOG="${MOBILE_E2E_LOG:-$LOG_DIR/mobile-e2e-$(date +%Y%m%d-%H%M%S).log}"

# `setsid` gives the run its own session; the inner redirection is on the actual
# command, so the wrapper's own fds stay closed and the tool returns at once.
# This is the correct form of the anti-pattern called out in docs/mobile-testing.md.
setsid node scripts/qa/mobile-e2e/run-maestro.js "$@" >"$LOG" 2>&1 </dev/null &
PID=$!

echo "started run-maestro (pid $PID)"
echo "log:  $LOG"
echo "tail: tail -f $LOG"
echo "exit: wait $PID; or check \`kill -0 $PID\`"
