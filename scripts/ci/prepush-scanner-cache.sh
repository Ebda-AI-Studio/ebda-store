#!/usr/bin/env bash
# PREPUSH-5: pass cache for the pre-push scanner run. usage: prepush-scanner-cache.sh check|record <scanner files...>
# Key = git tree hash of HEAD + the scanner list. The scanners read the WORKING DIRECTORY, so the cache is read or
# written ONLY when `git status --porcelain` is empty (no uncommitted or untracked files); a dirty tree always runs.
# Scanners also read GITIGNORED inputs (measured: they import built packages/*/dist and walk generated dirs), so the key
# also folds in a fingerprint of every present ignored file except node_modules and .husky/_: CONTENT hash for files
# under 64 KiB (prisma-meta.json, .env*), size+mtime for larger ones (dist trees).
# check: exit 0 = hit (skip the run), 1 = miss/dirty. record: writes a pass marker only on a clean tree. PREPUSH_CACHE_DIR overrides.
set -uo pipefail
mode="${1:-}"; shift || true
dir="${PREPUSH_CACHE_DIR:-$HOME/.cache/ebda-prepush}"
[ -z "$(git status --porcelain 2>/dev/null)" ] || exit 1
if [ "$(uname)" = Darwin ]; then st() { xargs -0 stat -f '%N %z %m'; }; else st() { xargs -0 stat -c '%n %s %Y'; }; fi
ignored_fp() {
  git ls-files -o -i --exclude-standard --directory | { grep -vE '(^|/)node_modules/$|^\.husky/_/' || true; } | LC_ALL=C sort | while IFS= read -r e; do
    if [ -d "$e" ]; then
      find "$e" -type f -size -64k -not -path '*/node_modules/*' -print0 | { xargs -0 shasum -a 256 2>/dev/null || true; }
      find "$e" -type f -size +63k -not -path '*/node_modules/*' -print0 | { st 2>/dev/null || true; }
    else
      printf '%s\0' "$e" | { xargs -0 shasum -a 256 2>/dev/null || true; }
    fi
  done | LC_ALL=C sort
}
compute_key() { { git rev-parse 'HEAD^{tree}'; printf '%s\n' "$@"; echo '--ignored--'; ignored_fp; } | shasum -a 256 | cut -c1-40; }
if [ -n "${PREPUSH_CACHE_KEY:-}" ]; then key="$PREPUSH_CACHE_KEY"; else key=$(compute_key "$@") || exit 1; fi
f="$dir/scanners-$key.ok"
case "$mode" in
  key) echo "$key" ;;
  check) [ -f "$f" ] ;;
  record) mkdir -p "$dir" && : > "$f" && { find "$dir" -name 'scanners-*.ok' -mtime +7 -delete 2>/dev/null || true; } ;;
  *) echo "usage: $0 key|check|record <files...>" >&2; exit 64 ;;
esac
