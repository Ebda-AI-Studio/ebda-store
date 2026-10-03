#!/usr/bin/env bash
# start|stop pgbouncer (must run as non-root => runs as postgres). Dev only.
set -euo pipefail
D=/tmp/ebda-pgbouncer
HERE="$(cd "$(dirname "$0")/.." && pwd)"
case "${1:-}" in
  start)
    mkdir -p $D && cp "$HERE/pgbouncer/userlist.txt" $D/userlist.txt && chown -R postgres $D
    cp "$HERE/pgbouncer/pgbouncer.ini" $D/pgbouncer.ini && chown postgres $D/pgbouncer.ini
    [ -f $D/pgbouncer.pid ] && kill -0 "$(cat $D/pgbouncer.pid)" 2>/dev/null && { echo "already running"; exit 0; }
    su postgres -c "/usr/sbin/pgbouncer -d $D/pgbouncer.ini"
    sleep 1; echo "pgbouncer up on 127.0.0.1:6432" ;;
  stop) [ -f $D/pgbouncer.pid ] && kill "$(cat $D/pgbouncer.pid)" && echo stopped || echo "not running" ;;
  *) echo "usage: $0 start|stop"; exit 2 ;;
esac
