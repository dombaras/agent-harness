#!/usr/bin/env bash
#
# mobile E2E — bring the device tier DOWN cleanly: stop the dev server, optionally
# the emulator, and prune dead `.serve/` records so a stopped emulator is never
# misreported as live (and its RAM is actually freed).
#
# Pairs with `device-up.sh`. The rule is: stop a dev server as soon as its tier
# passes; reuse an emulator WITHIN a session but stop it at session end. This
# makes that one command instead of a hand-typed `serve.js stop` per process.
#
# Usage:
#   scripts/qa/mobile-e2e/device-down.sh              # stop dev server + prune
#   scripts/qa/mobile-e2e/device-down.sh --emulator   # also stop the emulator (or iOS Simulator)
#   scripts/qa/mobile-e2e/device-down.sh --all        # stop-all heavy tiers
#
# Platform: android (default) or ios from `MOBILE_E2E_PLATFORM` / local.json
# `platform`. On ios the simulator is stopped via ios-simulator-down.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
LOCAL_CONFIG="$ROOT/scripts/qa/mobile-e2e/local.json"

DEV_NAME="${MOBILE_E2E_DEV_NAME:-$(node -e "try{const c=require('$LOCAL_CONFIG');process.stdout.write(c.devName||'')}catch(e){}" 2>/dev/null || true)}"
[ -z "$DEV_NAME" ] && DEV_NAME="app-dev"

# Platform selection: env MOBILE_E2E_PLATFORM > local.json `platform` > android.
# On ios the simulator is stopped via the sibling ios-simulator-down.sh instead
# of the adb/emulator teardown (which is Android-only).
PLATFORM="${MOBILE_E2E_PLATFORM:-$(node -e "try{const c=require('$LOCAL_CONFIG');process.stdout.write(c.platform||'')}catch(e){}" 2>/dev/null || true)}"
case "$PLATFORM" in ios|iOS|IOS) PLATFORM=ios ;; *) PLATFORM=android ;; esac

MODE="dev"
for arg in "$@"; do
  case "$arg" in
    --emulator) MODE="emulator" ;;
    --all) MODE="all" ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# Persist a quickboot snapshot before the emulator goes away, so the next
# device-up boots in seconds. Best-effort: a device that is already gone (or a
# save the emulator refuses) must never fail the teardown — but the failure is
# SURFACED (to stderr + `.serve/snapshot-save.log`), because a silent save
# failure is what made every bring-up cold-boot while the runbook claimed warm
# booting.
save_snapshot() {
  [ "${MOBILE_E2E_SNAPSHOT:-1}" = "0" ] && return 0
  local sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/android-sdk}}"
  local adb="$sdk/platform-tools/adb"
  local name="${MOBILE_E2E_SNAPSHOT_NAME:-agent-e2e}"
  local log="$ROOT/.serve/snapshot-save.log"
  [ -x "$adb" ] || return 0
  timeout 10 "$adb" get-state >/dev/null 2>&1 || return 0
  echo "device-down: saving quickboot snapshot ($name)"
  mkdir -p "$ROOT/.serve"
  if timeout 120 "$adb" emu avd snapshot save "$name" >"$log" 2>&1; then
    echo "device-down: snapshot saved ($name)"
  else
    echo "device-down: ! snapshot save failed — next device-up will cold boot (see $log)" >&2
  fi
}

if [ "$MODE" = "all" ]; then
  echo "device-down: stop-all + prune"
  if [ "$PLATFORM" = "android" ]; then save_snapshot; fi
  node scripts/serve.js stop-all || true
  if [ "$PLATFORM" = "ios" ]; then bash scripts/qa/mobile-e2e/ios-simulator-down.sh || true; fi
else
  echo "device-down: stop dev server ($DEV_NAME)"
  node scripts/serve.js stop --name "$DEV_NAME" || true
  if [ "$MODE" = "emulator" ]; then
    if [ "$PLATFORM" = "ios" ]; then
      echo "device-down: stop iOS Simulator"
      bash scripts/qa/mobile-e2e/ios-simulator-down.sh || true
    else
      save_snapshot
      echo "device-down: stop emulator"
      node scripts/serve.js stop --name emulator || true
      node scripts/serve.js stop --name adb-server || true
    fi
  fi
fi

node scripts/serve.js prune --worktrees || true
node scripts/serve.js list || true
