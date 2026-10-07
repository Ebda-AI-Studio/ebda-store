#!/usr/bin/env bash
# Rebuild the device-frame screenshots on ebda.app from the REAL storefront.
#
#   CAPTURE_ROOT=<ebda checkout that has the builder template families (PR #23 or later), npm ci done> \
#   npm run capture:stores -w apps/marketing
#
# 1. local Postgres + Redis containers (Apple `container`; never Neon or production)
# 2. migrate, give the strict-RLS role ebda_app a login, seed the five example stores
#    (seed-demo-stores.mjs: one per template family, published like the builder does)
# 3. run the API as ebda_app and a PRODUCTION build of apps/web (middleware resolves the Host)
# 4. capture.mjs: phone 390x844@3, tablet 820x1180@2, laptop 1440x900@2 (+ the phone full page)
# 5. encode.mjs: AVIF/WebP into public/devices/ and src/lib/device-shots.ts
# Containers and servers are stopped at the end; the containers are removed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
: "${CAPTURE_ROOT:?set CAPTURE_ROOT to an ebda checkout with node_modules}"
PG_PORT=${PG_PORT:-55461}; REDIS_PORT=${REDIS_PORT:-56461}; API_PORT=${API_PORT:-4861}; WEB_PORT=${WEB_PORT:-3060}
WORK=$(mktemp -d)
# Throw-away local credentials for the capture container only.
PG=postgresql
OWNER_URL="$PG://owner:owner@127.0.0.1:$PG_PORT/ebda_capture"
APP_URL="$PG://ebda_app:capture-local@127.0.0.1:$PG_PORT/ebda_capture"
PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  # `next start` runs a child server the subshell kill does not reach.
  lsof -ti "tcp:$WEB_PORT" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
  container stop ebda-capture-pg ebda-capture-redis >/dev/null 2>&1 || true
  container rm ebda-capture-pg ebda-capture-redis >/dev/null 2>&1 || true
}
trap cleanup EXIT

container run -d --name ebda-capture-pg -p "$PG_PORT:5432" -e POSTGRES_USER=owner -e POSTGRES_PASSWORD=owner \
  -e POSTGRES_DB=ebda_capture docker.io/library/postgres:16-alpine >/dev/null
container run -d --name ebda-capture-redis -p "$REDIS_PORT:6379" docker.io/library/redis:7-alpine >/dev/null
until container exec ebda-capture-pg pg_isready -U owner >/dev/null 2>&1; do sleep 1; done

cd "$CAPTURE_ROOT"
npm run db:generate >/dev/null && npm run build -w packages/database >/dev/null && npm run build -w packages/shared >/dev/null
(cd packages/database && DATABASE_URL=$OWNER_URL DIRECT_URL=$OWNER_URL npx prisma migrate deploy >/dev/null)
container exec ebda-capture-pg psql -U owner -d ebda_capture -c "ALTER ROLE ebda_app LOGIN PASSWORD 'capture-local';" >/dev/null

node "$HERE/prepare-images.mjs" "$WORK/img"
CAPTURE_ROOT="$CAPTURE_ROOT" OWNER_URL="$OWNER_URL" node "$HERE/seed-demo-stores.mjs"

npm run build -w apps/api >/dev/null
node -e "require('http').createServer((q,r)=>{q.resume();r.end('{\"ids\":[\"x\"],\"status\":200}')}).listen(4868,'127.0.0.1')" & PIDS+=($!)
env NODE_ENV=development PORT=$API_PORT JWT_SECRET=capture-jwt-secret-local-only-0123456789 \
  ENCRYPTION_KEY=capture-encryption-key-local-only-0123456789 INNGEST_BASE_URL=http://127.0.0.1:4868 \
  INNGEST_DEV=http://127.0.0.1:4868 PAYMENT_PROVIDER_STUB=1 API_URL=http://127.0.0.1:$API_PORT \
  DATABASE_URL="$APP_URL" DIRECT_URL="$OWNER_URL" \
  REDIS_URL=redis://127.0.0.1:$REDIS_PORT node apps/api/dist/index.js >"$WORK/api.log" 2>&1 & PIDS+=($!)

# OPEN_NEXT_CLOUDFLARE=1: unoptimised images, exactly as the storefront runs on Cloudflare.
(cd apps/web && OPEN_NEXT_CLOUDFLARE=1 NEXT_PUBLIC_API_URL=http://localhost:$API_PORT/api/v1 npx next build >/dev/null)
(cd apps/web && OPEN_NEXT_CLOUDFLARE=1 NEXT_PUBLIC_API_URL=http://localhost:$API_PORT/api/v1 npx next start -p "$WEB_PORT" >"$WORK/web.log" 2>&1) & PIDS+=($!)
until curl -s -o /dev/null -H "Host: souq-demo.ebda.app" "http://127.0.0.1:$WEB_PORT/"; do sleep 1; done
for id in souq dahab qamar lamma jasmine; do curl -s -o /dev/null -H "Host: $id-demo.ebda.app" "http://127.0.0.1:$WEB_PORT/"; done

WEB=http://127.0.0.1:$WEB_PORT API=http://localhost:$API_PORT IMG_DIR="$WORK/img" node "$HERE/capture.mjs" "$WORK/cap"
cd "$HERE/../.." && node "$HERE/encode.mjs" "$WORK/cap"
echo "done: public/devices/ and src/lib/device-shots.ts updated (raw captures in $WORK/cap)"
