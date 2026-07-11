-- Migration: loyalty_earn_unique
--
-- Closes the #528 deferred follow-up (loyalty double-award race). Both the
-- check-then-insert fast path in LoyaltyService.earnPointsFromPurchase
-- (findFirst for an existing `earn_purchase` transaction, no-op if found)
-- and its P2002 catch-the-violation handler are application-level guards.
-- Neither alone is a guarantee: the order/status-changed fanout runs
-- `concurrency: limit 5` per store, so two concurrent 'delivered' events for
-- the SAME order could both pass the findFirst before either commits its
-- insert, double-crediting the customer. Only a DB-level constraint closes
-- that window — this migration adds it.
--
-- Constraint choice: a partial unique index on (store_id, order_id) scoped
-- to type = 'earn_purchase', NOT a plain @@unique([storeId, orderId, type]).
-- `order_id` is reused across other LoyaltyTransactionType values, and at
-- least one of them legitimately has MULTIPLE rows per (store_id, order_id):
-- `adjust` rows are written by both LoyaltyService.reverseEarnedPointsFromOrder
-- (tag `refund-revoke:<earnTxId>`) and reverseRedeemedPointsFromOrder (tag
-- `redeem-recredit:<redeemTxId>`) — an order that both earned points AND
-- redeemed points at checkout, then got refunded, produces TWO 'adjust' rows
-- for that one order. A combined (store_id, order_id, type) unique constraint
-- would reject the second of those and break refund reversal. `earn_purchase`
-- itself has no such legitimate-repeat case (earnPointsFromPurchase's orderId
-- parameter is required, never null, and is meant to fire at most once per
-- delivered order) so scoping the uniqueness to just that type is correct.
-- Prisma's schema DSL cannot express a partial/filtered index, so this is a
-- hand-written raw-SQL migration (see the `LoyaltyTransaction` model comment
-- in schema.prisma for the pointer).
--
-- Dedup-before-index: before PR #528 added the findFirst guard,
-- earnPointsFromPurchase had NO idempotency check at all, so production may
-- already contain duplicate `earn_purchase` rows for the same order. A naive
-- CREATE UNIQUE INDEX would fail with a uniqueness violation against those.
-- Step 1 below deduplicates first, keeping the EARLIEST earn_purchase row per
-- (store_id, order_id) — ordered by created_at, tie-broken by id — and
-- deleting the rest, before the index is created. This mirrors the dedup+
-- partial-index pattern already used in migration
-- 20260622000000_cart_item_null_variant_unique.
--
-- NOTE (scope): this only deduplicates the loyalty_transactions AUDIT ROWS so
-- the index can be created. It does NOT retroactively correct
-- LoyaltyPoints.points / totalEarned balances that may have been inflated by
-- a historical double-award — the increment and the insert were committed
-- atomically together at the time, so a balance correction would need a
-- separate, explicit reconciliation pass (out of scope for this migration).

-- Step 1: deduplicate existing earn_purchase rows per (store_id, order_id),
-- keeping the earliest (created_at ASC, id ASC as tie-break).
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY store_id, order_id
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM loyalty_transactions
  WHERE type = 'earn_purchase'
    AND order_id IS NOT NULL
)
DELETE FROM loyalty_transactions
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- Step 2: create the partial unique index. Guarantees at most one
-- earn_purchase transaction per (store_id, order_id) at the DB level,
-- closing the concurrent-race window the application-level guards alone
-- cannot close.
--
-- LOCK NOTE: this is a plain (non-CONCURRENTLY) CREATE UNIQUE INDEX, so it takes
-- a SHARE lock that blocks writes to loyalty_transactions while the index builds
-- — and since FWB migrations apply on API boot, that also gates boot for that
-- window. At current scale (loyalty_transactions is a small table) this is
-- sub-second and safe. CONCURRENTLY cannot run inside Prisma's migration
-- transaction, so if this table ever grows large, build the index out-of-band
-- (manual CREATE UNIQUE INDEX CONCURRENTLY, then mark this migration applied)
-- instead of letting it run on boot.
CREATE UNIQUE INDEX IF NOT EXISTS "loyalty_transactions_earn_purchase_unique"
  ON "loyalty_transactions" ("store_id", "order_id")
  WHERE "type" = 'earn_purchase';
