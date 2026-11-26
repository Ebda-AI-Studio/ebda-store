#!/usr/bin/env bash
# shard-lines.sh SHARD SHARDS: read lines on stdin, print the ones that belong to shard SHARD of SHARDS (1-based).
# Line N (1-based) goes to shard ((N-1) mod SHARDS) + 1, so the shards are disjoint, together complete, and stable for a given input.
# Used to split the serial planner lane of the integration tier (scripts/ci/planner-lane.sh list) across the CI shards.
set -euo pipefail
shard="${1:?usage: shard-lines.sh SHARD SHARDS}"
shards="${2:?usage: shard-lines.sh SHARD SHARDS}"
case "$shard$shards" in *[!0-9]*) echo "shard-lines: SHARD and SHARDS must be integers" >&2; exit 64;; esac
{ [ "$shard" -ge 1 ] && [ "$shard" -le "$shards" ]; } || { echo "shard-lines: SHARD must be in 1..SHARDS" >&2; exit 64; }
awk -v s="$shard" -v n="$shards" 'NF { i++; if (((i - 1) % n) + 1 == s) print }'
