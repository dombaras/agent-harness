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
# Order matters: the APK build (a heavy one-shot) runs BEFORE the emulator (a
# heavy long-lived tier) so the two never overlap on a ~10 GB VM — building while
# the emulator is up OOMs the build and can get the emulator killed (F-296).
#
# Speed (F-30x device-tier startup): the build reuses the content-addressed
# native base + JS bundle via `build-apk.sh`/`apk-cache.js`, so only the JS
# bundle is re-signed per feature revision; the emulator boots from a quickboot
# snapshot when one is valid; and the dev-server start overlaps the emulator
# boot (both are independent). `device-up:timings {…}` is printed per phase.
#
# Idempotent: an already-booted emulator, a live adb server, an installed APK of
# the same version, and a running dev server are all REUSED (never restarted).
#
# Project config (never hardcoded here) — `scripts/qa/mobile-e2e/local.json`:
#   platform         android|ios               (default android; env MOBILE_E2E_PLATFORM wins)
#   avd              AVD name                    (boot-emulator.sh reads it)
#   appId            Android package id          (install / version check)
#   apk              path to the APK            (default: conventional Gradle path)
#   devCmd           dev-server command         (default: npm run dev)
#   devUrl           dev-server health URL      (default: http://localhost:3000)
#   devName          serve.js label             (default: app-dev)
#   devBuildCmd      backend build (optional); when set, run ONCE before the
#                    server and cache it (backend-build-cache.js). For a
#                    production backend set devCmd: "npm run start",
#                    devBuildCmd: "npm run build".
#   devBuildCache    globs whose content invalidates devBuildCmd (required for
#                    caching; e.g. ["app/**","lib/**","next.config.*"]).
#   devBuildOutput   optional artifact a cache hit must also find present
#                    (e.g. ".next/BUILD_ID") — a deleted build is a miss.
# Env overrides: MOBILE_E2E_APK / MOBILE_E2E_DEV_CMD / MOBILE_E2E_DEV_URL /
#   MOBILE_E2E_DEV_NAME / MOBILE_E2E_SKIP_BUILD / MOBILE_E2E_SKIP_INSTALL /
#   MOBILE_E2E_OVERLAP (default 1) / MOBILE_E2E_DEV_MEM_MAX (dev-server cgroup
#   cap, default 2560M) / MOBILE_E2E_DEV_BUILD_CMD / MOBILE_E2E_DEV_BUILD_FORCE.
#
# The dev server gets an EXPLICIT --mem-max: serve.js sums group member CAPS, so
# without it the dev server would claim the whole heavy_mem_max_mb default and
# the later emulator would be tightened to the tiny remainder (= its guest RAM,
# pinning qemu against its cgroup cap). 2560M covers next dev's ~1.9 GB peak and
# leaves the group budget for the emulator (see boot-emulator.sh --mem-max).
# A production backend (`next start`) is far leaner and steadier across the long
# matrix run; `devBuildCmd` opts in and is run as a capped one-shot, sequenced
# with the APK build so two heavy one-shots never overlap.
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
SERVE_DIR="$ROOT/.serve"

WITH_DEV=1
for arg in "$@"; do
  case "$arg" in
    --no-dev) WITH_DEV=0 ;;
    -h|--help) sed -n '2,/^set -euo pipefail$/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
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
DEV_MEM_MAX="${MOBILE_E2E_DEV_MEM_MAX:-2560}M"
DEV_BUILD_CMD="${MOBILE_E2E_DEV_BUILD_CMD:-$(cfg devBuildCmd)}"
BUILD_CACHE_JS="$ROOT/scripts/qa/mobile-e2e/backend-build-cache.js"
[ -z "$DEV_CMD" ] && DEV_CMD="npm run dev"
[ -z "$DEV_URL" ] && DEV_URL="http://localhost:3000"
[ -z "$DEV_NAME" ] && DEV_NAME="app-dev"
# Conventional Expo/RN release output when local.json declares no `apk`.
[ -z "$APK" ] && APK="$ROOT/mobile/android/app/build/outputs/apk/release/app-release.apk"

# Platform selection: env MOBILE_E2E_PLATFORM > local.json `platform` > android.
# android = the full APK/adb/emulator tier; ios = `ios-simulator-up.sh` + the dev
# server only (no Gradle, no adb, no APK install — those are Android-only).
PLATFORM="${MOBILE_E2E_PLATFORM:-$(cfg platform)}"
case "$PLATFORM" in ios|iOS|IOS) PLATFORM=ios ;; *) PLATFORM=android ;; esac

mkdir -p "$SERVE_DIR"
now_ms() { date +%s%3N; }
T_START="$(now_ms)"
T_BUILD="$T_START"
T_BOOT="$T_START"
T_INSTALL="$T_START"
T_DEV="$T_START"

echo "device-up: platform=$PLATFORM app=${APP_ID:-?} apk=${APK:-<auto>} dev=${DEV_URL} group=${TIER_GROUP}"

# 1. Build the APK FIRST, as a capped one-shot, BEFORE the emulator exists. The
#    build is a heavy one-shot (Gradle daemon + Kotlin daemon + R8/D8) and the
#    emulator is a heavy long-lived tier; running both at once on a ~10 GB VM
#    OOMs the build AND can get the emulator killed (F-296, 2026-09-30). Build
#    then boot serializes the two heavy phases. `serve.js run` also refuses a
#    build that does not fit a live group budget, so a rebuild while an emulator
#    is already up fails loudly instead of thrashing the box.
#
#    build-apk.sh owns the cache: it reuses a full-key hit, else overlays a fresh
#    JS bundle onto the cached native base, else runs Gradle. It prints the APK
#    path as `APK=…`, which we adopt (the cached/overlaid path differs from the
#    conventional one).
if [ "$PLATFORM" != "ios" ] && [ "${MOBILE_E2E_SKIP_INSTALL:-0}" != "1" ] && [ "${MOBILE_E2E_SKIP_BUILD:-0}" != "1" ]; then
  echo "[1/5] building the app (cached via apk-cache.js; override with MOBILE_E2E_SKIP_BUILD=1)"
  BUILD_LOG="$SERVE_DIR/device-up-build.log"
  if [ -x "$ROOT/scripts/qa/mobile-e2e/build-apk.sh" ]; then
    bash "$ROOT/scripts/qa/mobile-e2e/build-apk.sh" 2>&1 | tee "$BUILD_LOG"
    # PIPESTATUS[0] is build-apk.sh's status under `set -o pipefail`.
    parsed="$(sed -n 's/^APK=//p' "$BUILD_LOG" | tail -1)"
    [ -n "$parsed" ] && APK="$parsed"
  elif [ -x "$ROOT/scripts/qa/mobile-e2e/build-dev-apk.sh" ]; then
    echo "  (using project build-dev-apk.sh — route it through \`serve.js run\` so it is capped)"
    bash "$ROOT/scripts/qa/mobile-e2e/build-dev-apk.sh"
  else
    echo "  (no build-apk.sh / build-dev-apk.sh; set MOBILE_E2E_SKIP_BUILD=1 if the APK is prebuilt)"
  fi
elif [ "$PLATFORM" = "ios" ]; then
  echo "[1/5] build skipped (platform=ios — the Android APK is not used)"
else
  echo "[1/5] build skipped"
fi
T_BUILD="$(now_ms)"
T_BACKEND="$T_BUILD"

# 1b. Optional production backend build. It must finish before the server starts,
#     and it is itself a heavy one-shot, so it runs here — after the APK build,
#     before the emulator — keeping heavy one-shots from overlapping (F-296).
#     Cached by input fingerprint: an unchanged tree skips it entirely. A failed
#     build aborts (never a stale server); a success is recorded for next time.
if [ "$WITH_DEV" = "1" ] && [ -n "$DEV_BUILD_CMD" ]; then
  echo "[1b/5] backend build: $DEV_BUILD_CMD"
  if [ "${MOBILE_E2E_DEV_BUILD_FORCE:-0}" != "1" ] && [ -f "$BUILD_CACHE_JS" ] && node "$BUILD_CACHE_JS" check --cmd "$DEV_BUILD_CMD"; then
    echo "  (build inputs unchanged — cached)"
  else
    node scripts/serve.js run --name backend-build --group "$TIER_GROUP" --cmd "$DEV_BUILD_CMD" || {
      echo "FAIL — backend build failed ('$DEV_BUILD_CMD'): fix it before the device tier can come up." >&2
      exit 1
    }
    [ -f "$BUILD_CACHE_JS" ] && node "$BUILD_CACHE_JS" record --cmd "$DEV_BUILD_CMD" || true
  fi
  T_BACKEND="$(now_ms)"
elif [ "$WITH_DEV" = "1" ]; then
  echo "[1b/5] no backend build declared (dev server only)"
fi

# 2. adb server + emulator + bounded boot gate (the primitive owns readiness).
#    4. The dev server is independent of the device, so when overlap is on it is
#    started concurrently with the boot and joined after the install.
start_dev() {
  echo "[4/5] dev server ($DEV_NAME) via serve.js --group $TIER_GROUP (mem<=$DEV_MEM_MAX)"
  node scripts/serve.js start --cmd "$DEV_CMD" --url "$DEV_URL" --name "$DEV_NAME" --group "$TIER_GROUP" --mem-max "$DEV_MEM_MAX"
}

if [ "$PLATFORM" = "ios" ]; then
  echo "[2/5] iOS Simulator (boot-emulator.sh delegates to ios-simulator-up.sh on platform=ios)"
else
  echo "[2/5] adb server + emulator (boot-emulator.sh)"
fi
OVERLAP="${MOBILE_E2E_OVERLAP:-1}"
DEV_PID=""
if [ "$WITH_DEV" = "1" ] && [ "$OVERLAP" = "1" ]; then
  # Boot in the foreground, dev server in the background; joined after install.
  start_dev &
  DEV_PID=$!
  if ! bash scripts/qa/mobile-e2e/boot-emulator.sh; then
    kill "$DEV_PID" 2>/dev/null || true
    echo "FAIL — device bring-up failed; see boot-emulator.sh output and .serve/emulator.err.log" >&2
    exit 1
  fi
else
  bash scripts/qa/mobile-e2e/boot-emulator.sh
fi
T_BOOT="$(now_ms)"

if [ "$PLATFORM" != "ios" ] && [ ! -x "$ADB" ]; then
  echo "FAIL — adb not found at $ADB (set ANDROID_HOME)." >&2
  exit 1
fi

# 3. Install the (now-built) APK onto the booted device. iOS installs the .app
#    inside ios-simulator-up.sh, so there is nothing to do here.
if [ "$PLATFORM" = "ios" ]; then
  echo "[3/5] install skipped (platform=ios — the app is installed by ios-simulator-up.sh)"
elif [ "${MOBILE_E2E_SKIP_INSTALL:-0}" != "1" ]; then
  if [ -n "$APP_ID" ] && [ -f "$APK" ]; then
    echo "[3/5] installing $APK"
    timeout 300 "$ADB" install -r "$APK"
  else
    echo "[3/5] no APK at $APK (set local.json .apk or MOBILE_E2E_APK) — skipping install"
  fi
else
  echo "[3/5] install skipped"
fi
T_INSTALL="$(now_ms)"

# Join the concurrently-started dev server (its readiness is gated in step 5).
if [ "$WITH_DEV" = "1" ] && [ "$OVERLAP" != "1" ]; then
  start_dev
elif [ "$WITH_DEV" != "1" ]; then
  echo "[4/5] dev server skipped (--no-dev)"
elif [ -n "$DEV_PID" ]; then
  # Already announced by start_dev; wait for its bounded readiness probe to end.
  if ! wait "$DEV_PID"; then
    echo "FAIL — dev server did not start (see .serve/$DEV_NAME.err.log)" >&2
    exit 1
  fi
fi
T_DEV="$(now_ms)"

# 5. Bounded readiness of the whole tier. The Android boot gate is adb-only;
#    iOS readiness is the simulator install (already done) plus the dev URL.
echo "[5/5] readiness"
if [ "$PLATFORM" != "ios" ]; then
  timeout 30 "$ADB" wait-for-device
  boot=""
  for _ in $(seq 1 30); do
    boot="$(timeout 10 "$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
    [ "$boot" = "1" ] && break
    sleep 2
  done
  [ "$boot" = "1" ] || { echo "FAIL — emulator did not finish booting." >&2; exit 1; }
fi

if [ "$WITH_DEV" = "1" ]; then
  node scripts/wait-for.js --health "$DEV_URL" --timeout 120 --quiet || {
    echo "FAIL — dev server not healthy at $DEV_URL (see .serve/$DEV_NAME.out.log)" >&2
    exit 1
  }
fi

node scripts/serve.js list
T_END="$(now_ms)"
timings="{\"build_ms\":$((T_BUILD-T_START)),\"backend_ms\":$((T_BACKEND-T_BUILD)),\"boot_ms\":$((T_BOOT-T_BACKEND)),\"install_ms\":$((T_INSTALL-T_BOOT)),\"dev_ms\":$((T_DEV-T_INSTALL)),\"ready_ms\":$((T_END-T_DEV)),\"total_ms\":$((T_END-T_START))}"
echo "device-up:timings $timings"
printf '%s\n' "$timings" >>"$SERVE_DIR/device-up-timings.jsonl" 2>/dev/null || true
echo "device-up: OK"
