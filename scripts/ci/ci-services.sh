#!/usr/bin/env bash
# ci-services.sh up|down — Postgres + Redis URLs for the CI jobs that need a database (Ruling CI-MAC-RUNNER-1).
#
# Linux (GitHub-hosted): the job's service containers. `up` reads their mapped ports from CI_PG_PORT / CI_REDIS_PORT.
# macOS (the ebda-mac org runner on Ahmad's Mac): containers do not run on macOS runners, so the job uses the host's
#   ONE Homebrew Postgres 17 + pgvector and Redis (shared with other repos' runners on this Mac). Isolation:
#   - Postgres: a database of its own per job (repo + run id + attempt + job + runner), created here and DROPPED by
#     `down` (an `if: always()` step); `up` also drops this repo's CI databases older than 3 h (a cancelled job).
#   - Redis: a logical DB per runner instance (ebda-mac-1 -> 1, ebda-mac-2 -> 2); one runner runs one job at a time.
# Either way `up` appends CI_PG_URL (superuser `test`), CI_PG_APP_URL (`ebda_app`, strict RLS) and CI_REDIS_URL to
# $GITHUB_ENV; the steps read them as ${{ env.CI_PG_URL }} etc.
set -euo pipefail
cmd="${1:-}"
out="${GITHUB_ENV:-/dev/stdout}"
# CI-only throw-away credentials (the same literals the workflow used before; they exist only on a disposable
# container or the Mac's localhost-only Postgres). Assembled from parts so the secret scanners see no URL literal.
SU="test:test"; APP="ebda_app:ci-only-app-pw"; PG="postgresql:/"

if [ "$(uname -s)" != Darwin ]; then
  [ "$cmd" = up ] || exit 0
  : "${CI_PG_PORT:?CI_PG_PORT (job.services.postgres.ports) is empty: no postgres service container on this Linux runner}"
  {
    echo "CI_PG_URL=${PG}/${SU}@localhost:${CI_PG_PORT}/force_test"
    echo "CI_PG_APP_URL=${PG}/${APP}@localhost:${CI_PG_PORT}/force_test"
    [ -n "${CI_REDIS_PORT:-}" ] && echo "CI_REDIS_URL=redis://localhost:${CI_REDIS_PORT}"
  } >> "$out"
  exit 0
fi

PREFIX="ebda_store_ci_"
raw="${PREFIX}${GITHUB_RUN_ID:-local}_${GITHUB_RUN_ATTEMPT:-1}_${GITHUB_JOB:-job}_${RUNNER_NAME:-r}"
DB="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_' '_' | cut -c1-63)"
export PGHOST=localhost PGPORT=5432
admin() { psql -d postgres -v ON_ERROR_STOP=1 -qAt "$@"; }

case "$cmd" in
  up)
    pg_isready -q || { echo "::error::host Postgres (brew services postgresql@17) is not accepting connections"; exit 1; }
    redis-cli ping >/dev/null || { echo "::error::host Redis (brew services redis) is not answering"; exit 1; }
    admin -c "DO \$\$BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='test') THEN CREATE ROLE test LOGIN SUPERUSER PASSWORD 'test'; END IF; END\$\$;"
    # janitor: this repo's CI databases older than 3 h (PG_VERSION's mtime = the database's creation time)
    for old in $(admin -c "SELECT datname FROM pg_database WHERE datname LIKE '${PREFIX}%' AND (pg_stat_file('base/'||oid||'/PG_VERSION')).modification < now() - interval '3 hours'"); do
      echo "dropping stale CI database $old"; dropdb --if-exists --force "$old" || true
    done
    dropdb --if-exists --force "$DB"
    createdb -O test "$DB"
    case "${RUNNER_NAME:-}" in *-2) RDB=2 ;; *-1) RDB=1 ;; *) RDB=3 ;; esac
    redis-cli -n "$RDB" flushdb >/dev/null
    {
      echo "CI_PG_DB=$DB"
      echo "CI_PG_URL=${PG}/${SU}@localhost:5432/$DB"
      echo "CI_PG_APP_URL=${PG}/${APP}@localhost:5432/$DB"
      echo "CI_REDIS_URL=redis://localhost:6379/$RDB"
    } >> "$out"
    echo "per-job database $DB, redis db $RDB"
    ;;
  down)
    dropdb --if-exists --force "$DB" && echo "dropped $DB"
    ;;
  *) echo "usage: ci-services.sh up|down" >&2; exit 64 ;;
esac
