#!/usr/bin/env bash
#
# mobile E2E — boot the Android emulator as a detached `serve.js` process.
# Harness-owned; project values come from the sibling `local.json`.
#
# Why a script: the emulator is a long-lived process, so it must never run from
# the agent's own shell (see docs/mobile-testing.md). `serve.js` detaches it with
# its own stdio and returns as soon as the adb port is ready, so the tool never
# blocks. `serve.js start` is safe to re-run: if the emulator is already booted
# on the port it reports ready instead of launching a second one (reuse it).
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
SDK="${ANDROID_HOME:-$HOME/android-sdk}"
EMULATOR="$SDK/emulator/emulator"

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

cd "$ROOT"
node scripts/serve.js start \
  --cmd "$EMULATOR -avd $AVD -no-window -no-audio -no-boot-anim -no-snapshot -gpu $GPU -cores $CORES -memory $MEMORY" \
  --name emulator --port 5554 --timeout 180000
node scripts/serve.js list
