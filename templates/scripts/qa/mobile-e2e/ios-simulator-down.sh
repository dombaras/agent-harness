#!/usr/bin/env bash
#
# mobile E2E — bring an iOS Simulator DOWN (the iOS sibling of
# `device-down.sh`). Harness-owned; project values come from the sibling
# `local.json` `ios.deviceName` (or MOBILE_E2E_IOS_DEVICE_NAME / _UDID).
#
# Idempotent: a matching-but-already-gone simulator, a non-macOS host, or an
# unknown device all exit 0 — there is simply nothing to stop. Pass `--delete`
# to also remove the simulator device.
#
# Env overrides: MOBILE_E2E_IOS_DEVICE_NAME (and MOBILE_E2E_IOS_UDID to target
#   an exact device instead of matching by name).
#
# Usage:
#   scripts/qa/mobile-e2e/ios-simulator-down.sh            # shutdown matching sim
#   scripts/qa/mobile-e2e/ios-simulator-down.sh --delete   # shutdown + delete it
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
LOCAL_CONFIG="$ROOT/scripts/qa/mobile-e2e/local.json"

DELETE=0
for arg in "$@"; do
  case "$arg" in
    --delete) DELETE=1 ;;
    -h|--help) sed -n '2,/^set -euo pipefail$/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# Not macOS → nothing this script owns can be running.
if ! command -v xcrun >/dev/null 2>&1; then
  echo "ios-simulator-down: 'xcrun' not found (not macOS) — no iOS Simulator to stop."
  exit 0
fi

DEVICE_NAME="${MOBILE_E2E_IOS_DEVICE_NAME:-$(node -e "try{const c=require('$LOCAL_CONFIG');process.stdout.write((c.ios||{}).deviceName||'')}catch(e){}" 2>/dev/null || true)}"
[ -z "$DEVICE_NAME" ] && DEVICE_NAME="iOS Simulator"
UDID="${MOBILE_E2E_IOS_UDID:-}"

if [ -z "$UDID" ]; then
  UDID="$(
    DEVICE_NAME="$DEVICE_NAME" node -e '
      const { execFileSync } = require("child_process");
      const name = process.env.DEVICE_NAME;
      const list = JSON.parse(execFileSync("xcrun", ["simctl", "list", "devices", "-j"], { encoding: "utf8" }));
      const all = [];
      for (const devices of Object.values(list.devices || {})) {
        for (const d of devices) all.push(d);
      }
      const booted = all.find((d) => d.name === name && d.state === "Booted");
      const any = booted || all.find((d) => d.name === name);
      if (any) process.stdout.write(any.udid);
    ' 2>/dev/null || true
  )"
fi

if [ -z "$UDID" ]; then
  echo "ios-simulator-down: no simulator named '$DEVICE_NAME' — nothing to stop."
  exit 0
fi

echo "ios-simulator-down: shutting down $DEVICE_NAME ($UDID)"
xcrun simctl shutdown "$UDID" 2>/dev/null || true

if [ "$DELETE" = "1" ]; then
  echo "ios-simulator-down: deleting $UDID"
  xcrun simctl delete "$UDID" 2>/dev/null || true
fi

echo "ios-simulator-down: OK"
