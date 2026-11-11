#!/usr/bin/env bash
# PREPUSH-5: pass cache for the pre-push scanner run. usage: prepush-scanner-cache.sh check|record <scanner files...>
# Key = git tree hash of HEAD + the scanner list. The scanners read the WORKING DIRECTORY, so the cache is read or
# written ONLY when `git status --porcelain` is empty (no uncommitted or untracked files); a dirty tree always runs.
# Scanners also read GITIGNORED inputs (measured: they import built packages/*/dist and walk generated dirs), so the key
# also folds in a size+mtime fingerprint of every present ignored file except node_modules and .husky/_.
# check: exit 0 = hit (skip the run), 1 = miss/dirty. record: writes a pass marker only on a clean tree. PREPUSH_CACHE_DIR overrides.
set -uo pipefail
mode="${1:-}"; shift || true
dir="${PREPUSH_CACHE_DIR:-$HOME/.cache/ebda-prepush}"
[ -z "$(git status --porcelain 2>/dev/null)" ] || exit 1
if [ "$(uname)" = Darwin ]; then st() { xargs -0 stat -f '%N %z %m'; }; else st() { xargs -0 stat -c '%n %s %Y'; }; fi
ignored_fp() {
  git ls-files -o -i --exclude-standard --directory | { grep -vE '(^|/)node_modules/$|^\.husky/_/' || true; } | LC_ALL=C sort | while IFS= read -r e; do
    if [ -d "$e" ]; then find "$e" -type f -not -path '*/node_modules/*' -print0; else printf '%s\0' "$e"; fi
  done | { st 2>/dev/null || true; } | LC_ALL=C sort
}
key=$( { git rev-parse 'HEAD^{tree}'; printf '%s\n' "$@"; echo '--ignored--'; ignored_fp; } | shasum -a 256 | cut -c1-40) || exit 1
f="$dir/scanners-$key.ok"
case "$mode" in
  check) [ -f "$f" ] ;;
  record) mkdir -p "$dir" && : > "$f" && { find "$dir" -name 'scanners-*.ok' -mtime +7 -delete 2>/dev/null || true; } ;;
  *) echo "usage: $0 check|record <files...>" >&2; exit 64 ;;
esac
