# INFRA-3

> Section: 2026-10-07 — INFRA-GAPS (branch `fix/infra-gaps`)

Ruling INFRA-3 — CI COVERAGE: `tests/integration/rls-ebda-app.test.ts` and `rls-pooler-isolation.test.ts` are EXCLUDED from the per-PR `test-integration` job and run only in `test-rls-ebda-app`, which is `schedule`/`workflow_dispatch` only (nightly). So the `SET ROLE postgres` defect above was invisible to PR CI. Not changed: moving a pgbouncer-installing job onto every PR is a cost decision. Cost if wrong: an RLS-proof regression is caught up to a day after merge.
