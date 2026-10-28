# BUILDER-LOCAL-1

> Section: 2026-10-07 — Visual builder Phase 1 (branch `feat/builder-phase1`, BUILDER-\*)

Ruling BUILDER-LOCAL-1 — local verification ran on Apple `container` Postgres 16 / Redis 7 (never Neon). The pre-existing `rls-ebda-app` assertion "cannot escalate" tries `SET ROLE postgres`; on a container whose superuser is `test` that role does not exist and the assertion fails for the wrong reason, so the local run created a `postgres` role first. Not a change to the test; noted so a local red is not misread. Cost if wrong: none to CI (its job is unchanged).
