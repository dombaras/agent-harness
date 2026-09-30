#!/usr/bin/env bash
#
# agent-search.sh — thin, ignore-aware ripgrep wrapper for agent workspaces.
#
# Why this exists: recursive discovery is run constantly by agents and must stay
# cheap and deterministic. This wrapper
#   * relies on the canonical ignore files (`.ignore` + `.gitignore`) and NEVER
#     passes --no-ignore / --unrestricted, so node_modules/.git/build trees are
#     skipped by default;
#   * drops lockfiles, minified bundles, source maps, and oversized files
#     (--max-columns / --max-filesize) so one generated 20 MB file can't dominate;
#   * supports `--files` for cheap file discovery (no content is read);
#   * caps output (default 200 lines; override with --limit N or
#     AGENT_SEARCH_LIMIT) so a broad query can't flood an agent's context.
#
# Usage:
#   scripts/agent-search.sh <pattern> [paths...]      # content search
#   scripts/agent-search.sh --files [path]            # list candidate files
#   scripts/agent-search.sh -g '*.ts' <pattern>       # extra rg globs pass through
#   scripts/agent-search.sh --limit 50 <pattern>
#   scripts/agent-search.sh --help
#
# `git grep` is still preferred for symbol searches over tracked files only (it
# reads the git index and its file set is exactly the repo's); use this wrapper
# for generated/untracked-aware content search. See docs/wsl-optimizations.md.
set -u

LIMIT="${AGENT_SEARCH_LIMIT:-200}"
MAX_FILESIZE="${AGENT_SEARCH_MAX_FILESIZE:-1M}"
MAX_COLUMNS="${AGENT_SEARCH_MAX_COLUMNS:-300}"

usage() {
  sed -n '2,/^set -u$/p' "$0" | sed 's/^# \{0,1\}//; /^set -u$/d'
}

if ! command -v rg >/dev/null 2>&1; then
  echo "agent-search: ripgrep (rg) not found — install it (apt-get install ripgrep)." >&2
  exit 127
fi

FILES_MODE=0
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --files) FILES_MODE=1; shift ;;
    --limit) LIMIT="${2:-200}"; shift 2 ;;
    --limit=*) LIMIT="${1#--limit=}"; shift ;;
    -h | --help)
      usage
      exit 0
      ;;
    --no-ignore | --unrestricted | -u | -U)
      echo "agent-search: refusing '$1' — this wrapper relies on the canonical" >&2
      echo "  ignore files; pass an explicit -g glob to add a path back in." >&2
      exit 2
      ;;
    --hidden)
      echo "agent-search: refusing '--hidden' — hidden trees (.next/.cache/.git)" >&2
      echo "  are the high-cost ones this wrapper exists to skip." >&2
      exit 2
      ;;
    --)
      shift
      while [ $# -gt 0 ]; do
        args+=("$1")
        shift
      done
      ;;
    *)
      args+=("$1")
      shift
      ;;
  esac
done

if [ "$FILES_MODE" -eq 0 ] && [ "${#args[@]}" -eq 0 ]; then
  echo "agent-search: a pattern is required (or use --files)." >&2
  exit 2
fi

# Lockfiles / minified bundles / maps are noise for an agent reading matches.
# --hidden is intentionally never used: hidden trees are exactly the expensive
# ones (build output, caches) we want skipped.
common=(
  --color=never
  --max-columns="$MAX_COLUMNS"
  --max-columns-preview
  --max-filesize="$MAX_FILESIZE"
  --glob '!package-lock.json'
  --glob '!npm-shrinkwrap.json'
  --glob '!yarn.lock'
  --glob '!pnpm-lock.yaml'
  --glob '!bun.lockb'
  --glob '!Cargo.lock'
  --glob '!poetry.lock'
  --glob '!Pipfile.lock'
  --glob '!composer.lock'
  --glob '!Gemfile.lock'
  --glob '!*.min.js'
  --glob '!*.min.css'
  --glob '!*.map'
  --glob '!*.tsbuildinfo'
)

# Cap the stream with `head`; a broad query is expected to truncate, and the
# SIGPIPE that gives rg (exit 141) is not an error. Treat 0/1/141 as success.
set +o pipefail 2>/dev/null || true
if [ "$FILES_MODE" -eq 1 ]; then
  rg --files "${common[@]}" ${args[@]+"${args[@]}"} | head -n "$LIMIT"
else
  rg "${common[@]}" ${args[@]+"${args[@]}"} | head -n "$LIMIT"
fi
rc=${PIPESTATUS[0]:-0}
case "$rc" in
  0 | 1 | 141) exit 0 ;;
  *) exit "$rc" ;;
esac
