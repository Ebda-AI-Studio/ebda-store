#!/usr/bin/env bash
# Buy-flow parity, Node (base) vs workerd (head), BOTH connecting as the strict-RLS role `ebda_app`.
# Needs: Postgres 17 + pgvector on :5432 with an owner role (OWNER_URL), the `ebda_app` LOGIN role (APP_PW),
# a pgbouncer (transaction mode) on PGB_PORT serving the head database, a Redis on REDIS_PORT,
# apps/api built. Resources are parameters so concurrent runs on one host do not collide.
#   bash scripts/ebda-parity-as-app.sh        (see docs/ebda/plans/sp4-sp5-evidence.md)
set -uo pipefail
cd "$(dirname "$0")/.."
OWNER=${OWNER:-parity:parity}            # user:password of the database owner / superuser
APP_PW=${APP_PW:-ci-only-app-pw}         # password of the ebda_app LOGIN role
DB_BASE=${DB_BASE:-ev_base}; DB_HEAD=${DB_HEAD:-ev_head}   # fresh, migrated
PGB_PORT=${PGB_PORT:-6491}               # pgbouncer (transaction mode) serving $DB_HEAD
REDIS_PORT=${REDIS_PORT:-56411}
BASE_PORT=${BASE_PORT:-4811}; HEAD_PORT=${HEAD_PORT:-4812}; STUB_PORT=${STUB_PORT:-4813}
STUB=http://127.0.0.1:$STUB_PORT
O=postgresql://$OWNER@127.0.0.1:5432
COMMON=(JWT_SECRET=bfp-parity-jwt-secret-local-only-0123456789
  ENCRYPTION_KEY=bfp-parity-encryption-key-local-only-0123456789
  INNGEST_BASE_URL=$STUB INNGEST_DEV=$STUB BFP_STUB_URL=$STUB LOAD_TEST_BYPASS_TOKEN=bfp-parity-load-test-token
  PAYMOB_BASE_URL=$STUB/paymob PAYMENT_PROVIDER_STUB=1
  PAYMENT_ATTEMPTS_PER_IP_10M=100000 PAYMENT_ATTEMPTS_PER_STORE_10M=100000
  PAYMENT_SESSION_MAX_DECLINES=1000 PAYMENT_IP_MAX_DECLINES=100000 NODE_ENV=development)
PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done; pkill -P $$ 2>/dev/null; true; }
trap cleanup EXIT
BASE_APP=postgresql://ebda_app:$APP_PW@127.0.0.1:5432/$DB_BASE
env "${COMMON[@]}" PORT=$BASE_PORT API_URL=http://127.0.0.1:$BASE_PORT WEB_URL=http://localhost:3000 ADMIN_URL=http://localhost:3001 \
  DATABASE_URL=$BASE_APP DIRECT_URL=$O/$DB_BASE REDIS_URL=redis://127.0.0.1:$REDIS_PORT \
  node apps/api/dist/index.js >/tmp/ev-node-api.log 2>&1 & PIDS+=($!)
PERSIST=$(mktemp -d)
(cd apps/api && WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgresql://ebda_app:$APP_PW@127.0.0.1:$PGB_PORT/$DB_HEAD \
  exec npx wrangler dev --port $HEAD_PORT --inspector-port ${INSPECTOR_PORT:-4814} --local --persist-to "$PERSIST" \
  $(for kv in "${COMMON[@]}" API_URL=http://127.0.0.1:$HEAD_PORT WEB_URL=http://localhost:3000 ADMIN_URL=http://localhost:3001; do echo --var "${kv/=/:}"; done) \
  >/tmp/ev-worker.log 2>&1) & PIDS+=($!)
for i in $(seq 1 90); do
  curl -fs http://127.0.0.1:$BASE_PORT/health >/dev/null && curl -fs http://127.0.0.1:$HEAD_PORT/health >/dev/null && break; sleep 1
done
node scripts/buy-flow-parity/run.mjs --api-url-base http://127.0.0.1:$BASE_PORT --api-url-head http://127.0.0.1:$HEAD_PORT \
  --pg-url-base $O/$DB_BASE --pg-url-head $O/$DB_HEAD --redis-url-base redis://127.0.0.1:$REDIS_PORT \
  --stub-port $STUB_PORT --api-port $BASE_PORT
echo "parity exit=$?"
