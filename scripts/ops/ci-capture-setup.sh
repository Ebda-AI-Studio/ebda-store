#!/usr/bin/env bash
# CI-1 (Customer Intelligence capture): the Cloudflare resources the API Worker binds, verify-then-skip.
#   - R2 bucket `ebda-ci` (private) + lifecycle: raw envelopes under outcomes/ expire after 24 months
#   - Queues `ebda-ci-events` and `ebda-ci-events-dlq`
# `wrangler deploy` does NOT create a bucket or a queue: a missing one fails the deploy (which is the safe
# direction). Account: personal/Whisky 11. Token: CF_API_TOKEN from ~/.whisky-services.env (R2 + Queues edit).
# Usage: bash scripts/ops/ci-capture-setup.sh        (idempotent; prints what it changed, never a token)
set -euo pipefail
ENVF="${EBDA_SERVICES_ENV:-$HOME/.whisky-services.env}"
if [ -z "${CF_API_TOKEN:-}" ] && [ -f "$ENVF" ]; then set -a; . "$ENVF"; set +a; fi
ACC="${CF_ACCOUNT_ID:-69188202efc4df480140dd76545aa3ab}"
API="https://api.cloudflare.com/client/v4/accounts/$ACC"
: "${CF_API_TOKEN:?CF_API_TOKEN not set}"
H=(-H "Authorization: Bearer $CF_API_TOKEN" -H "content-type: application/json")
call() { curl -sS "${H[@]}" "$@"; }
ok() { python3 -c 'import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get("success") else (print(json.dumps(d.get("errors")), file=sys.stderr) or 1))'; }
RETENTION_SECONDS=63072000   # 730 days = lib/ci/config.ts CI_RAW_RETENTION_DAYS (pinned by tests/unit/ci-config.test.ts)

echo "1/3 bucket ebda-ci"
if call "$API/r2/buckets/ebda-ci" | python3 -c 'import sys,json; sys.exit(0 if json.load(sys.stdin).get("success") else 1)'; then
  echo "  exists: skipped"
else
  call -X POST "$API/r2/buckets" -d '{"name":"ebda-ci"}' | ok; echo "  created (private: no public access, no custom domain)"
fi

echo "2/3 lifecycle: outcomes/ and index/ 730 days, tombstone/ and dlq/ 30 days"
RULES='[
 {"id":"Default Multipart Abort Rule","enabled":true,"conditions":{},"abortMultipartUploadsTransition":{"condition":{"type":"Age","maxAge":604800}}},
 {"id":"expire-ci-raw-24m","enabled":true,"conditions":{"prefix":"outcomes/"},"deleteObjectsTransition":{"condition":{"type":"Age","maxAge":63072000}}},
 {"id":"expire-ci-index-24m","enabled":true,"conditions":{"prefix":"index/"},"deleteObjectsTransition":{"condition":{"type":"Age","maxAge":63072000}}},
 {"id":"expire-ci-tombstone-30d","enabled":true,"conditions":{"prefix":"tombstone/"},"deleteObjectsTransition":{"condition":{"type":"Age","maxAge":2592000}}},
 {"id":"expire-ci-dlq-30d","enabled":true,"conditions":{"prefix":"dlq/"},"deleteObjectsTransition":{"condition":{"type":"Age","maxAge":2592000}}}]'
if call "$API/r2/buckets/ebda-ci/lifecycle" | python3 -c '
import sys,json
d=json.load(sys.stdin)
want={("expire-ci-raw-24m","outcomes/",63072000),("expire-ci-index-24m","index/",63072000),("expire-ci-tombstone-30d","tombstone/",2592000),("expire-ci-dlq-30d","dlq/",2592000)}
got=set()
for r in (d.get("result") or {}).get("rules") or []:
    t=(r.get("deleteObjectsTransition") or {}).get("condition") or {}
    if r.get("enabled"): got.add((r.get("id"),(r.get("conditions") or {}).get("prefix"),t.get("maxAge")))
sys.exit(0 if want<=got else 1)'; then
  echo "  already in place: skipped"
else
  call -X PUT "$API/r2/buckets/ebda-ci/lifecycle" -d "{\"rules\":$RULES}" | ok
  echo "  written"
fi

echo "3/3 queues"
EXISTING="$(call "$API/queues?per_page=100" | python3 -c 'import sys,json; print(" ".join(q["queue_name"] for q in (json.load(sys.stdin).get("result") or [])))')"
for q in ebda-ci-events ebda-ci-events-dlq; do
  case " $EXISTING " in
    *" $q "*) echo "  $q exists: skipped" ;;
    *) call -X POST "$API/queues" -d "{\"queue_name\":\"$q\"}" | ok; echo "  $q created" ;;
  esac
done
