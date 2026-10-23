#!/bin/bash
# Local run setup for tests/dahab (Phase B5): seeds every showroom the demo bar can switch to
# (storedemo = qamar, storedemo-souq, storedemo-jasmine, storedemo-lamma, storedemo-dahab) plus the three
# Dahab look stores and the scenario stores, and gives each a custom domain `<slug>.localhost-b5.test` so
# the PRODUCTION web build serves it (it refuses `.localhost` hosts; see playwright.dahab.config.ts).
# LOCAL DATABASE ONLY. The Dahab stores are the point of this run; the other showrooms are seeded only
# when DAHAB_ALL_SHOWROOMS=1 (the demo-bar switch test needs them).
#   DATABASE_URL=postgresql://... DIRECT_URL=... bash scripts/dahab-demo/seed-local-hosts.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
case "${DATABASE_URL:-}" in
  *127.0.0.1*|*localhost*|*192.168.64.*) ;;
  *) echo "refusing: DATABASE_URL is not a local database" >&2; exit 1 ;;
esac
mkdir -p apps/web/public/__dahab-demo
cp scripts/dahab-demo/assets/*.webp apps/web/public/__dahab-demo/
if [ "${DAHAB_ALL_SHOWROOMS:-0}" = "1" ]; then
  mkdir -p apps/web/public/__lamma-demo apps/web/public/__jasmine-demo apps/web/public/__souq-demo apps/web/public/__qamar-demo
  cp scripts/qamar-demo/assets/* apps/web/public/__qamar-demo/
  cp scripts/lamma-demo/assets/*.webp apps/web/public/__lamma-demo/
  cp scripts/jasmine-demo/assets/*.webp apps/web/public/__jasmine-demo/
  QAMAR_DEMO_ASSET_BASE=/__qamar-demo npx tsx scripts/storedemo/seed.mjs
  SOUQ_DEMO_ASSET_BASE=/__souq-demo npx tsx scripts/storedemo/seed.mjs --template souq
  JASMINE_DEMO_ASSET_BASE=/__jasmine-demo npx tsx scripts/storedemo/seed.mjs --template jasmine
  LAMMA_DEMO_ASSET_BASE=/__lamma-demo npx tsx scripts/storedemo/seed.mjs --template lamma
fi
DAHAB_DEMO_ASSET_BASE=/__dahab-demo npx tsx scripts/storedemo/seed.mjs --template dahab --local-look-stores
DAHAB_DEMO_ASSET_BASE=/__dahab-demo npx tsx scripts/storedemo/scenario-stores.mjs --template dahab
psql "${DIRECT_URL:-$DATABASE_URL}" -v ON_ERROR_STOP=1 -c "update stores set domain = slug || '.localhost-b5.test', domain_status = 'active', domain_verified_at = now() where (slug like 'storedemo%' or slug like 'dahab-%' or slug like 'qamar-%') and domain is distinct from slug || '.localhost-b5.test'"
