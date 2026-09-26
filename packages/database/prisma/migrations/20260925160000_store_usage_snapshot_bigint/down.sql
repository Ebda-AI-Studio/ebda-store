-- Down-migration for 20260925160000_store_usage_snapshot_bigint.
--
-- NOT SAFE TO RUN BLINDLY: a row written AFTER the up-migration could already
-- hold a value above 2^31-1 (2,147,483,647) in any of these 5 columns — that
-- is the exact overflow this migration exists to allow. Narrowing BIGINT ->
-- INTEGER on such a row either fails outright ("integer out of range", the
-- whole rollback aborts) or, if you strip the USING clause below down to a
-- bare cast, truncates the value silently. Before running this:
--
--   1. Confirm no row exceeds the INTEGER range:
--
--      SELECT id, store_id, period_start, revenue_fils, product_views,
--             ai_tokens_in, ai_tokens_out, ai_cost_micros
--      FROM store_usage_snapshots
--      WHERE revenue_fils   > 2147483647 OR revenue_fils   < -2147483648
--         OR product_views  > 2147483647 OR product_views  < -2147483648
--         OR ai_tokens_in   > 2147483647 OR ai_tokens_in   < -2147483648
--         OR ai_tokens_out  > 2147483647 OR ai_tokens_out  < -2147483648
--         OR ai_cost_micros > 2147483647 OR ai_cost_micros < -2147483648;
--
--      This MUST return zero rows before proceeding.
--
--   2. Only then run the ALTER below. The explicit `USING` cast makes
--      Postgres raise a real error (not a silent truncation) if a row over
--      the range slipped in between step 1 and this statement.

ALTER TABLE "store_usage_snapshots"
  ALTER COLUMN "revenue_fils"   TYPE INTEGER USING "revenue_fils"::integer,
  ALTER COLUMN "product_views"  TYPE INTEGER USING "product_views"::integer,
  ALTER COLUMN "ai_tokens_in"   TYPE INTEGER USING "ai_tokens_in"::integer,
  ALTER COLUMN "ai_tokens_out"  TYPE INTEGER USING "ai_tokens_out"::integer,
  ALTER COLUMN "ai_cost_micros" TYPE INTEGER USING "ai_cost_micros"::integer;
