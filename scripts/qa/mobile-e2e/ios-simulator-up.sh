#!/usr/bin/env bash
#
# mobile E2E — bring an iOS Simulator UP with `xcrun simctl` (the iOS sibling of
# `boot-emulator.sh` / the device half of `device-up.sh`). Harness-owned; project
# values come from the sibling `local.json` `ios` block.
#
# What it does, idempotently:
#   1. resolve the `ios` block from `scripts/qa/mobile-e2e/local.json`
#      (bundleId, deviceName, deviceType, appPath);
#   2. find a matching simulator — an already-booted one first, else any
#      existing one, else CREATE it from deviceType + the newest available iOS
#      runtime;
#   3. `xcrun simctl boot` + `bootstatus -b` (skip boot when already booted);
#   4. `xcrun simctl install` the unsigned `.app`;
#   5. print the device UDID + bundle id (and export them via GITHUB_ENV in CI).
#
# It fails LOUDLY when it cannot do its job: no `xcrun` (not macOS), no `.app`
# at the configured path, or no available iOS runtime. There is no silent
# fallback — a half-brought-up simulator would surface later as a mystery
# Maestro failure.
#
# Project config (never hardcoded here) — `scripts/qa/mobile-e2e/local.json`:
#   ios.bundleId     installed app bundle id (default com.example.app)
#   ios.deviceName   simulator name to find/create (default "iOS Simulator")
#   ios.deviceType   simctl device type      (default iPhone-15)
#   ios.appPath      unsigned simulator .app (required; no default — fails loud)
# Env overrides: MOBILE_E2E_IOS_BUNDLE_ID / MOBILE_E2E_IOS_DEVICE_NAME /
#   MOBILE_E2E_IOS_DEVICE_TYPE / MOBILE_E2E_IOS_APP / MOBILE_E2E_IOS_UDID.
#
# Usage:
#   scripts/qa/mobile-e2e/ios-simulator-up.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
LOCAL_CONFIG="$ROOT/scripts/qa/mobile-e2e/local.json"

cfg() {
  node -e "try{const c=require('$LOCAL_CONFIG');const v=(c.ios||{})['$1'];process.stdout.write(v==null?'':String(v))}catch(e){}" 2>/dev/null || true
}

BUNDLE_ID="${MOBILE_E2E_IOS_BUNDLE_ID:-$(cfg bundleId)}"
DEVICE_NAME="${MOBILE_E2E_IOS_DEVICE_NAME:-$(cfg deviceName)}"
DEVICE_TYPE="${MOBILE_E2E_IOS_DEVICE_TYPE:-$(cfg deviceType)}"
APP="${MOBILE_E2E_IOS_APP:-$(cfg appPath)}"
[ -z "$BUNDLE_ID" ] && BUNDLE_ID="com.example.app"
[ -z "$DEVICE_NAME" ] && DEVICE_NAME="iOS Simulator"
[ -z "$DEVICE_TYPE" ] && DEVICE_TYPE="com.apple.CoreSimulator.SimDeviceType.iPhone-15"

# 0. macOS / Xcode tooling is a hard prerequisite. A Linux host cannot bring up
#    an iOS Simulator; fail with the exact reason instead of a cryptic command
#    error. (This is also why the boot path in `boot-emulator.sh` delegates
#    here on `platform=ios` rather than trying any simctl logic inline.)
if ! command -v xcrun >/dev/null 2>&1; then
  echo "FAIL — ios-simulator-up.sh requires macOS with Xcode command-line tools ('xcrun' not found)." >&2
  echo "       This route runs on a macOS host/CI runner; it cannot boot an iOS Simulator on Linux." >&2
  exit 1
fi

# 1. Resolve the .app path (relative paths are repo-rooted) and require it. There
#    is no default: a project must name its own simulator build artifact.
if [ -z "$APP" ]; then
  echo "FAIL — no iOS simulator .app configured. Set MOBILE_E2E_IOS_APP or add" >&2
  echo "       \"ios\": { \"appPath\": \"<path>.app\" } to scripts/qa/mobile-e2e/local.json." >&2
  exit 1
fi
case "$APP" in
  /*) APP_ABS="$APP" ;;
  *) APP_ABS="$ROOT/$APP" ;;
esac
if [ ! -d "$APP_ABS" ] && [ ! -f "$APP_ABS" ]; then
  echo "FAIL — unsigned iOS simulator .app not found at: $APP_ABS" >&2
  echo "       Build it first, e.g.:" >&2
  echo "       cd mobile && npx eas-cli@latest build --platform ios --profile ios-simulator --local --non-interactive --output build/ios-simulator-app.app" >&2
  exit 1
fi

# 2. Find or create the simulator. Prefer a booted match, then any match, then
#    create one from the newest available iOS runtime. An explicit
#    MOBILE_E2E_IOS_UDID targets an exact device and skips the name lookup.
find_udid() {
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
}

UDID="${MOBILE_E2E_IOS_UDID:-}"
if [ -z "$UDID" ]; then
  UDID="$(find_udid)"
fi
if [ -n "$UDID" ]; then
  echo "ios-simulator-up: reusing simulator '$DEVICE_NAME' ($UDID)"
else
  RUNTIME="$(
    node -e '
      const { execFileSync } = require("child_process");
      const list = JSON.parse(execFileSync("xcrun", ["simctl", "list", "runtimes", "-j"], { encoding: "utf8" }));
      const ios = (list.runtimes || [])
        .filter((r) => r.isAvailable !== false && /iOS/i.test(r.name || ""))
        .sort((a, b) => String(b.version || "").localeCompare(String(a.version || ""), undefined, { numeric: true }));
      if (ios[0]) process.stdout.write(ios[0].identifier);
    ' 2>/dev/null || true
  )"
  if [ -z "$RUNTIME" ]; then
    echo "FAIL — no available iOS Simulator runtime found (install an iOS runtime via Xcode)." >&2
    exit 1
  fi
  UDID="$(xcrun simctl create "$DEVICE_NAME" "$DEVICE_TYPE" "$RUNTIME")"
  echo "ios-simulator-up: created simulator '$DEVICE_NAME' ($UDID) on $RUNTIME"
fi

# 3. Boot (idempotent) and wait for it to finish booting.
STATE="$(
  UDID="$UDID" node -e '
    const { execFileSync } = require("child_process");
    const list = JSON.parse(execFileSync("xcrun", ["simctl", "list", "devices", "-j"], { encoding: "utf8" }));
    for (const devices of Object.values(list.devices || {})) {
      for (const d of devices) if (d.udid === process.env.UDID) { process.stdout.write(d.state); return; }
    }
  ' 2>/dev/null || true
)"
if [ "$STATE" != "Booted" ]; then
  echo "ios-simulator-up: booting $UDID"
  xcrun simctl boot "$UDID"
else
  echo "ios-simulator-up: already booted $UDID"
fi
xcrun simctl bootstatus "$UDID" -b

# 4. Install the unsigned .app.
echo "ios-simulator-up: installing $APP_ABS"
xcrun simctl install "$UDID" "$APP_ABS"

# 5. Report identity (machine-readable first) and export to CI.
echo "UDID=$UDID"
echo "BUNDLE_ID=$BUNDLE_ID"
echo "ios-simulator-up: device=$DEVICE_NAME udid=$UDID bundle=$BUNDLE_ID app=$APP_ABS"
if [ -n "${GITHUB_ENV:-}" ]; then
  {
    echo "MOBILE_E2E_IOS_UDID=$UDID"
    echo "MOBILE_E2E_IOS_BUNDLE_ID=$BUNDLE_ID"
  } >>"$GITHUB_ENV"
fi
echo "ios-simulator-up: OK"
