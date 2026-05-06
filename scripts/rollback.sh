#!/usr/bin/env bash
# Emergency production rollback for Force Website Builder.
# Auto-redeploys: Vercel admin (apps/admin) + Vercel storefront (apps/web) + Railway API.
#
# What it does:
#   1. Refuses to run if there are uncommitted changes.
#   2. Warns if HEAD includes a Prisma migration (code rollback won't undo schema).
#   3. `git revert HEAD --no-edit && git push` — all 3 platforms auto-redeploy from main.
#
# For sub-30-second Vercel recovery, see docs/ROLLBACK.md "Vercel instant promote".
# For migration rollback (Neon branch restore), see docs/ROLLBACK.md "Neon snapshot restore".
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
  echo "   See docs/ROLLBACK.md → 'Neon snapshot restore'"
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
echo "  Vercel admin (apps/admin)     redeploys in ~2-3 min."
echo "  Vercel storefront (apps/web)  redeploys in ~2-3 min."
echo "  Railway API                   redeploys in ~2-3 min."
echo
echo "  Watch Vercel: https://vercel.com/ahmad-sharafs-projects → force-admin / force-web"
echo "  Watch Railway: railway logs --service api -e production"
