#!/usr/bin/env bash
# List upstream (FWB) commits that touched paths Ebda shares with it, since the
# last sync marker in .twin-sync. Read-only toward upstream: only `git fetch`;
# never pushes. Shared paths are documented in docs/TWIN-PATHS.md.
#
# Usage:
#   scripts/twin-diff.sh [since-ref]   commits on upstream/main touching shared paths
#                                      since <since-ref> (default: the sha in .twin-sync)
#   scripts/twin-diff.sh --mark <sha>  record <sha> as the new sync point
#
# Env: UPSTREAM_REMOTE (default: upstream), UPSTREAM_BRANCH (default: main)
set -euo pipefail

REMOTE="${UPSTREAM_REMOTE:-upstream}"
BRANCH="${UPSTREAM_BRANCH:-main}"
ROOT="$(git rev-parse --show-toplevel)"
MARKER="$ROOT/.twin-sync"

# Keep in step with the "Shared (worth syncing)" table in docs/TWIN-PATHS.md.
SHARED_PATHS=(
  apps/api/src/middleware
  apps/api/src/lib
  apps/api/src/services
  packages/database
  packages/ui
  apps/web/src/templates
  apps/web/src/lib
  apps/web/middleware.ts
  apps/admin/src/components
  apps/admin/src/lib
  packages/shared/src
)

usage() {
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
}

case "${1:-}" in
  -h | --help)
    usage
    exit 0
    ;;
  --mark)
    sha="${2:-}"
    if [ -z "$sha" ]; then
      echo "twin-diff: --mark needs a sha" >&2
      exit 2
    fi
    full="$(git rev-parse --verify --quiet "${sha}^{commit}")" || {
      echo "twin-diff: '$sha' is not a commit in this repo (fetch $REMOTE first)" >&2
      exit 2
    }
    printf '%s\n' "$full" >"$MARKER"
    echo "twin-diff: sync marker set to $full"
    exit 0
    ;;
esac

since="${1:-}"
if [ -z "$since" ]; then
  if [ ! -f "$MARKER" ]; then
    echo "twin-diff: no .twin-sync marker and no since-ref given" >&2
    exit 2
  fi
  since="$(tr -d '[:space:]' <"$MARKER")"
fi

if ! git remote get-url "$REMOTE" >/dev/null 2>&1; then
  echo "twin-diff: remote '$REMOTE' is not configured" >&2
  exit 2
fi

# Fetch only; this script has no push path.
git fetch --quiet "$REMOTE" "$BRANCH"
tip="$(git rev-parse --verify "refs/remotes/$REMOTE/$BRANCH")"

if ! git rev-parse --verify --quiet "${since}^{commit}" >/dev/null; then
  echo "twin-diff: since-ref '$since' not found" >&2
  exit 2
fi

echo "upstream $REMOTE/$BRANCH @ ${tip:0:12}, since ${since:0:12}"
echo "shared paths: ${SHARED_PATHS[*]}"
echo

count="$(git rev-list --count "$since..$tip" -- "${SHARED_PATHS[@]}")"
if [ "$count" -eq 0 ]; then
  echo "no upstream commits touch shared paths since the marker."
  exit 0
fi

echo "$count upstream commit(s) touching shared paths (oldest first):"
echo
git log --reverse --no-merges --date=short \
  --format='%h %ad %an  %s' "$since..$tip" -- "${SHARED_PATHS[@]}"
echo
echo "files changed:"
git diff --stat "$since..$tip" -- "${SHARED_PATHS[@]}" | tail -n 40
echo
echo "after porting, record the reviewed point:  scripts/twin-diff.sh --mark ${tip:0:12}"
