#!/usr/bin/env bash
# LOCAL ONLY (Task 14): start the API on a private port against a LOCAL pg (role ebda_app, strict RLS)
# and Redis with the latency-injecting fake embedder. Keep it in the foreground; kill it yourself.
#   PGPORT=56321 REDIS_PORT=56322 PORT=56340 SEARCH_SEMANTIC_ENABLED=true bash loadtests/search-local/run-api.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
APP_PW=${APP_PW:-ci-only-app-pw}; OWNER=${OWNER:-test:test}
PORT=${PORT:-56340}; PGPORT=${PGPORT:-56321}; REDIS_PORT=${REDIS_PORT:-56322}
env NODE_ENV=${LOAD_NODE_ENV:-staging} JWT_SECRET=ev-jwt-secret-local-only-0123456789 ENCRYPTION_KEY=ev-encryption-key-local-only-0123456789 \
  PORT=$PORT \
  LOAD_TEST_BYPASS_TOKEN=${LOAD_TEST_BYPASS_TOKEN:-local-load-token} \
  DATABASE_URL=postgresql://ebda_app:$APP_PW@127.0.0.1:$PGPORT/force_test \
  DIRECT_URL=postgresql://$OWNER@127.0.0.1:$PGPORT/force_test REDIS_URL=redis://127.0.0.1:$REDIS_PORT \
  npx tsx loadtests/search-local/dev-api.ts
