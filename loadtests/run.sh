#!/usr/bin/env bash
# Usage:
#   ./run.sh storefront-browse
#   ./run.sh checkout-flow
#   ./run.sh api-bursts
#   ./run.sh all
#
# Required env: STORE_ID. Optional: BASE_URL, PRODUCT_SLUG (checkout only).
set -euo pipefail

SCENARIO="${1:-storefront-browse}"
HERE="$(cd "$(dirname "$0")" && pwd)"

if ! command -v k6 >/dev/null 2>&1; then
  echo "k6 not installed. brew install k6 (macOS) or see k6.io" >&2
  exit 1
fi

if [ -z "${STORE_ID:-}" ]; then
  echo "STORE_ID env var is required (a public storefront uuid)." >&2
  exit 1
fi

run() {
  local file="$HERE/scenarios/$1.js"
  if [ ! -f "$file" ]; then
    echo "Unknown scenario: $1" >&2
    exit 1
  fi
  echo "=== Running $1 ==="
  k6 run "$file"
}

if [ "$SCENARIO" = "all" ]; then
  run storefront-browse
  run api-bursts
  # checkout-flow last — it writes orders, run separately if you need it
  echo "(skipping checkout-flow in 'all' mode — run it explicitly)"
else
  run "$SCENARIO"
fi
