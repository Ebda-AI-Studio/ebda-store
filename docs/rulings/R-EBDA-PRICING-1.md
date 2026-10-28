# R-EBDA-PRICING-1

> Section: 2026-10-07 — Locked pricing (R-EBDA-PRICING-\*)

Ruling R-EBDA-PRICING-1: historical `free` / `pro` / `comped` plan codes stay as hidden compatibility rows (zero fees, no price), never deleted or renamed. Evidence: `store_subscriptions.plan_code` references them; `tests/unit/locked-pricing.test.ts` asserts the migration has no DELETE/DROP and `tests/integration/locked-pricing-catalog.test.ts` re-runs it over stores on all four hidden plans. Cost if wrong: hidden rows linger until an explicit subscription migration retires them.
