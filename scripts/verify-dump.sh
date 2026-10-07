#!/usr/bin/env bash
# Assert that a gzipped pg_dump is a RESTORABLE backup — not merely a file that exists.
#
# ## Why a size check is not a backup check
#
# On 2026-08-02 the Force Media CRM production database was wiped, and the
# nightly backup archived 30 consecutive SCHEMA-ONLY dumps — ~3.5KB each, far
# above any sane byte floor — reporting success every single night. The DR that
# was supposed to make the wipe survivable had been backing up an empty database
# for five weeks, silently. A byte floor cannot tell "the whole catalogue" from
# "the table definitions and nothing in them".
#
# The mirror failure is the one this repo produced locally: 6 of 193 archives in
# ~/Desktop/projects/_backups/force-website-builder/ are valid gzip files
# containing ZERO bytes, written when pg_dump aborted and only `gzip` was left to
# decide the pipeline's fate. The file is present, recent and correctly named. It
# restores nothing.
#
# So this script asserts the PLAINTEXT side, before encryption makes the artifact
# permanently un-inspectable, and it counts DATA ROWS rather than bytes:
#
#   a. gzip integrity         — `gzip -t`; catches truncated/corrupt streams.
#   b. decompressed floor     — catches the zero-byte and near-empty cases.
#   c. pg_dump header         — catches "something else entirely" (an error page,
#                               an HTML 502 from a proxy, a partial write).
#   d. tables >= 1            — a dump defining no table is not a backup of this
#                               database, whatever it is.
#   e. rows >= tables         — the CRM assertion. Any real database has more
#                               data rows than it has tables. Compare against the
#                               TABLE COUNT, never against zero: the CRM dump
#                               that hid a total data loss was not empty, it held
#                               exactly one bookkeeping row, so `rows == 0` would
#                               have sailed straight past it.
#
# (d) is deliberately stricter than the reference implementation in
# ~/.claude/scripts/backup-all-neon.sh. There, a dump with zero tables AND zero
# rows satisfies `rows < tables` as `0 < 0` = false and passes the content gate —
# the both-sides-absent hole. Its byte floor happens to catch that case first;
# here it is closed explicitly rather than left to a second check's luck.
#
# Prints COUNTS ONLY. It never echoes dump contents — the dump is customer PII.
#
# Usage:  bash scripts/verify-dump.sh <dump.sql.gz>
#         source scripts/verify-dump.sh && verify_dump <dump.sql.gz>
# Env:    DUMP_MIN_BYTES  decompressed floor in bytes (default 1024)
# Exit:   0 = plausible, restorable backup
#         1 = NOT a valid backup (reason on stderr)
#         2 = usage error

set -uo pipefail

# Decompressed floor. A real Ebda dump is ~1.4MB gzipped / tens of MB plain, and
# even a bare schema is tens of KB, so 1KB sits far below anything legitimate and
# far above the failures it must catch (0 bytes, a truncated first block, a short
# error string). It is deliberately NOT tuned close to the real dump size: the row
# assertion below is the gate that has teeth, and a tight byte floor would only
# add false failures as the database grows or shrinks.
VERIFY_DUMP_MIN_BYTES_DEFAULT=1024

verify_dump() {
  local gz="${1:-}"
  local min_bytes="${DUMP_MIN_BYTES:-$VERIFY_DUMP_MIN_BYTES_DEFAULT}"

  if [ -z "$gz" ] || [ ! -f "$gz" ]; then
    echo "verify-dump: FAIL — no such dump file: ${gz:-<none>}" >&2
    return 1
  fi

  # (a) gzip integrity. A dump killed mid-stream still leaves a file behind.
  if ! gzip -t "$gz" 2>/dev/null; then
    echo "verify-dump: FAIL — not a valid gzip stream (truncated or corrupt): $gz" >&2
    return 1
  fi

  # Decompress ONCE to a temp file and run every remaining check over it. Piping
  # `gzip -dc` into `head`/`grep -q` would let those exit early, SIGPIPE the
  # decompressor, and — under `pipefail` — fail the check for a reason that has
  # nothing to do with the dump.
  local plain
  plain="$(mktemp)" || {
    echo "verify-dump: FAIL — could not create a temp file to inspect the dump" >&2
    return 1
  }
  if ! gzip -dc "$gz" >"$plain" 2>/dev/null; then
    rm -f "$plain"
    echo "verify-dump: FAIL — could not decompress: $gz" >&2
    return 1
  fi

  local bytes
  bytes="$(wc -c <"$plain" | tr -d ' ')"

  # (c) (d) (e) in a single awk pass. In pg_dump's plain format each table's data
  # sits between a "COPY ... FROM stdin;" line and a lone "\." terminator.
  # INSERT-format dumps (--inserts / --column-inserts) carry their rows as
  # statements instead, so count those too — otherwise a flag change elsewhere
  # would turn a perfectly good backup into a hard failure here.
  local counts hdr tables rows
  counts="$(
    awk '
      NR <= 20 && /^-- PostgreSQL database dump/ { hdr = 1 }
      /^CREATE TABLE /                           { tables++ }
      /^COPY .* FROM stdin;/                     { inblk = 1; next }
      inblk && /^\\\.$/                          { inblk = 0; next }
      inblk                                      { rows++; next }
      /^INSERT INTO /                            { rows++ }
      END                                        { printf "%d %d %d", hdr + 0, tables + 0, rows + 0 }
    ' "$plain"
  )"
  rm -f "$plain"
  read -r hdr tables rows <<<"$counts"

  if [ "${bytes:-0}" -lt "$min_bytes" ]; then
    echo "verify-dump: FAIL — decompresses to ${bytes} bytes (floor ${min_bytes}). An empty or truncated dump cannot restore." >&2
    return 1
  fi

  if [ "${hdr:-0}" -ne 1 ]; then
    echo "verify-dump: FAIL — no '-- PostgreSQL database dump' header. This is not a pg_dump; something else was captured." >&2
    return 1
  fi

  if [ "${tables:-0}" -lt 1 ]; then
    echo "verify-dump: FAIL — 0 CREATE TABLE statements. A dump that defines no table is not a backup of this database." >&2
    return 1
  fi

  if [ "${rows:-0}" -lt "${tables:-0}" ]; then
    echo "verify-dump: FAIL — ${rows} data rows across ${tables} tables — effectively schema-only. The database is empty, or reachable-but-wrong. NOT a valid backup." >&2
    return 1
  fi

  echo "verify-dump: OK — ${bytes} bytes plain, ${tables} tables, ${rows} data rows"
  return 0
}

if [ "${BASH_SOURCE[0]:-$0}" = "$0" ]; then
  if [ "$#" -ne 1 ]; then
    echo "usage: bash scripts/verify-dump.sh <dump.sql.gz>" >&2
    exit 2
  fi
  verify_dump "$1"
  exit $?
fi
