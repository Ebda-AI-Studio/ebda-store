#!/usr/bin/env bash
# scan-clone.sh <sha> <dest> [depth] - a PRIVATE, complete, shallow clone of <sha> in <dest> for the secret scanner to read, never the CI workspace.
#
# WHY (2026-11-18, main runs 44223670604 and 44268095513, "Check for secrets" on ebda-mac-1): trufflehog clones the workspace with
# `git clone file://$PWD`. A persistent runner workspace carries state from earlier jobs (the deploy `plan` jobs fetch with
# `filter: blob:none`): remote.origin.promisor/partialclonefilter keys AND `.git/objects/pack/*.promisor` marker packs. Removing the config keys was
# not enough (#950 ran "the workspace is a full clone" and the clone still failed "could not fetch ... from promisor remote"): the marker packs alone make
# git lazy-fetch objects the shallow history never had. Detecting every shape of that state is a losing game, so the scanner no longer touches the workspace:
# a fresh `git init` in <dest>, one plain (unfiltered) shallow fetch of the commit from the same origin with the checkout's own auth header.
# CI only: it refuses outside GitHub Actions (tests/unit/migration-order-gate.test.ts allow-lists this script for its shallow fetch for that reason).
set -euo pipefail
[ "${GITHUB_ACTIONS:-}" = true ] || { echo "scan-clone: refusing to run outside GitHub Actions (a shallow fetch would make a developer repo shallow)" >&2; exit 2; }
SHA="${1:?usage: scan-clone.sh <sha> <dest> [depth]}"; DEST="${2:?usage: scan-clone.sh <sha> <dest> [depth]}"; DEPTH="${3:-21}"
case "$DEPTH" in ''|*[!0-9]*) echo "scan-clone: depth must be a whole number" >&2; exit 2 ;; esac
URL="$(git remote get-url origin)"
# the checkout persists its credential as an extraheader in the workspace config; pass it by environment (never argv, never printed)
HDR="$(git config --get-all http.https://github.com/.extraheader 2>/dev/null | head -1 || true)"
rm -rf "$DEST"; git init -q "$DEST"
git -C "$DEST" remote add origin "$URL"
if [ -n "$HDR" ]; then export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.https://github.com/.extraheader GIT_CONFIG_VALUE_0="$HDR"; fi
git -C "$DEST" fetch -q --no-tags --depth="$DEPTH" origin "$SHA"
git -C "$DEST" update-ref refs/heads/scan FETCH_HEAD
git -C "$DEST" symbolic-ref HEAD refs/heads/scan
echo "scan-clone: $(git -C "$DEST" rev-parse --short HEAD) in a fresh clone ($(git -C "$DEST" rev-list --count refs/heads/scan) commits)"
