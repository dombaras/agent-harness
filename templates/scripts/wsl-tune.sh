#!/usr/bin/env bash
# wsl-tune.sh — one idempotent bootstrap for WSL2 memory/CPU pressure.
#
# The 2026-09-29 freeze was a capacity exhaustion: WSL2 is one Linux VM, and an
# emulator + agents + `next dev` filled RAM, thrashed swap, and starved the
# host<->VM vsock relay so every terminal froze at once. The capacity envelope
# (scripts/qa/capacity-lib.js) serializes heavy tiers; this script tunes the VM
# itself so a spike degrades instead of freezing:
#
#   - sysctls: low swappiness, small min_free_kbytes floor, bounded dirty ratios
#   - a systemd user.slice resource ceiling (MemoryHigh/MemoryMax/CPUQuota), so a
#     runaway is throttled/OOM-killed inside its cgroup, not the whole VM
#   - a SOFT init.scope MemoryHigh backstop (agent-wsl-backstop.service) for the
#     cgroup agents/emulators actually run in — WSL puts the wsl.exe session in
#     init.scope, NOT user.slice, so the ceiling above never binds the workload
#   - `.wslconfig` keys (processors, swap, vmIdleTimeout, reclaim) merged safely
#     via scripts/qa/wslconfig-merge.js
#
# Usage:
#   bash scripts/wsl-tune.sh status            # what is applied (default)
#   bash scripts/wsl-tune.sh apply             # apply everything (auto-sudo)
#   bash scripts/wsl-tune.sh wslconfig         # merge .wslconfig keys only
#   bash scripts/wsl-tune.sh down              # remove the in-WSL tunables
#   bash scripts/wsl-tune.sh apply --dry-run   # print, change nothing
#
# No-op outside WSL (override with AGENT_WSL_TUNE_FORCE=1). Env overrides:
#   AGENT_WSL_TUNE_SYSCTL, AGENT_WSL_TUNE_SLICE_DIR, AGENT_WSL_CONFIG,
#   AGENT_WSL_TUNE_DRY_RUN, AGENT_WSL_TUNE_PROCESSORS, AGENT_WSL_TUNE_SWAP,
#   AGENT_WSL_TUNE_IDLE_MS
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MERGERS="$SCRIPT_DIR/qa/wslconfig-merge.js"

SYSCTL_FILE="${AGENT_WSL_TUNE_SYSCTL:-/etc/sysctl.d/99-agent-wsl.conf}"
SLICE_DIR="${AGENT_WSL_TUNE_SLICE_DIR:-/etc/systemd/system/user.slice.d}"
SLICE_FILE="$SLICE_DIR/90-agent-cap.conf"
UNIT_DIR="${AGENT_WSL_TUNE_UNIT_DIR:-/etc/systemd/system}"
BACKSTOP_UNIT="$UNIT_DIR/agent-wsl-backstop.service"
BACKSTOP="${AGENT_WSL_TUNE_BACKSTOP:-8704M}"
DRY_RUN="${AGENT_WSL_TUNE_DRY_RUN:-0}"

log() { printf '%s\n' "$*"; }
warn() { printf '%s\n' "$*" >&2; }

is_wsl() {
  [ "${AGENT_WSL_TUNE_FORCE:-0}" = "1" ] && return 0
  [ -r /proc/version ] && grep -qiE 'microsoft|wsl' /proc/version
}

find_config() {
  if [ -n "${AGENT_WSL_CONFIG:-}" ]; then printf '%s' "$AGENT_WSL_CONFIG"; return; fi
  local f
  for f in /mnt/c/Users/*/.wslconfig; do
    [ -f "$f" ] && { printf '%s' "$f"; return 0; }
  done
  return 0
}

powershell_exe() {
  if command -v powershell.exe >/dev/null 2>&1; then command -v powershell.exe; return 0; fi
  local p="/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
  [ -x "$p" ] && { printf '%s' "$p"; return 0; }
  return 1
}

host_cpus() {
  local exe v
  exe="$(powershell_exe)" || return 1
  v="$("$exe" -NoProfile -Command "(Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors" 2>/dev/null | tr -d '\r ')"
  case "$v" in ''|*[!0-9]*) return 1;; *) printf '%s' "$v";; esac
}

target_processors() {
  if [ -n "${AGENT_WSL_TUNE_PROCESSORS:-}" ]; then printf '%s' "$AGENT_WSL_TUNE_PROCESSORS"; return 0; fi
  local hc
  hc="$(host_cpus)" || return 0
  case "$hc" in ''|*[!0-9]*) return 0;; esac
  if [ "$hc" -gt 6 ]; then printf '%s' "$((hc - 4))"; else printf '%s' "$((hc > 2 ? hc - 1 : 2))"; fi
}

SYSCTL_BODY="# Managed by @dombaras/agent-harness (scripts/wsl-tune.sh). Idempotent; 'wsl-tune.sh down' removes it.
vm.swappiness=10
vm.vfs_cache_pressure=50
vm.min_free_kbytes=262144
vm.dirty_background_ratio=5
vm.dirty_ratio=10"

slice_body() {
  cat <<EOF
# Managed by @dombaras/agent-harness (scripts/wsl-tune.sh). Idempotent; 'wsl-tune.sh down' removes it.
[Slice]
MemoryHigh=8G
MemoryMax=9G
CPUQuota=800%
EOF
}

# The user.slice ceiling above never binds the real workload: WSL's wsl.exe
# session — and so every agent, emulator, and dev server — is in init.scope, a
# sibling of user.slice, not a child. This oneshot runs at boot and puts a SOFT
# MemoryHigh on init.scope. Soft is deliberate: MemoryHigh reclaims/throttles as
# the line is approached and never OOM-kills, so a spike degrades instead of
# thrash-freezing every terminal. Heavy tiers also get a per-unit cap from
# serve.js; this backstop covers the agents themselves.
backstop_body() {
  cat <<EOF
# Managed by @dombaras/agent-harness (scripts/wsl-tune.sh). Idempotent; 'wsl-tune.sh down' removes it.
[Unit]
Description=agent-harness WSL memory backstop (soft MemoryHigh on init.scope)
After=systemd-user-sessions.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'systemctl set-property init.scope MemoryHigh=${BACKSTOP}'

[Install]
WantedBy=multi-user.target
EOF
}

apply_wslconfig() {
  local cfg sets=()
  cfg="$(find_config)"
  if [ -z "$cfg" ]; then
    warn "wsl-tune: no .wslconfig found (set AGENT_WSL_CONFIG to target one) — skipping host tuning"
    return 0
  fi
  local proc swap idle
  proc="$(target_processors || true)"
  swap="${AGENT_WSL_TUNE_SWAP:-4GB}"
  idle="${AGENT_WSL_TUNE_IDLE_MS:-7200000}"
  [ -n "$proc" ] && sets+=("--set" "wsl2.processors=$proc")
  sets+=("--set" "wsl2.swap=$swap")
  sets+=("--set" "wsl2.vmIdleTimeout=$idle")
  sets+=("--set" "experimental.autoMemoryReclaim=gradual")
  sets+=("--set" "experimental.sparseVhd=true")

  if [ "$DRY_RUN" = "1" ]; then
    log "wsl-tune: would merge into $cfg:"
    node "$MERGERS" --file "$cfg" "${sets[@]}" | sed 's/^/    /'
    return 0
  fi
  node "$MERGERS" --file "$cfg" --write --backup "${sets[@]}"
}

do_status() {
  log "wsl-tune status"
  if ! is_wsl; then log "  not WSL — tuning is a no-op here"; return 0; fi
  if [ -f "$SYSCTL_FILE" ]; then log "  sysctl:  $SYSCTL_FILE present"; else log "  sysctl:  not applied ($SYSCTL_FILE missing)"; fi
  if [ -r /proc/sys/vm/swappiness ]; then log "           vm.swappiness=$(cat /proc/sys/vm/swappiness)"; fi
  if [ -f "$SLICE_FILE" ]; then log "  slice:   $SLICE_FILE present"; else log "  slice:   not applied ($SLICE_FILE missing)"; fi
  if command -v systemctl >/dev/null 2>&1; then
    local mm cq
    mm="$(systemctl show user.slice -p MemoryMax --value 2>/dev/null || true)"
    cq="$(systemctl show user.slice -p CPUQuotaPerSecUSec --value 2>/dev/null || true)"
    [ -n "$mm" ] && log "           user.slice MemoryMax=$mm CPUQuota=$cq"
  fi
  if [ -f "$BACKSTOP_UNIT" ]; then log "  backstop: $BACKSTOP_UNIT present"; else log "  backstop: not applied ($BACKSTOP_UNIT missing)"; fi
  if command -v systemctl >/dev/null 2>&1; then
    local ih
    ih="$(systemctl show init.scope -p MemoryHigh --value 2>/dev/null || true)"
    [ -n "$ih" ] && log "           init.scope MemoryHigh=$ih (the cgroup agents/emulators actually run in)"
  fi
  local cfg; cfg="$(find_config)"
  if [ -n "$cfg" ] && [ -f "$cfg" ]; then
    log "  wslconfig: $cfg"
    grep -E '^[[:space:]]*(processors|memory|swap|vmIdleTimeout|autoMemoryReclaim|sparseVhd)[[:space:]]*=' "$cfg" | sed 's/^/           /' || true
  else
    log "  wslconfig: not found"
  fi
  if [ -r /proc/pressure/memory ]; then log "  PSI mem: $(grep -m1 '^some' /proc/pressure/memory)"; fi
  log ""
  log "  Apply/refresh with:  sudo bash scripts/wsl-tune.sh apply"
  log "  (.wslconfig changes need 'wsl --shutdown' from Windows PowerShell to take effect.)"
}

do_apply() {
  if ! is_wsl; then log "wsl-tune: not WSL — no-op."; return 0; fi
  if [ "$DRY_RUN" = "1" ]; then
    log "wsl-tune: would write $SYSCTL_FILE:"; printf '%s\n' "$SYSCTL_BODY" | sed 's/^/    /'
    log "wsl-tune: would write $SLICE_FILE:"; slice_body | sed 's/^/    /'
    log "wsl-tune: would write $BACKSTOP_UNIT:"; backstop_body | sed 's/^/    /'
    log "wsl-tune: would reload sysctl + systemd, enable agent-wsl-backstop.service"
    apply_wslconfig
    return 0
  fi
  if [ "$(id -u)" -ne 0 ]; then
    if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
      exec sudo -E bash "$0" apply "$@"
    fi
    warn "wsl-tune: in-WSL tunables need root — re-run: sudo bash scripts/wsl-tune.sh apply"
    apply_wslconfig
    return 0
  fi
  printf '%s\n' "$SYSCTL_BODY" > "$SYSCTL_FILE"
  log "wsl-tune: wrote $SYSCTL_FILE"
  sysctl --system >/dev/null 2>&1 || sysctl -p "$SYSCTL_FILE" >/dev/null 2>&1 || true
  log "wsl-tune: applied sysctls"
  mkdir -p "$SLICE_DIR"
  slice_body > "$SLICE_FILE"
  log "wsl-tune: wrote $SLICE_FILE"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload 2>/dev/null || true
    systemctl set-property --runtime user.slice MemoryHigh=8G MemoryMax=9G CPUQuota=800% 2>/dev/null || true
    log "wsl-tune: applied user.slice ceiling"
  fi
  printf '%s\n' "$(backstop_body)" > "$BACKSTOP_UNIT"
  log "wsl-tune: wrote $BACKSTOP_UNIT"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload 2>/dev/null || true
    if systemctl enable --now agent-wsl-backstop.service >/dev/null 2>&1; then
      log "wsl-tune: applied soft init.scope backstop (MemoryHigh=$BACKSTOP)"
    else
      warn "wsl-tune: could not start agent-wsl-backstop.service — run it after reboot, or apply manually:"
      warn "           systemctl set-property init.scope MemoryHigh=$BACKSTOP"
    fi
  fi
  apply_wslconfig
  log ""
  log "wsl-tune: done. MANUAL STEP — from Windows PowerShell run:  wsl --shutdown"
  log "  (only needed for the .wslconfig changes: processors/swap/vmIdleTimeout.)"
}

do_down() {
  if [ "$(id -u)" -ne 0 ]; then
    warn "wsl-tune down needs root — re-run: sudo bash scripts/wsl-tune.sh down"
    return 1
  fi
  rm -f "$SYSCTL_FILE" && log "wsl-tune: removed $SYSCTL_FILE" || true
  rm -f "$SLICE_FILE" && log "wsl-tune: removed $SLICE_FILE" || true
  if command -v systemctl >/dev/null 2>&1; then
    systemctl disable --now agent-wsl-backstop.service >/dev/null 2>&1 || true
    systemctl set-property init.scope MemoryHigh=infinity >/dev/null 2>&1 || true
  fi
  rm -f "$BACKSTOP_UNIT" && log "wsl-tune: removed $BACKSTOP_UNIT" || true
  sysctl --system >/dev/null 2>&1 || true
  command -v systemctl >/dev/null 2>&1 && systemctl daemon-reload 2>/dev/null || true
  log "wsl-tune: .wslconfig left untouched (restore a .bak-* file if you want to revert it)."
}

main() {
  local sub="status"
  local args=()
  for a in "$@"; do
    case "$a" in
      status|apply|wslconfig|down) sub="$a" ;;
      --dry-run) DRY_RUN=1 ;;
      *) args+=("$a") ;;
    esac
  done
  case "$sub" in
    status) do_status ;;
    apply) do_apply "${args[@]}" ;;
    wslconfig) apply_wslconfig ;;
    down) do_down ;;
  esac
}

main "$@"
