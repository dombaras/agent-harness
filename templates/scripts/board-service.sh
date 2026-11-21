#!/usr/bin/env bash
# board-service.sh — start/stop the shared external board service (ADR 0001).
#
# The board service is a single, shared Next.js + Prisma app that lives in the
# harness repo (`services/board/`), not in any project. This script manages its
# lifecycle and the connection config the clients read.
#
#   board-service.sh up          start it (idempotent); prints the URL
#   board-service.sh down        stop it
#   board-service.sh status      running? + health probe
#   board-service.sh env         print the client env exports
#   board-service.sh install     persist: systemd --user unit (+ bashrc fallback)
#   board-service.sh uninstall   stop + remove the unit
#
# Config resolution (first found wins):
#   - $BOARD_SERVICE_DIR              explicit service directory
#   - $AGENT_HARNESS_HOME/services/board
#   - ~/develop/agent-harness/services/board
#
# Client env (written to <config>/board.env, sourced by the shell hook):
#   BACKLOG_API_URL, BACKLOG_API_TOKEN, BACKLOG_PROJECT
set -euo pipefail

HARNESS_HOME="${AGENT_HARNESS_HOME:-$HOME/develop/agent-harness}"
CONFIG_DIR="${BOARD_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/agent-harness}"
ENV_FILE="$CONFIG_DIR/board.env"              # CLIENT config (BACKLOG_*)
SERVICE_ENV_FILE="$CONFIG_DIR/board-service.env"  # SERVICE config (DATABASE_URL, BOARD_TOKENS)
UNIT_DIR="${BOARD_UNIT_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user}"
UNIT_NAME="agent-board.service"
BASHRC="${BOARD_BASHRC:-$HOME/.bashrc}"
BASHRC_MARKER="# >>> agent-harness board service >>>"
BASHRC_END="# <<< agent-harness board service <<<"
DEFAULT_PORT="${BOARD_PORT:-3021}"
LOG_DIR="${BOARD_LOG_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/agent-board}"
DRY_RUN=0

say() { printf 'board-service: %s\n' "$*"; }
run() {
  if [ "$DRY_RUN" = "1" ]; then printf '  [dry-run] %s\n' "$*"; return 0; fi
  "$@"
}
have() { command -v "$1" >/dev/null 2>&1; }

service_dir() {
  for d in "${BOARD_SERVICE_DIR:-}" "$HARNESS_HOME/services/board" "$HOME/develop/agent-harness/services/board"; do
    [ -n "$d" ] || continue
    [ -f "$d/package.json" ] && { printf '%s' "$d"; return 0; }
  done
  return 1
}

url() { printf 'http://127.0.0.1:%s' "$DEFAULT_PORT"; }

is_up() {
  have curl || return 1
  curl -sf -o /dev/null --max-time 2 "$(url)/api/health" 2>/dev/null
}

cmd_up() {
  local dir
  dir="$(service_dir)" || { say "service code not found (set BOARD_SERVICE_DIR or AGENT_HARNESS_HOME)"; return 1; }
  if is_up; then say "already running at $(url)"; return 0; fi
  if have systemctl && systemctl --user list-unit-files "$UNIT_NAME" >/dev/null 2>&1 \
     && systemctl --user cat "$UNIT_NAME" >/dev/null 2>&1; then
    run systemctl --user start "$UNIT_NAME"
    say "started via systemd ($UNIT_NAME)"
  elif have systemd-run && systemd-run --user --version >/dev/null 2>&1; then
    # Transient unit: fully detached from this shell/tool call and survives it.
    run systemd-run --user --unit=agent-board-transient \
      --working-directory="$dir" \
      --setenv=NODE_ENV=production \
      npx next start -p "$DEFAULT_PORT"
    say "started via systemd-run (transient unit)"
  else
    mkdir -p "$LOG_DIR"
    # Last resort: setsid + full stdio redirection in a subshell.
    ( cd "$dir" && exec setsid npx next start -p "$DEFAULT_PORT" >"$LOG_DIR/service.log" 2>&1 </dev/null ) &
    disown 2>/dev/null || true
    say "started detached (port $DEFAULT_PORT; log $LOG_DIR/service.log)"
  fi
  for _ in $(seq 1 30); do is_up && { say "healthy at $(url)"; return 0; }; sleep 1; done
  say "did not become healthy in 30s — check $LOG_DIR/service.log"; return 1
}

cmd_down() {
  if have systemctl && systemctl --user cat "$UNIT_NAME" >/dev/null 2>&1; then
    run systemctl --user stop "$UNIT_NAME" || true
  fi
  # Fallback: kill a detached next-server bound to our port.
  if have pkill; then pkill -f "next start -p $DEFAULT_PORT" 2>/dev/null || true; fi
  say "stopped"
}

cmd_status() {
  if is_up; then say "running — $(curl -s --max-time 2 "$(url)/api/health")"
  else say "not running ($(url))"; return 1; fi
}

cmd_env() {
  local f="$ENV_FILE"
  if [ -f "$f" ]; then cat "$f"; else
    printf 'export BACKLOG_API_URL="%s"\n' "$(url)"
    printf 'export BACKLOG_API_TOKEN="%s"\n' "${BOARD_TOKEN:-change-me}"
    printf 'export BACKLOG_PROJECT="%s"\n' "${BOARD_PROJECT:-${PROJECT_NAME:-project}}"
  fi
}

write_env() {
  [ "$DRY_RUN" = "1" ] && { printf '  [dry-run] write %s\n' "$ENV_FILE"; return 0; }
  mkdir -p "$CONFIG_DIR"
  {
    printf '# agent-harness board service client config (ADR 0001).\n'
    printf 'export BACKLOG_API_URL="%s"\n' "$(url)"
    printf 'export BACKLOG_API_TOKEN="%s"\n' "${BOARD_TOKEN:-}"
    printf 'export BACKLOG_PROJECT="%s"\n' "${BOARD_PROJECT:-}"
  } >"$ENV_FILE"
}

write_unit() {
  local dir
  dir="$(service_dir)" || { say "service code not found"; return 1; }
  [ "$DRY_RUN" = "1" ] && { printf '  [dry-run] write %s/%s\n' "$UNIT_DIR" "$UNIT_NAME"; return 0; }
  mkdir -p "$UNIT_DIR"
  {
    echo "[Unit]"
    echo "Description=agent-harness shared board service (ADR 0001)"
    echo "After=default.target"
    # Auto-start across WSL restarts: the board DB is a Docker container, so wait
    # for the engine and retry the boot until Postgres is actually accepting
    # connections (Docker + the container come up asynchronously after boot).
    echo "Wants=docker.service"
    echo "After=docker.service"
    echo
    echo "[Service]"
    echo "WorkingDirectory=$dir"
    [ -f "$SERVICE_ENV_FILE" ] && echo "EnvironmentFile=$SERVICE_ENV_FILE"
    echo "Environment=NODE_ENV=production"
    # `next`'s shebang is `#!/usr/bin/env node`, and systemd --user's default
    # PATH omits user-level Node installs (nvm/volta/~/.local/bin), so the unit
    # restart-loops with `env: 'node': No such file or directory` (exit 127).
    # Pin the directory of the node that generated this unit.
    local node_dir
    node_dir="$(dirname "$(command -v node 2>/dev/null || printf '%s' /usr/bin/node)")"
    echo "Environment=PATH=$node_dir:/usr/local/bin:/usr/bin:/bin"
    # Best-effort gate: wait (bounded, ~60s) for the DB port before the app
    # boots. Uses bash (the `/dev/tcp` redirect is a bash feature).
    echo "ExecStartPre=-/bin/bash -c 'for i in \$(seq 1 30); do (exec 3<>/dev/tcp/127.0.0.1/5432) 2>/dev/null && exit 0; sleep 2; done; exit 0'"
    echo "ExecStart=$dir/node_modules/.bin/next start -p $DEFAULT_PORT"
    echo "Restart=always"
    echo "RestartSec=3"
    echo
    echo "[Install]"
    echo "WantedBy=default.target"
  } >"$UNIT_DIR/$UNIT_NAME"
}

install_bashrc_hook() {
  [ "$DRY_RUN" = "1" ] && { printf '  [dry-run] bashrc hook in %s\n' "$BASHRC"; return 0; }
  touch "$BASHRC"
  awk -v b="$BASHRC_MARKER" -v e="$BASHRC_END" '$0==b{skip=1;next} skip&&$0==e{skip=0;next} !skip{print}' "$BASHRC" >"$BASHRC.tmp.$$" && mv "$BASHRC.tmp.$$" "$BASHRC"
  {
    printf '%s\n' "$BASHRC_MARKER"
    printf '[ -f "%s" ] && . "%s"\n' "$ENV_FILE" "$ENV_FILE"
    # Safety net: if systemd did not bring the service up (e.g. no linger, or a
    # cold WSL boot racing Docker), nudge it once per shell — bounded and silent.
    printf 'if command -v systemctl >/dev/null 2>&1 && ! systemctl --user is-active --quiet %s 2>/dev/null; then\n' "$UNIT_NAME"
    printf '  systemctl --user start %s >/dev/null 2>&1 || true\n' "$UNIT_NAME"
    printf 'fi\n'
    printf '%s\n' "$BASHRC_END"
  } >>"$BASHRC"
}

cmd_install() {
  write_env
  write_unit
  install_bashrc_hook
  if have systemctl && systemctl --user show-environment >/dev/null 2>&1; then
    run systemctl --user daemon-reload
    run systemctl --user enable --now "$UNIT_NAME"
    say "systemd --user unit '$UNIT_NAME' enabled."
  else
    say "systemd --user unavailable — bashrc hook + detached start is the persistence path."
  fi
  cmd_up
  say "persisted. Client env in $ENV_FILE (source your shell or open a new one)."
}

cmd_uninstall() {
  cmd_down
  if have systemctl; then run systemctl --user disable "$UNIT_NAME" 2>/dev/null || true; fi
  [ "$DRY_RUN" != "1" ] && rm -f "$UNIT_DIR/$UNIT_NAME" "$ENV_FILE"
  if [ "$DRY_RUN" != "1" ] && [ -f "$BASHRC" ]; then
    awk -v b="$BASHRC_MARKER" -v e="$BASHRC_END" '$0==b{skip=1;next} skip&&$0==e{skip=0;next} !skip{print}' "$BASHRC" >"$BASHRC.tmp.$$" && mv "$BASHRC.tmp.$$" "$BASHRC"
  fi
  say "uninstalled"
}

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
}

ACTION="${1:-status}"
shift || true
case "$ACTION" in
  up) cmd_up ;;
  down) cmd_down ;;
  restart) cmd_down; cmd_up ;;
  status) cmd_status ;;
  env) cmd_env ;;
  install) cmd_install ;;
  uninstall) cmd_uninstall ;;
  help|-h|--help) usage ;;
  *) usage; exit 2 ;;
esac
