#!/usr/bin/env bash
# SLOP-PREPUSH-1: the slop guard CI runs as "Slop baselines" (.github/workflows/pr-quality.yml: `slop-guard.mjs --root pr --base-root base`), run before the push.
# Three money PRs (#887, #891, #890, 2026-11-17) were pushed and failed that CI check on a new unused export, each costing a CI cycle and a voided money review.
# Usage: scripts/ci/pre-push-slop.sh <base-ref> [head-ref]   (the gate passes origin/main and HEAD)
# Runs ONLY when a .ts/.tsx file differs between the merge base and head. Exports the pushed head and the base's guard + baseline with `git archive`
# (about 1 s, 58 MB) so a dirty tree or untracked files cannot change the verdict, then runs the BASE's guard code against the head, exactly as CI does.
# Prints the guard's own messages (the same text CI gives) and exits 1 on any new violation. A missing base ref skips with a note (CI is the gate).
set -euo pipefail
BASE_REF="${1:?usage: pre-push-slop.sh <base-ref> [head-ref]}"; HEAD_REF="${2:-HEAD}"
git rev-parse -q --verify "$BASE_REF^{commit}" >/dev/null || { echo "! slop guard skipped: no $BASE_REF locally; CI runs it"; exit 0; }
MB="$(git merge-base "$BASE_REF" "$HEAD_REF" 2>/dev/null || true)"
[ -n "$MB" ] || { echo "! slop guard skipped: no merge base with $BASE_REF; CI runs it"; exit 0; }
if ! git diff --name-only "$MB" "$HEAD_REF" | grep -qE '\.(ts|tsx)$'; then echo "-> slop guard skipped: no .ts/.tsx change"; exit 0; fi
# physical path: the guard only runs main() when import.meta.url equals its argv[1], and macOS temp dirs (/var -> /private/var) differ by symlink
T="$(cd "$(mktemp -d)" && pwd -P)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/pr" "$T/base"
# the files the guard reads: code under the configured roots, its config + baseline, the vendored-folder proof, per-root eslint suppressions (inside the roots).
# Only paths that exist at that ref are archived (git archive aborts on a missing pathspec).
export_ref() { # <ref> <dest> <path>...
  local ref="$1" dest="$2" p; shift 2
  local present=()
  while IFS= read -r p; do [ -n "$p" ] && present+=("$p"); done < <(git ls-tree --name-only "$ref" -- "$@")
  [ "${#present[@]}" -gt 0 ] || return 0
  git archive "$ref" "${present[@]}" | tar -x -C "$dest"
}
export_ref "$HEAD_REF" "$T/pr" apps packages .pr-quality.json .pr-quality-baseline.json foundation.lock.json tests/unit/foundation-parity.test.ts
export_ref "$BASE_REF" "$T/base" apps packages .github/pr-quality .pr-quality.json .pr-quality-baseline.json
[ -f "$T/base/.github/pr-quality/slop-guard.mjs" ] || { echo "! slop guard skipped: $BASE_REF has no .github/pr-quality/slop-guard.mjs; CI runs it"; exit 0; }
echo "-> slop guard (same check as CI 'Slop baselines', new violations vs $BASE_REF only)"
if node "$T/base/.github/pr-quality/slop-guard.mjs" --root "$T/pr" --base-root "$T/base"; then exit 0; fi
echo "slop-guard: BLOCKED. This is the check CI's 'Slop baselines' runs; it would fail there too. Fix it or justify it inline with  pq-allow(<rule>): <reason>" >&2
exit 1
