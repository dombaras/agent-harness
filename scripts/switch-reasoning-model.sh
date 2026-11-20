#!/usr/bin/env bash
# POSIX twin of scripts/switch-reasoning-model.ps1 (WSL/Linux/macOS).
# Switches the reasoning-tier model: rewrites the `model` field in opencode.json
# and the `model:` frontmatter of the six reasoning-tier agents to one model.
#
# Usage: bash scripts/switch-reasoning-model.sh <alias|model-id>
# Aliases: go|go-flash|go-deepseek, go-pro, deepseek|flash|direct,
#          deepseek-pro|pro, nvidia|kimi|kimi-k3, nemotron, openrouter|or|m3, or a
#          bare model id (auto-prefixed with deepseek/ when it has no provider).
set -euo pipefail

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  echo "usage: bash scripts/switch-reasoning-model.sh <alias|model-id>" >&2
  exit 2
fi

root="$(cd "$(dirname "$0")/.." && pwd)"

target_lc="$(printf '%s' "$TARGET" | tr '[:upper:]' '[:lower:]')"
case "$target_lc" in
  go|go-flash|go-deepseek) target_model="opencode-go/deepseek-v4.1-flash" ;;
  go-pro)                  target_model="opencode-go/deepseek-v4-pro" ;;
  deepseek|flash|deepseek-flash|direct) target_model="deepseek/deepseek-flash" ;;
  deepseek-pro|deepseek-v4-pro|pro) target_model="deepseek/deepseek-v4-pro" ;;
  nvidia|kimi|kimi-k3)     target_model="nvidia/moonshotai/kimi-k3" ;;
  nemotron|nemotron-ultra) target_model="nvidia/nemotron-3-ultra-550b-a55b:free" ;;
  openrouter|or|minimax-m3|m3) target_model="openrouter/minimax/minimax-m3" ;;
  *) target_model="$TARGET" ;;
esac
case "$target_model" in
  */*) ;;
  *) target_model="deepseek/$target_model" ;;
esac

# Every alias value is also a "find" value (anything the script can switch TO it
# can also switch FROM) — see the note in the PowerShell twin.
reasoning_models="
opencode-go/deepseek-v4.1-flash
opencode-go/deepseek-v4-pro
deepseek/deepseek-flash
deepseek/deepseek-v4-pro
nvidia/moonshotai/kimi-k3
nvidia/nemotron-3-ultra-550b-a55b:free
openrouter/minimax/minimax-m3
"

files="
opencode.json
.opencode/agents/planner.md
.opencode/agents/system-architect.md
.opencode/agents/security-engineer.md
.opencode/agents/diagnostics-expert.md
.opencode/agents/product-manager.md
.opencode/agents/qa-architect.md
"

esc_bre() { printf '%s' "$1" | sed -e 's/[][\\.^$*#]/\\&/g'; }
esc_repl() { printf '%s' "$1" | sed -e 's/[\\&#]/\\&/g'; }

changed=""
skipped=""
for rel in $files; do
  path="$root/$rel"
  if [ ! -f "$path" ]; then
    printf 'warning: missing: %s\n' "$rel" >&2
    continue
  fi
  raw="$(cat "$path"; printf x)"; raw="${raw%x}"
  new="$raw"
  find_hits=0
  for m in $reasoning_models; do
    [ "$m" = "$target_model" ] && continue
    case "$new" in *"$m"*) find_hits=1 ;; esac
    new="$(printf '%s' "$new" | sed "s#$(esc_bre "$m")#$(esc_repl "$target_model")#g"; printf x)"; new="${new%x}"
  done
  if [ "$new" != "$raw" ]; then
    printf '%s' "$new" > "$path"
    changed="$changed $rel"
  elif [ "$find_hits" = 0 ]; then
    case "$raw" in
      *"$target_model"*) ;;
      *)
        current="$(printf '%s' "$raw" | grep -oE 'model:[[:space:]]*"?[A-Za-z0-9._:/-]+"?' | head -1 | sed -E 's/^model:[[:space:]]*"?//; s/"$//')"
        skipped="${skipped}${rel} (current value \"${current}\" not in replace list; edit by hand or add an alias)\n"
        ;;
    esac
  fi
done

printf 'Switched reasoning-tier model -> %s\n' "$target_model"
if [ -n "$changed" ]; then
  printf 'Updated:\n'
  for rel in $changed; do printf '  - %s\n' "$rel"; done
fi
if [ -n "$skipped" ]; then
  printf 'Skipped (current value not in replace list):\n'
  printf '%b' "$skipped"
  printf 'Add an alias to scripts/switch-reasoning-model.sh (or edit the file by hand).\n'
fi
if [ -z "$changed" ] && [ -z "$skipped" ]; then
  printf 'No files changed (already set).\n'
fi
printf 'Restart opencode for the change to take effect.\n'
