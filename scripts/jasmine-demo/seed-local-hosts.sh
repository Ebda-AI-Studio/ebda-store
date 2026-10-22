#!/bin/bash
# Local run setup for tests/jasmine (Phase B3): seeds every showroom the demo bar can switch to
# (storedemo = qamar, storedemo-souq, storedemo-jasmine) plus the three Jasmine look stores, and
# gives each a custom domain `<slug>.localhost-b3.test` so the PRODUCTION web build serves it
# (it refuses `.localhost` hosts; see playwright.jasmine.config.ts). LOCAL DATABASE ONLY.
#   DATABASE_URL=postgresql://... DIRECT_URL=... bash scripts/jasmine-demo/seed-local-hosts.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
case "${DATABASE_URL:-}" in
  *127.0.0.1*|*localhost*) ;;
  *) echo "refusing: DATABASE_URL is not a local database" >&2; exit 1 ;;
esac
mkdir -p apps/web/public/__jasmine-demo apps/web/public/__souq-demo apps/web/public/__qamar-demo
cp scripts/jasmine-demo/assets/*.webp apps/web/public/__jasmine-demo/
QAMAR_DEMO_ASSET_BASE=/__qamar-demo npx tsx scripts/storedemo/seed.mjs
SOUQ_DEMO_ASSET_BASE=/__souq-demo npx tsx scripts/storedemo/seed.mjs --template souq
JASMINE_DEMO_ASSET_BASE=/__jasmine-demo npx tsx scripts/storedemo/seed.mjs --template jasmine --local-look-stores
JASMINE_DEMO_ASSET_BASE=/__jasmine-demo npx tsx scripts/storedemo/scenario-stores.mjs --template jasmine
psql "${DIRECT_URL:-$DATABASE_URL}" -v ON_ERROR_STOP=1 -c "update stores set domain = slug || '.localhost-b3.test', domain_status = 'active', domain_verified_at = now() where (slug like 'storedemo%' or slug like 'jasmine-%') and domain is distinct from slug || '.localhost-b3.test'"
