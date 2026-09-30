#!/usr/bin/env bash
#
# mobile E2E — bring up the Android device tier: the adb server, the emulator,
# and a bounded readiness gate. Harness-owned; project values come from the
# sibling `local.json`.
#
# Why a script: the adb server and the emulator are long-lived processes, so they
# must never run from the agent's own shell (see docs/mobile-testing.md). adb is
# the classic trap — `adb start-server` forks a daemon that is reaped with the
# tool's process group, so the client hangs forever with no output. Here BOTH the
# adb server and the emulator are started detached through `serve.js`, which
# returns as soon as the readiness target is up, and every later adb call is
# wrapped in `timeout` so a wedged adb fails fast instead of hanging the tool.
# Re-running is safe: an already-ready adb server / booted emulator is reused.
#
# GPU backend — the single biggest device-side knob:
#   * `swiftshader_indirect` (default) renders on the CPU and is the safe WSL2
#     fallback when there is no GPU passthrough.
#   * `host` renders on the host GPU and cuts UI-settle time sharply. Use it when
#     the box exposes a GPU (verify with `nvidia-smi` / `glxinfo`).
#
# Tunables (env; `local.json` supplies `avd`):
#   MOBILE_E2E_AVD     AVD name            (default: local.json `avd`)
#   MOBILE_E2E_GPU     gpu backend         (default swiftshader_indirect)
#   MOBILE_E2E_CORES   vCPU cores          (default 2)
#   MOBILE_E2E_MEMORY  RAM in MB           (default 2048)
#   ANDROID_HOME       Android SDK root    (default ~/android-sdk)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
LOCAL_CONFIG="$ROOT/scripts/qa/mobile-e2e/local.json"
GPU="${MOBILE_E2E_GPU:-swiftshader_indirect}"
CORES="${MOBILE_E2E_CORES:-2}"
MEMORY="${MOBILE_E2E_MEMORY:-2048}"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/android-sdk}}"
EMULATOR="$SDK/emulator/emulator"
ADB="$SDK/platform-tools/adb"

# AVD: env override, else local.json `avd`, else fail with the available list.
AVD="${MOBILE_E2E_AVD:-}"
if [ -z "$AVD" ] && [ -f "$LOCAL_CONFIG" ]; then
  AVD="$(node -e "try{process.stdout.write(String(require('$LOCAL_CONFIG').avd||''))}catch(e){}" 2>/dev/null || true)"
fi
if [ -z "$AVD" ]; then
  echo "FAIL — no AVD set. Set MOBILE_E2E_AVD or add \"avd\": \"<name>\" to scripts/qa/mobile-e2e/local.json." >&2
  [ -x "$EMULATOR" ] && "$EMULATOR" -list-avds >&2 || true
  exit 1
fi

if [ ! -x "$EMULATOR" ]; then
  echo "FAIL — emulator binary not found at $EMULATOR (set ANDROID_HOME)." >&2
  exit 1
fi
if [ ! -x "$ADB" ]; then
  echo "FAIL — adb binary not found at $ADB (set ANDROID_HOME)." >&2
  exit 1
fi

cd "$ROOT"

# 1. Reap dead `.serve/` records so a stale adb-server/emulator entry from a
#    previous session cannot misreport the machine.
node scripts/serve.js prune >/dev/null 2>&1 || true

# 2. Ensure the adb SERVER is up, detached, BEFORE any adb client call. A bare
#    `adb devices`/`start-server` hangs when the server is down (the forked
#    daemon is tied to this tool's process group), so it is launched through
#    serve.js like any other long-lived process. Idempotent: if 5037 already
#    answers, this is a no-op.
if ! timeout 5 "$ADB" devices >/dev/null 2>&1; then
  echo "adb server not ready — starting it detached (serve.js, port 5037)"
  node scripts/serve.js start \
    --cmd "$ADB -a nodaemon server" \
    --name adb-server --port 5037 --timeout 30000
fi
if ! timeout 10 "$ADB" devices >/dev/null 2>&1; then
  echo "FAIL — adb server did not come up on port 5037." >&2
  echo "  Inspect: .serve/adb-server.err.log" >&2
  exit 1
fi

# 3. Start (or reuse) the emulator, detached, ready when its adb port answers.
node scripts/serve.js start \
  --cmd "$EMULATOR -avd $AVD -no-window -no-audio -no-boot-anim -no-snapshot -gpu $GPU -cores $CORES -memory $MEMORY" \
  --name emulator --port 5554 --timeout 180000

# 4. Bounded readiness gate — never sleep-and-pray, and never let a wedged adb
#    hang the tool. `adb wait-for-device` returns once a device is attached; then
#    poll `sys.boot_completed` (bounded) until Android is fully up.
echo "waiting for the device to finish booting (bounded)…"
timeout 90 "$ADB" wait-for-device
boot=""
for _ in $(seq 1 30); do
  boot="$(timeout 10 "$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
  [ "$boot" = "1" ] && break
  sleep 2
done
if [ "$boot" != "1" ]; then
  echo "FAIL — emulator did not finish booting (sys.boot_completed != 1)." >&2
  echo "  adb devices (bounded):" >&2
  timeout 10 "$ADB" devices >&2 || true
  exit 1
fi
echo "boot ok"
node scripts/serve.js list
