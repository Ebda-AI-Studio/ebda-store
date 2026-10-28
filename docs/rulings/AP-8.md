# AP-8

> Section: 2026-09-30 — accounting + profit batch (branch `fix/accounting-profit-batch`)

**Ruling AP-8 — `conversionRate` is orders per PRODUCT VIEW (%), from the nightly
`funnel_snapshots`, labelled `conversionRateBasis: 'orders_per_product_view'`.**
There is no session tracking, and `checkouts_started` is 0 everywhere (it counts
abandoned-cart rows, which guests never create — audit finding 6b/6c, not in this
batch). No views → `null`. Cost if wrong: a consumer compares it with a
session-based rate from another platform and reads it as low.
