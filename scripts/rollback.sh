#!/usr/bin/env bash
# Emergency production rollback for Ebda.
# Auto-redeploys on push to main: Cloudflare Workers web/admin/orders/marketing (one
# standalone cf-{web,admin,orders,marketing}-deploy.yml per app, each path-filtered).
# The API is ALSO a Cloudflare Worker (cf-api-deploy.yml) but is workflow_dispatch-ONLY
# — a push does not redeploy it. This script dispatches it explicitly so a rollback
# never silently leaves the API on the old commit while the frontends roll back.
#
# What it does:
#   1. Refuses to run if there are uncommitted changes.
#   2. Warns if HEAD includes a Prisma migration (code rollback won't undo schema).
#   3. `git revert HEAD --no-edit && git push` — the 4 frontend workflows re-run and
#      wrangler deploys the reverted Workers.
#   4. Explicitly dispatches cf-api-deploy.yml, since nothing else will.
#
# For the instant per-worker fast-path (`wrangler rollback`, no code change), see
# docs/ROLLBACK.md "A. Per-worker fast-path".
# For migration rollback (local pg_dump restore), see docs/ROLLBACK.md
# "C. Data rollback".
#
# Usage:
#   bash scripts/rollback.sh

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

if ! git diff --quiet || ! git diff --staged --quiet; then
  echo "ERROR: uncommitted changes present. Stash or commit them first, then re-run." >&2
  exit 1
fi

# Ebda writes hand-built migrations under packages/database/prisma/migrations/<TS>_<name>/migration.sql
# capture first: `git diff | grep -q` under pipefail SIGPIPEs git on a large diff and would silently skip this warning
CHANGED_FILES="$(git diff HEAD~1 HEAD --name-only)"
if grep -qE "packages/database/prisma/migrations|migration\.sql$" <<<"$CHANGED_FILES"; then
  echo "⚠️  HEAD includes a Prisma migration. Code rollback won't undo schema changes."
  echo "   See docs/ROLLBACK.md → 'C. Data rollback'"
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
echo "  Cloudflare Workers (web, admin, orders, marketing) redeploy automatically in ~3-5 min"
echo "  (each cf-{app}-deploy.yml is path-filtered — only the apps whose files changed re-run)."
echo
echo "Dispatching the API Worker rollback explicitly (cf-api-deploy.yml is workflow_dispatch-only)..."
if command -v gh >/dev/null 2>&1; then
  gh workflow run cf-api-deploy.yml && echo "  ✓ cf-api-deploy.yml dispatched." \
    || echo "  ✗ dispatch failed — run it manually: gh workflow run cf-api-deploy.yml"
else
  echo "  gh CLI not found — dispatch manually: gh workflow run cf-api-deploy.yml"
fi

echo
echo "  Watch all deploys: gh run watch  (or GitHub Actions → cf-{web,admin,orders,marketing,api}-deploy.yml)"
echo "  Verify commit parity across every pipeline once green: curl /health on each surface,"
echo "  compare 'commit' to this branch's new HEAD (docs/ROLLBACK.md has the exact check)."
