#!/usr/bin/env bash
# Refuse a database dump that cannot restore anything (the 2026-09-17 lesson: a present, recent, correctly named file that was
# valid gzip around ZERO bytes). Checks: the file exists and is larger than MIN_BYTES, pg_restore can read its table of contents,
# and it holds data for the tables every Ebda store has (stores, orders, users) plus a plausible number of TABLE DATA entries.
# usage: verify-db-dump.sh <file.dump>        env: MIN_BYTES (default 200000), MIN_TABLES (default 60)
set -euo pipefail
f="${1:?usage: verify-db-dump.sh <file.dump>}"
min_bytes="${MIN_BYTES:-200000}"; min_tables="${MIN_TABLES:-60}"
[ -s "$f" ] || { echo "verify-db-dump: $f is missing or empty" >&2; exit 1; }
size="$(wc -c < "$f" | tr -d ' ')"
[ "$size" -ge "$min_bytes" ] || { echo "verify-db-dump: $f is only $size bytes (< $min_bytes) - refusing" >&2; exit 1; }
restore="${PG_RESTORE:-pg_restore}"
toc="$("$restore" --list "$f")" || { echo "verify-db-dump: pg_restore cannot read $f" >&2; exit 1; }
n="$(printf '%s\n' "$toc" | grep -c ' TABLE DATA ' || true)"
[ "$n" -ge "$min_tables" ] || { echo "verify-db-dump: only $n TABLE DATA entries (< $min_tables) - refusing" >&2; exit 1; }
for t in stores orders users; do
  printf '%s\n' "$toc" | grep -q " TABLE DATA public $t " || { echo "verify-db-dump: no data entry for table $t - refusing" >&2; exit 1; }
done
echo "verify-db-dump: ok ($size bytes, $n tables with data)"
