#!/usr/bin/env bash
# PREPUSH-5: bounded-concurrency semaphore for the pre-push SCANNER run. N numbered slot files (default 4); the
# command runs while holding ONE slot, so at most N pushes run scanners at once, host-wide, and they NEVER touch the
# single heavy-test lock that every agent's own vitest runs queue on. Never skips: waits up to
# PREPUSH_SLOT_MAX_WAIT_S (default 900), then FAILS (exit 75), it never runs the command outside a slot.
# The kernel drops a slot when its holder dies (lockf/flock), so a killed push never wedges a slot.
# usage: scripts/ci/prepush-slot.sh <command...>   PREPUSH_SLOT_DIR / PREPUSH_SLOTS override (tests)
set -uo pipefail
[ "$#" -gt 0 ] || { echo "prepush-slot: no command" >&2; exit 64; }
dir="${PREPUSH_SLOT_DIR:-$HOME/.claude/locks}"
n="${PREPUSH_SLOTS:-4}"
max="${PREPUSH_SLOT_MAX_WAIT_S:-900}"
mkdir -p "$dir"
marker=$(mktemp "${TMPDIR:-/tmp}/prepush-slot.XXXXXX")
trap 'rm -f "$marker"' EXIT
rm -f "$marker"

try_slot() { # $1 = slot file; the marker proves the command started (75 alone is ambiguous)
  if command -v lockf >/dev/null 2>&1; then
    lockf -k -t 0 "$1" sh -c 'echo started > "$0"; shift; exec "$@"' "$marker" "$@"
  else
    touch "$1"
    flock -n -E 75 "$1" sh -c 'echo started > "$0"; shift; exec "$@"' "$marker" "$@"
  fi
}

start=$SECONDS
announced=0
while :; do
  for i in $(seq 1 "$n"); do
    try_slot "$dir/prepush-slot-$i.lock" "$@"; rc=$?
    if [ -e "$marker" ]; then exit "$rc"; fi
  done
  [ "$announced" -eq 1 ] || { echo "-> pre-push: all $n scanner slots busy; this push queues (never skipped)." >&2; announced=1; }
  if [ $((SECONDS - start)) -ge "$max" ]; then
    echo "prepush-slot: waited ${max}s for a scanner slot; refusing to run outside a slot or skip." >&2
    exit 75
  fi
  sleep 2
done
