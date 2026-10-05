#!/usr/bin/env bash
# Creates the Hyperdrive config the Worker binds as HYPERDRIVE (wrangler.jsonc). Needs a Cloudflare
# API token (CLOUDFLARE_API_TOKEN) and the Neon pooled connection string of the NON-BYPASS role
# `ebda_app` in HYPERDRIVE_CONNECTION_STRING. Never the owner role (R-EBDA-001: no BYPASSRLS role in
# the runtime path).
#
# QUERY CACHING IS DISABLED, deliberately and permanently (design section 3): a Hyperdrive cached read
# is keyed on SQL text + parameters, NOT on the transaction-local tenant GUCs, so caching could serve
# one store's rows to another. `--caching-disabled` is the whole point of this script; tests/unit
# pins it. Do not re-enable without a cross-tenant test that proves the cache key includes the GUC.
#
#   HYPERDRIVE_CONNECTION_STRING='postgres://ebda_app:...@...neon.tech/ebda?sslmode=require' \
#     bash apps/api/scripts/cf-hyperdrive-create.sh [name]
set -euo pipefail
NAME="${1:-ebda-neon}"
: "${HYPERDRIVE_CONNECTION_STRING:?set HYPERDRIVE_CONNECTION_STRING to the ebda_app (non-bypass) pooled URL}"
case "$HYPERDRIVE_CONNECTION_STRING" in
  *neondb_owner*|*postgres:*@*) echo "refusing an owner/superuser connection string: use the ebda_app role" >&2; exit 2 ;;
esac
ROLE="$(node -e 'process.stdout.write(decodeURIComponent(new URL(process.env.HYPERDRIVE_CONNECTION_STRING).username))')"
[ "$ROLE" = ebda_app ] || { echo 'refusing an owner/superuser or unreviewed role: use ebda_app' >&2; exit 2; }
SAFE="$(psql "$HYPERDRIVE_CONNECTION_STRING" -XAt -v ON_ERROR_STOP=1 -c "SELECT NOT (rolsuper OR rolbypassrls) FROM pg_roles WHERE rolname = current_user")"
[ "$SAFE" = t ] || { echo 'refusing an owner/superuser database role' >&2; exit 2; }

npx wrangler hyperdrive create "$NAME" --connection-string="$HYPERDRIVE_CONNECTION_STRING" --caching-disabled
echo "Put the printed id into apps/api/wrangler.jsonc (hyperdrive[0].id) for this environment."
