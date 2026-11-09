# CLOSURE-E4

> Section: Admin audit closure 2026-11-09, phase 2 (branch `fix/admin-audit-closure`)

Ruling CLOSURE-E4 - BE:E-4, the super-admin fan-out stays capped at `SUPER_ADMIN_FANOUT_CAP=500` stores (warn on truncation, hub reads the D1 list); cursor/rollup is not built. Residual of FP-7: platform totals past 500 stores are partial. Ebda is pre-launch with far fewer stores; a D1 rollup is the fix when the store count approaches the cap. Cost if wrong: super-admin totals under-count once there are more than 500 stores.
