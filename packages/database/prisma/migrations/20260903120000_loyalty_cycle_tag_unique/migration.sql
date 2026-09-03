-- Migration: loyalty_cycle_tag_unique
--
-- Makes the refund/re-delivery loyalty cycle idempotent at the DB level.
--
-- LoyaltyService derives "are this order's earned points currently credited or
-- revoked" by counting balancing `adjust` rows: `refund-revoke:<earnTxId>:<n>`
-- written by reverseEarnedPointsFromOrder, `redeliver-recredit:<earnTxId>:<n>`
-- written by recreditRevokedEarn. Equal counts = credited, revokes ahead by one
-- = revoked. That count-then-write is a check-then-act with no constraint
-- behind it, so it is a pure TOCTOU: the order/status-changed fanout runs
-- `concurrency: limit 5` per store AND Inngest retries steps, so two concurrent
-- delivered events can both read `recredits = 0`, both build the tag
-- `redeliver-recredit:<earnTxId>:0`, and both commit — crediting the customer
-- twice. The refund side has the mirror-image race (partial-then-full refund,
-- or a redelivered gateway webhook) and double-decrements.
--
-- The earn path already had this closed by the partial unique index from
-- 20260711120000_loyalty_earn_unique; the application-level P2002 handlers in
-- recreditRevokedEarn / reverseEarnedPointsFromOrder are written to that same
-- contract and only actually fire because of the index below. Without it the
-- loser of the race commits happily and the catch never runs.
--
-- Constraint choice: a partial unique index on (store_id, order_id, description)
-- scoped to CYCLE-TAGGED `adjust` rows only. It cannot cover all `adjust` rows —
-- reverseRedeemedPointsFromOrder writes `redeem-recredit:<redeemTxId>` for the
-- same order, and the admin award endpoint writes operator-supplied
-- descriptions — and it deliberately does NOT cover the LEGACY un-numbered
-- `refund-revoke:<earnTxId>` tag (the only format before cycle numbering
-- shipped). The `%:%` patterns match only tags carrying a cycle number, a
-- format that does not exist in any row written before this deploy, so the
-- index cannot fail to build against production data and needs no dedup step
-- (contrast 20260711120000, which had to deduplicate first). Legacy bare rows
-- still COUNT in the application (earnCycleState treats a bare tag as cycle 0);
-- they are simply never written again, so they need no uniqueness.
--
-- Prisma's schema DSL cannot express a partial/filtered index, so this is a
-- hand-written raw-SQL migration (see the `LoyaltyTransaction` model comment in
-- schema.prisma for the pointer).
--
-- LOCK NOTE: plain (non-CONCURRENTLY) CREATE UNIQUE INDEX takes a SHARE lock
-- that blocks writes to loyalty_transactions while it builds, and FWB
-- migrations apply on API boot. At current scale (small table, and the
-- predicate matches zero rows today) this is sub-second. If the table ever
-- grows large, build it out-of-band with CREATE UNIQUE INDEX CONCURRENTLY and
-- mark this migration applied instead of letting it run on boot.
CREATE UNIQUE INDEX IF NOT EXISTS "loyalty_transactions_cycle_tag_unique"
  ON "loyalty_transactions" ("store_id", "order_id", "description")
  WHERE "type" = 'adjust'
    AND (
      "description" LIKE 'refund-revoke:%:%'
      OR "description" LIKE 'redeliver-recredit:%:%'
    );
