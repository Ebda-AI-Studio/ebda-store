#!/usr/bin/env bash
#
# CI/CD entry point for Cloudflare Workers Builds (Git-connected deploys).
#
# This is the script CF Workers Builds calls from the repo root when building
# each Next app as a Cloudflare Worker via OpenNext.  It differs from the local
# manual path (scripts/cf-build.sh) in two ways:
#
#   1. It runs `npm ci` first (clean install from the committed package-lock).
#   2. It runs `npx prisma generate` via the root `db:generate` script so that
#      the @force/database package types are available before the Next build.
#
# cf-build.sh (the sibling script) is the LOCAL manual path — it skips install
# steps because a developer already has node_modules.  Use cf-ci-build.sh ONLY
# in automated CI/CD environments (Cloudflare Workers Builds, GitHub Actions,
# or any fresh-clone build runner).
#
# The instrumentation.ts workaround is identical to cf-build.sh — see that
# file's header comment for the upstream @opennextjs/cloudflare bug explanation.
#
# Usage in CF Workers Builds dashboard:
#   Build command: bash scripts/cf-ci-build.sh <web|admin|orders>
#   Build output:  apps/<app>/.open-next
#
# Local test (dry-run, no wrangler deploy):
#   bash scripts/cf-ci-build.sh web
#
set -euo pipefail

APP="${1:?usage: cf-ci-build.sh <web|admin|orders>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$ROOT/apps/$APP"
BIN="$ROOT/node_modules/.bin/opennextjs-cloudflare"

[ -d "$APP_DIR" ] || { echo "cf-ci-build: no such app: apps/$APP" >&2; exit 1; }
[ -f "$APP_DIR/wrangler.jsonc" ] || { echo "cf-ci-build: missing apps/$APP/wrangler.jsonc" >&2; exit 1; }

echo "cf-ci-build: installing dependencies (npm ci)..."
cd "$ROOT"
npm ci

echo "cf-ci-build: generating Prisma client (db:generate)..."
npm run db:generate

[ -x "$BIN" ] || { echo "cf-ci-build: @opennextjs/cloudflare not found after install — check devDependencies in apps/$APP/package.json" >&2; exit 1; }

cd "$APP_DIR"

INSTR="instrumentation.ts"
BAK="$INSTR.cfbak"
restore() { if [ -f "$BAK" ]; then mv -f "$BAK" "$INSTR"; echo "cf-ci-build: restored $INSTR"; fi; }
trap restore EXIT

if [ -f "$INSTR" ]; then
  mv "$INSTR" "$BAK"
  echo "cf-ci-build: moved $INSTR aside for the Cloudflare build (OpenNext trace workaround)"
fi

echo "cf-ci-build: building apps/$APP for Cloudflare..."
OPEN_NEXT_CLOUDFLARE=1 "$BIN" build

echo "cf-ci-build: done — apps/$APP/.open-next/worker.js ready for wrangler deploy"
