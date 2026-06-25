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
# proxied requests (GOTCHA 4 in the cutover runbook). admin/orders are plain
# single-host workers (their custom_domain routes win over web's `*/*` catch-all).
for app in "${APPS[@]}"; do
  dir="$ROOT/apps/$app"
  [ -d "$dir" ] || { echo "skip config: no apps/$app"; continue; }
  # NOTE: each branch is ONE $'...' literal (zone hardcoded) so every \n expands.
  # Interpolating a $VAR mid-string would re-quote the tail and emit literal \n.
  case "$app" in
    web)    ROUTES_JSON=$'  "routes": [\n    { "pattern": "store.force-ai.co", "custom_domain": true },\n    { "pattern": "cf.force-ai.co", "custom_domain": true },\n    { "pattern": "*/*", "zone_name": "force-ai.co" }\n  ],\n' ;;
    admin)  ROUTES_JSON=$'  "routes": [\n    { "pattern": "admin.force-ai.co", "custom_domain": true }\n  ],\n' ;;
    orders) ROUTES_JSON=$'  "routes": [\n    { "pattern": "orders.force-ai.co", "custom_domain": true }\n  ],\n' ;;
    *)      ROUTES_JSON='' ;;
  esac
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
  echo "✓ wrote apps/$app/{open-next.config.ts,wrangler.jsonc}"
done

echo
echo "Done. Build + deploy a preview worker:"
echo "  bash scripts/cf-build.sh web    # then: (cd apps/web && npx wrangler deploy)"
