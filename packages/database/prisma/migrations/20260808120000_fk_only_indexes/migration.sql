-- Migration: fk_only_indexes
--
-- Adds a single-column index for the five foreign keys that had no index whose
-- LEADING column is the FK. Postgres does not create these automatically — it
-- indexes the referenced (parent) side via the PK, never the referencing side.
--
-- All five relations are `onDelete: SetNull`. Deleting the parent fires an RI
-- trigger that runs, on the child table:
--
--   UPDATE <child> SET <fk> = NULL WHERE <fk> = $1
--
-- filtering on the FK column ALONE. Three of the five (customers, coupons,
-- promotions) already appear in a composite `(store_id, <fk>)` index, which
-- serves the merchant-facing "rows in this group" reads perfectly well — but a
-- btree cannot be range-scanned on a non-leading column, so it does not help
-- this trigger. The other two (orders.applied_promotion_id,
-- order_events.actor_id) had no covering index at all.
--
-- Consequence today: deleting a CustomerGroup, a Promotion, or a User seq-scans
-- the child table while holding the parent row's lock. On `orders` and
-- `order_events` — the two largest tables here, and both only-growing — that is
-- a lock held for the length of a full-table scan on a live storefront.
--
-- Write cost is the trade: five more btrees to maintain on insert/update. Four
-- of the five columns are nullable and sparsely populated (most customers have
-- no group, most orders no applied promotion, most order events no actor), so
-- the indexes stay small and the per-row maintenance is a nullable-column entry.
--
-- LOCK NOTE — same constraint documented in 20260711120000_loyalty_earn_unique
-- and 20260720000000_order_refund_reversed_at: these are plain, non-CONCURRENTLY
-- CREATE INDEX statements, because CONCURRENTLY cannot run inside Prisma's
-- migration transaction. Each takes a SHARE lock that blocks WRITES (not reads)
-- to its table while the index builds — and FWB applies migrations on API boot,
-- so this also gates boot for that window.
--
-- `coupons`, `promotions` and `customers` are small enough for this to be
-- sub-second. `orders` and `order_events` are NOT, and only grow. If this
-- measurably delays boot, build those two out-of-band against the DIRECT_URL
-- (non-pooled) endpoint first:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "orders_applied_promotion_id_idx"
--     ON "orders"("applied_promotion_id");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "order_events_actor_id_idx"
--     ON "order_events"("actor_id");
--
-- then apply this migration as normal — every statement is IF NOT EXISTS, so the
-- pre-built pair is a no-op and the migration stays a single source of truth
-- rather than needing `prisma migrate resolve --applied`.

CREATE INDEX IF NOT EXISTS "customers_group_id_idx"
  ON "customers"("group_id");

CREATE INDEX IF NOT EXISTS "coupons_customer_group_id_idx"
  ON "coupons"("customer_group_id");

CREATE INDEX IF NOT EXISTS "promotions_customer_group_id_idx"
  ON "promotions"("customer_group_id");

CREATE INDEX IF NOT EXISTS "orders_applied_promotion_id_idx"
  ON "orders"("applied_promotion_id");

CREATE INDEX IF NOT EXISTS "order_events_actor_id_idx"
  ON "order_events"("actor_id");
