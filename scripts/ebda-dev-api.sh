#!/usr/bin/env bash
# Start ONE local Ebda API for evidence runs, as the strict-RLS role `ebda_app`, and keep it in the
# foreground (run it with & and kill it yourself). Verification mail is never sent outside production:
# it is captured and its link logged, so stdout goes to $LOG (the scripted E2E reads it).
#   PORT=4815 DB=ev_spn REDIS_PORT=56411 LOG=/tmp/ev-node-sp.log  bash scripts/ebda-dev-api.sh
# (The MODE=worker Hyperdrive branch was removed in NZ-17 slice 2: the Worker has no Postgres; use `npm run cf:test:do` / wrangler dev.)
# Background jobs start nothing here (no Worker bindings), so no external call is made.
set -uo pipefail
cd "$(dirname "$0")/.."
PORT=${PORT:-4815}; DB=${DB:-ev_spn}; LOG=${LOG:-/tmp/ev-api-node.log}
APP_PW=${APP_PW:-ci-only-app-pw}; OWNER=${OWNER:-parity:parity}
REDIS_PORT=${REDIS_PORT:-56411}
VARS=(NODE_ENV=development JWT_SECRET=ev-jwt-secret-local-only-0123456789 ENCRYPTION_KEY=ev-encryption-key-local-only-0123456789
  PAYMENT_PROVIDER_STUB=1 SIGNUP_IP_PER_HOUR=1000 SIGNUP_SUBNET_PER_HOUR=1000
  WEB_URL=http://localhost:3000 ADMIN_URL=http://localhost:3001 API_URL=http://127.0.0.1:$PORT)
env "${VARS[@]}" PORT=$PORT DATABASE_URL=postgresql://ebda_app:$APP_PW@127.0.0.1:5432/$DB \
  DIRECT_URL=postgresql://$OWNER@127.0.0.1:5432/$DB REDIS_URL=redis://127.0.0.1:$REDIS_PORT \
  node apps/api/dist/index.js >"$LOG" 2>&1
