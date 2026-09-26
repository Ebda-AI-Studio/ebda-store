#!/usr/bin/env bash
# check-action-pins.sh — every third-party GitHub Action is pinned to a full
# 40-hex commit SHA (#1517).
#
# A tag or branch ref (`@v4`, `@main`) is mutable: whoever controls that repo
# can repoint it, and the next run executes their code inside a workflow that
# holds CLOUDFLARE_API_TOKEN / RAILWAY_TOKEN / AI_FIX_PAT. Every `uses:` in this
# repo is SHA-pinned today; this makes that a gate instead of a convention.
#
# Allowed:
#   uses: owner/repo[/path]@<40 hex>        (a trailing `# v4` comment is fine)
#   uses: ./local/action                    (same-repo action, reviewed with the PR)
#   uses: docker://image@sha256:<64 hex>    (digest-pinned container action)
# Everything else fails.
#
# Usage: check-action-pins.sh [DIR ...]   (default: .github)
# Exit 1 on any unpinned ref; 2 if nothing was scanned (a gate that scanned
# zero files must not report success).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2

DIRS=("$@")
[ ${#DIRS[@]} -eq 0 ] && DIRS=(.github)

files=()
while IFS= read -r -d '' f; do files+=("$f"); done < <(
  find "${DIRS[@]}" -type f \( -name '*.yml' -o -name '*.yaml' \) -print0 2>/dev/null
)
if [ ${#files[@]} -eq 0 ]; then
  echo "check-action-pins: no workflow/action YAML found under: ${DIRS[*]}" >&2
  exit 2
fi

bad=0
checked=0
for f in "${files[@]}"; do
  lineno=0
  while IFS= read -r line || [ -n "$line" ]; do
    lineno=$((lineno + 1))
    # `uses:` as a mapping key, optionally as the first key of a list item.
    [[ "$line" =~ ^[[:space:]]*(-[[:space:]]+)?uses:[[:space:]]*(.*)$ ]] || continue
    ref="${BASH_REMATCH[2]}"
    ref="${ref%%#*}"                       # drop a trailing comment
    ref="${ref//\"/}"; ref="${ref//\'/}"   # drop quotes
    ref="$(printf '%s' "$ref" | sed -e 's/[[:space:]]*$//')"
    checked=$((checked + 1))
    if [[ "$ref" == ./* ]]; then continue; fi
    if [[ "$ref" =~ ^docker://[^@[:space:]]+@sha256:[0-9a-f]{64}$ ]]; then continue; fi
    if [[ "$ref" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+@[0-9a-f]{40}$ ]]; then continue; fi
    echo "$f:$lineno: unpinned action ref: $ref"
    bad=$((bad + 1))
  done < "$f"
done

if [ "$bad" -gt 0 ]; then
  echo "check-action-pins: $bad unpinned ref(s) of $checked — pin each to a full commit SHA (keep the tag as a trailing comment)." >&2
  exit 1
fi
echo "check-action-pins: $checked uses: refs across ${#files[@]} file(s), all pinned."
