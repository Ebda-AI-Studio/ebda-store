# R-EBDA-PRICING-9

> Section: 2026-10-07 — Locked pricing (R-EBDA-PRICING-\*)

Ruling R-EBDA-PRICING-9: the unreleased locked-pricing migration was renamed from `20261005090000_locked_pricing` to `20261007000000_locked_pricing` so it sorts after `20261005090000_sp7_shipping` (same timestamp prefix). It was never applied to any shared database. Cost if wrong: none for a database that has not run it; one that did would re-apply an idempotent upsert.
