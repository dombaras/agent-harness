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
#   * The emulator's cgroup cap is set EXPLICITLY (`--mem-max` = guest RAM +
#     2048 MB). serve.js sums group member CAPS, so without an explicit cap the
#     EMULATOR (started after the dev server) would be tightened to the group
#     remainder — which, with the dev server already holding the full default,
#     equals guest RAM and pins qemu against its cap (constant reclaim). The
#     +2048 MB is the documented `emulator_ram_mb + ~2 GB` headroom for qemu's
#     host-side overhead and page cache.
#   * The GPU backend is auto-detected: `host` only when a real GPU/renderer is
#     present, else `swiftshader_indirect` (the safe WSL2 fallback). `-gpu host`
#     on a box whose only renderer is llvmpipe is software GL anyway.
#     On WSL2 the detection probes with Mesa's `d3d12` driver (the Windows GPU
#     behind /dev/dxg) and, when accelerated, launches the emulator with the
#     matching GL env — otherwise Mesa silently picks llvmpipe even with a GPU
#     (F-296). Enable it once with `bash scripts/wsl-gpu.sh apply`.
#   * On the WSL d3d12 path `-gpu host` is launched with `-feature -Vulkan`
#     (the gfxstream Vulkan backend segfaults qemu; GLES-over-host is stable).
#   * If an AUTO-selected backend still fails to boot, the tier retries once
#     with `swiftshader_indirect`, unless MOBILE_E2E_GPU pins one explicitly.
#   MOBILE_E2E_CORES / MOBILE_E2E_MEMORY / MOBILE_E2E_GPU override each.
#
# Tunables (env; `local.json` supplies `avd`):
#   MOBILE_E2E_AVD         AVD name            (default: local.json `avd`)
#   MOBILE_E2E_AVD_CONFIG  AVD config.ini path (default: ~/.android/avd/<avd>.avd/config.ini)
#   MOBILE_E2E_GPU         gpu backend         (default: auto-detected)
#   MOBILE_E2E_CORES       vCPU cores          (default: host/AVD-derived)
#   MOBILE_E2E_MEMORY      RAM in MB           (default: envelope emulator_ram_mb)
#   MOBILE_E2E_MEM_MAX     cgroup cap in MB     (default: MOBILE_E2E_MEMORY + 2048)
#   MOBILE_E2E_TIER_GROUP  heavy-tier group    (default: mobile)
#   MOBILE_E2E_SNAPSHOT    quickboot snapshot  (default 1; `0` = cold boot)
#   MOBILE_E2E_SNAPSHOT_NAME snapshot name      (default agent-e2e)
#   ANDROID_HOME           Android SDK root    (default ~/android-sdk)
#
# Boot speed: a quickboot snapshot turns the ~40-60 s cold boot into a few
# seconds. It is stateful, so a snapshot that fails the bounded boot gate is
# retried once WITHOUT a snapshot (cold boot) before the tier is declared dead.
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

# GL renderer as the emulator's `-gpu host` would actually see it. On WSL the
# Windows GPU is behind /dev/dxg and Mesa defaults to llvmpipe, so the probe
# forces the d3d12 driver (exactly what `wsl-gpu.sh apply` verifies); without
# that, a real GPU reads as software and the emulator never uses it (F-296).
is_wsl_gpu() { [ -e /dev/dxg ]; }

gl_renderer() {
  command -v glxinfo >/dev/null 2>&1 || return 0
  if is_wsl_gpu; then
    MESA_LOADER_DRIVER_OVERRIDE=d3d12 GALLIUM_DRIVER=d3d12 glxinfo -B 2>/dev/null \
      | grep -i 'OpenGL renderer string' | head -1 | sed 's/.*: //' || true
  else
    glxinfo -B 2>/dev/null | grep -i 'OpenGL renderer string' | head -1 | sed 's/.*: //' || true
  fi
}

detect_gpu() {
  # An NVIDIA driver answers directly (no GL probe needed).
  if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then echo host; return; fi
  # Otherwise trust the effective renderer: a software renderer means `host` GL
  # is llvmpipe and buys nothing over swiftshader.
  local r
  r="$(gl_renderer | tr 'A-Z' 'a-z')"
  case "$r" in
    *llvmpipe*|*softpipe*|*swrast*|*"software rasterizer"*) echo swiftshader_indirect; return ;;
    "") echo swiftshader_indirect; return ;;
  esac
  echo host
}

HOST_CPUS="$(nproc 2>/dev/null || echo 2)"
AVD_CORES="$(avd_ncore)"
CORES="${MOBILE_E2E_CORES:-$(resolve_cores)}"
MEMORY="${MOBILE_E2E_MEMORY:-$(resolve_memory)}"
GPU="${MOBILE_E2E_GPU:-$(detect_gpu)}"
case "$CORES" in ''|*[!0-9]*) CORES=2 ;; esac
case "$MEMORY" in ''|*[!0-9]*) MEMORY=2048 ;; esac
# Explicit cgroup cap so serve.js's group budget does not tighten the emulator
# (started after the dev server) down to the group remainder = guest RAM. Guest
# RAM + 2048 MB covers qemu's host-side overhead + page cache (docs: keep the
# cap >= emulator_ram_mb + ~2 GB).
MEM_CAP="${MOBILE_E2E_MEM_MAX:-$((MEMORY + 2048))}"
case "$MEM_CAP" in ''|*[!0-9]*) MEM_CAP=$((MEMORY + 2048)) ;; esac

# When the backend is a real GPU reached over WSL's d3d12 path, the emulator
# inherits the same driver selection (serve.js runs the command through a shell
# and forwards the caller's env) — otherwise `-gpu host` would still use llvmpipe.
GPU_ENV=""
GPU_EXTRA=""
if [ "$GPU" = "host" ] && is_wsl_gpu; then
  GPU_ENV="MESA_LOADER_DRIVER_OVERRIDE=d3d12 GALLIUM_DRIVER=d3d12"
  # Disable the emulator's Vulkan feature on the WSL d3d12 path: its gfxstream
  # Vulkan backend segfaults qemu mid-boot (the "Segmentation fault (core
  # dumped)" that made every F-296 run fall back to the software rasterizer),
  # while GLES-over-host on d3d12 is stable. Verified: `-gpu host -feature
  # -Vulkan` boots to `D3D12 (Intel(R) Graphics)`; without `-feature -Vulkan` it
  # crashes. Native (non-WSL) host GPUs keep Vulkan.
  GPU_EXTRA="-feature -Vulkan"
fi

# WSL GPU passthrough available but GL resolved to software: the emulator is
# about to render at a fraction of the speed for no reason. Name the fix.
if [ "$GPU" != "host" ] && is_wsl_gpu && [ -z "${MOBILE_E2E_GPU:-}" ]; then
  echo "! WSL GPU passthrough is present but GL is software (llvmpipe)." >&2
  echo "  Enable D3D12 acceleration once:  bash scripts/wsl-gpu.sh apply" >&2
fi

if [ "$PRINT_PROFILE" = "2" ]; then
  sed -n '2,/^set -euo pipefail$/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
  exit 0
fi

if [ "$PRINT_PROFILE" = "1" ]; then
  node -e "process.stdout.write(JSON.stringify({avd:process.argv[1]||null,hostCpus:Number(process.argv[2]),avdCores:Number(process.argv[3]),cores:Number(process.argv[4]),memory:Number(process.argv[5]),memMax:Number(process.argv[6]),gpu:process.argv[7],gpuEnv:process.argv[8]||null,gpuExtra:process.argv[9]||null,tierGroup:process.argv[10]},null,2)+'\n')" \
    "$AVD" "$HOST_CPUS" "$AVD_CORES" "$CORES" "$MEMORY" "$MEM_CAP" "$GPU" "$GPU_ENV" "$GPU_EXTRA" "$TIER_GROUP"
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

echo "device profile: avd=$AVD cores=$CORES/$HOST_CPUS memory=${MEMORY}MB gpu=$GPU${GPU_ENV:+ ($GPU_ENV)} (avd declares ${AVD_CORES} cores)"
if [ "$CORES" -gt "$AVD_CORES" ]; then
  echo "  ! cores ($CORES) exceed the AVD's hw.cpu.ncore ($AVD_CORES); the guest may cap them." >&2
fi

# 0. Ensure a writable XDG_RUNTIME_DIR. The emulator aborts hard ("Aborted (core
#    dumped)") when XDG_RUNTIME_DIR is unset or points at a missing/unwritable
#    directory — exactly the case on a systemd-less WSL where /run/user/<uid> is
#    absent, which cost a whole failed bring-up (F-296). Resolve a usable one and
#    export it; serve.js forwards the caller's env to the emulator command.
if [ -z "${XDG_RUNTIME_DIR:-}" ] || [ ! -d "${XDG_RUNTIME_DIR:-}" ] || [ ! -w "${XDG_RUNTIME_DIR:-}" ]; then
  XDG_RUNTIME_DIR="${TMPDIR:-/tmp}/agent-emulator-runtime-$(id -u)"
  mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
  export XDG_RUNTIME_DIR
  echo "XDG_RUNTIME_DIR was unset/unwritable; using $XDG_RUNTIME_DIR (the emulator aborts without a writable runtime dir)"
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
SNAPSHOT="${MOBILE_E2E_SNAPSHOT:-1}"
SNAPSHOT_NAME="${MOBILE_E2E_SNAPSHOT_NAME:-agent-e2e}"

start_emulator() {
  local gpu="$1" gpu_env="$2" gpu_extra="$3" snap="$4" snaparg
  if [ "$snap" = "on" ]; then snaparg="-snapshot $SNAPSHOT_NAME"; else snaparg="-no-snapshot"; fi
  node scripts/serve.js start \
    --cmd "$gpu_env $EMULATOR -avd $AVD -no-window -no-audio -no-boot-anim $snaparg -gpu $gpu $gpu_extra -cores $CORES -memory $MEMORY" \
    --name emulator --port 5554 --group "$TIER_GROUP" --mem-max "${MEM_CAP}M" --timeout 180000
}

# 4. Bounded readiness gate — never sleep-and-pray, and never let a wedged adb
#    hang the tool. `adb wait-for-device` returns once a device is attached; then
#    poll `sys.boot_completed` (bounded) until Android is fully up. Returns
#    non-zero when the device never finishes booting (a dead/segfaulted qemu).
wait_boot() {
  echo "waiting for the device to finish booting (bounded)…"
  timeout 90 "$ADB" wait-for-device
  boot=""
  for _ in $(seq 1 30); do
    boot="$(timeout 10 "$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
    [ "$boot" = "1" ] && break
    sleep 2
  done
  [ "$boot" = "1" ]
}

log_emulator_failure() {
  echo "  adb devices (bounded):" >&2
  timeout 10 "$ADB" devices >&2 || true
  if [ -f ".serve/emulator.err.log" ]; then
    echo "  .serve/emulator.err.log (tail):" >&2
    tail -8 .serve/emulator.err.log >&2 || true
  fi
}

restart_emulator() {
  node scripts/serve.js stop --name emulator >/dev/null 2>&1 || true
  node scripts/serve.js prune >/dev/null 2>&1 || true
}

# One boot attempt: start with the given flags and hold the bounded boot gate.
try_boot() {
  start_emulator "$1" "$2" "$3" "$4"
  wait_boot
}

WANT_SNAP="on"
[ "$SNAPSHOT" = "0" ] && WANT_SNAP="off"

BOOTED=0
if try_boot "$GPU" "$GPU_ENV" "$GPU_EXTRA" "$WANT_SNAP"; then
  BOOTED=1
else
  log_emulator_failure
  # A quickboot snapshot can go stale/corrupt (or the WSL d3d12 backend can
  # segfault restoring it). Retry once cold before blaming the GPU.
  if [ "$WANT_SNAP" = "on" ]; then
    echo "  snapshot boot failed; retrying once WITHOUT a snapshot (cold boot)…" >&2
    restart_emulator
    if try_boot "$GPU" "$GPU_ENV" "$GPU_EXTRA" "off"; then BOOTED=1; fi
  fi
fi

# A healthy emulator uses a GPU backend that actually boots. If it still has not,
# and the user did not pin MOBILE_E2E_GPU, fall back ONCE to the software
# rasterizer: the 2026-09-30 F-296 case was the auto-selected WSL `host`+d3d12
# path segfaulting qemu, and the run only proceeded after a manual
# `MOBILE_E2E_GPU=swiftshader_indirect`. Bake that recovery in.
if [ "$BOOTED" != "1" ] && [ -z "${MOBILE_E2E_GPU:-}" ] && [ "$GPU" != "swiftshader_indirect" ]; then
  echo "  auto-selected gpu=$GPU crashed; retrying once with the software rasterizer (gpu=swiftshader_indirect)…" >&2
  restart_emulator
  GPU="swiftshader_indirect"
  GPU_ENV=""
  GPU_EXTRA=""
  if try_boot "$GPU" "$GPU_ENV" "$GPU_EXTRA" "off"; then BOOTED=1; fi
fi

if [ "$BOOTED" != "1" ]; then
  echo "FAIL — emulator did not finish booting (sys.boot_completed != 1)." >&2
  log_emulator_failure
  exit 1
fi
echo "boot ok"
node scripts/serve.js list
