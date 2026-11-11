#!/usr/bin/env bash
# PREPUSH-5: pass cache for the pre-push scanner run. usage: prepush-scanner-cache.sh check|record <scanner files...>
# Key = git tree hash of HEAD + the scanner list. The scanners read the WORKING DIRECTORY, so the cache is read or
# written ONLY when `git status --porcelain` is empty (no uncommitted or untracked files); a dirty tree always runs.
# check: exit 0 = hit (skip the run), 1 = miss/dirty. record: writes a pass marker only on a clean tree. PREPUSH_CACHE_DIR overrides.
set -uo pipefail
mode="${1:-}"; shift || true
dir="${PREPUSH_CACHE_DIR:-$HOME/.cache/ebda-prepush}"
[ -z "$(git status --porcelain 2>/dev/null)" ] || exit 1
key=$( { git rev-parse 'HEAD^{tree}'; printf '%s\n' "$@"; } | shasum -a 256 | cut -c1-40) || exit 1
f="$dir/scanners-$key.ok"
case "$mode" in
  check) [ -f "$f" ] ;;
  record) mkdir -p "$dir" && : > "$f" && { find "$dir" -name 'scanners-*.ok' -mtime +7 -delete 2>/dev/null || true; } ;;
  *) echo "usage: $0 check|record <files...>" >&2; exit 64 ;;
esac
