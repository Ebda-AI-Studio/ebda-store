#!/usr/bin/env bash
# Local Neon backup for Force Website Builder — runs from the PRE-PUSH hook.
# Dumps the production DB to
# ~/Desktop/projects/_backups/<project>/pre-push/<ts>-<sha>.sql.gz — its own
# subdirectory, separate from the nightly `backup-all-neon.sh`'s 30-day
# rotation (see the #1846 note below `PRE_PUSH_KEEP`). Keeps the 10 most
# recent pre-push dumps; prunes older.
#
# ## 2026-09-17 — why this script grew pre-flight checks and a verifier
#
# 6 of 193 archives in the local backup tree were valid gzip files containing
# ZERO bytes — 20260916T120700Z-6af9aa42.sql.gz and three more from 2026-08-19.
# This script wrote every one of them, and the cause reproduces on demand:
#
#   1. `pg_dump` on the default PATH is Homebrew's 14.24; Neon serves 17.11.
#      pg_dump refuses across that gap ("aborting because of server version
#      mismatch", exit 1) before emitting a single byte.
#   2. `2>/dev/null` threw that explanation away.
#   3. `... | gzip -9 > "$OUT"` had ALREADY created $OUT, and gzip compressed the
#      empty stream into a perfectly valid 20-byte archive.
#   4. `.husky/pre-push` calls this non-blocking, so the push carried on.
#
# The result is a file that is present, recent, correctly named — and restores
# nothing. Nothing in the pipeline was broken enough to notice.
#
# Every guard below exists to make that specific outcome impossible: the version
# gap is refused up front with the fix, the pooled URL is refused up front, the
# error text is shown instead of discarded, the dump is written to a temp file
# and VERIFIED before it is allowed to take a backup's name, and a dump that
# fails verification is parked as `.SUSPECT` rather than left sitting in the
# `*.sql.gz` glob that `docs/ROLLBACK.md` restores from.
#
# Requires: pg_dump >= the Neon server major (PG17 -> brew install postgresql@17),
# gzip, and a DIRECT (non-pooler) DATABASE_URL.
#
# Usage:
#   bash scripts/backup-db.sh
#   bash scripts/backup-db.sh --quiet      # for cron
#   bash scripts/backup-db.sh --no-prune   # don't auto-delete old backups

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# Neon serves PG17. pg_dump refuses to dump a server newer than itself, so the
# Homebrew keg has to come FIRST on PATH — /opt/homebrew/bin/pg_dump is whatever
# major happened to be linked (14.24 on this Mac), and that is defect (1) above.
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
REQUIRED_PG_MAJOR=17

QUIET=false
PRUNE=true
for arg in "$@"; do
  case "$arg" in
    --quiet) QUIET=true ;;
    --no-prune) PRUNE=false ;;
  esac
done

PROJECT_NAME="$(basename "$(pwd)")"
# #1846: a SEPARATE subdirectory from the nightly `backup-all-neon.sh`'s
# `_backups/<project>/` — that script's docs claim "30 rotations = 30-day
# window", which is only true if it owns its own 30-slot rotation. Pre-push
# runs on every push (can be many times a day); sharing one directory and one
# unscoped `ls -t *.sql.gz | tail -n +31` prune meant a high-push day evicted
# nightly backups early, silently shrinking the documented recovery window.
# Pre-push dumps are a same-day supplementary safety net, not part of that
# 30-day guarantee — see docs/DB-BACKUP-RESTORE.md.
BACKUP_DIR="${HOME}/Desktop/projects/_backups/${PROJECT_NAME}/pre-push"
mkdir -p "$BACKUP_DIR"
# How many pre-push dumps to keep. Small on purpose — these exist to cover
# "the last few pushes today", not the month-long window the nightly owns.
PRE_PUSH_KEEP=10

SHA="$(git rev-parse --short HEAD)"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${BACKUP_DIR}/${TS}-${SHA}.sql.gz"

# Resolve DATABASE_URL (env > apps/api/.env > .env)
if [ -z "${DATABASE_URL:-}" ]; then
  for f in apps/api/.env .env; do
    if [ -f "$f" ]; then
      DATABASE_URL=$(grep -E "^DATABASE_URL=" "$f" | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' || true)
      [ -n "${DATABASE_URL:-}" ] && break
    fi
  done
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL not set (env or .env)." >&2
  exit 1
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "ERROR: pg_dump not installed. Run: brew install postgresql@17" >&2
  exit 1
fi

# ── pre-flight 1: pg_dump major >= server major ──────────────────────────────
PG_DUMP_MAJOR="$(pg_dump --version | awk '{print $3}' | cut -d. -f1)"
if [ "${PG_DUMP_MAJOR:-0}" -lt "$REQUIRED_PG_MAJOR" ]; then
  echo "ERROR: pg_dump is major ${PG_DUMP_MAJOR}, but Neon serves PG${REQUIRED_PG_MAJOR}." >&2
  echo "       pg_dump aborts on a newer server and writes NOTHING, which is how six" >&2
  echo "       zero-byte 'backups' reached ${BACKUP_DIR}." >&2
  echo "       Fix: brew install postgresql@17" >&2
  exit 1
fi

# ── pre-flight 2: refuse the pooled URL ──────────────────────────────────────
# The repo .env carries Neon's POOLED connection string (that is the right URL
# for the app). pg_dump needs the DIRECT one: through the pooler it hangs rather
# than failing cleanly, which is a worse failure than the version mismatch —
# there is no error line to read afterwards.
case "$DATABASE_URL" in
  *-pooler.*)
    echo "ERROR: DATABASE_URL points at the Neon POOLER; pg_dump needs the DIRECT url." >&2
    echo "       Fix: export DATABASE_URL=\"\$(neonctl connection-string --project-id lucky-truth-54548746 \\" >&2
    echo "              --org-id org-proud-silence-64969971 --role-name neondb_owner)\"" >&2
    echo "       (the nightly ~/.claude/scripts/backup-all-neon.sh pulls it from Neon for this reason)" >&2
    exit 1
    ;;
esac

$QUIET || echo "Backing up ${PROJECT_NAME} @ ${SHA} → ${OUT}"

# ── dump to a TEMP file ──────────────────────────────────────────────────────
# Never write straight to $OUT. A redirect creates the destination before the
# producer has proved it can produce anything, so a failed dump still leaves a
# correctly-named file behind. $OUT is only created below, after verification.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
TMP_GZ="${WORK}/dump.sql.gz"
ERR="${WORK}/pg_dump.err"

if ! pg_dump "$DATABASE_URL" --no-owner --no-privileges --clean --if-exists 2>"$ERR" | gzip -9 >"$TMP_GZ"; then
  # Show the reason. `2>/dev/null` here is what turned a one-line diagnosis into
  # a month of silent empty backups. Only the last line, so a connection string
  # echoed in a verbose libpq error cannot end up in a terminal scrollback.
  echo "ERROR: pg_dump failed: $(tail -1 "$ERR")" >&2
  exit 1
fi

# ── verify BEFORE it is allowed to be called a backup ────────────────────────
if ! bash scripts/verify-dump.sh "$TMP_GZ"; then
  # Keep the evidence, but NOT under the *.sql.gz name the restore procedure
  # globs: a dump that failed its content check is the record of when the data
  # disappeared, and it must never be picked up as "the most recent backup".
  SUSPECT="${OUT}.SUSPECT"
  mv "$TMP_GZ" "$SUSPECT"
  echo "ERROR: dump failed verification — NOT saved as a backup." >&2
  echo "       Parked for forensics at: ${SUSPECT}" >&2
  exit 1
fi

mv "$TMP_GZ" "$OUT"

if $PRUNE; then
  ls -t "$BACKUP_DIR"/*.sql.gz 2>/dev/null | tail -n +$((PRE_PUSH_KEEP + 1)) | xargs -r rm -f
fi

if ! $QUIET; then
  SIZE=$(du -h "$OUT" | cut -f1)
  COUNT=$(ls "$BACKUP_DIR"/*.sql.gz 2>/dev/null | wc -l | tr -d ' ')
  echo "✓ Backed up ${SIZE}. Keeping ${COUNT} backups in ${BACKUP_DIR}"
fi
