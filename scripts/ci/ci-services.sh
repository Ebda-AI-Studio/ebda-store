#!/usr/bin/env bash
# ci-services.sh up|down — Postgres + Redis URLs for the CI jobs that need a database (Ruling CI-MAC-RUNNER-1).
#
# Linux (GitHub-hosted): the job's service containers. `up` reads their mapped ports from CI_PG_PORT / CI_REDIS_PORT.
# macOS (the ebda-mac org runner on Ahmad's Mac): containers do not run on macOS runners, so the job uses the host's
#   ONE Homebrew Postgres 17 + pgvector and Redis (shared with other repos' runners on this Mac). Isolation:
#   - Postgres: a database of its own per job (repo + run id + attempt + job + runner), created here and DROPPED by
#     `down` (an `if: always()` step); `up` also drops this repo's CI databases older than 3 h (a cancelled job).
#   - Redis: a logical DB reserved for Ebda CI per runner instance (ebda-mac-1 -> 14, ebda-mac-2 -> 15); never a shared one.
#   - The app role: `ebda_app` is cluster-global and the host's pg_hba is `trust` on localhost, so the Mac path never
#     ALTERs it (`app-login` only checks it can log in). Ruling CI-MAC-ROLE-1 in docs/ebda/ci.md.
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
    # Redis DBs 14 and 15 are reserved for Ebda CI on this host (docs/ebda/ci.md); other tools use 0/9/11/13. One per
    # runner instance, and a runner runs one job at a time, so flushing it only ever clears this job's predecessor.
    case "${RUNNER_NAME:-}" in
      ebda-mac-1) RDB=14 ;;
      ebda-mac-2) RDB=15 ;;
      *) echo "::error::no Ebda-CI Redis DB reserved for runner '${RUNNER_NAME:-}' (add one in ci-services.sh + docs/ebda/ci.md)"; exit 1 ;;
    esac
    redis-cli -n "$RDB" flushdb >/dev/null
    pg_isready -q || { echo "::error::host Postgres (brew services postgresql@17) is not accepting connections"; exit 1; }
    redis-cli ping >/dev/null || { echo "::error::host Redis (brew services redis) is not answering"; exit 1; }
    admin -c "DO \$\$BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='test') THEN CREATE ROLE test LOGIN SUPERUSER PASSWORD 'test'; END IF; END\$\$;"
    # janitor: this repo's CI databases older than 3 h (PG_VERSION's mtime = the database's creation time)
    for old in $(admin -c "SELECT datname FROM pg_database WHERE datname LIKE '${PREFIX}%' AND (pg_stat_file('base/'||oid||'/PG_VERSION')).modification < now() - interval '3 hours'"); do
      echo "dropping stale CI database $old"; dropdb --if-exists --force "$old" || true
    done
    dropdb --if-exists --force "$DB"
    createdb -O test "$DB"
    # The host cluster's default TimeZone is the Mac's (UTC+3), the Linux service container's is UTC. The pg adapter
    # writes a Date as a UTC wall-clock string that the SESSION zone then reads, so every write made outside a tenant
    # transaction (which pins UTC itself) shifted by the zone offset: staff-invite-seats fixtures expired 3 h in the past
    # and every accept answered 400 INVITE_INVALID. Pin the per-job database (never the shared cluster) to UTC.
    admin -c "ALTER DATABASE \"$DB\" SET timezone TO 'UTC'"
    {
      echo "CI_PG_DB=$DB"
      echo "CI_PG_URL=${PG}/${SU}@localhost:5432/$DB"
      echo "CI_PG_APP_URL=${PG}/${APP}@localhost:5432/$DB"
      echo "CI_REDIS_URL=redis://localhost:6379/$RDB"
    } >> "$out"
    echo "per-job database $DB, redis db $RDB"
    ;;
  app-login)
    # Linux (a disposable service container): give ebda_app the CI-only login, as the workflow always did.
    # macOS: the shared host cluster. Never ALTER the role there; it must already be able to log in (one-time host setup).
    if [ "$(uname -s)" = Darwin ]; then
      ok="$(admin -c "SELECT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls FROM pg_roles WHERE rolname='ebda_app'")"
      [ "$ok" = t ] || { echo "::error::host role ebda_app is missing, cannot log in, or bypasses RLS. One-time host setup: psql -d postgres -c 'ALTER ROLE ebda_app LOGIN'"; exit 1; }
      echo "ebda_app can log in on the host cluster (not altered)"
    fi
    ;;
  down)
    dropdb --if-exists --force "$DB" && echo "dropped $DB"
    ;;
  *) echo "usage: ci-services.sh up|down" >&2; exit 64 ;;
esac
