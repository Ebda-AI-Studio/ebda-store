#!/usr/bin/env bash
# local-test.sh — the pre-merge unit-test gate, runnable on the Mac even when CI
# runners are offline. Kills the "running tests locally is too painful, I'll let
# CI catch it" friction that let the #101 green->red regression slip onto main.
#
# Usage:
#   scripts/local-test.sh                 # full tests/unit suite
#   scripts/local-test.sh tests/unit/x.test.ts   # one file/dir
#
# Works in a fresh `git worktree` (where node_modules is absent) — it installs
# and builds the workspace packages the unit suite needs, then runs vitest via
# its real entrypoint (sidesteps the broken flat pnpm symlinks on dev machines).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

TARGET="${1:-tests/unit}"

if [ ! -d node_modules ] || [ ! -e node_modules/vitest ]; then
  echo "==> node_modules missing/incomplete — clean install (npm ci)"
  rm -f node_modules 2>/dev/null || true   # clear any stale symlink
  npm ci --no-audit --no-fund
fi

echo "==> generating Prisma client + building workspace packages the unit suite imports"
npm run db:generate >/dev/null
npm run build -w packages/database >/dev/null
npm run build -w packages/shared >/dev/null

echo "==> vitest run $TARGET"
# Invoke the real vitest entry directly: dev machines sometimes have a broken
# flat node_modules/vitest symlink even though the package is in the store.
VITEST="$ROOT/node_modules/vitest/vitest.mjs"
[ -f "$VITEST" ] || VITEST="$(ls "$ROOT"/node_modules/.pnpm/vitest@*/node_modules/vitest/vitest.mjs 2>/dev/null | head -1)"
node "$VITEST" run "$TARGET"
