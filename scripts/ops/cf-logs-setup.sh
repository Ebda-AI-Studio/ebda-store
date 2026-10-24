#!/usr/bin/env bash
# G7: Workers Logs + Logpush to R2 with 30-day retention, and the PDPL export-bundle expiry (G10).
# Idempotent. Account: personal/Whisky 11 (69188202efc4df480140dd76545aa3ab).
#
# Steps and the token each needs (the wrangler OAuth login has NONE of these scopes):
#   1  bucket ebda-logs + 30-day lifecycle          CF_API_TOKEN: Account > Workers R2 Storage > Edit
#   2  ebda-private lifecycle: exports/ expire 7 d  same token (keeps the existing multipart-abort rule)
#   3  Logpush job (workers_trace_events -> R2)     CF_API_TOKEN also needs Account > Logs > Edit, plus
#                                                    LOGPUSH_R2_ACCESS_KEY_ID / LOGPUSH_R2_SECRET_ACCESS_KEY:
#                                                    an R2 API token, Object Read & Write, scoped to ebda-logs ONLY
# Usage: set -a; . ~/.whisky-services.env; set +a; bash scripts/ops/cf-logs-setup.sh
set -euo pipefail
ACC="${CF_ACCOUNT_ID:-69188202efc4df480140dd76545aa3ab}"
API="https://api.cloudflare.com/client/v4/accounts/$ACC"
: "${CF_API_TOKEN:?CF_API_TOKEN not set}"
H=(-H "Authorization: Bearer $CF_API_TOKEN" -H "content-type: application/json")
call() { curl -sS "${H[@]}" "$@"; }
ok() { python3 -c 'import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get("success") else (print(json.dumps(d.get("errors")), file=sys.stderr) or 1))'; }

echo "1/3 bucket ebda-logs"
if call "$API/r2/buckets/ebda-logs" | ok 2>/dev/null; then echo "  exists"; else
  call -X POST "$API/r2/buckets" -d '{"name":"ebda-logs"}' | ok; echo "  created"; fi
call -X PUT "$API/r2/buckets/ebda-logs/lifecycle" \
  -d '{"rules":[{"id":"expire-30d","enabled":true,"conditions":{"prefix":""},"deleteObjectsTransition":{"condition":{"type":"Age","maxAge":2592000}}}]}' | ok
echo "  lifecycle: delete after 30 days"

echo "2/3 ebda-private lifecycle (exports/ 7 days)"
call -X PUT "$API/r2/buckets/ebda-private/lifecycle" -d '{"rules":[
 {"id":"Default Multipart Abort Rule","enabled":true,"conditions":{},"abortMultipartUploadsTransition":{"condition":{"type":"Age","maxAge":604800}}},
 {"id":"expire-pdpl-exports-7d","enabled":true,"conditions":{"prefix":"exports/"},"deleteObjectsTransition":{"condition":{"type":"Age","maxAge":604800}}}]}' | ok
echo "  ok"

echo "3/3 Logpush job"
if [ -z "${LOGPUSH_R2_ACCESS_KEY_ID:-}" ] || [ -z "${LOGPUSH_R2_SECRET_ACCESS_KEY:-}" ]; then
  echo "  SKIPPED: set LOGPUSH_R2_ACCESS_KEY_ID / LOGPUSH_R2_SECRET_ACCESS_KEY (R2 token scoped to ebda-logs)"; exit 3; fi
JOBS="$(call "$API/logpush/jobs")"
if echo "$JOBS" | python3 -c 'import sys,json; d=json.load(sys.stdin); sys.exit(0 if any(j.get("name")=="ebda-workers-trace" for j in d.get("result") or []) else 1)'; then
  echo "  job ebda-workers-trace exists"; exit 0; fi
# Only the five Ebda Workers; fields trimmed to what an incident needs (no request headers/bodies).
FILTER='{"where":{"key":"ScriptName","operator":"in","value":["ebda-api","ebda-web","ebda-admin","ebda-marketing","ebda-orders"]}}'
BODY="$(python3 - "$FILTER" <<PY
import json,sys,os
print(json.dumps({
 "name":"ebda-workers-trace","dataset":"workers_trace_events","enabled":True,
 "destination_conf":"r2://ebda-logs/workers/{DATE}?account-id=$ACC&access-key-id=%s&secret-access-key=%s" % (os.environ["LOGPUSH_R2_ACCESS_KEY_ID"], os.environ["LOGPUSH_R2_SECRET_ACCESS_KEY"]),
 "output_options":{"field_names":["Event","EventTimestampMs","Outcome","Exceptions","Logs","ScriptName","ScriptVersion","DispatchNamespace"]},
 "filter":sys.argv[1]}))
PY
)"
call -X POST "$API/logpush/jobs" -d "$BODY" | ok
echo "  job created"
