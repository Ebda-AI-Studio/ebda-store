#!/usr/bin/env bash
# Generate the LOCAL-ONLY Cloudflare/OpenNext build tooling for the FWB Next apps
# so `bash scripts/cf-build.sh <app>` then `wrangler deploy` works. These files are
# git-ignored on purpose (see .gitignore / docs/migration/cloudflare-preview-workers.md):
# open-next.config.ts imports @opennextjs/cloudflare, an untracked devDep that breaks
# the Vercel/CI typecheck if committed.
#
# Idempotent — safe to re-run.
# Usage: bash scripts/cf-setup-local.sh [web admin orders]   (default: all three)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Default to all three apps when no args; otherwise honor the given list.
if [ "$#" -eq 0 ]; then APPS=(web admin orders); else APPS=("$@"); fi
CF_DEP="@opennextjs/cloudflare@1.19.11"
WRANGLER="wrangler@^4.86.0"

# 1. devDeps (local only — never committed to package.json to keep Vercel/CI lean)
for app in "${APPS[@]}"; do
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
    web)    ROUTES_JSON=$'  "routes": [\n    { "pattern": "store.force-ai.co", "custom_domain": true },\n    { "pattern": "cf.force-ai.co", "custom_domain": true },\n    { "pattern": "*/*", "zone_name": "force-ai.co" }\n  ],\n' ;;
    admin)  ROUTES_JSON=$'  "routes": [\n    { "pattern": "admin.force-ai.co", "custom_domain": true },\n    { "pattern": "admin.force-ai.co/*", "zone_name": "force-ai.co" }\n  ],\n' ;;
    orders) ROUTES_JSON=$'  "routes": [\n    { "pattern": "orders.force-ai.co", "custom_domain": true },\n    { "pattern": "orders.force-ai.co/*", "zone_name": "force-ai.co" }\n  ],\n' ;;
    *)      ROUTES_JSON='' ;;
  esac
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
    cat > "$dir/wrangler.jsonc" <<EOF
{
  "name": "force-$app-cf-preview",
  "main": ".open-next/worker.js",
  "compatibility_date": "2025-03-25",
  "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
  "assets": { "directory": ".open-next/assets", "binding": "ASSETS" },
  "services": [{ "binding": "WORKER_SELF_REFERENCE", "service": "force-$app-cf-preview" }],
  "r2_buckets": [{ "binding": "NEXT_INC_CACHE_R2_BUCKET", "bucket_name": "force-web-opennext-cache" }],
  "durable_objects": { "bindings": [
    { "name": "NEXT_TAG_CACHE_DO_SHARDED", "class_name": "DOShardedTagCache" },
    { "name": "NEXT_CACHE_DO_QUEUE", "class_name": "DurableObjectQueueHandler" }
  ] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["DOShardedTagCache", "DurableObjectQueueHandler"] }],
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
  "main": ".open-next/worker.js",
  "compatibility_date": "2025-03-25",
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
