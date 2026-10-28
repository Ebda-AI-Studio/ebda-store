#!/usr/bin/env bash
# Start ONE local Ebda API for evidence runs, as the strict-RLS role `ebda_app`, and keep it in the
# foreground (run it with & and kill it yourself). Verification mail is never sent outside production:
# it is captured and its link logged, so stdout goes to $LOG (the scripted E2E reads it).
#   MODE=node   PORT=4815 DB=ev_spn REDIS_PORT=56411 LOG=/tmp/ev-node-sp.log  bash scripts/ebda-dev-api.sh
#   MODE=worker PORT=4816 DB=ev_sp PGB_PORT=6491 INSPECTOR_PORT=4817 LOG=/tmp/ev-worker-sp.log bash scripts/ebda-dev-api.sh
# Background jobs start nothing here (no Worker bindings), so no external call is made.
set -uo pipefail
cd "$(dirname "$0")/.."
MODE=${MODE:-node}; PORT=${PORT:-4815}; DB=${DB:-ev_spn}; LOG=${LOG:-/tmp/ev-api-$MODE.log}
APP_PW=${APP_PW:-ci-only-app-pw}; OWNER=${OWNER:-parity:parity}
REDIS_PORT=${REDIS_PORT:-56411}; PGB_PORT=${PGB_PORT:-6491}
VARS=(NODE_ENV=development JWT_SECRET=ev-jwt-secret-local-only-0123456789 ENCRYPTION_KEY=ev-encryption-key-local-only-0123456789
  PAYMENT_PROVIDER_STUB=1 SIGNUP_IP_PER_HOUR=1000 SIGNUP_SUBNET_PER_HOUR=1000
  WEB_URL=http://localhost:3000 ADMIN_URL=http://localhost:3001 API_URL=http://127.0.0.1:$PORT)
if [ "$MODE" = node ]; then
  env "${VARS[@]}" PORT=$PORT DATABASE_URL=postgresql://ebda_app:$APP_PW@127.0.0.1:5432/$DB \
    DIRECT_URL=postgresql://$OWNER@127.0.0.1:5432/$DB REDIS_URL=redis://127.0.0.1:$REDIS_PORT \
    node apps/api/dist/index.js >"$LOG" 2>&1
else
  # The config without the Workers AI binding (Ruling SEARCH-T10-4): the binding forces a remote
  # proxy session that needs a Cloudflare login. No AI binding = no embeddings = lexical search.
  node scripts/cf-api-local-config.mjs || exit 1
  cd apps/api && WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgresql://ebda_app:$APP_PW@127.0.0.1:$PGB_PORT/$DB \
    npx wrangler dev --port $PORT --inspector-port ${INSPECTOR_PORT:-4817} --local --config .wrangler.local.jsonc --persist-to "$(mktemp -d)" \
    $(for kv in "${VARS[@]}"; do echo --var "${kv/=/:}"; done) >"$LOG" 2>&1
fi
