# AN-8

> Section: 2026-09-30 — Analytics batch 1 (branch `fix/analytics-batch-1`, PR #2220)

**Ruling AN-8 — dead-stock value is variant-aware (closes AP-10's left sibling).** Main's
`STOCK_VALUE_SQL` values each active variant at its own cost, falling back to the parent's; this
branch's scan multiplied the variant sum by the parent cost. `deadStockValueFils` is its JS twin,
differing only where AN-2 requires: an on-hand unit with no cost anywhere makes the value `null`,
not 0. The open-row dedupe (one open flag per product) is unchanged. Asserted in
`tests/integration/accounting/deadstock-scan.test.ts` (variant costs 3000/4000 × 10 → 70000; the
disabled variant excluded). Cost if wrong: none beyond AP-10's — the two valuation paths can drift
if one is edited without the other.

GL cards + cashflow after the merge: `glRevenueWindow` reads main's corrected `profitAndLoss`
(period-filtered) with this branch's `startDate`/`endDate` window; `cashflowTrend` keeps main's
`status IN ('posted','reversed')` refund dedupe and receives this branch's picker range.
