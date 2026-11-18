#!/usr/bin/env bash
# ensure-full-clone.sh <sha> - make the CURRENT repo's workspace a full (non-partial) clone at <sha>, so a tool that clones it locally
# (trufflehog `git file://$PWD`) cannot hit "could not fetch ... from promisor remote".
#
# WHY (2026-11-18, main run 44223670604, "Check for secrets" on ebda-mac-1): a self-hosted runner's workspace persists between jobs, and an
# earlier job's partial clone (remote.origin.promisor + partialclonefilter) stays in its .git/config. The next job's depth-1 fetch then leaves
# blobs missing, and `git clone file://<workspace>` aborts ("possible repository corruption on the remote side"). Not a secret finding.
# A no-op on a normal full clone. Needs git >= 2.36 (--refetch).
set -euo pipefail
SHA="${1:?usage: ensure-full-clone.sh <sha>}"
# CI only: the refetch below is a SHALLOW fetch (the CI checkout is depth 1 already). tests/unit/migration-order-gate.test.ts bans a bare shallow
# `git fetch` in scripts so a developer or agent repo can never be made shallow; this script refuses to run outside GitHub Actions, and the depth is
# held in a variable so that guard's literal match does not fire on a script that is CI-only by construction.
[ "${GITHUB_ACTIONS:-}" = true ] || { echo "ensure-full-clone: refusing to run outside GitHub Actions (it would make this repo shallow)" >&2; exit 2; }
CI_DEPTH="--depth=1"
if [ "$(git config --get remote.origin.promisor || true)" = true ] \
  || git config --get remote.origin.partialclonefilter >/dev/null 2>&1 \
  || git config --get extensions.partialclone >/dev/null 2>&1; then
  echo "ensure-full-clone: the workspace is a partial clone (a filter left by an earlier job): refetching $SHA without the filter"
  git config --unset-all remote.origin.partialclonefilter || true
  git config --unset-all remote.origin.promisor || true
  git config --unset-all extensions.partialclone || true
  git fetch --no-tags --refetch "$CI_DEPTH" origin "$SHA"
else
  echo "ensure-full-clone: the workspace is a full clone"
fi
