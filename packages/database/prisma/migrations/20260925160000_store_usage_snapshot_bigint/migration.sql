-- Migration: store_usage_snapshot_bigint (#1057, and product_views per #1062)
--
-- Widens 5 columns on store_usage_snapshots from INTEGER (max 2^31-1 =
-- 2,147,483,647) to BIGINT: revenue_fils, product_views, ai_tokens_in,
-- ai_tokens_out, ai_cost_micros. The writer (store-usage-snapshot.ts) already
-- computes each of these as a SQL BIGINT via a raw SUM()/COUNT() over the
-- store's month — only the destination column was too narrow, so a
-- high-volume store's monthly total (2.1M+ KWD revenue, or the equivalent in
-- AI tokens/cost-micros) would either be silently truncated through
-- `Number()` on write or, once the JS number itself exceeds int4 range, throw
-- "integer out of range" and drop that month's snapshot entirely.
--
-- SAFE / ADDITIVE, no data loss: every existing INTEGER value fits losslessly
-- in BIGINT (this is a strict widening, not a narrowing) — there is no value
-- currently in this table for which the conversion can fail. store_usage_
-- snapshots is a small table (one row per store per calendar month, not per
-- order/product), so the ACCESS EXCLUSIVE lock this ALTER TYPE briefly holds
-- while Postgres rewrites the column is sub-second in practice, even summed
-- across all 5 columns.
--
-- Down-migration: down.sql in this same directory (per schema.prisma's
-- header convention). Reverting BIGINT -> INTEGER is NOT safe in general (a
-- snapshot row written after this migration could already hold a value above
-- 2^31-1) — down.sql documents that and requires an explicit override rather
-- than silently truncating data on rollback.

ALTER TABLE "store_usage_snapshots"
  ALTER COLUMN "revenue_fils" TYPE BIGINT,
  ALTER COLUMN "product_views" TYPE BIGINT,
  ALTER COLUMN "ai_tokens_in" TYPE BIGINT,
  ALTER COLUMN "ai_tokens_out" TYPE BIGINT,
  ALTER COLUMN "ai_cost_micros" TYPE BIGINT;
