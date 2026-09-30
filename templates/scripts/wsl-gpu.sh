#!/usr/bin/env bash
# wsl-gpu.sh — enable/verify real GPU acceleration for WSL2 (OpenGL over D3D12).
#
# Why: the Android device tier is the slowest part of the mobile E2E run, and on
# a software renderer it is CPU-bound (~2.5 s per Maestro command; F-291/F-296).
# WSL2 can pass the Windows GPU through `/dev/dxg`, but two commonly-missing
# pieces are needed and this script fixes/diagnoses both:
#
#   1. the `vgem` DRM module must be loaded. Modern WSL kernels (>= 2.5) ship it
#      as a loadable module and do NOT auto-load it, so `/dev/dri` is absent and
#      every GL app — including the emulator's `-gpu host` — silently falls back
#      to the llvmpipe software renderer (WSL issue #12702, #11837).
#   2. Mesa must select the `d3d12` gallium driver. It does NOT by default, so
#      even with `/dev/dri` present, `glxinfo` still reports llvmpipe. Forcing
#      `GALLIUM_DRIVER=d3d12` (with `/usr/lib/wsl/lib` on the loader path) makes
#      `glxinfo -B` report `D3D12 (<Windows GPU>)` and `Accelerated: yes`.
#
# `status` shows exactly which of those two is missing; `apply` loads + persists
# vgem and verifies d3d12; `env` prints the exports to use for a GL process.
# `boot-emulator.sh` probes the same path and uses it automatically.
#
# Usage:
#   bash scripts/wsl-gpu.sh status     # diagnose (default)
#   bash scripts/wsl-gpu.sh apply      # load vgem (persist) + verify d3d12 (auto-sudo)
#   bash scripts/wsl-gpu.sh env        # print the GL env exports (eval-able)
#
# No-op outside WSL (no /dev/dxg; override with AGENT_WSL_GPU_FORCE=1).
# Idempotent. Env overrides:
#   AGENT_WSL_GPU_DRIVER (d3d12), AGENT_WSL_GPU_MODULE (vgem),
#   AGENT_WSL_GPU_MODULES_FILE (/etc/modules-load.d/vgem.conf),
#   AGENT_WSL_GPU_GLXINFO (glxinfo), AGENT_WSL_GPU_FORCE
set -euo pipefail

MODULE="${AGENT_WSL_GPU_MODULE:-vgem}"
DRIVER="${AGENT_WSL_GPU_DRIVER:-d3d12}"
MODULES_FILE="${AGENT_WSL_GPU_MODULES_FILE:-/etc/modules-load.d/${MODULE}.conf}"
GLXINFO="${AGENT_WSL_GPU_GLXINFO:-glxinfo}"

log() { printf '%s\n' "$*"; }
warn() { printf '%s\n' "$*" >&2; }

# WSL GPU passthrough exposes the Windows adapter at /dev/dxg. Absent => not WSL
# or no GPU-PV, and everything here is a no-op.
has_dxg() {
  [ "${AGENT_WSL_GPU_FORCE:-0}" = "1" ] && return 0
  [ -e /dev/dxg ]
}

module_loaded() {
  if command -v lsmod >/dev/null 2>&1; then
    lsmod | awk '{print $1}' | grep -qx "$MODULE" && return 0
  fi
  ls /dev/dri/renderD* >/dev/null 2>&1
}

# The usable GL renderer for the D3D12 path (empty if glxinfo is unavailable or
# the probe fails). Only meaningful once vgem is loaded.
d3d12_renderer() {
  command -v "$GLXINFO" >/dev/null 2>&1 || return 0
  MESA_LOADER_DRIVER_OVERRIDE="$DRIVER" GALLIUM_DRIVER="$DRIVER" \
    "$GLXINFO" -B 2>/dev/null \
    | grep -i 'OpenGL renderer string' | head -1 \
    | sed 's/.*: //' || true
}

d3d12_accelerated() {
  local dev
  dev="$(d3d12_renderer)"
  [ -n "$dev" ] || return 1
  case "$(printf '%s' "$dev" | tr 'A-Z' 'a-z')" in
    *llvmpipe*|*softpipe*|*swrast*|*"software rasterizer"*) return 1 ;;
  esac
  return 0
}

do_status() {
  log "wsl-gpu status"
  if ! has_dxg; then
    log "  not WSL GPU passthrough (/dev/dxg absent) — nothing to do here"
    return 0
  fi
  log "  /dev/dxg:      present (Windows GPU exposed)"
  if module_loaded; then
    log "  $MODULE module: loaded (/dev/dri render node present)"
  else
    log "  $MODULE module: NOT loaded — /dev/dri is missing; the emulator will use llvmpipe"
    log "                 fix: bash scripts/wsl-gpu.sh apply   (or: sudo modprobe $MODULE)"
  fi
  if ! command -v "$GLXINFO" >/dev/null 2>&1; then
    log "  glxinfo:       not installed (apt install mesa-utils) — cannot verify acceleration"
    return 0
  fi
  local dev
  dev="$(d3d12_renderer)"
  if d3d12_accelerated; then
    log "  d3d12 renderer: $dev  (Accelerated: yes)"
    log ""
    log "  Apply for a GL process:  $(shell_env)"
  else
    log "  d3d12 renderer: ${dev:-<probe failed>} — not accelerated"
    [ "$(module_loaded && echo 1 || echo 0)" = "1" ] \
      && log "                 $MODULE is loaded but Mesa did not pick d3d12" \
      || log "                 load $MODULE first: bash scripts/wsl-gpu.sh apply"
  fi
}

shell_env() {
  printf 'export GALLIUM_DRIVER=%s MESA_LOADER_DRIVER_OVERRIDE=%s\n' "$DRIVER" "$DRIVER"
}

do_env() {
  if has_dxg && d3d12_accelerated; then
    shell_env
  fi
}

do_apply() {
  if ! has_dxg; then
    log "wsl-gpu: not WSL GPU passthrough — no-op."
    return 0
  fi
  local needs_root=0
  module_loaded || needs_root=1
  [ -w "$(dirname "$MODULES_FILE")" ] || needs_root=1
  if [ "$needs_root" = "1" ] && [ "$(id -u)" -ne 0 ]; then
    if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
      exec sudo -E bash "$0" apply "$@"
    fi
    warn "wsl-gpu: loading $MODULE and writing $MODULES_FILE need root — re-run: sudo bash scripts/wsl-gpu.sh apply"
    return 1
  fi

  if module_loaded; then
    log "wsl-gpu: $MODULE already loaded"
  else
    if command -v modprobe >/dev/null 2>&1; then
      modprobe "$MODULE" && log "wsl-gpu: loaded $MODULE" || warn "wsl-gpu: modprobe $MODULE failed"
    else
      warn "wsl-gpu: modprobe not found — cannot load $MODULE"
    fi
  fi

  # Persist across WSL restarts. modules-load.d is the modern, supported path.
  if [ ! -f "$MODULES_FILE" ] || ! grep -qx "$MODULE" "$MODULES_FILE" 2>/dev/null; then
    mkdir -p "$(dirname "$MODULES_FILE")"
    printf '%s\n' "$MODULE" > "$MODULES_FILE"
    log "wsl-gpu: wrote $MODULES_FILE (loads $MODULE on boot)"
  else
    log "wsl-gpu: $MODULES_FILE already lists $MODULE"
  fi

  log ""
  if d3d12_accelerated; then
    local dev; dev="$(d3d12_renderer)"
    log "wsl-gpu: GPU acceleration is ACTIVE — $dev"
    log "  For a GL process, export:  $(shell_env)"
    log "  (boot-emulator.sh probes this automatically and uses -gpu host.)"
  else
    warn "wsl-gpu: $MODULE loaded but d3d12 acceleration not detected."
    warn "  Ensure the Windows GPU driver supports WSL (Intel/AMD/NVIDIA WSL driver),"
    warn "  then 'wsl --shutdown' from Windows PowerShell and retry."
  fi
}

main() {
  local sub="status"
  for a in "$@"; do
    case "$a" in
      status|apply|env) sub="$a" ;;
      *) warn "wsl-gpu: unknown argument: $a"; exit 2 ;;
    esac
  done
  case "$sub" in
    status) do_status ;;
    apply) do_apply "$@" ;;
    env) do_env ;;
  esac
}

main "$@"
