#!/usr/bin/env bash
# Cut ONE store's frontend from Vercel to Cloudflare-for-SaaS.
#   1) creates the CF custom hostname, 2) flips Store.domainProvider='cloudflare',
#   3) prints the CNAME the merchant must set. DNS itself is changed by the merchant/you.
# Reversible: re-run with --rollback to set the provider back to 'vercel' + delete the
# CF custom hostname.
#
# Usage:
#   CF_API_TOKEN=... CF_ZONE_ID=... CF_FALLBACK_ORIGIN=cf.forcemediakw.com \
#   DATABASE_URL=... bash scripts/cf-migrate-store.sh <store-slug> [--rollback]
set -euo pipefail
SLUG="${1:?usage: cf-migrate-store.sh <slug> [--rollback]}"
MODE="${2:-}"
: "${CF_API_TOKEN:?set CF_API_TOKEN}"
: "${CF_ZONE_ID:?set CF_ZONE_ID}"
: "${DATABASE_URL:?set DATABASE_URL}"
CF="https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/custom_hostnames"
db() { command psql "$DATABASE_URL" -t -A "$@"; }

DOMAIN=$(db -c "SELECT domain FROM stores WHERE slug='$SLUG' AND domain IS NOT NULL;")
[ -n "$DOMAIN" ] || {
  echo "store '$SLUG' has no custom domain — nothing to cut over." >&2
  exit 1
}

if [ "$MODE" = "--rollback" ]; then
  ID=$(curl -s -H "Authorization: Bearer $CF_API_TOKEN" "$CF?hostname=$DOMAIN" |
    python3 -c "import sys,json;r=json.load(sys.stdin).get('result') or [];print(r[0]['id'] if r else '')")
  if [ -n "$ID" ]; then
    curl -s -X DELETE -H "Authorization: Bearer $CF_API_TOKEN" "$CF/$ID" >/dev/null &&
      echo "deleted CF hostname $ID"
  fi
  db -c "UPDATE stores SET domain_provider='vercel' WHERE slug='$SLUG';" >/dev/null
  echo "↩︎  $SLUG ($DOMAIN) reverted to vercel"
  exit 0
fi

echo "→ provisioning CF custom hostname for $DOMAIN"
curl -s -X POST -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
  -d "{\"hostname\":\"$DOMAIN\",\"ssl\":{\"method\":\"http\",\"type\":\"dv\",\"settings\":{\"min_tls_version\":\"1.2\"}}}" \
  "$CF" |
  python3 -c "import sys,json;d=json.load(sys.stdin);print('  CF:',('ok '+d['result']['id']) if d.get('success') else ('FAILED '+json.dumps(d.get('errors'))))"
db -c "UPDATE stores SET domain_provider='cloudflare' WHERE slug='$SLUG';" >/dev/null
echo "✓ $SLUG ($DOMAIN) provider → cloudflare"
echo
echo "MERCHANT DNS — set this ONE record, then watch SSL go active (minutes):"
echo "  CNAME  $DOMAIN  →  ${CF_FALLBACK_ORIGIN:-cf.forcemediakw.com}"
echo "Verify: admin → store → Domain (status flips to verified once SSL is active)."
echo "Rollback: bash scripts/cf-migrate-store.sh $SLUG --rollback"
