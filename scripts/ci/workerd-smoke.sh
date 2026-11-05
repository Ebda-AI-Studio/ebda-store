#!/usr/bin/env bash
# Boot the API Worker in workerd (scripts/ci/workerd-smoke.mjs). Ruling DEPLOY-SAFETY-1.
# NEON-ZERO N-17 (Ruling NZ-D23): no Postgres any more, so nothing to migrate or seed; the smoke uses a local D1.
#   bash scripts/ci/workerd-smoke.sh [--config <wrangler config relative to apps/api>]
set -euo pipefail
cd "$(dirname "$0")/../.."
exec node scripts/ci/workerd-smoke.mjs "$@"
