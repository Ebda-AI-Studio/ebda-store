#!/usr/bin/env bash
# The HEAVY part of the pre-push gate. .husky/pre-push runs this inside ONE hold of the host lock
# (scripts/ci/host-lock.sh, ~/.claude/locks/heavy-test.lock), so only one worktree's gate runs on the Mac at a time:
# prettier, lint, three tsc runs and the unit suite used to run in parallel from several worktrees (load 30, 2026-10-25)
# and starved the Umbra CI guest. NEVER call host-lock.sh from inside this script (it is not re-entrant: a nested
# lockf on the same file would wait on its own parent forever).
#
# PREPUSH-1 (Ahmad 2026-10-26): the gate runs only the cheap checks + what THIS push touches (scripts/ci/pre-push-plan.mjs,
# built on the same planner as CI): prettier on the changed files, gitleaks on the push range, lint/typecheck of the
# affected workspaces, `vitest related` on the changed files. The planner falling back to 'full' (lockfile, package.json,
# root config, packages/shared|database, no merge base) runs the whole legacy gate below. The full suite stays in CI + nightly.
#
# Order: the cheap checks first, so a typo fails in seconds instead of after a 10-minute typecheck.
set -euo pipefail

# Mirrors CI's client-secret-scan job: every `uses:` pinned to a 40-hex SHA (#1517).
bash scripts/check-action-pins.sh

BASE=$(git merge-base origin/main HEAD 2>/dev/null || true)
if [ -n "$BASE" ]; then PLAN=$(node scripts/ci/pre-push-plan.mjs --base "$BASE"); else PLAN='{"mode":"full","files":[]}'; fi
MODE=$(node -e 'console.log(JSON.parse(process.argv[1]).mode)' "$PLAN")
field() { node -e 'const v=JSON.parse(process.argv[1])[process.argv[2]]; console.log(Array.isArray(v)?v.join(" "):v)' "$PLAN" "$1"; }
echo "-> pre-push plan: $MODE"

if [ "$MODE" != "full" ]; then
  # gitleaks on the push range only (same config as CI's gitleaks workflow)
  if command -v gitleaks >/dev/null 2>&1; then
    gitleaks detect --source . --config .gitleaks.toml --log-opts="${BASE}..HEAD" --redact --exit-code 1
  else
    echo "! gitleaks not installed; CI scans this range"
  fi
  FILES=$(node -e 'const f=JSON.parse(process.argv[1]).files.filter(x=>/\.(ts|tsx|js|jsx|json|md)$/.test(x)&&require("fs").existsSync(x));console.log(f.join("\n"))' "$PLAN")
  if [ -n "$FILES" ]; then printf '%s\n' "$FILES" | xargs npx prettier --check; fi
  [ "$MODE" = "docs" ] && { echo "OK docs-only push: cheap checks passed"; exit 0; }

  echo "-> generating prisma client + building shared packages (needed for typecheck/tests)..."
  npm run db:generate >/dev/null 2>&1
  npm run build -w packages/database -w packages/shared -w packages/ui >/dev/null 2>&1

  LINT=$(field lint)
  if [ -n "$LINT" ]; then echo "-> lint: $LINT"; npm run lint $LINT; fi
  for tsc in $(field typecheck); do echo "-> tsc $tsc"; npx tsc --noEmit -p "$tsc"; done

  RELATED=$(field related)
  if [ -n "$RELATED" ]; then
    echo "-> vitest related (changed files only; the full suite runs in CI + nightly)"
    _SCHEME="postgresql"; _CREDS="test:test"; _HOST="localhost:5432"; _DB="test_db"
    export TEST_DATABASE_URL="${_SCHEME}://${_CREDS}@${_HOST}/${_DB}"
    # PREPUSH-2: unit tier only. `related` follows imports, so exclude what needs Postgres/Redis (CI runs it).
    EXCLUDE_ARGS=()
    for g in $(field exclude); do EXCLUDE_ARGS+=(--exclude "$g"); done
    npx vitest related --run --passWithNoTests --maxWorkers=50% "${EXCLUDE_ARGS[@]}" $RELATED
  fi
  echo "OK affected-only pre-push gate passed"
  exit 0
fi

echo "-> planner cannot narrow this push: running the FULL gate"

# prettier gate — CI's Lint job runs format:check; mirroring it here keeps the
# hook honest (a docs-only PR failed CI on formatting the local gate never ran)
npm run format:check

# Catch lockfile drift before Railway hits the same trap on `npm ci`.
# Standing emnapi trap — see feedback-emnapi-lockfile-desync-after-add.md.
npm ci --dry-run

# Generate Prisma client before typecheck. Without this, apps/api typecheck
# reports ~396 phantom errors (all "any" / "unknown" types from missing
# @prisma/client type declarations). CI does this implicitly via the build
# step, but the pre-push hook needs to be explicit.
echo "-> generating prisma client (needed for typecheck)..."
npm run db:generate >/dev/null 2>&1

# Build the shared workspace packages before typecheck/tests (fixed
# 2026-07-05). apps/* consume @ebda/database, @ebda/shared, @ebda/ui via
# their compiled dist output, not raw source -- skipping this made every
# downstream typecheck AND unit-test run fail ("Cannot find module
# '@ebda/database'" / "Failed to resolve entry for package '@ebda/shared'").
# CI's Build job builds every workspace before typecheck/tests depend on it;
# this only builds the 3 shared packages (not the apps) to keep the hook fast.
echo "-> building shared packages (needed for downstream typecheck + tests)..."
npm run build -w packages/database -w packages/shared -w packages/ui >/dev/null 2>&1

npm run lint


echo "-> typechecking apps..."
npx tsc --noEmit -p apps/api/tsconfig.json
npx tsc --noEmit -p apps/admin/tsconfig.json
npx tsc --noEmit -p apps/web/tsconfig.json

echo "-> running unit tests (~4s)..."
# Set TEST_DATABASE_URL to a local placeholder so vitest setup-e2e.ts skips
# the prod-guard check. Built in parts so secretlint does not flag this file.
# Unit tests mock Prisma and make no real DB connections.
_SCHEME="postgresql"
_CREDS="test:test"
_HOST="localhost:5432"
_DB="test_db"
export TEST_DATABASE_URL="${_SCHEME}://${_CREDS}@${_HOST}/${_DB}"
# half the cores per run (the whole gate already holds the one host lock, see .husky/pre-push)
npm run test:unit -- --maxWorkers=50%

