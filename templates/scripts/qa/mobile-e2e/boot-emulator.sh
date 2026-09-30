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
# Right-sizing (the device tier is the slowest, heaviest part of a run):
#   * CPU cores are derived from the host (`nproc`) and the AVD's own
#     `hw.cpu.ncore`, capped so the agent, dev server, and Windows host keep
#     room. A fixed 2 cores on an 8-vCPU box made qemu the bottleneck.
#   * Guest RAM comes from the capacity envelope (`emulator_ram_mb`, the single
#     owner of the number), not a second hardcoded literal.
#   * The GPU backend is auto-detected: `host` only when a real GPU/renderer is
#     present, else `swiftshader_indirect` (the safe WSL2 fallback). `-gpu host`
#     on a box whose only renderer is llvmpipe is software GL anyway.
#   MOBILE_E2E_CORES / MOBILE_E2E_MEMORY / MOBILE_E2E_GPU override each.
#
# Tunables (env; `local.json` supplies `avd`):
#   MOBILE_E2E_AVD         AVD name            (default: local.json `avd`)
#   MOBILE_E2E_AVD_CONFIG  AVD config.ini path (default: ~/.android/avd/<avd>.avd/config.ini)
#   MOBILE_E2E_GPU         gpu backend         (default: auto-detected)
#   MOBILE_E2E_CORES       vCPU cores          (default: host/AVD-derived)
#   MOBILE_E2E_MEMORY      RAM in MB           (default: envelope emulator_ram_mb)
#   MOBILE_E2E_TIER_GROUP  heavy-tier group    (default: mobile)
#   ANDROID_HOME           Android SDK root    (default ~/android-sdk)
#
# Modes:
#   boot-emulator.sh                 boot the tier
#   boot-emulator.sh --print-profile print the resolved profile as JSON and exit
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
LOCAL_CONFIG="$ROOT/scripts/qa/mobile-e2e/local.json"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/android-sdk}}"
EMULATOR="$SDK/emulator/emulator"
ADB="$SDK/platform-tools/adb"
TIER_GROUP="${MOBILE_E2E_TIER_GROUP:-mobile}"

PRINT_PROFILE=0
for arg in "$@"; do
  case "$arg" in
    --print-profile) PRINT_PROFILE=1 ;;
    -h|--help) PRINT_PROFILE=2 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# AVD: env override, else local.json `avd`, else fail with the available list.
AVD="${MOBILE_E2E_AVD:-}"
if [ -z "$AVD" ] && [ -f "$LOCAL_CONFIG" ]; then
  AVD="$(node -e "try{process.stdout.write(String(require('$LOCAL_CONFIG').avd||''))}catch(e){}" 2>/dev/null || true)"
fi

# --- Profile resolution (pure; never starts anything) ------------------------
avd_config() {
  if [ -n "${MOBILE_E2E_AVD_CONFIG:-}" ]; then
    echo "$MOBILE_E2E_AVD_CONFIG"
  elif [ -n "$AVD" ]; then
    echo "$HOME/.android/avd/$AVD.avd/config.ini"
  else
    echo ""
  fi
}

avd_ncore() {
  local cfg n
  cfg="$(avd_config)"
  n=""
  [ -n "$cfg" ] && [ -f "$cfg" ] && n="$(grep -iE '^hw\.cpu\.ncore' "$cfg" 2>/dev/null | head -1 | cut -d= -f2 | tr -d ' ')"
  case "$n" in ''|*[!0-9]*) n=4 ;; esac
  echo "$n"
}

resolve_cores() {
  local host reserve avail avd n
  host="$(nproc 2>/dev/null || echo 2)"
  case "$host" in ''|*[!0-9]*) host=2 ;; esac
  avd="$(avd_ncore)"
  reserve=$(( host / 4 )); [ "$reserve" -lt 2 ] && reserve=2
  avail=$(( host - reserve )); [ "$avail" -lt 2 ] && avail=2
  if [ "$avd" -lt "$avail" ]; then n="$avd"; else n="$avail"; fi
  [ "$n" -lt 2 ] && n=2
  echo "$n"
}

resolve_memory() {
  local m
  m="$(node -e "try{process.stdout.write(String(require('$ROOT/scripts/qa/capacity-lib.js').readEnvelope('$ROOT').emulatorRamMb||''))}catch(e){}" 2>/dev/null || true)"
  case "$m" in ''|*[!0-9]*) m=2048 ;; esac
  echo "$m"
}

detect_gpu() {
  # Real GPU passthrough (DRM render node) or an NVIDIA driver answers.
  if [ -d /dev/dri ] && ls /dev/dri/renderD* >/dev/null 2>&1; then echo host; return; fi
  if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then echo host; return; fi
  # Otherwise, trust glxinfo when present: a software renderer means host GL is
  # llvmpipe and `host` buys nothing over swiftshader.
  if command -v glxinfo >/dev/null 2>&1; then
    local r
    r="$(glxinfo -B 2>/dev/null | tr 'A-Z' 'a-z' || true)"
    case "$r" in
      *llvmpipe*|*softpipe*|*swrast*|*"software rasterizer"*) echo swiftshader_indirect; return ;;
    esac
    echo "$r" | grep -q 'opengl renderer' && { echo host; return; }
  fi
  echo swiftshader_indirect
}

HOST_CPUS="$(nproc 2>/dev/null || echo 2)"
AVD_CORES="$(avd_ncore)"
CORES="${MOBILE_E2E_CORES:-$(resolve_cores)}"
MEMORY="${MOBILE_E2E_MEMORY:-$(resolve_memory)}"
GPU="${MOBILE_E2E_GPU:-$(detect_gpu)}"
case "$CORES" in ''|*[!0-9]*) CORES=2 ;; esac
case "$MEMORY" in ''|*[!0-9]*) MEMORY=2048 ;; esac

if [ "$PRINT_PROFILE" = "2" ]; then
  sed -n '2,45p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
fi

if [ "$PRINT_PROFILE" = "1" ]; then
  node -e "process.stdout.write(JSON.stringify({avd:process.argv[1]||null,hostCpus:Number(process.argv[2]),avdCores:Number(process.argv[3]),cores:Number(process.argv[4]),memory:Number(process.argv[5]),gpu:process.argv[6],tierGroup:process.argv[7]},null,2)+'\n')" \
    "$AVD" "$HOST_CPUS" "$AVD_CORES" "$CORES" "$MEMORY" "$GPU" "$TIER_GROUP"
  exit 0
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

echo "device profile: avd=$AVD cores=$CORES/$HOST_CPUS memory=${MEMORY}MB gpu=$GPU (avd declares ${AVD_CORES} cores)"
if [ "$CORES" -gt "$AVD_CORES" ]; then
  echo "  ! cores ($CORES) exceed the AVD's hw.cpu.ncore ($AVD_CORES); the guest may cap them." >&2
fi

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
#    `--group` lets the emulator and the dev server share one machine-wide
#    mobile-tier budget instead of fighting the single-heavy-tier lock.
node scripts/serve.js start \
  --cmd "$EMULATOR -avd $AVD -no-window -no-audio -no-boot-anim -no-snapshot -gpu $GPU -cores $CORES -memory $MEMORY" \
  --name emulator --port 5554 --group "$TIER_GROUP" --timeout 180000

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
