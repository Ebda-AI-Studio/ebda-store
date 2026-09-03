-- Migration: loyalty_reversal_tag_unique
--
-- Closes a check-then-act race on BOTH loyalty reversal paths.
--
-- `reverseEarnedPointsFromOrder` and `reverseRedeemedPointsFromOrder` each
-- guard themselves by looking for an `adjust` row tagged with the original
-- transaction id (`refund-revoke:<earnTxId>` / `redeem-recredit:<redeemTxId>`)
-- and returning early if one exists. The check and the write are separate
-- statements with nothing behind them, and the `order/refunded` fanout runs
-- `concurrency: { key: storeId, limit: 5 }` with `retries: 3`. Two events for
-- the same order — a gateway webhook racing an admin refund, or
-- `refund-reversal-stuck-sweep` re-firing against an in-flight retry — can both
-- read no-tag and both commit:
--
--   * earn side   → the customer's balance is DOUBLE-DECREMENTED
--   * redeem side → the customer is DOUBLE-RECREDITED
--
-- The `claim-reversed` marker cannot prevent this: it is deliberately the final
-- step, stamped only after the loyalty reversal has already run.
--
-- The earn-award path already had this closed by the partial unique index in
-- 20260711120000_loyalty_earn_unique. This is the same treatment for the two
-- reversals, and the application-level P2002 handlers added alongside it only
-- fire because of this index — without it the loser of the race commits
-- happily and the catch never runs.
--
-- WHY THIS SUPERSEDES 20260903120000_loyalty_cycle_tag_unique: that migration
-- scoped its index to `refund-revoke:%:%` and `redeliver-recredit:%:%` — a
-- cycle-numbered tag format written for a re-credit scheme that was then
-- withdrawn (there is no refunded → delivered transition; the
-- `VALID_ORDER_TRANSITIONS` map marks `refunded` terminal). Those patterns
-- require a SECOND colon, and the tags the code actually writes carry a UUID,
-- which contains hyphens and no colon. That index therefore matched zero rows
-- and zero future writes: it shipped as a money-path fix while changing
-- nothing.
--
-- It is corrected HERE, in a new migration, rather than by editing that file in
-- place. Prisma keys `_prisma_migrations` on the directory name and stores a
-- checksum of the body; rewriting an already-applied migration makes
-- `prisma migrate deploy` fail with a modified-migration error, and FWB applies
-- migrations on API BOOT — so that is an API outage, not a warning. Force-
-- resolving instead would mark the name applied without ever running the new
-- SQL, leaving the real index uncreated and both P2002 handlers unreachable
-- while the money race stayed open. Step 1 below drops the inert index, so the
-- end state is identical whether or not the predecessor was ever applied.
--
-- SCOPE: deliberately NOT all `adjust` rows. The admin award endpoint writes
-- operator-supplied descriptions for the same order, which may legitimately
-- repeat.
--
-- DEDUP: unlike its predecessor, this cannot assume the predicate matches
-- nothing — these tags have been written since long before this migration, and
-- duplicates are precisely the bug being closed, so any that exist would abort
-- `CREATE UNIQUE INDEX`. Step 2 keeps the earliest row per
-- (store_id, order_id, description) and deletes the rest, mirroring
-- 20260711120000 and 20260622000000.
--
-- NOTE ON BALANCES: removing a duplicate ledger row does NOT undo the balance
-- movement it caused. A customer already double-decremented stays
-- double-decremented; this migration stops it recurring and leaves the ledger
-- self-consistent. Retroactive correction needs a per-store reconciliation
-- against loyalty_points and is deliberately not attempted here — silently
-- rewriting customer balances inside a boot-time migration is worse than
-- leaving a known, auditable discrepancy.
--
-- LOCK NOTE: plain (non-CONCURRENTLY) CREATE UNIQUE INDEX takes a SHARE lock
-- that blocks writes to loyalty_transactions while it builds, and FWB
-- migrations apply on API boot. Small table today, so sub-second. If it ever
-- grows large, build it out-of-band with CREATE UNIQUE INDEX CONCURRENTLY and
-- mark this migration applied instead of letting it run on boot.

-- Step 1: drop the inert index from 20260903120000_loyalty_cycle_tag_unique.
DROP INDEX IF EXISTS "loyalty_transactions_cycle_tag_unique";

-- Step 2: deduplicate, keeping the earliest row per tag.
DELETE FROM "loyalty_transactions" t
USING (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "store_id", "order_id", "description"
      ORDER BY "created_at" ASC, "id" ASC
    ) AS rn
  FROM "loyalty_transactions"
  WHERE "type" = 'adjust'
    AND "order_id" IS NOT NULL
    AND (
      "description" LIKE 'refund-revoke:%'
      OR "description" LIKE 'redeem-recredit:%'
    )
) dupes
WHERE t."id" = dupes."id"
  AND dupes.rn > 1;

-- Step 3: the constraint the application's P2002 handlers are written against.
CREATE UNIQUE INDEX IF NOT EXISTS "loyalty_transactions_reversal_tag_unique"
  ON "loyalty_transactions" ("store_id", "order_id", "description")
  WHERE "type" = 'adjust'
    AND "order_id" IS NOT NULL
    AND (
      "description" LIKE 'refund-revoke:%'
      OR "description" LIKE 'redeem-recredit:%'
    );
