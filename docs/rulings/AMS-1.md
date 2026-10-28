# AMS-1

> Section: 2026-10-01 — backlog batch a-money-services (branch `fix/backlog-a-money-services`)

**Ruling AMS-1 — revenue_drop needs 50.000 EGP of weekly revenue in either
window, and every anomaly baseline is the 3 weeks BEFORE the current one
(issues 2245 / 2268; extends AP-6).** revenue_drop was dead until the P&L fix
and was the only metric with no thin-data floor; its 28d/4 baseline also
contained the week it was compared against (so were margin_drop's and
refund_spike's). Pinned by `tests/integration/accounting/profit-anomaly-revenue-floor.test.ts`.
The stored column is still named `baseline28d`; it now holds the prior-21d
per-week figure, and the merchant-facing label (`finance.anomalies.baseline28d`,
key unchanged) now reads "Weekly baseline (prior 3 weeks)" in en/ar. Cost if wrong: a store whose weekly revenue is below
50.000 EGP in both windows gets no revenue alert even when it falls to zero.
