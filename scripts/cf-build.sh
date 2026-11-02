#!/usr/bin/env bash
#
# Build a Next app for Cloudflare (OpenNext) in one command.
#
# WHY THIS SCRIPT EXISTS — OpenNext cannot trace Next's `instrumentation.ts` in
# our monorepo standalone output. Next emits `.next/server/instrumentation.js`
# but does NOT copy it into `.next/standalone/`, and OpenNext's copyTracedFiles
# then dies with:
#     Error: File server/instrumentation.js does not exist
# This is an upstream @opennextjs/aws limitation (still present in the latest
# @opennextjs/cloudflare@1.19.11) — it is triggered by the mere PRESENCE of the
# file, independent of its contents, so there is no in-file code fix. The only
# reliable workaround is to build with instrumentation.ts absent.
#
# This script does exactly that, automatically and safely: it moves
# instrumentation.ts aside for the build only, then ALWAYS restores it (EXIT
# trap — even on failure / Ctrl-C), so the committed Vercel path is never
# altered. Apps without an instrumentation.ts (e.g. orders) just build straight.
#
# Usage:   bash scripts/cf-build.sh <web|admin|orders>
# Then:    cd apps/<app> && npx wrangler deploy   (needs a prior `wrangler login`)
#
# Requires the @opennextjs/cloudflare + wrangler devDeps (declared in each
# app's package.json) and apps/<app>/{wrangler.jsonc,open-next.config.ts}.
# Those two ARE committed, but only as a local-dev fallback: cf-{web,admin,orders}-deploy.yml and
# ci.yml's worker-dry-run both regenerate them with scripts/cf-setup-local.sh
# before calling this script, so edit the generator, not the committed copies.
#
set -euo pipefail

APP="${1:?usage: cf-build.sh <web|admin|orders>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$ROOT/apps/$APP"
BIN="$ROOT/node_modules/.bin/opennextjs-cloudflare"

[ -d "$APP_DIR" ] || { echo "cf-build: no such app: apps/$APP" >&2; exit 1; }
[ -x "$BIN" ] || { echo "cf-build: @opennextjs/cloudflare not installed — run: npm i -D @opennextjs/cloudflare@1.19.11 wrangler@4.116.0 -w @ebda/$APP" >&2; exit 1; }
[ -f "$APP_DIR/wrangler.jsonc" ] || { echo "cf-build: missing apps/$APP/wrangler.jsonc (see docs/migration/cloudflare-preview-workers.md)" >&2; exit 1; }

# The API origin must be baked into Next's browser bundle at build time.
# Runtime Worker vars cannot repair NEXT_PUBLIC_* values after compilation.
if [ -z "${NEXT_PUBLIC_API_URL:-}" ]; then
  EBDA_API_HOST="$(node -e "process.stdout.write(require('$ROOT/packages/shared/dist/brand/index.js').BRAND.domains.api)")"
  if [ "$APP" = web ]; then
    export NEXT_PUBLIC_API_URL="https://$EBDA_API_HOST/api/v1"
  else
    export NEXT_PUBLIC_API_URL="https://$EBDA_API_HOST"
  fi
fi

cd "$APP_DIR"

INSTR="instrumentation.ts"
BAK="$INSTR.cfbak"
restore() { if [ -f "$BAK" ]; then mv -f "$BAK" "$INSTR"; echo "cf-build: restored $INSTR"; fi; }
trap restore EXIT

if [ -f "$INSTR" ]; then
  mv "$INSTR" "$BAK"
  echo "cf-build: moved $INSTR aside for the Cloudflare build (OpenNext trace workaround)"
fi

node "$ROOT/scripts/ci/patch-opennext-preview-props.mjs"
echo "cf-build: building apps/$APP for Cloudflare..."
OPEN_NEXT_CLOUDFLARE=1 "$BIN" build

if [ "$APP" = web ]; then node "$ROOT/scripts/ci/assert-web-middleware.mjs" "$APP_DIR"; fi
echo "cf-build: ✓ apps/$APP built -> apps/$APP/.open-next/worker.js"
echo "cf-build: deploy with -> (cd apps/$APP && npx wrangler deploy)"
