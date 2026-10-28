# R-EBDA-PRICING-7

> Section: 2026-10-07 — Locked pricing (R-EBDA-PRICING-\*)

Ruling R-EBDA-PRICING-7: runtime enum-to-plan mapping is `STORE_PLAN_TO_PLAN_CODE` (starter→basic, professional→growth, enterprise→business, free→free); the old `LEGACY_STORE_PLAN_TO_PLAN_CODE` is frozen because a test pins it to the original SP5 backfill. Re-asserting an unchanged enum tier on a store holding a hidden plan keeps its row (an admin re-save cannot demote comped to Business). Evidence: `plan-sync.ts`, `plan-gates.test.ts`. Cost if wrong: an admin who really wants to move a comped store must name a different tier.
