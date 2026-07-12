#!/usr/bin/env bash
# Usage:
#   ./run.sh storefront-browse
#   ./run.sh checkout-flow
#   ./run.sh api-bursts
#   ./run.sh multi-store-storm
#   ./run.sh lens-n-medium-traffic
#   ./run.sh lens-scaling-admin-auth
#   ./run.sh all
#
# Required env: STORE_ID (single-store scenarios).
#               STORE_IDS (multi-store-storm, lens-n-medium-traffic — comma-separated UUIDs; see seed:loadtest).
#               ADMIN_EMAIL, ADMIN_PASSWORD (lens-scaling-admin-auth only).
# Optional: BASE_URL, PRODUCT_SLUG (checkout only), LOAD_TEST_TOKEN.
set -euo pipefail

SCENARIO="${1:-storefront-browse}"
HERE="$(cd "$(dirname "$0")" && pwd)"

if ! command -v k6 >/dev/null 2>&1; then
  echo "k6 not installed. brew install k6 (macOS) or see k6.io" >&2
  exit 1
fi

# the multi-store storms (+ lens-n-medium-traffic) use STORE_IDS (plural);
# all other scenarios use STORE_ID.
if [ "$SCENARIO" = "multi-store-storm" ] || [ "$SCENARIO" = "multi-store-checkout-storm" ] || [ "$SCENARIO" = "lens-n-medium-traffic" ]; then
  if [ -z "${STORE_IDS:-}" ]; then
    echo "STORE_IDS env var is required for $SCENARIO (comma-separated store uuids)." >&2
    echo "Seed them first: npm run seed:loadtest --workspace @force/database" >&2
    echo "Then: STORE_IDS=\$(cat loadtests/.loadtest-store-ids.txt) ./run.sh $SCENARIO" >&2
    exit 1
  fi
else
  if [ -z "${STORE_ID:-}" ]; then
    echo "STORE_ID env var is required (a public storefront uuid)." >&2
    exit 1
  fi
  if [ "$SCENARIO" = "lens-scaling-admin-auth" ]; then
    if [ -z "${ADMIN_EMAIL:-}" ] || [ -z "${ADMIN_PASSWORD:-}" ]; then
      echo "ADMIN_EMAIL and ADMIN_PASSWORD env vars are required for lens-scaling-admin-auth." >&2
      exit 1
    fi
  fi
fi

run() {
  local file="$HERE/scenarios/$1.js"
  if [ ! -f "$file" ]; then
    echo "Unknown scenario: $1" >&2
    exit 1
  fi
  echo "=== Running $1 ==="
  # STORE_IDS and LOAD_TEST_TOKEN are passed through from the environment
  # automatically (k6 reads __ENV.* from the process environment).
  k6 run "$file"
}

if [ "$SCENARIO" = "all" ]; then
  run storefront-browse
  run api-bursts
  # checkout-flow last — it writes orders, run separately if you need it
  echo "(skipping checkout-flow in 'all' mode — run it explicitly)"
  # multi-store-storm / lens-n-medium-traffic require seeded STORE_IDS so they are excluded from 'all'
  echo "(skipping multi-store-storm in 'all' mode — run it explicitly with STORE_IDS set)"
  echo "(skipping lens-n-medium-traffic in 'all' mode — run it explicitly with STORE_IDS set, staging/load env only)"
  echo "(skipping lens-scaling-admin-auth in 'all' mode — run it explicitly with ADMIN_EMAIL/ADMIN_PASSWORD set)"
else
  run "$SCENARIO"
fi
