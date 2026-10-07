#!/usr/bin/env bash
# ci-gates.sh — boot the board service on a throwaway Postgres and run the
# harness board gates against it in service mode (ADR 0001 §7 / H-37).
#
# This is the CI counterpart of the local `board-service.sh`: it proves the
# service builds, migrates, boots, and serves a board that the shipped gates
# (`check-backlog.js`, `check-concurrency.js`) accept in `BACKLOG_BACKEND=service`.
#
# Required env: DATABASE_URL (points at a disposable Postgres), BOARD_TOKENS
# (`<token>:<project>`). Optional: BOARD_FIXTURE, BOARD_CI_PROJECT, BOARD_CI_PORT.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
svc_dir="$(cd "$here/.." && pwd)"
repo_dir="$(cd "$svc_dir/../.." && pwd)"

dataset="${BOARD_FIXTURE:-$svc_dir/scripts/ci-board.md}"
project="${BOARD_CI_PROJECT:-ci}"
port="${BOARD_CI_PORT:-3021}"
token="${BOARD_CI_TOKEN:-ci-board-token}"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ci-gates: DATABASE_URL is not set" >&2
  exit 1
fi

tmp="$(mktemp -d)"
cleanup() {
  [ -n "${svc_pid:-}" ] && kill "$svc_pid" 2>/dev/null || true
  rm -rf "$tmp"
}
trap cleanup EXIT

cd "$svc_dir"

echo "ci-gates: generating the Prisma client"
DATABASE_URL="$DATABASE_URL" BOARD_TOKENS="$BOARD_TOKENS" npx prisma generate >/dev/null

echo "ci-gates: applying schema to the disposable database"
DATABASE_URL="$DATABASE_URL" BOARD_TOKENS="$BOARD_TOKENS" npx prisma db push >/dev/null

echo "ci-gates: seeding the '$project' board from $(basename "$dataset")"
cp "$dataset" "$tmp/BACKLOG.md"
DATABASE_URL="$DATABASE_URL" BOARD_TOKENS="$BOARD_TOKENS" \
  npx tsx scripts/migrate-board.ts --root "$tmp" --project "$project" --name "$project"

echo "ci-gates: building + booting the service on port $port"
DATABASE_URL="$DATABASE_URL" BOARD_TOKENS="$BOARD_TOKENS" npx next build >/dev/null
DATABASE_URL="$DATABASE_URL" BOARD_TOKENS="$BOARD_TOKENS" npx next start -p "$port" >"$tmp/service.log" 2>&1 &
svc_pid=$!

for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$port/api/health" >/dev/null && break
  sleep 1
done
curl -sf "http://127.0.0.1:$port/api/health"

echo "ci-gates: running the board gates in service mode"
export BACKLOG_BACKEND=service
export BACKLOG_API_URL="http://127.0.0.1:$port"
export BACKLOG_API_TOKEN="$token"
export BACKLOG_PROJECT="$project"
node "$repo_dir/templates/scripts/qa/check-backlog.js"
node "$repo_dir/templates/scripts/qa/check-concurrency.js"

echo "ci-gates: green"
