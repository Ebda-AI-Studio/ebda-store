#!/usr/bin/env bash
# Pre-push gate, MAC-LIGHT-1 (Ahmad 2026-11-02): the Mac only edits code; GitHub-hosted CI is the gate.
# This keeps ONLY the fast checks (a few seconds): the action-pin check, gitleaks on the push range, and prettier on
# the files this push changed, plus `vitest related` on the changed source files (unit tier only, no full suite).
# Lint, typecheck, prisma generate, package builds and the full suite run in CI, not here.
# Only the `vitest related` step takes the host lock (scripts/ci/host-lock.sh, PREPUSH-4); NEVER call host-lock.sh
# from inside this script (not re-entrant). The scanner step uses a 4-slot semaphore + pass cache instead (PREPUSH-5). Planner kept for reference: scripts/ci/pre-push-plan.mjs (unused here).
set -euo pipefail

# Mirrors CI's client-secret-scan job: every `uses:` pinned to a 40-hex SHA (#1517).
bash scripts/check-action-pins.sh

BASE=$(git merge-base origin/main HEAD 2>/dev/null || true)
if [ -z "$BASE" ]; then
  echo "! pre-push: no merge base with origin/main; secret scan and format check left to CI"
  exit 0
fi

# gitleaks on the push range only (same config as CI's gitleaks workflow)
if command -v gitleaks >/dev/null 2>&1; then
  gitleaks detect --source . --config .gitleaks.toml --log-opts="${BASE}..HEAD" --redact --exit-code 1
else
  echo "! gitleaks not installed; CI scans this range"
fi

# prettier on the changed files only
FILES=$(git diff --name-only --diff-filter=ACMR "$BASE"..HEAD | grep -E '\.(ts|tsx|js|jsx|json|md)$' | while read -r f; do [ -f "$f" ] && echo "$f"; done || true)
if [ -n "$FILES" ]; then printf '%s\n' "$FILES" | xargs npx prettier --check; fi

# Cheap related tests: only tests that import/mock a changed module (the planner picks the files and the unit-tier
# exclude list, PREPUSH-2). Skipped when the planner cannot narrow ("full"), docs-only, or the shared packages are not
# built (no builds here; a missing dist would only produce environment failures).
PLAN=$(node scripts/ci/pre-push-plan.mjs --base "$BASE" 2>/dev/null || echo '{"mode":"full"}')
field() { node -e 'const v=JSON.parse(process.argv[1])[process.argv[2]]||[]; console.log(Array.isArray(v)?v.join(" "):v)' "$PLAN" "$1"; }
MODE=$(node -e 'console.log(JSON.parse(process.argv[1]).mode)' "$PLAN")
RELATED=$(field related)
if [ "$MODE" = "affected" ]; then
  if [ -n "$RELATED" ] && [ -d packages/database/dist ] && [ -d packages/shared/dist ]; then
    EXCLUDE_ARGS=()
    for g in $(field exclude); do EXCLUDE_ARGS+=(--exclude "$g"); done
    # PREPUSH-4: a wide change fans `vitest related` out to thousands of tests, which on a loaded Mac holds the
    # host lock for hours. Past the cap CI runs it (sharded); the lock is held only for the vitest run itself.
    NREL=$(printf '%s\n' $RELATED | wc -l | tr -d ' ')
    if [ "$NREL" -gt "${PREPUSH_RELATED_MAX:-6}" ]; then
      echo "! vitest related skipped: $NREL changed files > ${PREPUSH_RELATED_MAX:-6}; CI runs it, sharded"
    else
      echo "-> vitest related (changed source files only, $NREL files)"
      bash scripts/ci/host-lock.sh npx vitest related --run --passWithNoTests --maxWorkers=50% "${EXCLUDE_ARGS[@]}" $RELATED
    fi
  else
    echo "! related tests skipped (nothing related, or packages not built); CI runs them"
  fi
fi

# SCANNER-1 (Ruling PREPUSH-3, speed PREPUSH-5): the repo-scanning unit tests ALWAYS run, whatever the diff. `vitest related` only follows
# imports, so it misses a gate that walks the whole tree (a banned string in apps/admin, a route-table walk, a git grep):
# those used to go green here and red in CI. The list is derived by content (scripts/ci/pre-push-plan.mjs SCANNER_RULE), not
# kept by hand. Same environment guard as the related step (built shared packages).
SCANNERS=$(field scanners)
if [ -n "$SCANNERS" ]; then
  if [ -d packages/database/dist ] && [ -d packages/shared/dist ]; then
    # PREPUSH-5: scanners are light (about 100 s CPU, 0.5 GB, measured), so they do NOT take the host-wide heavy lock.
    # Two layers keep a push at about 2 min with 8 agents pushing: (1) a pass cache keyed by the git TREE hash of HEAD
    # plus the scanner list (every scanner reads the tracked tree, so identical tree + list = identical result; a
    # re-push, amend or retry costs 0 s); (2) a 4-slot semaphore (prepush-slot.sh) with a fixed --maxWorkers=2.
    # CI still runs every scanner; this cache lives only on this Mac and only ever records a PASS.
    CACHE_DIR="${PREPUSH_CACHE_DIR:-$HOME/.cache/ebda-prepush}"
    KEY=$( { git rev-parse 'HEAD^{tree}'; printf '%s\n' $SCANNERS; } | shasum -a 256 | cut -c1-40)
    if [ -f "$CACHE_DIR/scanners-$KEY.ok" ]; then
      echo "-> vitest scanners: this exact tree + list already passed locally; cache hit, skipped (CI still runs them)"
    else
      echo "-> vitest scanners ($(printf '%s\n' $SCANNERS | wc -l | tr -d ' ') repo-scanning tests, always run on a cache miss)"
      # shellcheck disable=SC2086
      bash scripts/ci/prepush-slot.sh npx vitest run --passWithNoTests --maxWorkers=2 $SCANNERS
      mkdir -p "$CACHE_DIR" && : > "$CACHE_DIR/scanners-$KEY.ok"
      find "$CACHE_DIR" -name 'scanners-*.ok' -mtime +7 -delete 2>/dev/null || true
    fi
  else
    echo "! scanner tests skipped (packages not built); CI runs them"
  fi
fi

echo "OK light pre-push gate passed (lint/typecheck/full suite run in CI)"
