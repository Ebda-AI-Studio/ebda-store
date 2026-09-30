#!/usr/bin/env bash
# Generate the Cloudflare/OpenNext worker config for the FWB Next apps so
# `bash scripts/cf-build.sh <app>` then `wrangler deploy` works.
#
# apps/<app>/open-next.config.ts and wrangler.jsonc ARE committed (.gitignore
# records why), but THIS script overwrites both on every deploy
# (.github/workflows/cf-deploy.yml) and in ci.yml's cf-build-check — the
# committed copies are a local-dev fallback, and editing them changes nothing
# that ships. Edit this script instead. The generated result is asserted by
# scripts/assert-cf-cache-bindings.sh in both places.
#
# Idempotent — safe to re-run.
# Usage: bash scripts/cf-setup-local.sh [web admin orders]   (default: all three)
# CF_SETUP_SKIP_DEPS=1 skips step 1 (the devDep install) — CI already has the
# pinned @opennextjs/cloudflare + wrangler from `npm ci`, since both are
# declared in apps/{web,admin,orders}/package.json at the same pins.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Default to all three apps when no args; otherwise honor the given list.
if [ "$#" -eq 0 ]; then APPS=(web admin orders); else APPS=("$@"); fi
CF_DEP="@opennextjs/cloudflare@1.19.11"
WRANGLER="wrangler@^4.86.0"

# 1. devDeps. Already declared in each app's package.json at these pins, so this
#    is a no-op reinstall on a fresh `npm ci`; kept for a checkout that predates
#    them. CF_SETUP_SKIP_DEPS=1 skips it.
for app in "${APPS[@]}"; do
  [ "${CF_SETUP_SKIP_DEPS:-}" = "1" ] && break
  [ -d "$ROOT/apps/$app" ] || { echo "skip deps: no apps/$app"; continue; }
  echo "→ installing CF devDeps for @force/$app"
  npm i -D "$CF_DEP" "$WRANGLER" -w "@force/$app" --no-audit --no-fund
done

# 2. per-app open-next.config.ts + wrangler.jsonc
#
# ROUTES — the `force-ai.co` production hostnames each worker owns. These MUST be
# emitted here so a CI `wrangler deploy` (.github/workflows/cf-deploy.yml) binds
# the correct domains; a route-less worker deploys to *.workers.dev only and the
# live custom hostnames stop resolving.
#
# web carries an extra `*/*` zone route: it is the Cloudflare-for-SaaS FALLBACK
# ORIGIN, so every merchant Custom Hostname (wadyaljuz.com, …) proxies through
# the storefront worker. A bare fallback-origin custom domain alone returns HTTP
# 522 — the `*/*` zone route is what makes the worker actually answer those
# proxied requests (GOTCHA 4 in the cutover runbook).
#
# CRITICAL (GOTCHA 5, 2026-06-25): that `*/*` route OVERRIDES the admin/orders
# custom domains in the SAME zone — Cloudflare does NOT let a custom domain win
# over a `*/*` zone route, so admin/orders.force-ai.co would just serve the
# storefront. The fix: give admin/orders a MORE-SPECIFIC zone route
# (`admin.force-ai.co/*`) which DOES beat `*/*`. So each carries BOTH its
# custom_domain (for DNS + edge cert) AND the specific zone route (to win routing
# priority). wrangler accepts both for the same host. Verified live 2026-06-25.
for app in "${APPS[@]}"; do
  dir="$ROOT/apps/$app"
  [ -d "$dir" ] || { echo "skip config: no apps/$app"; continue; }
  # NOTE: each branch is ONE $'...' literal (zone hardcoded) so every \n expands.
  # Interpolating a $VAR mid-string would re-quote the tail and emit literal \n.
  case "$app" in
    web)    ROUTES_JSON=$'  "routes": [\n    { "pattern": "store.force-ai.co", "custom_domain": true },\n    { "pattern": "cf.force-ai.co", "custom_domain": true },\n    { "pattern": "pecannbee.com.kw/*", "zone_name": "pecannbee.com.kw" },\n    { "pattern": "www.pecannbee.com.kw/*", "zone_name": "pecannbee.com.kw" },\n    { "pattern": "*/*", "zone_name": "force-ai.co" }\n  ],\n' ;;
    admin)  ROUTES_JSON=$'  "routes": [\n    { "pattern": "admin.force-ai.co", "custom_domain": true },\n    { "pattern": "admin.force-ai.co/*", "zone_name": "force-ai.co" }\n  ],\n' ;;
    orders) ROUTES_JSON=$'  "routes": [\n    { "pattern": "orders.force-ai.co", "custom_domain": true },\n    { "pattern": "orders.force-ai.co/*", "zone_name": "force-ai.co" }\n  ],\n' ;;
    *)      ROUTES_JSON='' ;;
  esac
  # apps/web deploys a CUSTOM Worker entry (sentry-worker-entry.ts) that wraps the
  # OpenNext handler with @sentry/cloudflare (SSR error capture) AND reverse-proxies
  # the force-ai.co / www company apex to Cloudflare Pages. Other apps deploy the raw
  # OpenNext worker. Keep this in sync with the committed apps/web/wrangler.jsonc —
  # this generator OVERWRITES that file, so `main` MUST be set here too (else the
  # custom entry is silently dropped and Sentry SSR + the apex proxy never deploy).
  if [ "$app" = "web" ]; then
    MAIN_ENTRY="sentry-worker-entry.ts"
    COMPAT_DATE="2025-08-16"   # >= required by @sentry/cloudflare (https.request)
  else
    MAIN_ENTRY=".open-next/worker.js"
    COMPAT_DATE="2025-03-25"
  fi
  # OpenNext cache config (2026-06-27). DEFAULT = empty config = current
  # behaviour, ZERO risk. When OPENNEXT_CACHE=true (a repo variable threaded by
  # cf-deploy.yml) AND this is the storefront (web), emit the R2 incremental
  # cache + sharded-Durable-Object tag cache + DO queue so revalidateTag works
  # ACROSS isolates — a merchant theme/brand-color save then applies in ~1s
  # instead of up to ~15s (each isolate's memory cache was independent).
  #
  # PRE-REQS before enabling: the R2 bucket `force-web-opennext-cache` must exist
  # (cf-deploy.yml creates it idempotently), and the change MUST be verified on a
  # CF PREVIEW deploy first — the DO binding class names below are the documented
  # OpenNext names and must match `.open-next/worker.js`'s exports for that
  # version. Import paths + default-export shapes verified against
  # @opennextjs/cloudflare@1.19.11. See docs/migration/cf-opennext-hardening-plan.md.
  if [ "${OPENNEXT_CACHE:-}" = "true" ] && [ "$app" = "web" ]; then
    cat > "$dir/open-next.config.ts" <<'EOF'
import { defineCloudflareConfig } from '@opennextjs/cloudflare';
import r2IncrementalCache from '@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache';
import doShardedTagCache from '@opennextjs/cloudflare/overrides/tag-cache/do-sharded-tag-cache';
import doQueue from '@opennextjs/cloudflare/overrides/queue/do-queue';
import queueCache from '@opennextjs/cloudflare/overrides/queue/queue-cache';

// All four are DEFAULT exports in @opennextjs/cloudflare@1.19.11 (verified).
export default defineCloudflareConfig({
  incrementalCache: r2IncrementalCache,
  tagCache: doShardedTagCache({ baseShardSize: 12, regionalCache: true }),
  queue: queueCache(doQueue),
  enableCacheInterception: true,
});
EOF
    # The DO classes live in the OpenNext-GENERATED worker, but web's `main` is
    # the custom Sentry entry, which doesn't re-export them — workerd then
    # warns "no such Durable Object class is exported" at deploy time and
    # every tag-cache/queue call fails at runtime (observed on the first
    # OPENNEXT_CACHE=true deploy, 2026-07-12). Generate a wrapper entry that
    # re-exports the wrapped handler plus both DO classes. Class names
    # re-verified against @opennextjs/cloudflare@1.19.11
    # dist/cli/templates/worker.js: DOQueueHandler + DOShardedTagCache (the
    # queue class is NOT "DurableObjectQueueHandler" — that earlier guess
    # would have broken the NEXT_CACHE_DO_QUEUE binding).
    #
    # Migration tag v1 was NOT re-used over an applied DurableObjectQueueHandler
    # namespace (issue 715): Cloudflare refuses a deploy that binds a Durable
    # Object class with no applied migration, and every storefront deploy since
    # has bound NEXT_CACHE_DO_QUEUE → DOQueueHandler and succeeded (e.g.
    # cf-deploy run 36660446440, 2026-09-30, version f79154b6: "env.NEXT_CACHE_
    # DO_QUEUE (DOQueueHandler) Durable Object"). So v1 carries DOQueueHandler.
    # A future class change needs a NEW tag (v2 + renamed_classes), never v1.
    if [ "$app" = "web" ]; then
      cat > "$dir/cache-worker-entry.ts" <<'EOF'
// GENERATED by scripts/cf-setup-local.sh when OPENNEXT_CACHE=true — do not edit.
// Wraps the Sentry worker entry and re-exports the OpenNext Durable Object
// classes that the wrangler.jsonc DO bindings reference.
export { default } from './sentry-worker-entry';
// @ts-expect-error — `.open-next/worker.js` is generated at build time
export { DOQueueHandler, DOShardedTagCache } from './.open-next/worker.js';
EOF
      MAIN_ENTRY="cache-worker-entry.ts"
    fi
    cat > "$dir/wrangler.jsonc" <<EOF
{
  "name": "force-$app-cf-preview",
  "main": "${MAIN_ENTRY}",
  "compatibility_date": "${COMPAT_DATE}",
  "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
  "assets": { "directory": ".open-next/assets", "binding": "ASSETS" },
  "services": [{ "binding": "WORKER_SELF_REFERENCE", "service": "force-$app-cf-preview" }],
  "r2_buckets": [{ "binding": "NEXT_INC_CACHE_R2_BUCKET", "bucket_name": "force-web-opennext-cache" }],
  "durable_objects": { "bindings": [
    { "name": "NEXT_TAG_CACHE_DO_SHARDED", "class_name": "DOShardedTagCache" },
    { "name": "NEXT_CACHE_DO_QUEUE", "class_name": "DOQueueHandler" }
  ] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["DOShardedTagCache", "DOQueueHandler"] }],
${ROUTES_JSON}  "observability": { "enabled": true }
}
EOF
  else
    cat > "$dir/open-next.config.ts" <<'EOF'
import { defineCloudflareConfig } from '@opennextjs/cloudflare';
export default defineCloudflareConfig({});
EOF
    cat > "$dir/wrangler.jsonc" <<EOF
{
  "name": "force-$app-cf-preview",
  "main": "${MAIN_ENTRY}",
  "compatibility_date": "${COMPAT_DATE}",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "directory": ".open-next/assets", "binding": "ASSETS" },
${ROUTES_JSON}  "observability": { "enabled": true }
}
EOF
  fi
  echo "✓ wrote apps/$app/{open-next.config.ts,wrangler.jsonc}"
done

echo
echo "Done. Build + deploy a preview worker:"
echo "  bash scripts/cf-build.sh web    # then: (cd apps/web && npx wrangler deploy)"
