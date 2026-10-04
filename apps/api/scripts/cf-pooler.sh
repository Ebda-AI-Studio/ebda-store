#!/usr/bin/env bash
# start|stop a local transaction-mode pgbouncer (dev only, fake credentials). pgbouncer refuses
# to run as root, so it runs as `postgres` when invoked as root.
set -euo pipefail
D=/tmp/ebda-api-pgbouncer
HERE="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$(command -v pgbouncer || echo /usr/sbin/pgbouncer)"
run() { if [ "$(id -u)" = 0 ]; then su postgres -c "$*"; else sh -c "$*"; fi; }
case "${1:-}" in
  start)
    mkdir -p "$D"
    cp "$HERE/pgbouncer/userlist.txt" "$D/userlist.txt"
    cp "$HERE/pgbouncer/pgbouncer.ini" "$D/pgbouncer.ini"
    [ "$(id -u)" = 0 ] && chown -R postgres "$D"
    if [ -f "$D/pgbouncer.pid" ] && kill -0 "$(cat "$D/pgbouncer.pid")" 2>/dev/null; then
      echo "pgbouncer already running"; exit 0
    fi
    run "$BIN -d $D/pgbouncer.ini"
    sleep 1; echo "pgbouncer up on 127.0.0.1:6433 (transaction mode, pool 8)" ;;
  stop)
    if [ -f "$D/pgbouncer.pid" ]; then kill "$(cat "$D/pgbouncer.pid")" && echo stopped; else echo "not running"; fi ;;
  *) echo "usage: $0 start|stop"; exit 2 ;;
esac
