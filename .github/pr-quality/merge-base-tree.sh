#!/usr/bin/env bash
# Builds the merge-base reference tree for the PR ratchets (slop-guard.mjs / capability-ratchet.mjs --merge-base-root).
#   merge-base-tree.sh <base-checkout> <out-dir>      expects refs/pr/head fetched in the base checkout; runs from the trusted base branch
# Writes into <out-dir>: the ratchet files as of merge-base(HEAD, refs/pr/head) (slop baseline, every eslint-suppressions.json, capabilities/baselines)
# and `.mb-touched`, the paths the PR changed since then (--no-renames: old and new path both listed).
# Writes NOTHING (so the guards compare against the base tip only) when there is no merge-base or it is more than MB_MAX_COMMITS (200) commits
# or MB_MAX_DAYS (7) days behind the tip: an old merge-base must not resurrect exemptions main has since removed.
set -euo pipefail
BASE="$1"; OUT="$2"
MAX_COMMITS="${MB_MAX_COMMITS:-200}"; MAX_DAYS="${MB_MAX_DAYS:-7}"
mkdir -p "$OUT"
git -C "$BASE" fetch --no-tags --unshallow origin 2>/dev/null || git -C "$BASE" fetch --no-tags origin 2>/dev/null || true
MB="$(git -C "$BASE" merge-base HEAD refs/pr/head 2>/dev/null || true)"
if [ -z "$MB" ]; then echo "::notice::no merge-base; comparing against the base tip"; exit 0; fi
BEHIND="$(git -C "$BASE" rev-list --count "$MB..HEAD")"
AGE=$(( $(git -C "$BASE" log -1 --format=%ct HEAD) - $(git -C "$BASE" log -1 --format=%ct "$MB") ))
if [ "$BEHIND" -gt "$MAX_COMMITS" ] || [ "$AGE" -gt $(( MAX_DAYS * 86400 )) ]; then
  echo "::notice::merge-base is $BEHIND commits / $((AGE / 86400)) days behind the tip (cap $MAX_COMMITS / $MAX_DAYS): comparing against the base tip"
  exit 0
fi
BP=".pr-quality-baseline.json"
if [ -f "$BASE/.pr-quality.json" ]; then
  BP="$(node -e "try{console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).baseline||'.pr-quality-baseline.json')}catch{console.log('.pr-quality-baseline.json')}" "$BASE/.pr-quality.json")"
fi
git -C "$BASE" ls-tree -r --name-only "$MB" | awk -v bp="$BP" '$0==bp || /(^|\/)eslint-suppressions\.json$/ || /^capabilities\/baselines\/.*\.json$/' > "$OUT/.files.tmp"
if [ -s "$OUT/.files.tmp" ]; then
  xargs git -C "$BASE" archive "$MB" -- < "$OUT/.files.tmp" | tar -x -C "$OUT"
fi
rm -f "$OUT/.files.tmp"
git -C "$BASE" diff --name-only --no-renames "$MB" refs/pr/head > "$OUT/.mb-touched"
