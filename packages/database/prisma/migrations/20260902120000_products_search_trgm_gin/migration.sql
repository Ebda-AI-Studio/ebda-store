-- Trigram GIN indexes for the public product search (adversarial audit P1-3,
-- 2026-09-02).
--
-- WHY: GET /public/products?search=<term> runs a leading-wildcard ILIKE
-- ('%term%') over name / name_ar / description / description_ar. A leading
-- wildcard cannot use any btree index, and the four columns had no trigram/
-- FTS index at all — every uncached search term was a full sequential scan
-- of the tenant's product rows, and the cache key embeds the term, so
-- unique-term traffic (an attacker, or just organic long-tail searches)
-- bypassed every cache layer and hit the table each time. On Neon that is
-- billable compute pinned awake. gin_trgm_ops makes '%term%' ILIKE
-- index-backed for terms of >= 3 chars (shorter terms fall back to a scan,
-- bounded by the new >= 2 route floor + 120s cache).
--
-- ALL FOUR columns are indexed, not just the names: the search WHERE is an
-- OR across all four, and the planner can only BitmapOr the arms when every
-- arm is indexable — one unindexed OR arm forces the seq scan anyway.
--
-- LOCK NOTE — same constraint documented in 20260808120000_fk_only_indexes
-- and 20260808200000_products_sku_partial_unique: these are plain,
-- non-CONCURRENTLY CREATE INDEX statements because CONCURRENTLY cannot run
-- inside Prisma's migration transaction. Each takes a SHARE lock that blocks
-- WRITES (not reads) to `products` while it builds — and FWB applies
-- migrations on API boot, so the build also gates boot for that window.
--
-- >>> PRODUCTION PREREQUISITE (do NOT skip): `products` is a live table.
-- Before this migration reaches production, pre-build the indexes
-- out-of-band with CONCURRENTLY against the non-pooled DIRECT_URL endpoint:
--
--   CREATE EXTENSION IF NOT EXISTS pg_trgm;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "products_name_trgm_idx"
--     ON "products" USING gin ("name" gin_trgm_ops);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "products_name_ar_trgm_idx"
--     ON "products" USING gin ("name_ar" gin_trgm_ops);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "products_description_trgm_idx"
--     ON "products" USING gin ("description" gin_trgm_ops);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "products_description_ar_trgm_idx"
--     ON "products" USING gin ("description_ar" gin_trgm_ops);
--
-- Every statement below is IF NOT EXISTS, so with the pre-build done the
-- migration is a clean no-op on production, while a fresh/CI database
-- creates the indexes normally (small table, sub-second). This is the
-- repo's established pattern for CONCURRENTLY-requiring index builds — the
-- migration file stays the single source of truth, no
-- `prisma migrate resolve --applied` bookkeeping needed.
--
-- KNOWN, ACCEPTED DRIFT: Prisma cannot express expression/opclass indexes,
-- so `prisma migrate diff` will not know about these. Do not let a future
-- `migrate dev` drop them.
--
-- Rollback: rollback.sql alongside this file (drops the four indexes
-- CONCURRENTLY; the pg_trgm extension is left installed — dropping an
-- extension other objects may depend on is not a safe automatic rollback).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "products_name_trgm_idx"
  ON "products" USING gin ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "products_name_ar_trgm_idx"
  ON "products" USING gin ("name_ar" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "products_description_trgm_idx"
  ON "products" USING gin ("description" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "products_description_ar_trgm_idx"
  ON "products" USING gin ("description_ar" gin_trgm_ops);
