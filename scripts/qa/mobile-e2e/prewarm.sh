#!/usr/bin/env bash
#
# mobile E2E — warm the device-tier APK cache OFF the critical path.
#
# A cold `assembleRelease` is 7-11 min; run inside `device-up.sh` it blocks the
# whole tier. This script pays that cost up front (e.g. right after a worktree is
# created or the harness is updated) so the next `device-up.sh` is a fast
# cache hit/overlay. It is idempotent and safe to run at any time:
#
#   * a full-key cache hit exits immediately (nothing to do);
#   * else the native-base + fresh-bundle overlay is tried (seconds);
#   * else the capped Gradle build runs.
#
# `build-apk.sh` routes the Gradle build through `serve.js run`, so prewarm obeys
# the machine-wide capacity envelope: it refuses (non-zero, no build) when a
# heavy tier is live rather than thrashing the VM. That makes it safe to invoke
# speculatively.
#
# Usage:
#   scripts/qa/mobile-e2e/prewarm.sh            # warm, in the foreground
#   scripts/qa/mobile-e2e/prewarm.sh --detach   # warm in the background, return
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
CACHE_JS="$ROOT/scripts/qa/mobile-e2e/apk-cache.js"

if [ "${1:-}" = "--detach" ]; then
  LOG="${MOBILE_E2E_PREWARM_LOG:-$ROOT/.serve/prewarm.log}"
  mkdir -p "$(dirname "$LOG")"
  setsid bash "$ROOT/scripts/qa/mobile-e2e/prewarm.sh" >"$LOG" 2>&1 </dev/null &
  echo "prewarm: started detached (log: $LOG, pid $!)"
  exit 0
fi

if [ ! -f "$CACHE_JS" ]; then
  echo "prewarm: no apk-cache.js — nothing to do" >&2
  exit 0
fi

if node "$CACHE_JS" get >/dev/null 2>&1; then
  echo "prewarm: full cache hit — device-up is ready"
  exit 0
fi

if [ "${MOBILE_E2E_APK_OVERLAY:-1}" != "0" ] && node "$CACHE_JS" overlay >/dev/null 2>&1; then
  echo "prewarm: native base + fresh bundle overlaid — device-up is ready"
  exit 0
fi

if [ -x "$ROOT/scripts/qa/mobile-e2e/build-apk.sh" ]; then
  echo "prewarm: building the native base (capped)…"
  bash "$ROOT/scripts/qa/mobile-e2e/build-apk.sh"
else
  echo "prewarm: no build-apk.sh — nothing to do" >&2
fi
