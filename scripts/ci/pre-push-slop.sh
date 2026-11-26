#!/usr/bin/env bash
# SLOP-PREPUSH-1: the slop guard CI runs as "Slop baselines" (.github/workflows/pr-quality.yml: `slop-guard.mjs --root pr --base-root base --merge-base-root mb`), run before the push, in CI form.
# Local command (same as the hook): bash scripts/ci/pre-push-slop.sh origin/main HEAD   Note: the guard counts a test-only import as NOT a use, so an export used only by a test fails here exactly as in CI.
# Three money PRs (#887, #891, #890, 2026-11-17) were pushed and failed that CI check on a new unused export, each costing a CI cycle and a voided money review.
# Usage: scripts/ci/pre-push-slop.sh <base-ref> [head-ref]   (the gate passes origin/main and HEAD)
# Runs ONLY when a .ts/.tsx file differs between the merge base and head. Exports the pushed head and the base's guard + baseline with `git archive`
# (about 1 s, 58 MB) so a dirty tree or untracked files cannot change the verdict, then runs the BASE's guard code against the head, exactly as CI does.
# Prints the guard's own messages (the same text CI gives) and exits 1 on any new violation. A missing base ref skips with a note (CI is the gate).
set -euo pipefail
# A pre-push hook runs with GIT_DIR (and friends) exported. The merge-base step below runs mutating git (update-ref) inside a throwaway clone; with GIT_DIR
# inherited it would write into THIS repo instead (it moved a worktree's HEAD and a shared ref on its first real push). Run in the cwd's own repo only.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_COMMON_DIR GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
BASE_REF="${1:?usage: pre-push-slop.sh <base-ref> [head-ref]}"; HEAD_REF="${2:-HEAD}"
git rev-parse -q --verify "$BASE_REF^{commit}" >/dev/null || { echo "! slop guard skipped: no $BASE_REF locally; CI runs it"; exit 0; }
MB="$(git merge-base "$BASE_REF" "$HEAD_REF" 2>/dev/null || true)"
[ -n "$MB" ] || { echo "! slop guard skipped: no merge base with $BASE_REF; CI runs it"; exit 0; }
if ! git diff --name-only "$MB" "$HEAD_REF" | grep -qE '\.(ts|tsx)$'; then echo "-> slop guard skipped: no .ts/.tsx change"; exit 0; fi
# physical path: the guard only runs main() when import.meta.url equals its argv[1], and macOS temp dirs (/var -> /private/var) differ by symlink
T="$(cd "$(mktemp -d)" && pwd -P)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/pr" "$T/base"
# the BASE's foundation.lock.json is part of that set: the guard trusts the vendored-folder exemption only while the PR's lock equals the base's (SLOP-VENDORED-1);
# without it every push judged the vendored exports as findings that CI (which has the base checkout) does not report.
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
export_ref "$BASE_REF" "$T/base" apps packages .github/pr-quality .pr-quality.json .pr-quality-baseline.json foundation.lock.json
[ -f "$T/base/.github/pr-quality/slop-guard.mjs" ] || { echo "! slop guard skipped: $BASE_REF has no .github/pr-quality/slop-guard.mjs; CI runs it"; exit 0; }
# CI form (.github/workflows/pr-quality.yml): the ratchet files as of the MERGE BASE are built by the base branch's merge-base-tree.sh, which needs a git
# checkout whose HEAD is the base tip and whose refs/pr/head is the PR head. A throwaway --shared --no-checkout clone provides exactly that without copying
# objects or files (and without touching this repo's refs: refs/pr/head is only set inside the clone).
MBARGS=()
if [ -f "$T/base/.github/pr-quality/merge-base-tree.sh" ]; then
  GB="$T/gitbase"
  git clone -q --shared --no-checkout "$(git rev-parse --show-toplevel)" "$GB" >/dev/null 2>&1 || true
  if [ -d "$GB/.git" ]; then
    git -C "$GB" update-ref --no-deref HEAD "$(git rev-parse "$BASE_REF^{commit}")"
    git -C "$GB" update-ref refs/pr/head "$(git rev-parse "$HEAD_REF^{commit}")"
    if bash "$T/base/.github/pr-quality/merge-base-tree.sh" "$GB" "$T/mb" >/dev/null 2>&1; then MBARGS=(--merge-base-root "$T/mb"); fi
  fi
  [ "${#MBARGS[@]}" -gt 0 ] || echo "! merge-base tree not built; judging against the base tip only (CI may allow slightly more)"
fi
GUARD_ARGS=(--root "$T/pr" --base-root "$T/base" "${MBARGS[@]}")
echo "-> slop guard, CI form: slop-guard.mjs ${GUARD_ARGS[*]//$T/<tmp>} (new violations vs $BASE_REF only)"
if node "$T/base/.github/pr-quality/slop-guard.mjs" "${GUARD_ARGS[@]}"; then exit 0; fi
echo "slop-guard: BLOCKED. This is the check CI's 'Slop baselines' runs; it would fail there too. Fix it or justify it inline with  pq-allow(<rule>): <reason>" >&2
exit 1
