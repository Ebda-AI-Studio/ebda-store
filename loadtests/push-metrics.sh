#!/usr/bin/env bash
# push-metrics.sh — parse k6 --summary-export files and ingest into Axiom.
#
# Usage (CI — token from env):
#   bash loadtests/push-metrics.sh
#
# Usage (local ad-hoc run):
#   AXIOM_INGEST_TOKEN=<token> bash loadtests/push-metrics.sh
#   AXIOM_INGEST_TOKEN=<token> RESULTS_DIR=/path/to/results bash loadtests/push-metrics.sh
#
# Required env:
#   AXIOM_INGEST_TOKEN  — Axiom API token with Ingest scope (GitHub secret on CI,
#                         or personal token locally). Skips silently if unset.
#
# Optional env:
#   AXIOM_DATASET       — Axiom dataset to ingest into (default: force-api-railway)
#   RESULTS_DIR         — directory containing summary-*.json files
#                         (default: loadtests/results/ relative to repo root)
#
# The summary-*.json files are written by k6's --summary-export flag. Each file
# contains aggregated metrics (p95, RPS, error rate) for one scenario run — NOT
# the raw per-request NDJSON from --out json. This keeps the ingested payload
# tiny (~2 KB per run) while giving the long-term trend data we care about.
#
# Axiom chart setup (one-time, ~5 min):
#   1. Open app.axiom.co → Datasets → force-api-railway
#   2. Dashboards → New dashboard → Add chart
#   3. APL query: ["force-api-railway"] | where scenario != "" | summarize avg(p95_ms) by bin(_time, 1d), scenario
#   4. Repeat for rps and error_rate fields

set -euo pipefail

TOKEN="${AXIOM_INGEST_TOKEN:-}"
DATASET="${AXIOM_DATASET:-force-api-railway}"
HERE="$(cd "$(dirname "$0")" && pwd)"
RESULTS_DIR="${RESULTS_DIR:-$HERE/results}"

if [ -z "$TOKEN" ]; then
  echo "[push-metrics] AXIOM_INGEST_TOKEN not set — skipping metric push" >&2
  exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "[push-metrics] jq not found — cannot parse k6 summary files" >&2
  exit 1
fi

shopt -s nullglob
summaries=("$RESULTS_DIR"/summary-*.json)
shopt -u nullglob

if [ "${#summaries[@]}" -eq 0 ]; then
  echo "[push-metrics] no summary-*.json files found in $RESULTS_DIR — nothing to push" >&2
  exit 0
fi

# Build NDJSON payload — one JSON object per summary file.
payload=""
for f in "${summaries[@]}"; do
  # Derive scenario name from filename: summary-storefront-browse-20260524T030000.json → storefront-browse
  filename="$(basename "$f")"
  # strip leading "summary-" and trailing "-<timestamp>.json"
  scenario="${filename#summary-}"
  scenario="${scenario%-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9].json}"

  p95=$(jq -r '.metrics.http_req_duration.values["p(95)"] // "null"' "$f")
  rps=$(jq -r '.metrics.http_reqs.values.rate // "null"' "$f")
  error_rate=$(jq -r '.metrics.http_req_failed.values.rate // "null"' "$f")

  if [ "$p95" = "null" ] && [ "$rps" = "null" ]; then
    echo "[push-metrics] $filename: no http_req_duration metrics — skipping (scenario may have had no HTTP requests)" >&2
    continue
  fi

  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  record="{\"_time\":\"$ts\",\"level\":\"info\",\"message\":\"k6 load test results\",\"scenario\":\"$scenario\",\"p95_ms\":$p95,\"rps\":$rps,\"error_rate\":$error_rate,\"project\":\"force-website-builder\"}"
  payload="${payload}${record}"$'\n'
  echo "[push-metrics] queued: scenario=$scenario p95_ms=$p95 rps=$rps error_rate=$error_rate"
done

if [ -z "$payload" ]; then
  echo "[push-metrics] no valid records to push" >&2
  exit 0
fi

# Axiom ingest endpoint — accepts NDJSON (Content-Type: application/x-ndjson)
response=$(printf '%s' "$payload" | curl -sS -w "\n%{http_code}" -X POST \
  "https://api.axiom.co/v1/datasets/${DATASET}/ingest" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/x-ndjson" \
  --data-binary @-)

http_code="${response##*$'\n'}"
body="${response%$'\n'*}"

if [ "$http_code" -ge 200 ] && [ "$http_code" -lt 300 ]; then
  echo "[push-metrics] axiom ingest OK (HTTP $http_code): $body"
else
  echo "[push-metrics] axiom ingest FAILED (HTTP $http_code): $body" >&2
  exit 1
fi
