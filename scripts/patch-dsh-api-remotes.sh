#!/usr/bin/env bash
# Add 'turn-notify/focus' to dsh-api-remotes' forwarded-Host-event allowlist.
#
# Why: the host forwards ONLY the events in API_REMOTE_FORWARDED_EVENTS to
# web clients. Our server plugin emits turn-notify/focus on notification
# click; the browser half subscribes via ctx.remote.$on to focus the
# matching session. Without this patch the event never reaches the page.
#
# Idempotent. Patches the runtime copy the host reads (profile flat
# fallback / global install) plus this repo's node_modules copy.
# Re-run after reinstalling DSH or npm install.
set -euo pipefail

MARKER="turn-notify/focus"

INSTALL_DIR="$(readlink -f "$HOME/.dsh/profiles/node_modules/@deepseek-ai/dsh-api-remotes" 2>/dev/null || true)"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)/node_modules/@deepseek-ai/dsh-api-remotes"
EXTRA_DIR="${DSH_API_REMOTES_DIR:-}"
GLOBAL_DIR="$(npm root -g 2>/dev/null)/@deepseek-ai/dsh-api-remotes"

PATCH_DIRS=()
[ -n "$INSTALL_DIR" ] && [ -d "$INSTALL_DIR" ] && PATCH_DIRS+=("$INSTALL_DIR")
[ -n "$EXTRA_DIR" ] && [ -d "$EXTRA_DIR" ] && PATCH_DIRS+=("$(readlink -f "$EXTRA_DIR")")
[ -d "$GLOBAL_DIR" ] && PATCH_DIRS+=("$GLOBAL_DIR")
[ -d "$REPO_DIR" ] && PATCH_DIRS+=("$REPO_DIR")

PATCH_DIRS=($(printf '%s\n' "${PATCH_DIRS[@]}" | awk '!seen[$0]++'))

if [ "${#PATCH_DIRS[@]}" -eq 0 ]; then
  echo "no dsh-api-remotes copy found to patch" >&2
  exit 1
fi

for dir in "${PATCH_DIRS[@]}"; do
  f="$dir/lib/index.js"
  if ! grep -q "$MARKER" "$f" 2>/dev/null; then
    sed -i 's|\t"llm/adapters-updated",|\t"llm/adapters-updated",\n\t"turn-notify/focus",|' "$f"
    echo "patched: $f"
  else
    echo "already patched: $f"
  fi
  # types copy keeps the client-side key face in sync
  tf="$dir/lib/types/index.js"
  if [ -f "$tf" ] && ! grep -q "$MARKER" "$tf" 2>/dev/null; then
    sed -i 's|"llm/adapters-updated",|"llm/adapters-updated",\n\t"turn-notify/focus",|' "$tf"
    echo "patched types: $tf"
  fi
done
echo "done."
