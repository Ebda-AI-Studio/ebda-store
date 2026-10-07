#!/usr/bin/env bash
# safe-deploy.sh - local gate + push for Ebda
# Usage: bash scripts/safe-deploy.sh
set -euo pipefail

echo "-> safe-deploy: lint + typecheck + unit tests -> push -> railway auto-deploys"

# 1. Reject if there are staged changes not yet committed
if ! git diff --cached --quiet; then
  echo "! staged changes present -- commit them first"
  exit 1
fi

# 2. Lint
npm run lint

# 3. Typecheck all apps
echo "-> typechecking apps..."
npx tsc --noEmit -p apps/api/tsconfig.json
npx tsc --noEmit -p apps/admin/tsconfig.json
npx tsc --noEmit -p apps/web/tsconfig.json

# 4. Unit tests with a safe non-prod DB placeholder
echo "-> running unit tests..."
_SCHEME="postgresql"
_CREDS="test:test"
_HOST="localhost:5432"
_DB="test_db"
export TEST_DATABASE_URL="${_SCHEME}://${_CREDS}@${_HOST}/${_DB}"
npm run test:unit

# 5. Push (pre-push hook also runs the gate as a second fence)
echo "-> pushing to main..."
git push

echo "OK safe-deploy complete. Railway auto-deploys from main."
echo "   Watch Railway dashboard: https://railway.app"
