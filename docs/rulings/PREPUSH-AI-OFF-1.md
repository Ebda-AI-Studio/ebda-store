# PREPUSH-AI-OFF-1

Ruling PREPUSH-AI-OFF-1 (2026-11-05, Ahmad: "skip it always, keep the CI one only") - the local advisory blast-radius
and AI review are removed from `.husky/pre-push` (and `scripts/ci/pre-push-ai-review.sh` deleted). Both still run in CI
on every pull request (`blast-radius.yml`, `ai-review.yml`); the local pre-push gate (action pins, gitleaks, prettier,
host-locked checks via `scripts/ci/pre-push-gate.sh`) is unchanged. Evidence: the local AI review ran 56-57 chunks per
push and queued every push 30-60 min during the 2026-11-04 Neon push wave. Cost if wrong: a finding shows up in the CI
review comment instead of before the push (still before merge).
