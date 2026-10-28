# AP-9

> Section: 2026-09-30 — accounting + profit batch (branch `fix/accounting-profit-batch`)

**Ruling AP-9 — COGS posting is fed, not changed.** `order-posting.ts` already
books DR 5000 / CR 1200 per line with a cost; it was never fed because
`order_items.cost_price` was null (348/349 in prod). Variant cost is now
snapshotted, so COGS posts for NEW orders only. Historical orders are not
backfilled (that is a production write + a posting-date decision). Cost if
wrong: P&L before this deploy keeps 0 COGS until a backfill is ruled.
