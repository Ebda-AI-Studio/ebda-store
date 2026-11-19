#!/usr/bin/env bash
# MERGE-QUEUE-1 (draft; nothing calls this until Ahmad keeps the Enterprise plan and the queue ruleset is enabled).
# The drain's final merge step when a merge queue is on: ENQUEUE the PR pinned to the head SHA the merge-gate verified
# (money stamp + AI review + creator checks already passed on THIS head), instead of `gh pr merge`.
#   MERGE_GATE_MERGE_CMD='bash scripts/ci/merge-queue-enqueue.sh "$repo" "$pr" "$sha"' bash scripts/ci/merge-gate.sh ...
# Pinning: expectedHeadOid makes GitHub REFUSE the enqueue when the head moved after the gate (same property as
# `gh pr merge --match-head-commit`). Exit 0 = queued (or already queued/merged); non-zero = refused, with GitHub's reason.
# MERGE_QUEUE_GH replaces `gh` (tests only).
set -euo pipefail
repo="${1:?usage: merge-queue-enqueue.sh <owner/repo> <pr> <head-sha>}"; pr="${2:?}"; sha="${3:?}"
GH="${MERGE_QUEUE_GH:-gh}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "merge-queue-enqueue: REFUSED: head sha must be 40 hex chars, got '$sha'" >&2; exit 1; }
[[ "$pr" =~ ^[0-9]+$ ]] || { echo "merge-queue-enqueue: REFUSED: pr must be a number" >&2; exit 1; }
id="$($GH pr view "$pr" --repo "$repo" --json id,headRefOid,state --jq 'select(.state=="OPEN" and .headRefOid=="'"$sha"'") | .id')" || id=""
[ -n "$id" ] || { echo "merge-queue-enqueue: REFUSED: PR $pr is not open at head $sha (moved or closed after the gate)" >&2; exit 1; }
out="$($GH api graphql -f query='mutation($id:ID!,$oid:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$oid}){mergeQueueEntry{position state}}}' -f id="$id" -f oid="$sha" 2>&1)" || {
  echo "merge-queue-enqueue: REFUSED by GitHub: $out" >&2; exit 1; }
echo "merge-queue-enqueue: PR $pr queued at $sha: $out"
