#!/usr/bin/env bash
#
# setup-tmpfs.sh — RAM-backed build/cache storage for WSL2 agent workspaces.
#
#   ############################################################
#   #  WARNING: tmpfs is VOLATILE RAM. Its contents vanish on  #
#   #  reboot, OOM, WSL restart, or `setup-tmpfs.sh down`.     #
#   #  Put CACHES and BUILD ARTIFACTS here ONLY.               #
#   #  NEVER source code, databases, secrets, or git state.    #
#   ############################################################
#
# Mounts a single tmpfs root (default /mnt/ramdisk) sized 25-40% of WSL RAM and
# points the cache/build env vars for ONLY the ecosystems actually installed:
#   PIP_CACHE_DIR, npm_config_cache, PNPM_STORE_DIR, YARN_CACHE_FOLDER,
#   CARGO_TARGET_DIR, GOCACHE, GRADLE_USER_HOME, CCACHE_DIR, SCCACHE_DIR,
#   RUSTC_WRAPPER=sccache.
#
# It is idempotent (a no-op when the tmpfs is already mounted), no-ops outside
# WSL, and can persist across shells/boots via a ~/.bashrc hook and an optional
# systemd --user unit.
#
# Usage:
#   setup-tmpfs.sh [up]            mount + write env (default; idempotent)
#   setup-tmpfs.sh ensure          quiet idempotent variant (used by the hook)
#   setup-tmpfs.sh env             print `export ...` lines for `eval`
#   setup-tmpfs.sh status          show mount + env state
#   setup-tmpfs.sh install         persist: copy here + systemd unit + bashrc hook
#   setup-tmpfs.sh down            unmount + remove the persisted env file
#   setup-tmpfs.sh uninstall       down + remove unit + bashrc hook
#   setup-tmpfs.sh --dry-run ...   print what would happen; change nothing
#
# Overrides: AGENT_RAMDISK, AGENT_TMPFS_PERCENT (25-40), AGENT_TMPFS_CONFIG,
# AGENT_TMPFS_FORCE=1 (treat non-WSL as WSL), AGENT_TMPFS_DRY_RUN=1.
set -u

RAMDISK="${AGENT_RAMDISK:-/mnt/ramdisk}"
PERCENT="${AGENT_TMPFS_PERCENT:-30}"
CONFIG_DIR="${AGENT_TMPFS_CONFIG:-$HOME/.config/agent-harness}"
ENV_FILE="$CONFIG_DIR/tmpfs.env"
INSTALLED_SCRIPT="$CONFIG_DIR/setup-tmpfs.sh"
UNIT_DIR="${AGENT_TMPFS_UNIT_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user}"
UNIT_NAME="agent-tmpfs.service"
BASHRC="${AGENT_TMPFS_BASHRC:-$HOME/.bashrc}"
DRY_RUN="${AGENT_TMPFS_DRY_RUN:-0}"
BASHRC_MARKER="# agent-harness tmpfs caches (managed)"
BASHRC_END="# agent-harness tmpfs caches (managed end)"

ACTION="up"
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    up | ensure | env | status | install | down | uninstall) ACTION="$arg" ;;
    -h | --help) ACTION="help" ;;
    *)
      echo "setup-tmpfs: unknown argument: $arg" >&2
      ACTION="help"
      ;;
  esac
done

usage() {
  sed -n '2,/^set -u$/p' "$0" | sed 's/^# \{0,1\}//; /^set -u$/d'
}

have() { command -v "$1" >/dev/null 2>&1; }

run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '  [dry-run] %s\n' "$*"
    return 0
  fi
  "$@"
}

as_root() {
  if [ "$(id -u)" = "0" ]; then
    "$@"
  elif have sudo; then
    sudo -n "$@"
  else
    "$@"
  fi
}

is_wsl() {
  # AGENT_TMPFS_FORCE can force the answer either way (0 = force off, 1 = force on).
  [ "${AGENT_TMPFS_FORCE:-}" = "1" ] && return 0
  [ "${AGENT_TMPFS_FORCE:-}" = "0" ] && return 1
  [ -n "${WSL_DISTRO_NAME:-}" ] && return 0
  grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null
}

is_mounted() {
  awk -v p="$RAMDISK" '$2==p {f=1} END {exit(f?0:1)}' /proc/mounts 2>/dev/null
}

is_tmpfs() {
  awk -v p="$RAMDISK" '$2==p && $3=="tmpfs" {f=1} END {exit(f?0:1)}' /proc/mounts 2>/dev/null
}

total_ram_mb() {
  local kb
  kb=$(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null)
  [ -n "${kb:-}" ] || kb=$((4 * 1024 * 1024))
  echo $((kb / 1024))
}

size_mb() {
  local pct="$PERCENT" total
  [ "$pct" -lt 25 ] 2>/dev/null && pct=25
  [ "$pct" -gt 40 ] 2>/dev/null && pct=40
  total=$(total_ram_mb)
  echo $((total * pct / 100))
}

# Emit env vars for ecosystems actually present. Nothing is set for a toolchain
# that isn't installed (no phantom cache dirs).
env_lines() {
  if have python3 || have python || have pip || have pip3; then
    echo "export PIP_CACHE_DIR=$RAMDISK/cache/pip"
  fi
  if have npm; then
    echo "export npm_config_cache=$RAMDISK/cache/npm"
  fi
  if have pnpm; then
    echo "export PNPM_STORE_DIR=$RAMDISK/cache/pnpm"
  fi
  if have yarn; then
    echo "export YARN_CACHE_FOLDER=$RAMDISK/cache/yarn"
  fi
  if have cargo || have rustc; then
    echo "export CARGO_TARGET_DIR=$RAMDISK/cargo/target"
  fi
  if have go; then
    echo "export GOCACHE=$RAMDISK/cache/go"
  fi
  if have gradle; then
    echo "export GRADLE_USER_HOME=$RAMDISK/gradle"
  fi
  if have ccache; then
    echo "export CCACHE_DIR=$RAMDISK/cache/ccache"
  fi
  if have sccache; then
    echo "export SCCACHE_DIR=$RAMDISK/cache/sccache"
    echo "export RUSTC_WRAPPER=sccache"
  fi
}

ensure_dirs() {
  local line dir
  while IFS= read -r line; do
    dir="${line#*=}"
    case "$dir" in
      "$RAMDISK"/*) run mkdir -p "$dir" ;;
    esac
  done < <(env_lines)
}

write_env_file() {
  run mkdir -p "$CONFIG_DIR"
  if [ "$DRY_RUN" = "1" ]; then
    printf '  [dry-run] write %s\n' "$ENV_FILE"
    return 0
  fi
  {
    echo "# agent-harness RAM-backed build/cache env — generated by setup-tmpfs.sh."
    echo "# WARNING: volatile tmpfs backing; caches/build artifacts only."
    env_lines
  } >"$ENV_FILE"
}

mount_opts() {
  # Own the mount as the invoking user so cache subdirs are writable without
  # root for every subsequent build.
  echo "size=$(size_mb)M,mode=0755,uid=$(id -u),gid=$(id -g)"
}

guard_ramdisk() {
  case "$RAMDISK" in
    "" | / | /mnt | /home | "$HOME")
      echo "setup-tmpfs: refusing unsafe AGENT_RAMDISK '$RAMDISK'." >&2
      return 1
      ;;
  esac
  return 0
}

cmd_up() {
  is_wsl || {
    echo "setup-tmpfs: not WSL — no-op."
    return 0
  }
  guard_ramdisk || return 1
  if is_mounted; then
    if ! is_tmpfs; then
      echo "setup-tmpfs: $RAMDISK is mounted but not tmpfs — refusing to touch it." >&2
      return 1
    fi
    echo "setup-tmpfs: $RAMDISK already mounted (no-op mount)."
  else
    run as_root mkdir -p "$RAMDISK"
    if [ "$DRY_RUN" = "1" ]; then
      printf '  [dry-run] mount -t tmpfs -o %s tmpfs %s\n' "$(mount_opts)" "$RAMDISK"
    else
      if ! as_root mount -t tmpfs -o "$(mount_opts)" tmpfs "$RAMDISK"; then
        echo "setup-tmpfs: mount failed (needs root) — retry with: sudo $0 up" >&2
        return 1
      fi
      echo "setup-tmpfs: mounted tmpfs at $RAMDISK ($(mount_opts), ${PERCENT}% of RAM)."
    fi
  fi
  ensure_dirs
  write_env_file
  echo
  echo "# WARNING: $RAMDISK is RAM-backed and VOLATILE — a reboot, OOM, or"
  echo "# 'setup-tmpfs.sh down' ERASES it. Caches and build artifacts only;"
  echo "# NEVER source code, databases, or git state."
  echo "# Activate in this shell with:  eval \"\$($0 env)\""
}

cmd_ensure() {
  is_wsl || return 0
  guard_ramdisk || return 0
  if ! is_mounted; then
    as_root mkdir -p "$RAMDISK" >/dev/null 2>&1
    as_root mount -t tmpfs -o "$(mount_opts)" tmpfs "$RAMDISK" >/dev/null 2>&1 || return 0
  fi
  ensure_dirs >/dev/null 2>&1
  write_env_file >/dev/null 2>&1
  return 0
}

cmd_status() {
  if ! is_wsl; then
    echo "setup-tmpfs: not WSL — tmpfs setup is a no-op here."
    return 0
  fi
  if is_mounted; then
    echo "mounted: yes"
    awk -v p="$RAMDISK" '$2==p {print "  fstype=" $3 " options=" $4}' /proc/mounts
    df -h "$RAMDISK" | sed 's/^/  /'
  else
    echo "mounted: no ($RAMDISK)"
  fi
  echo "config:  $CONFIG_DIR"
  [ -f "$ENV_FILE" ] && echo "env:     present ($ENV_FILE)" || echo "env:     absent"
  echo "env vars detected for this host:"
  env_lines | sed 's/^/  /'
}

write_unit() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '  [dry-run] write %s/%s\n' "$UNIT_DIR" "$UNIT_NAME"
    return 0
  fi
  mkdir -p "$UNIT_DIR"
  {
    echo "[Unit]"
    echo "Description=agent-harness RAM-backed build/cache tmpfs"
    echo "After=default.target"
    echo
    echo "[Service]"
    echo "Type=oneshot"
    echo "RemainAfterExit=yes"
    echo "Environment=AGENT_TMPFS_CONFIG=$CONFIG_DIR"
    echo "ExecStart=$INSTALLED_SCRIPT up"
    echo "ExecStop=$INSTALLED_SCRIPT down"
    echo
    echo "[Install]"
    echo "WantedBy=default.target"
  } >"$UNIT_DIR/$UNIT_NAME"
}

install_bashrc_hook() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '  [dry-run] install bashrc hook in %s\n' "$BASHRC"
    return 0
  fi
  touch "$BASHRC"
  awk -v b="$BASHRC_MARKER" -v e="$BASHRC_END" '
    $0==b {skip=1; next}
    skip && $0==e {skip=0; next}
    !skip {print}
  ' "$BASHRC" >"$BASHRC.tmp.$$" && mv "$BASHRC.tmp.$$" "$BASHRC"
  {
    printf '%s\n' "$BASHRC_MARKER"
    printf '%s\n' 'if [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qiE "microsoft|wsl" /proc/version 2>/dev/null; then'
    printf '  [ -x "%s" ] && "%s" ensure >/dev/null 2>&1\n' "$INSTALLED_SCRIPT" "$INSTALLED_SCRIPT"
    printf '  [ -f "%s" ] && . "%s"\n' "$ENV_FILE" "$ENV_FILE"
    printf '%s\n' 'fi'
    printf '%s\n' "$BASHRC_END"
  } >>"$BASHRC"
}

remove_bashrc_hook() {
  [ -f "$BASHRC" ] || return 0
  if [ "$DRY_RUN" = "1" ]; then
    printf '  [dry-run] remove bashrc hook from %s\n' "$BASHRC"
    return 0
  fi
  awk -v b="$BASHRC_MARKER" -v e="$BASHRC_END" '
    $0==b {skip=1; next}
    skip && $0==e {skip=0; next}
    !skip {print}
  ' "$BASHRC" >"$BASHRC.tmp.$$" && mv "$BASHRC.tmp.$$" "$BASHRC"
}

cmd_install() {
  is_wsl || {
    echo "setup-tmpfs: not WSL — install is a no-op."
    return 0
  }
  guard_ramdisk || return 1
  run mkdir -p "$CONFIG_DIR" "$UNIT_DIR"
  if [ "$DRY_RUN" != "1" ] && [ "$(readlink -f "$0")" != "$(readlink -f "$INSTALLED_SCRIPT" 2>/dev/null)" ]; then
    cp -f "$0" "$INSTALLED_SCRIPT"
    chmod 0755 "$INSTALLED_SCRIPT"
  fi
  write_unit
  install_bashrc_hook
  if have systemctl && systemctl --user show-environment >/dev/null 2>&1; then
    run systemctl --user daemon-reload
    run systemctl --user enable --now "$UNIT_NAME"
    echo "setup-tmpfs: systemd --user unit '$UNIT_NAME' enabled."
  else
    echo "setup-tmpfs: systemd --user unavailable — ~/.bashrc hook is the persistence path."
  fi
  cmd_up
  echo
  echo "setup-tmpfs: persisted. New shells mount on demand and source $ENV_FILE."
}

cmd_down() {
  is_wsl || {
    echo "setup-tmpfs: not WSL — no-op."
    return 0
  }
  if is_mounted; then
    if run as_root umount "$RAMDISK"; then
      echo "setup-tmpfs: unmounted $RAMDISK."
    else
      echo "setup-tmpfs: umount failed for $RAMDISK." >&2
    fi
  else
    echo "setup-tmpfs: $RAMDISK not mounted (no-op)."
  fi
  if [ "$DRY_RUN" != "1" ]; then
    rm -f "$ENV_FILE"
  fi
  echo "setup-tmpfs: new shells no longer receive tmpfs env; run 'eval \"\$(setup-tmpfs.sh env)\"' after removing stale vars if needed."
}

cmd_uninstall() {
  if have systemctl; then
    run systemctl --user disable --now "$UNIT_NAME" 2>/dev/null || true
  fi
  if [ "$DRY_RUN" != "1" ]; then
    rm -f "$UNIT_DIR/$UNIT_NAME" "$ENV_FILE" "$INSTALLED_SCRIPT"
  fi
  remove_bashrc_hook
  cmd_down
  echo "setup-tmpfs: uninstalled."
}

case "$ACTION" in
  help) usage ;;
  up) cmd_up ;;
  ensure) cmd_ensure ;;
  env) env_lines ;;
  status) cmd_status ;;
  install) cmd_install ;;
  down) cmd_down ;;
  uninstall) cmd_uninstall ;;
esac
