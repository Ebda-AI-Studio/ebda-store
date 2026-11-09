#!/usr/bin/env bash
# Assert the worker config scripts/cf-setup-local.sh just GENERATED matches the
# OPENNEXT_CACHE mode. ONE copy, run by both .github/workflows/cf-{web,admin,orders}-deploy.yml
# (before every storefront deploy) and ci.yml's worker-dry-run (on every PR
# that can move the Worker bundle) — issues 2089/2152/2154: CI used to build
# the committed config, which the generator overwrites, so it never exercised
# the config that ships and never ran this assertion.
#
# Why it exists: cf-setup-local.sh rewrites open-next.config.ts and
# wrangler.jsonc from scratch, and its no-cache branch silently drops the tag
# cache, the R2 incremental cache and their bindings. revalidateTag then
# resolves to the library's "dummy" no-op — every purge returns success,
# invalidates nothing, and merchants wait out the fetch TTL after each save
# while the pipeline stays green. That is how a D1 tag cache was committed,
# documented as REQUIRED and never deployed.
#
# Mode is EXPLICIT (issue 2240). Only the storefront (web) carries the cache:
#   OPENNEXT_CACHE=true   → the three cache tokens must be present
#   OPENNEXT_CACHE=false  → the documented empty-cache fallback must be present
#                           (the deliberate escape hatch for a bad cache rollout)
#   anything else         → FAIL. Unset, renamed or mistyped ('True', 'ture')
#                           used to fall into the empty-cache branch and deploy
#                           the silent no-op with a green tick — the variable's
#                           loss was undetectable.
# admin/orders never carry cache bindings; they are asserted empty whatever
# the variable says.
#
# Ruling EDGE-BUILD-1: the storefront's two HTML edge caches (apps/web/
# demo-edge-cache.ts, store-edge-cache.ts) put the Worker version id in their
# cache key, read from the CF_VERSION_METADATA binding. Without the binding
# there is no id and both layers switch themselves off (fail closed: slow, not
# broken) — a storefront that renders every page from scratch with a green
# pipeline. So in BOTH modes the web config must carry the binding.
#
# Usage: OPENNEXT_CACHE=<true|false> bash scripts/assert-cf-cache-bindings.sh <web|admin|orders>
set -euo pipefail

APP="${1:?usage: assert-cf-cache-bindings.sh <web|admin|orders>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/apps/$APP"
WRANGLER="$DIR/wrangler.jsonc"
ONC="$DIR/open-next.config.ts"
[ -f "$WRANGLER" ] && [ -f "$ONC" ] || { echo "::error::apps/$APP has no generated wrangler.jsonc/open-next.config.ts — run scripts/cf-setup-local.sh $APP first"; exit 1; }

mode="empty"
if [ "$APP" = "web" ]; then
  case "${OPENNEXT_CACHE:-}" in
    true) mode="cache" ;;
    false) mode="empty" ;;
    *)
      echo "::error::OPENNEXT_CACHE is '${OPENNEXT_CACHE:-<unset>}' — it must be exactly 'true' (R2 + DO tag cache) or 'false' (the documented empty-cache fallback). An unset or mistyped value used to deploy the empty cache silently, turning every revalidateTag into a no-op. Set the repo variable."
      exit 1 ;;
  esac
fi

if [ "$APP" = "web" ]; then
  grep -qE '"version_metadata"[[:space:]]*:[[:space:]]*\{[[:space:]]*"binding"[[:space:]]*:[[:space:]]*"CF_VERSION_METADATA"' "$WRANGLER" \
    || { echo "::error::generated apps/$APP/wrangler.jsonc has NO version_metadata binding named CF_VERSION_METADATA — the HTML edge caches key on the Worker version id (Ruling EDGE-BUILD-1) and switch OFF without it: every storefront page would render from scratch. Check scripts/cf-setup-local.sh"; exit 1; }
fi

if [ "$mode" = "cache" ]; then
  grep -q 'NEXT_TAG_CACHE' "$WRANGLER" \
    || { echo "::error::OPENNEXT_CACHE=true but generated apps/$APP/wrangler.jsonc has NO tag-cache binding — revalidateTag would be a silent no-op. Check scripts/cf-setup-local.sh"; exit 1; }
  grep -q 'NEXT_INC_CACHE_R2_BUCKET' "$WRANGLER" \
    || { echo "::error::OPENNEXT_CACHE=true but generated apps/$APP/wrangler.jsonc has NO incremental-cache binding — ISR/SSG pages would revalidate from origin on every isolate"; exit 1; }
  grep -q 'tagCache' "$ONC" \
    || { echo "::error::OPENNEXT_CACHE=true but generated apps/$APP/open-next.config.ts declares no tagCache override — revalidateTag resolves to the dummy no-op"; exit 1; }
  echo "apps/$APP: cache bindings present in the config that will actually deploy"
else
  if grep -qE 'r2_buckets|durable_objects' "$WRANGLER"; then
    echo "::error::apps/$APP: expected the empty-cache config but generated wrangler.jsonc carries cache bindings. Check scripts/cf-setup-local.sh"
    exit 1
  fi
  if grep -q 'tagCache' "$ONC"; then
    echo "::error::apps/$APP: expected the empty-cache config but generated open-next.config.ts declares a tagCache override. Check scripts/cf-setup-local.sh"
    exit 1
  fi
  echo "apps/$APP: empty-cache config present, as expected"
fi
