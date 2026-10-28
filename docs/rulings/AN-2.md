# AN-2

> Section: 2026-09-30 — Analytics batch 1 (branch `fix/analytics-batch-1`, PR #2220)

**Ruling AN-2 — dead-stock flags for products with no cost price store `stock_value_fils = NULL`
and are flagged on the 90-day rule alone.** The value threshold (EGP 50) cannot be applied to an
unknown value; skipping them made the scan blind on stores that never entered costs, and storing 0
would be a false value. Cost if wrong: a store with many cheap, slow products and no costs sees more
flags than the value threshold would allow once costs are entered.
