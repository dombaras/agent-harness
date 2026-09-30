#!/usr/bin/env bash
#
# mobile E2E — bring the whole device tier UP in one idempotent command: the adb
# server, the emulator, the app build + install, and the dev server (in the same
# machine-wide `mobile` tier group), verified against a health URL.
#
# Why a wrapper: `boot-emulator.sh` covers the adb server + emulator only. The
# 2026-09 LibraryOS recon showed a device session hand-rolling 15-21 setup calls
# (adb server, emulator boot, APK build, install, dev-server start, health probe),
# each an opportunity to skip the readiness gate or the capacity check. This is
# the single entry point; the primitives stay where they are (boot-emulator.sh,
# serve.js) and this only sequences them.
#
# Idempotent: an already-booted emulator, a live adb server, an installed APK of
# the same version, and a running dev server are all REUSED (never restarted).
#
# Project config (never hardcoded here) — `scripts/qa/mobile-e2e/local.json`:
#   avd              AVD name                    (boot-emulator.sh reads it)
#   appId            Android package id          (install / version check)
#   apk              path to the APK            (default: conventional Gradle path)
#   devCmd           dev-server command         (default: npm run dev)
#   devUrl           dev-server health URL      (default: http://localhost:3000)
#   devName          serve.js label             (default: app-dev)
# Env overrides: MOBILE_E2E_APK / MOBILE_E2E_DEV_CMD / MOBILE_E2E_DEV_URL /
#   MOBILE_E2E_DEV_NAME / MOBILE_E2E_SKIP_BUILD / MOBILE_E2E_SKIP_INSTALL.
#
# Usage:
#   scripts/qa/mobile-e2e/device-up.sh            # full bring-up
#   scripts/qa/mobile-e2e/device-up.sh --no-dev   # emulator + app only (no dev server)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
LOCAL_CONFIG="$ROOT/scripts/qa/mobile-e2e/local.json"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/android-sdk}}"
ADB="$SDK/platform-tools/adb"
TIER_GROUP="${MOBILE_E2E_TIER_GROUP:-mobile}"

WITH_DEV=1
for arg in "$@"; do
  case "$arg" in
    --no-dev) WITH_DEV=0 ;;
    -h|--help) sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

cfg() {
  node -e "try{const c=require('$LOCAL_CONFIG');const v=c['$1'];process.stdout.write(v==null?'':String(v))}catch(e){}" 2>/dev/null || true
}

APP_ID="${MOBILE_E2E_APP_ID:-$(cfg appId)}"
APK="${MOBILE_E2E_APK:-$(cfg apk)}"
DEV_CMD="${MOBILE_E2E_DEV_CMD:-$(cfg devCmd)}"
DEV_URL="${MOBILE_E2E_DEV_URL:-$(cfg devUrl)}"
DEV_NAME="${MOBILE_E2E_DEV_NAME:-$(cfg devName)}"
[ -z "$DEV_CMD" ] && DEV_CMD="npm run dev"
[ -z "$DEV_URL" ] && DEV_URL="http://localhost:3000"
[ -z "$DEV_NAME" ] && DEV_NAME="app-dev"

echo "device-up: app=${APP_ID:-?} apk=${APK:-<auto>} dev=${DEV_URL} group=${TIER_GROUP}"

# 1. adb server + emulator + bounded boot gate (the primitive owns readiness).
echo "[1/4] adb server + emulator (boot-emulator.sh)"
bash scripts/qa/mobile-e2e/boot-emulator.sh

if [ ! -x "$ADB" ]; then
  echo "FAIL — adb not found at $ADB (set ANDROID_HOME)." >&2
  exit 1
fi

# 2. Build + install the APK (skip when already installed at the same version).
#    The build command is project-owned; default to the conventional Gradle
#    release/apk path and let MOBILE_E2E_APK override the output.
if [ "${MOBILE_E2E_SKIP_INSTALL:-0}" != "1" ] && [ -n "$APP_ID" ]; then
  if [ "${MOBILE_E2E_SKIP_BUILD:-0}" != "1" ]; then
    echo "[2/4] building the app (project build; override with MOBILE_E2E_SKIP_BUILD=1)"
    if [ -n "$APK" ] && [ -x "$ROOT/scripts/qa/mobile-e2e/build-apk.sh" ]; then
      bash "$ROOT/scripts/qa/mobile-e2e/build-apk.sh"
    else
      echo "  (no scripts/qa/mobile-e2e/build-apk.sh; set MOBILE_E2E_SKIP_BUILD=1 if the APK is prebuilt)"
    fi
  fi
  if [ -n "$APK" ] && [ -f "$APK" ]; then
    echo "[2/4] installing $APK"
    timeout 300 "$ADB" install -r "$APK"
  else
    echo "[2/4] no APK path resolved (set local.json .apk or MOBILE_E2E_APK) — skipping install"
  fi
else
  echo "[2/4] install skipped"
fi

# 3. Dev server, in the SAME heavy-tier group so the pair is one budget.
if [ "$WITH_DEV" = "1" ]; then
  echo "[3/4] dev server ($DEV_NAME) via serve.js --group $TIER_GROUP"
  node scripts/serve.js start --cmd "$DEV_CMD" --url "$DEV_URL" --name "$DEV_NAME" --group "$TIER_GROUP"
else
  echo "[3/4] dev server skipped (--no-dev)"
fi

# 4. Bounded readiness of the whole tier.
echo "[4/4] readiness"
timeout 30 "$ADB" wait-for-device
boot=""
for _ in $(seq 1 30); do
  boot="$(timeout 10 "$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
  [ "$boot" = "1" ] && break
  sleep 2
done
[ "$boot" = "1" ] || { echo "FAIL — emulator did not finish booting." >&2; exit 1; }

if [ "$WITH_DEV" = "1" ]; then
  node scripts/wait-for.js --health "$DEV_URL" --timeout 120 --quiet || {
    echo "FAIL — dev server not healthy at $DEV_URL (see .serve/$DEV_NAME.out.log)" >&2
    exit 1
  }
fi

node scripts/serve.js list
echo "device-up: OK"
