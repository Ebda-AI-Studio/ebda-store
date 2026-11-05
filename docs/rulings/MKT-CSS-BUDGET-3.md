# Ruling MKT-CSS-BUDGET-3 - marketing CSS budget 15.5 -> 16 KB

**Date:** 2026-11-05

**Decision:** the default `cssGzipKb` budget in `scripts/ci/marketing-perf-budget.json` rises from 15.5 KB to 16 KB.

**Evidence:** CI run 41966028877 (PR 418, which changes no marketing source) measured gzip CSS just over 15.5 KB on every marketing page (`css 15.5KB > 15.5KB`). The growth came from shared packages merged to main after #397. Main's CI runs only affected jobs, so `Worker dry-run (marketing)` did not run there and the overage went unmeasured until an unrelated PR triggered it. The budget follows the rule set in MKT-NAV-BUDGET-2: measured + 0.5 KB, rounded up to 0.5.

**Cost if wrong:** about 0.5 KB of extra CSS headroom could hide one small regression; the ratchet-down path (split the art stylesheet per route) stays open.
