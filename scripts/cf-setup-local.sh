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
for app in "${APPS[@]}"; do
  dir="$ROOT/apps/$app"
  [ -d "$dir" ] || { echo "skip config: no apps/$app"; continue; }
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
  "assets": { "directory": ".open-next/assets", "binding": "ASSETS" }
}
EOF
  echo "✓ wrote apps/$app/{open-next.config.ts,wrangler.jsonc}"
done

echo
echo "Done. Build + deploy a preview worker:"
echo "  bash scripts/cf-build.sh web    # then: (cd apps/web && npx wrangler deploy)"
