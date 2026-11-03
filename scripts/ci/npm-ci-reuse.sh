#!/usr/bin/env bash
# npm-ci-reuse.sh — Ruling CI-NODE-MODULES-1.
# Hosted (EBDA_RUNS_ON empty): exactly `npm ci`. Self-hosted: restore node_modules from a runner-local store.
#   key   = sha256(package-lock.json + node major + arch)
#   store = ${EBDA_NM_STORE:-$RUNNER_TOOL_CACHE/../ebda-node-modules}/<key>/  (pristine trees, saved BEFORE any generate step)
# Restore = hardlink copy (cp -al), except the dirs install/generate steps WRITE into (prisma engines+client, caches),
# which are real copies so no job can mutate the store or a sibling job's tree. A failed restore or `npm ls` falls back to `npm ci`.
set -uo pipefail
if [ -z "${EBDA_RUNS_ON:-}" ]; then exec npm ci; fi

KEEP="${EBDA_NM_KEEP:-2}"   # 2, not 3: ~2.4 GB/key; the Umbra VM has 37 GB free and the floor is 30 GB
STORE="${EBDA_NM_STORE:-${RUNNER_TOOL_CACHE:-$HOME/_tool}/../ebda-node-modules}"
MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
KEY="$( { cat package-lock.json; echo "node$MAJOR"; uname -m; } | sha256sum | cut -c1-24)"
DIR="$STORE/$KEY"
# Dirs written to after install (prisma postinstall/generate, tool caches): copied, never hardlinked.
MUTABLE=(.prisma @prisma/client @prisma/engines prisma .cache .vite .vite-temp)
mkdir -p "$STORE"

nm_dirs() { # relative node_modules dirs: root + workspaces
  local d; if [ -d node_modules ]; then echo node_modules; fi
  for d in apps/*/node_modules packages/*/node_modules; do [ -d "$d" ] && echo "$d"; done
  return 0
}

unlink_mutable() { # replace hardlinked mutable dirs by real copies
  local nm m
  for nm in "$@"; do for m in "${MUTABLE[@]}"; do
    if [ -e "$nm/$m" ]; then
      rm -rf "$nm/$m.cpy" && cp -a "$nm/$m" "$nm/$m.cpy" && rm -rf "$nm/$m" && mv "$nm/$m.cpy" "$nm/$m" || return 1
    fi
  done; done
}

restore() {
  [ -f "$DIR/.complete" ] || return 1
  local nm list=()
  while IFS= read -r nm; do list+=("$nm"); done < "$DIR/.dirs"
  [ ${#list[@]} -gt 0 ] || return 1
  for nm in "${list[@]}"; do
    rm -rf "$nm" && mkdir -p "$(dirname "$nm")" && cp -al "$DIR/tree/$nm" "$nm" || return 1
  done
  unlink_mutable "${list[@]}" || return 1
  npm ls --depth=0 --workspaces --include-workspace-root >/dev/null 2>&1 || { echo "npm ls failed after restore"; return 1; }
}

if restore; then
  touch "$DIR"; echo "node_modules restored from store key=$KEY (skipped npm ci)"; exit 0
fi
[ -d "$DIR" ] && { echo "store key=$KEY unusable, discarding"; rm -rf "$DIR"; }
echo "node_modules store miss key=$KEY: npm ci"
nm_dirs | xargs -r rm -rf
npm ci || exit $?

# Save pristine tree (now: before db:generate) atomically; failure to save never fails the job.
save() {
  local nm; TMP="$STORE/.tmp-$KEY-$$"
  rm -rf "$TMP"; mkdir -p "$TMP/tree" || return 1
  for nm in $(nm_dirs); do
    mkdir -p "$TMP/tree/$(dirname "$nm")" && cp -a "$nm" "$TMP/tree/$nm" || return 1
  done
  nm_dirs > "$TMP/.dirs" && touch "$TMP/.complete" || return 1
  if [ -d "$DIR" ]; then rm -rf "$TMP"; else mv "$TMP" "$DIR"; fi
}
save || { echo "store save failed (non-fatal)"; rm -rf "$TMP"; }
# Keep the newest $KEEP keys; drop stale tmp dirs.
find "$STORE" -maxdepth 1 -name '.tmp-*' -mmin +60 -exec rm -rf {} + 2>/dev/null
ls -1dt "$STORE"/*/ 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -rf
du -sh "$DIR" 2>/dev/null | sed 's/^/store size: /'
exit 0
