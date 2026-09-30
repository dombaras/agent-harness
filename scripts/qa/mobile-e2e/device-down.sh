#!/usr/bin/env bash
#
# mobile E2E — bring the device tier DOWN cleanly: stop the dev server, optionally
# the emulator, and prune dead `.serve/` records so a stopped emulator is never
# misreported as live (and its RAM is actually freed).
#
# Pairs with `device-up.sh`. The rule is: stop a dev server as soon as its tier
# passes; reuse an emulator WITHIN a session but stop it at session end. This
# makes that one command instead of a hand-typed `serve.js stop` per process.
#
# Usage:
#   scripts/qa/mobile-e2e/device-down.sh              # stop dev server + prune
#   scripts/qa/mobile-e2e/device-down.sh --emulator   # also stop the emulator
#   scripts/qa/mobile-e2e/device-down.sh --all        # stop-all heavy tiers
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
LOCAL_CONFIG="$ROOT/scripts/qa/mobile-e2e/local.json"

DEV_NAME="${MOBILE_E2E_DEV_NAME:-$(node -e "try{const c=require('$LOCAL_CONFIG');process.stdout.write(c.devName||'')}catch(e){}" 2>/dev/null || true)}"
[ -z "$DEV_NAME" ] && DEV_NAME="app-dev"

MODE="dev"
for arg in "$@"; do
  case "$arg" in
    --emulator) MODE="emulator" ;;
    --all) MODE="all" ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [ "$MODE" = "all" ]; then
  echo "device-down: stop-all + prune"
  node scripts/serve.js stop-all || true
else
  echo "device-down: stop dev server ($DEV_NAME)"
  node scripts/serve.js stop --name "$DEV_NAME" || true
  if [ "$MODE" = "emulator" ]; then
    echo "device-down: stop emulator"
    node scripts/serve.js stop --name emulator || true
    node scripts/serve.js stop --name adb-server || true
  fi
fi

node scripts/serve.js prune || true
node scripts/serve.js list || true
