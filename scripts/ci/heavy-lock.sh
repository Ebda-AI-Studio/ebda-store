#!/usr/bin/env bash
# heavy-lock.sh acquire|release — one heavy test job at a time on Ahmad's Mac (Ruling CI-MAC-RUNNER-1).
#
# The Mac's runners share one host: the test jobs bind FIXED ports (API 4000, web 3000/3001, workerd 8811-8813, the
# builder mock API) and a vitest/Playwright run takes most of the 16 GB. So a heavy job holds the SAME host-wide lock
# that ~/.claude/scripts/host-lock.sh uses for local suites (~/.claude/locks/heavy-test.lock, macOS lockf, owner line
# in <lock>.owner): CI and local heavy runs queue behind each other, never run side by side.
#
# acquire: a background holder takes the lock and keeps it until `release` removes its hold file. The runner kills a
#   job's leftover processes when the job ends, so a cancelled job never wedges the queue.
# Linux (GitHub-hosted, one VM per job): no-op.
set -euo pipefail
[ "$(uname -s)" = Darwin ] || exit 0
LOCK="${HEAVY_LOCK_FILE:-$HOME/.claude/locks/heavy-test.lock}"
HOLD="${RUNNER_TEMP:?}/heavy-lock.hold"
GOT="${RUNNER_TEMP}/heavy-lock.acquired"
MAX="${HEAVY_LOCK_MAX_WAIT_S:-3600}"
case "${1:-}" in
  acquire)
    mkdir -p "$(dirname "$LOCK")"; rm -f "$GOT"; touch "$HOLD"
    [ -r "$LOCK.owner" ] && echo "heavy lock owner now: $(cut -c1-160 "$LOCK.owner")"
    start=$SECONDS
    nohup lockf -k -t "$MAX" "$LOCK" sh -c '
      printf "%s %s ci %s %s/%s\n" "$$" "$(date +%FT%T)" "$GITHUB_REPOSITORY" "$GITHUB_JOB" "$RUNNER_NAME" > "$1.owner"
      touch "$2"
      while [ -f "$3" ]; do sleep 2; done' sh "$LOCK" "$GOT" "$HOLD" >/dev/null 2>&1 &
    while [ ! -f "$GOT" ]; do
      kill -0 $! 2>/dev/null || { echo "::error::heavy lock not acquired within ${MAX}s"; exit 75; }
      sleep 2
    done
    echo "heavy lock acquired after $((SECONDS - start))s"
    ;;
  release)
    rm -f "$HOLD" "$GOT"; echo "heavy lock released"
    ;;
  *) echo "usage: heavy-lock.sh acquire|release" >&2; exit 64 ;;
esac
