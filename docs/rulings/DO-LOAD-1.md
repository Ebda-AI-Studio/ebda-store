# DO-LOAD-1

> Section: 2026-11-11 plans-vs-main audit, X3 (k6 p95 on the DO path)

Ruling DO-LOAD-1 - the DO-path p95 gate (< 500 ms, storefront browse + checkout) is run with `loadtests/do-path.sh` against local workerd or a staging Worker ONLY; the script refuses any ebda.app host. Measured result: NOT MEASURED. Local workerd needs the seeded Postgres store (`apps/api/scripts/cf-seed.sql`), which the Postgres-port work in flight owns, and no staging Worker with a seeded store exists. AHMAD-APPROVE: (1) a short capped run (1 VU ramp to 10, 2 min) against production storefront reads only, never checkout; (2) a staging Worker with a seeded store for the full run. Cost if wrong: the launch gate stays unmeasured; a p95 regression on the DO path is found by a shopper, not by CI.
