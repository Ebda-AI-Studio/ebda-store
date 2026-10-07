#!/usr/bin/env bash
# Guest-checkout admission probe — ONE copy, called by both
# .github/workflows/railway-deploy.yml jobs (the post-deploy "Verify guest
# checkout is still admitted" step and the hourly guest-checkout-probe job).
#
# On 2026-09-03 a correct security fix (removing the merchant-origin CSRF
# exemption) made POST /payments/create unreachable for cookieless guests, and
# demo-store.example took 17 orders over two days without a single payment row.
# This asserts the ADMISSION decision only: a deliberately non-existent order
# id means a healthy API answers 404 NOT_FOUND — the request cleared CSRF and
# reached business logic — and nothing is created. A CSRF_* code means guests
# are locked out of the money path again.
#
# Why one script (issue 2191): the deploy step gained a bounded retry (#1535)
# while the hourly copy kept firing a single curl, so a lone 429 (paymentLimiter
# is IP-keyed behind a shared runner IP) or a 502 during a replica swap paged
# "CSRF lockout" on the only continuous monitor of the guest card-payment path.
# Two copies of one probe drift; this file is the probe.
#
# Classification, in order:
#   404                 → admitted, exit 0
#   000 / 429 / 5xx     → retry-worthy (checked BEFORE the body: an infra-level
#                         failure's body is a load-balancer page or nothing,
#                         which would otherwise read as __UNPARSEABLE__)
#   CSRF_*              → deterministic lockout, fail immediately (no retry)
#   unparseable body    → fail: admission could not be verified
#   anything else       → fail: admission unverified
# It cannot pass vacuously: a dead host, an unparseable body or any non-404
# status fails rather than being read as healthy.
#
# Env: API_BASE (required), PROBE_SESSION_ID (X-Session-ID, default
# admission-probe), PROBE_ATTEMPTS (default 5), PROBE_SLEEP_SECS (default 5).
# Requires curl and node on PATH.
set -euo pipefail

: "${API_BASE:?API_BASE is required (e.g. https://api.ebda.app)}"
SESSION_ID="${PROBE_SESSION_ID:-admission-probe}"
ATTEMPTS="${PROBE_ATTEMPTS:-5}"
SLEEP_SECS="${PROBE_SLEEP_SECS:-5}"

probe_args=(-s -m 20 -X POST "$API_BASE/api/v1/payments/create" -H 'Content-Type: application/json' -H "X-Session-ID: $SESSION_ID" -d '{"orderId":"00000000-0000-0000-0000-000000000000","provider":"tap"}')

code=000
err=''
for i in $(seq 1 "$ATTEMPTS"); do
  body=$(mktemp) || body="${RUNNER_TEMP:-/tmp}/admission-probe.json"
  code=$(curl "${probe_args[@]}" -o "$body" -w '%{http_code}') || code=000
  err=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s)?.error?.code ?? ""))}catch{process.exit(3)}})' < "$body" 2>/dev/null) || err='__UNPARSEABLE__'
  echo "attempt $i: status=$code error_code=${err:-<none>}"

  if [ "$code" = "404" ]; then
    echo "Guest checkout admitted: cleared CSRF and reached business logic."
    exit 0
  fi

  case "$code" in
    000 | 429 | 5??)
      echo "retry-worthy: status=$code error_code=${err:-<none>} — waiting ${SLEEP_SECS}s"
      sleep "$SLEEP_SECS"
      continue ;;
  esac

  case "$err" in
    CSRF_*)
      echo "::error::Guest checkout is locked out again: POST /payments/create returned $code $err for a cookieless request. This is the 2026-09-03 regression. Do not leave this build serving."
      exit 1 ;;
    __UNPARSEABLE__)
      echo "::error::$API_BASE/api/v1/payments/create returned $code with a body this probe could not parse, so admission could not be verified. A broken check is not a healthy deploy."
      exit 1 ;;
  esac

  echo "::error::Expected 404 NOT_FOUND for a non-existent order (proving the request cleared CSRF and reached business logic), got $code ${err:-<none>}. Admission is unverified."
  exit 1
done

echo "::error::Guest checkout admission never reached a verifiable state after $ATTEMPTS attempts (last: status=$code error_code=${err:-<none>}) — likely still rate-limited or a persistent 5xx. Admission is unverified."
exit 1
