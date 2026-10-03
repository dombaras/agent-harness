#!/usr/bin/env bash
#
# setup-nightly.sh — install the off-hours E2E cycle as a systemd --user timer.
#
# Runs `scripts/nightly.js run` on a schedule (default 02:00) in this project, so
# the full E2E battery test the day's landed code while nobody is working. The
# timer is `Persistent=true`: if the machine was off at the scheduled time it
# runs on the next boot. User units need lingering to fire without a login
# session, which `install` enables (loginctl enable-linger).
#
#   setup-nightly.sh install [--time HH:MM] [--force]   create + enable the timer
#   setup-nightly.sh uninstall                          disable + remove it
#   setup-nightly.sh status                             timer state + last run
#   setup-nightly.sh run-now                            run the cycle immediately
#   setup-nightly.sh --dry-run ...                      print what would change
#
# Overrides: AGENT_NIGHTLY_TIME (HH:MM, default 02:00), AGENT_NIGHTLY_UNIT,
# AGENT_NIGHTLY_UNIT_DIR, AGENT_NIGHTLY_ROOT (project root), AGENT_NIGHTLY_DRY_RUN=1.
# A machine without systemd --user falls back to a crontab line (printed, not
# installed).
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="${AGENT_NIGHTLY_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
SLUG="$(basename "$ROOT" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9' '-' | sed 's/-*$//')"
[ -n "$SLUG" ] || SLUG="project"
UNIT_NAME="${AGENT_NIGHTLY_UNIT:-agent-nightly-${SLUG}}"
UNIT_DIR="${AGENT_NIGHTLY_UNIT_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user}"
TIME="02:00"
DRY_RUN="${AGENT_NIGHTLY_DRY_RUN:-0}"

ACTION=""
WANT_TIME=""
FORCE=0
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  a="${args[$i]}"
  case "$a" in
    --dry-run) DRY_RUN=1 ;;
    --time) WANT_TIME="${args[$((i + 1))]:-}"; i=$((i + 1)) ;;
    --time=*) WANT_TIME="${a#--time=}" ;;
    --force) FORCE=1 ;;
    install | uninstall | status | run-now) ACTION="$a" ;;
    -h | --help) ACTION="help" ;;
    *) echo "setup-nightly: unknown argument: $a" >&2; ACTION="help" ;;
  esac
done
[ -n "$WANT_TIME" ] && TIME="$WANT_TIME"

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

have_systemd() {
  have systemctl && systemctl --user show-environment >/dev/null 2>&1
}

validate_time() {
  case "$TIME" in
    [0-2][0-9]:[0-5][0-9]) return 0 ;;
    *) echo "setup-nightly: --time must be HH:MM (got '$TIME')" >&2; return 1 ;;
  esac
}

write_units() {
  run mkdir -p "$UNIT_DIR"
  if [ "$DRY_RUN" = "1" ]; then
    printf '  [dry-run] write %s/%s.{service,timer}\n' "$UNIT_DIR" "$UNIT_NAME"
    return 0
  fi
  cat >"$UNIT_DIR/$UNIT_NAME.service" <<EOF
[Unit]
Description=agent-harness nightly E2E cycle for $SLUG
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$ROOT
ExecStart=$(command -v node) $ROOT/scripts/nightly.js run --root $ROOT
TimeoutStartSec=infinity
Nice=10
EOF
  cat >"$UNIT_DIR/$UNIT_NAME.timer" <<EOF
[Unit]
Description=Run the agent-harness nightly E2E cycle for $SLUG

[Timer]
OnCalendar=*-*-* $TIME:00
Persistent=true
RandomizedDelaySec=300
Unit=$UNIT_NAME.service

[Install]
WantedBy=timers.target
EOF
  echo "setup-nightly: wrote $UNIT_DIR/$UNIT_NAME.{service,timer}"
}

remove_units() {
  if [ "$DRY_RUN" != "1" ]; then
    rm -f "$UNIT_DIR/$UNIT_NAME.service" "$UNIT_DIR/$UNIT_NAME.timer"
  else
    printf '  [dry-run] remove %s/%s.{service,timer}\n' "$UNIT_DIR" "$UNIT_NAME"
  fi
}

enable_linger() {
  if have loginctl; then
    run loginctl enable-linger "$(id -un)" >/dev/null 2>&1 ||
      run sudo -n loginctl enable-linger "$(id -un)" >/dev/null 2>&1 ||
      echo "setup-nightly: could not enable linger automatically — run: sudo loginctl enable-linger $(id -un)"
  fi
}

cmd_install() {
  validate_time || return 1
  if ! have systemd; then
    echo "setup-nightly: no systemd --user bus on this host — install the cron fallback instead:"
    echo "  $TIME daily: cd $ROOT && node scripts/nightly.js run --root $ROOT"
    return 1
  fi
  if [ "$FORCE" != "1" ] && [ -f "$UNIT_DIR/$UNIT_NAME.timer" ] && [ "$DRY_RUN" != "1" ]; then
    echo "setup-nightly: $UNIT_NAME.timer already installed (pass --force to rewrite)."
  fi
  write_units
  enable_linger
  run systemctl --user daemon-reload
  run systemctl --user enable --now "$UNIT_NAME.timer"
  echo "setup-nightly: enabled $UNIT_NAME.timer for $TIME daily (Persistent=true)."
  echo "  next:      systemctl --user list-timers $UNIT_NAME.timer"
  echo "  run now:   $ROOT/scripts/setup-nightly.sh run-now"
  echo "  uninstall: $ROOT/scripts/setup-nightly.sh uninstall"
}

cmd_uninstall() {
  if have systemd; then
    run systemctl --user disable --now "$UNIT_NAME.timer" 2>/dev/null || true
  fi
  remove_units
  if have systemd; then
    run systemctl --user daemon-reload
  fi
  echo "setup-nightly: uninstalled $UNIT_NAME."
}

cmd_status() {
  if [ -f "$UNIT_DIR/$UNIT_NAME.timer" ]; then
    echo "timer:     installed ($UNIT_DIR/$UNIT_NAME.timer)"
  else
    echo "timer:     not installed"
  fi
  if have systemd; then
    systemctl --user is-enabled "$UNIT_NAME.timer" 2>/dev/null | sed 's/^/enabled:   /' || true
    systemctl --user list-timers "$UNIT_NAME.timer" --no-pager 2>/dev/null | sed 's/^/  /' || true
  fi
  if [ -f "$ROOT/.agents/qa-runs/nightly/latest.json" ]; then
    node "$ROOT/scripts/nightly.js" report --root "$ROOT" 2>/dev/null || true
  else
    echo "last run:  none recorded"
  fi
}

cmd_run_now() {
  cd "$ROOT" || return 1
  exec node "$ROOT/scripts/nightly.js" run --root "$ROOT"
}

case "$ACTION" in
  help | "") usage ;;
  install) cmd_install ;;
  uninstall) cmd_uninstall ;;
  status) cmd_status ;;
  run-now) cmd_run_now ;;
esac
