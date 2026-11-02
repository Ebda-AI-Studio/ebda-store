#!/usr/bin/env bash
# Pre-push gate, MAC-LIGHT-1 (Ahmad 2026-11-02): the Mac only edits code; GitHub-hosted CI is the gate.
# This keeps ONLY the fast checks (a few seconds): the action-pin check, gitleaks on the push range, and prettier on
# the files this push changed. Lint, typecheck, prisma generate, package builds and unit tests run in CI, not here.
# .husky/pre-push still runs this inside one hold of the host lock (scripts/ci/host-lock.sh). NEVER call host-lock.sh
# from inside this script (not re-entrant). Planner kept for reference: scripts/ci/pre-push-plan.mjs (unused here).
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

echo "OK light pre-push gate passed (lint/typecheck/tests run in CI)"
