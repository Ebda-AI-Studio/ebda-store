#!/usr/bin/env bash
# Host-wide mutex for the HEAVY part of the pre-push gate: only ONE full unit suite runs on this Mac at a time.
#
# WHY (2026-10-25). Several agents push in parallel and each pre-push runs the whole vitest suite (~15 k tests,
# measured 105 concurrent vitest processes). Together with the Umbra CI VM they starved the host (16 GB RAM,
# swap 3 of 4 GB used) and the guest wedged on I/O. The gate is NEVER skipped; it queues.
#
# usage: scripts/ci/host-lock.sh <name> <command...>      lock dir: ${HOST_LOCK_DIR:-~/.claude/locks}/<name>.lock
# - waits (prints who holds it, every 30 s) up to HOST_LOCK_MAX_WAIT_S (default 3600); on timeout it FAILS (exit 75),
#   it does not run the command unlocked and does not skip it
# - a holder that died is detected (kill -0) and its lock reclaimed, so a killed push never wedges the queue
# - portable on purpose (mkdir is atomic everywhere): macOS has no flock(1)
set -uo pipefail
name="${1:?lock name}"; shift
[ "$#" -gt 0 ] || { echo "host-lock: no command" >&2; exit 64; }
dir="${HOST_LOCK_DIR:-$HOME/.claude/locks}"
mkdir -p "$dir"
lock="$dir/$name.lock"
max="${HOST_LOCK_MAX_WAIT_S:-3600}"
poll="${HOST_LOCK_POLL_S:-2}"
waited=0; next_msg=0

while ! mkdir "$lock" 2>/dev/null; do
  holder="$(cat "$lock/pid" 2>/dev/null || true)"
  if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
    echo "host-lock: holder pid $holder is gone; reclaiming $name" >&2
    rm -rf "$lock"; continue
  fi
  if [ -z "$holder" ] && [ -d "$lock" ] && [ -n "$(find "$lock" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then
    rm -rf "$lock"; continue   # created but never stamped: the holder died between mkdir and the pid write
  fi
  if [ "$waited" -ge "$next_msg" ]; then
    echo "-> pre-push: another full test run holds the host lock ($name, pid ${holder:-?}, in $(cat "$lock/cwd" 2>/dev/null || echo '?')); waiting ${waited}s. The gate is not skipped, it queues." >&2
    next_msg=$((waited + 30))
  fi
  if [ "$waited" -ge "$max" ]; then
    echo "host-lock: waited ${max}s for $name; refusing to run unlocked or skip. Re-run the push, or check pid ${holder:-?}." >&2
    exit 75
  fi
  sleep "$poll"; waited=$((waited + poll))
done

printf '%s\n' "$$" > "$lock/pid"; pwd > "$lock/cwd"
trap 'rm -rf "$lock"' EXIT
trap 'exit 130' INT TERM
[ "$waited" -gt 0 ] && echo "-> pre-push: host lock acquired after ${waited}s" >&2
"$@"
