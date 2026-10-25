#!/usr/bin/env bash
# Host-wide mutex for the HEAVY part of the pre-push gate: only ONE full unit suite runs on this Mac at a time.
#
# WHY (2026-10-25). Several agents push in parallel and each pre-push runs the whole vitest suite (~15 k tests,
# measured 105 concurrent vitest processes). Together with the Umbra CI VM they starved the host (16 GB RAM,
# swap 3 of 4 GB used) and the guest wedged on I/O. The gate is NEVER skipped; it queues.
#
# ONE lock for everything heavy: ~/.claude/locks/heavy-test.lock, taken with macOS lockf(1) (no flock(1) on macOS).
# Agents and humans use the same file by hand:   lockf -k ~/.claude/locks/heavy-test.lock <command...>
# so the manual rule and this hook exclude each other. The kernel drops the lock when the holder dies, so a killed
# push never wedges the queue. Linux (CI, tests) falls back to flock(1) on the same file path.
#
# usage: scripts/ci/host-lock.sh <command...>        HOST_LOCK_FILE overrides the path (tests only)
# - prints who is ahead of us (when we have to wait) and keeps waiting up to HOST_LOCK_MAX_WAIT_S (default 3600)
# - on timeout it FAILS (exit 75); it never runs the command unlocked and never skips it
set -uo pipefail
[ "$#" -gt 0 ] || { echo "host-lock: no command" >&2; exit 64; }
file="${HOST_LOCK_FILE:-$HOME/.claude/locks/heavy-test.lock}"
max="${HOST_LOCK_MAX_WAIT_S:-3600}"
mkdir -p "$(dirname "$file")"

if command -v lockf >/dev/null 2>&1; then
  try() { lockf -k -t 0 "$file" true; }                     # 75 = busy
  run() { lockf -k -t "$max" "$file" "$@"; }                # 75 = timed out
elif command -v flock >/dev/null 2>&1; then
  touch "$file"
  try() { flock -n -E 75 "$file" true; }
  run() { flock -w "$max" -E 75 "$file" "$@"; }
else
  echo "host-lock: neither lockf nor flock is available; refusing to run the heavy gate unlocked" >&2
  exit 75
fi

if ! try; then
  echo "-> pre-push: another heavy test run holds ~/.claude/locks/heavy-test.lock; this one queues (the gate is not skipped)." >&2
  start=$SECONDS
  run "$@"; rc=$?
  if [ "$rc" -eq 75 ] && [ $((SECONDS - start)) -ge "$max" ]; then
    echo "host-lock: waited ${max}s for the heavy-test lock; refusing to run unlocked or skip." >&2
  fi
  exit "$rc"
fi
run "$@"
