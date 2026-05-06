#!/usr/bin/env bash
# Local Neon backup for Force Website Builder.
# Dumps the production DB to ~/Desktop/projects/_backups/<project>/<ts>-<sha>.sql.gz.
# Keeps the 30 most recent backups; prunes older.
#
# Run manually before any risky deploy, OR wire into launchd/cron, OR add as
# a `.husky/pre-push` hook for "backup before every push" coverage.
#
# Requires: pg_dump (brew install postgresql), gzip, .env with DATABASE_URL.
#
# Usage:
#   bash scripts/backup-db.sh
#   bash scripts/backup-db.sh --quiet      # for cron
#   bash scripts/backup-db.sh --no-prune   # don't auto-delete old backups

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

QUIET=false
PRUNE=true
for arg in "$@"; do
  case "$arg" in
    --quiet) QUIET=true ;;
    --no-prune) PRUNE=false ;;
  esac
done

PROJECT_NAME="$(basename "$(pwd)")"
BACKUP_DIR="${HOME}/Desktop/projects/_backups/${PROJECT_NAME}"
mkdir -p "$BACKUP_DIR"

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
  echo "ERROR: pg_dump not installed. Run: brew install postgresql" >&2
  exit 1
fi

$QUIET || echo "Backing up ${PROJECT_NAME} @ ${SHA} → ${OUT}"
pg_dump "$DATABASE_URL" --no-owner --no-privileges --clean --if-exists 2>/dev/null | gzip -9 > "$OUT"

if $PRUNE; then
  ls -t "$BACKUP_DIR"/*.sql.gz 2>/dev/null | tail -n +31 | xargs -r rm -f
fi

if ! $QUIET; then
  SIZE=$(du -h "$OUT" | cut -f1)
  COUNT=$(ls "$BACKUP_DIR"/*.sql.gz 2>/dev/null | wc -l | tr -d ' ')
  echo "✓ Backed up ${SIZE}. Keeping ${COUNT} backups in ${BACKUP_DIR}"
fi
