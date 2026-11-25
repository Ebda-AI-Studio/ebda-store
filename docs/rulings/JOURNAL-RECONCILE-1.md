# JOURNAL-RECONCILE-1

> Section: 2026-11-17 — track1 money class fix (branch `fix/journal-missing-sale-reconcile`)

**Ruling JOURNAL-RECONCILE-1 — a paid order with no sale journal entry is repaired by the hourly
order-created sweep on each Durable Object store, by posting the entry directly (idempotent), not by
re-sending `order/created`.**

Every paid path books the sale through the same best-effort `order/created` enqueue: card webhook,
Mark paid, COD paid on delivery (`order.service` `codCollectedOnDelivery`) and COD paid by courier
statement (#735). Each enqueue only logs a failure. Measured on main before this change:

- `order-created-stuck-sweep` re-sends only for `paymentStatus = 'paid' AND orderCreatedNotifiedAt IS NULL`
  with `createdAt` in the last 12 h. A COD order is notified at creation and paid days later, so a lost
  enqueue on delivery or statement is invisible to it.
- `accounting-period-reconciliation` (daily) compares 24 h aggregates keyed on the order's `createdAt`. It
  alerts P0 on drift but repairs nothing, and a COD order paid days after creation falls outside its
  window.

So a lost enqueue left a paid order with no journal entry, forever. Now `handleOrderCreatedStuckSweep`, on
a DO store's alarm tick, calls the money op `journalRepairSales` (`packages/repo/src/do/ledger.ts`
`repairMissingSaleJournals`). It finds the orders that were PAID in the window `[now - 72 h, now - 10 min)`
and have no `journal_entries` row `(source 'order', source_id = order id)`, then posts each with
`postOrderSaleJournal`.

- **Paid time:** "paid" is the latest completed payment's `paid_at`. An order with no payment row (store
  credit only) uses `created_at`.
- **Skipped:** zero-total, cancelled and refunded orders, and stores with accounting off. The NOT EXISTS
  filter is in the query, so a page of already-posted orders cannot starve a missing one.
- **Failures:** each order posts in its own transaction, so one failure is reported and never blocks the
  others.
- **Alerts:** a repair sends an `info` alert (it healed, so no page). An order that cannot be posted sends
  `p1` (`journal.reconcile.failed`).
- **Cost:** the platform cron tick opens no step (Ruling INNGEST-BUDGET-1).

**Why post directly instead of re-sending `order/created` (the controller's first suggestion).** The
event also drives CAPI conversions, merchant webhooks, WhatsApp and the e-receipt. Those consumers are
not all idempotent across a re-send, and the defect being repaired is the missing books entry. Posting
through the same idempotent `postOrderSaleJournal` that the fan-out uses cannot double-book: the DO
serialises both, and the unique `(store_id, source, source_id)` index rejects a second entry.

**Double-book guarantee.** Two layers protect against a second entry; the second one is what guarantees it.

1. Inside `postEntry`'s `transactionSync` (`packages/repo/src/do/ledger.ts`, the `SELECT ... WHERE store_id AND source AND
source_id` before the INSERT), an existing entry is returned with `created: false`. The DO runs one section at a time,
   so this check already covers a fan-out landing at the same moment as a repair.
2. The unique partial index `journal_entries_store_source_source_id_unique (store_id, source, source_id) WHERE source_id IS
NOT NULL` (`packages/cf-schema/migrations/store/0001_init.sql:1371`) holds even against a code path that skips the
   lookup. Every StoreDO applies it through `apps/api/src/cf/store-do/migrations.ts` (`STORE_MIGRATIONS`). The test inserts
   a duplicate row directly and expects `UNIQUE constraint failed`.

**Past the window: detection, not repair.** An outage longer than the look-back would drop out silently, so the same tick
calls `journalStaleCount` (`countStaleMissingSaleJournals`) once per UTC day. That call is keyed `journal-stale:<day>`, so
any same-day replay returns the stored count with its original `countedAt`.

- **What it counts:** paid orders, paid before `day start - JOURNAL_REPAIR_MAX_AGE_HOURS`, that have no sale entry.
- **Which orders count:** only orders paid on or after the store's first journal entry. Orders from before the books
  started (accounting turned on later) never page.
- **Alert:** a count above 0 pages P1 `journal.reconcile.stale` with the count. The alert fires only when the count was
  computed in this tick (`countedAt` under 10 minutes old), so it goes out once a day per store.
- **Repair:** these orders are booked by hand, or by widening the window for one run.

**Floor.** `JOURNAL_REPAIR_MAX_AGE_HOURS` (default 72) bounds the look-back, so a store that turns
accounting on never back-posts its history. On the first ticks after deploy, any order paid in the last
72 h with no entry is posted and reported. That is the intended repair.

**Residual.** The other consumers of a lost `order/created` for a COD payment are not re-driven here:

- CAPI conversion, merchant `order.paid` webhook and e-receipt;
- customer notification. This one is already sent at creation for COD.

Cost if wrong: an `info` alert per store per hour while a repair keeps finding new orders (it would mean
the enqueue is failing continuously, which is what the alert is for).
