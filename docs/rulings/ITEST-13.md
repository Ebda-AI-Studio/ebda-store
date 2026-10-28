# ITEST-13

> Section: Lifecycle emails and referral attribution (2026-10-22, branch `feat/lifecycle-emails`)

Ruling ITEST-13 - Planner and database-wide-counter tests run in a SERIAL lane (`scripts/ci/planner-lane.sh`, ci.yml integration step): files importing `tests/helpers/app-role-planner` plus the two payment files that count database-wide `idle in transaction` sessions run alone, after the parallel pass, on a quiet database, with the assertions unchanged. Evidence: in 1 of 3 full local runs a different planner file failed (index counters did not move, a small store read 19,558 rows instead of < 3,000, `idle in transaction` was [1] not [0]) because other files write the same big tables or hold transactions; per-file schemas are impossible (RLS, ebda\_\* definers and policies live in `public`) and `enable_seqscan = off` would stop proving production behaviour. Cost if wrong: the integration step runs the lane files a second time serially (about 2 minutes).

---

> Section: Lifecycle emails and referral attribution (2026-10-22, branch `feat/lifecycle-emails`)

Ruling ITEST-13 - Planner and database-wide-counter tests run in a SERIAL lane (`scripts/ci/planner-lane.sh`, ci.yml integration step): files importing `tests/helpers/app-role-planner` plus the two payment files that count database-wide `idle in transaction` sessions run alone, after the parallel pass, on a quiet database, with the assertions unchanged. Evidence: in 1 of 3 full local runs a different planner file failed (index counters did not move, a small store read 19,558 rows instead of < 3,000, `idle in transaction` was [1] not [0]) because other files write the same big tables or hold transactions; per-file schemas are impossible (RLS, ebda\_\* definers and policies live in `public`) and `enable_seqscan = off` would stop proving production behaviour. Cost if wrong: the integration step runs the lane files a second time serially (about 2 minutes).
