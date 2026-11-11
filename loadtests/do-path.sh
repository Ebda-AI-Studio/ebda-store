#!/usr/bin/env bash
# k6 p95 on the Durable-Object path: storefront browse + checkout, NON-PROD targets only.
#   BASE_URL=http://localhost:8787/api/v1 STORE_ID=<uuid> PRODUCT_SLUG=<slug> ./do-path.sh
# Refuses any ebda.app host (production). Prod load tests are AHMAD-APPROVE (docs/rulings/DO-LOAD-1.md).
# Writes p95 per scenario to results/do-path-<utc>.json (k6 --summary-export); gate = p95 < 500 ms.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
: "${BASE_URL:?BASE_URL required (local workerd or a staging Worker)}"
: "${STORE_ID:?STORE_ID required}"
case "$BASE_URL" in
  *ebda.app*) echo "refusing production host: $BASE_URL (needs Ahmad's explicit approval)" >&2; exit 1 ;;
esac
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$HERE/results"
for sc in storefront-browse checkout-flow; do
  k6 run --summary-export "$HERE/results/do-path-$sc-$stamp.json" \
    -e BASE_URL="$BASE_URL" -e STORE_ID="$STORE_ID" -e PRODUCT_SLUG="${PRODUCT_SLUG:-}" \
    "$HERE/scenarios/$sc.js"
  node -e 'const m=require(process.argv[1]).metrics.http_req_duration;console.log(process.argv[2],"p95 ms =",m["p(95)"]);process.exit(m["p(95)"]<500?0:1)' \
    "$HERE/results/do-path-$sc-$stamp.json" "$sc"
done
