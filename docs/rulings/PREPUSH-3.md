# PREPUSH-3

> Section: Admin fix pass 2026-11-04, track T1 API core (branch `feat/admin-fix-t1-api-core`)

Ruling PREPUSH-3 - `vitest related` follows imports, so a repo-wide gate (a banned string in `apps/admin`, a route-table walk, a `git grep`) is never related to the file that broke it and went green locally and red in CI. `scripts/ci/pre-push-plan.mjs` now emits `scanners`: every `tests/unit/**` test whose source matches `SCANNER_RULE` (`readdirSync`, `globSync`, a `walk...(` helper, `git ls-files`, `git grep`), and `scripts/ci/pre-push-gate.sh` runs them on every push whatever the diff, behind the same built-packages guard as the related step. The list is derived, not kept: a new scanner is covered the day it is written (167 today; the 138 named at the time are all included). Evidence: `tests/unit/pre-push-plan.test.ts`. Cost if wrong: a push runs a few extra fixture-reading tests (about a minute) and a scanner that avoids those tokens is missed until CI.
