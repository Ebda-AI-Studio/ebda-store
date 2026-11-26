#!/usr/bin/env bash
# The Store's product-specific pre-push steps (F10): vendored scripts/foundation/pre-push-gate.sh runs the common checks (action pins, gitleaks,
# prettier) and then this file LAST, with BASE (the merge base with origin/main) exported. Moved verbatim from the former scripts/ci/pre-push-gate.sh.
# NOTHING here takes the host-wide heavy lock (PREPUSH-8: self-hosted CI jobs hold it back to back, so a push waited 30+ min): `vitest related` and the
# scanners both run in prepush slots (scripts/ci/prepush-slot.sh, 2 workers). The scanner step uses a 4-slot semaphore + pass cache instead (PREPUSH-5).
# Planner kept for reference: scripts/ci/pre-push-plan.mjs (unused here).
# shellcheck disable=SC2086  # word splitting of the file lists is intended (they are newline/space separated paths without spaces)
set -euo pipefail

# SLOP-PREPUSH-1: the same slop guard CI runs ("Slop baselines": new unused exports, any, console, ...), only when a .ts/.tsx file changed. See scripts/ci/pre-push-slop.sh.
bash scripts/ci/pre-push-slop.sh origin/main HEAD

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
      # PREPUSH-8: related tests (<= PREPUSH_RELATED_MAX files, integration/E2E excluded) are plain unit tests: they bind no fixed port and
      # need no exclusive host. They run in a prepush slot with 2 workers, NEVER behind the host-wide heavy lock: self-hosted CI jobs
      # take that lock back to back, so a local push waited 30+ min (measured 2026-11-17, owner "ci ... unit/ebda-mac-2"). The slot count
      # (default 4) x 2 workers bounds the CPU a push burst can add next to a running CI job.
      bash scripts/ci/prepush-slot.sh npx vitest related --run --passWithNoTests --maxWorkers=2 "${EXCLUDE_ARGS[@]}" $RELATED
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
    # plus the scanner list, used ONLY on a clean working tree (scanners read the working directory, so a dirty tree
    # always runs; a re-push of a clean identical tree costs 0 s); (2) a 4-slot semaphore (prepush-slot.sh) with a fixed --maxWorkers=2.
    # CI still runs every scanner; this cache lives only on this Mac and only ever records a PASS (ignored inputs are in the key).
    # PREPUSH-5b: the key is computed BEFORE the run and the pass is recorded under that pre-run key, so a rebuild or an
    # edit during the scan can never be cached as a pass for the post-scan state. Empty key = dirty tree = no cache.
    # shellcheck disable=SC2086
    KEY=$(bash scripts/ci/prepush-scanner-cache.sh key $SCANNERS 2>/dev/null || true)
    # shellcheck disable=SC2086
    if [ -n "$KEY" ] && PREPUSH_CACHE_KEY="$KEY" bash scripts/ci/prepush-scanner-cache.sh check $SCANNERS; then
      echo "-> vitest scanners: this exact clean tree + list already passed locally; cache hit, skipped (CI still runs them)"
    else
      echo "-> vitest scanners ($(printf '%s\n' $SCANNERS | wc -l | tr -d ' ') repo-scanning tests, always run on a cache miss or dirty tree)"
      # shellcheck disable=SC2086
      bash scripts/ci/prepush-slot.sh npx vitest run --passWithNoTests --maxWorkers=2 $SCANNERS
      # shellcheck disable=SC2086
      if [ -n "$KEY" ]; then PREPUSH_CACHE_KEY="$KEY" bash scripts/ci/prepush-scanner-cache.sh record $SCANNERS || true; fi
    fi
  else
    echo "! scanner tests skipped (packages not built); CI runs them"
  fi
fi
