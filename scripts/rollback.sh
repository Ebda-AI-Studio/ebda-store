#!/usr/bin/env bash
# Emergency production rollback for Force Website Builder.
# Auto-redeploys: Cloudflare Workers web/admin/orders (via cf-deploy.yml → wrangler
# deploy) + Railway API (git auto-deploy).
#
# What it does:
#   1. Refuses to run if there are uncommitted changes.
#   2. Warns if HEAD includes a Prisma migration (code rollback won't undo schema).
#   3. `git revert HEAD --no-edit && git push` — cf-deploy.yml re-runs and wrangler
#      deploys the reverted Workers; Railway auto-redeploys the API from main.
#
# For the instant per-worker fast-path (`wrangler rollback` / `railway rollback`,
# no code change), see docs/ROLLBACK.md "A. Per-worker fast-path".
# For migration rollback (local pg_dump restore), see docs/ROLLBACK.md
# "C. Migration rollback".
#
# Usage:
#   bash scripts/rollback.sh

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

if ! git diff --quiet || ! git diff --staged --quiet; then
  echo "ERROR: uncommitted changes present. Stash or commit them first, then re-run." >&2
  exit 1
fi

# FWB writes hand-built migrations under packages/database/prisma/migrations/<TS>_<name>/migration.sql
if git diff HEAD~1 HEAD --name-only | grep -qE "packages/database/prisma/migrations|migration\.sql$"; then
  echo "⚠️  HEAD includes a Prisma migration. Code rollback won't undo schema changes."
  echo "   See docs/ROLLBACK.md → 'C. Migration rollback'"
  echo
  read -p "Continue with code-only rollback anyway? [y/N] " -n 1 -r REPLY; echo
  [[ $REPLY =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }
fi

echo "Current HEAD: $(git log -1 --pretty='%h %s')"
echo "Reverting and pushing..."
git revert HEAD --no-edit
git push

echo
echo "✓ Pushed revert commit to main."
echo "  Cloudflare Workers (apps/web, admin, orders) redeploy via cf-deploy.yml in ~3-5 min."
echo "  Railway API                                  redeploys in ~2-3 min."
echo
echo "  Watch Workers: gh run watch  (or GitHub Actions → cf-deploy.yml)"
echo "  Watch Railway: railway logs --service api -e production"
