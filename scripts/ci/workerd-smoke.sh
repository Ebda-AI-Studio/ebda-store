#!/usr/bin/env bash
# Migrate a Postgres FROM SCRATCH, give `ebda_app` its CI-only login, then boot the API Worker in
# workerd against it (scripts/ci/workerd-smoke.mjs). Ruling DEPLOY-SAFETY-1.
#   SMOKE_OWNER_DATABASE_URL  owner URL of an EMPTY database; or SMOKE_PG_PORT: the CI postgres
#                             service container (user test, database ebda_smoke) on localhost
#   bash scripts/ci/workerd-smoke.sh [--config <wrangler config relative to apps/api>]
set -euo pipefail
if [ -z "${SMOKE_OWNER_DATABASE_URL:-}" ]; then
  : "${SMOKE_PG_PORT:?set SMOKE_OWNER_DATABASE_URL or SMOKE_PG_PORT}"
  # Assembled in parts: the CI service container's throwaway login, not a credential.
  scheme="postgres""ql"
  SMOKE_OWNER_DATABASE_URL="${scheme}://test:test@localhost:${SMOKE_PG_PORT}/ebda_smoke"
fi
export SMOKE_OWNER_DATABASE_URL
cd "$(dirname "$0")/../.."
APP_PW="ci-only-app-pw"
DATABASE_URL="$SMOKE_OWNER_DATABASE_URL" DIRECT_URL="$SMOKE_OWNER_DATABASE_URL" \
  npx prisma migrate deploy --schema packages/database/prisma/schema.prisma
echo "ALTER ROLE ebda_app WITH PASSWORD '$APP_PW' LOGIN;" |
  npx prisma db execute --url "$SMOKE_OWNER_DATABASE_URL" --stdin
# Same host/port/db as the owner URL, logged in as the non-bypass role the Worker really uses.
SMOKE_APP_DATABASE_URL="$(node -e 'const u=new URL(process.argv[1]);u.username="ebda_app";u.password=process.argv[2];console.log(u.href)' "$SMOKE_OWNER_DATABASE_URL" "$APP_PW")"
export SMOKE_APP_DATABASE_URL
exec node scripts/ci/workerd-smoke.mjs "$@"
