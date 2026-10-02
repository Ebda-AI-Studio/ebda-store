-- Migration: order_search_trgm_and_fk_indexes (issue 2405 + 2026-10-01 index
-- audit, docs/perf/index-audit-2026-10.md). Index-only: no column, no data
-- change, RLS unchanged.
--
-- 1. Order search (issue 2405). `OrderService.listWhere` searches the order
--    number and the registered customer's first/last name, email and phone
--    with a leading-wildcard ILIKE. `orderSearchWhere` now resolves the
--    matching customers first (BitmapOr over the four `users` indexes below)
--    and then filters `orders` on `order_number ILIKE` OR `customer_id IN`,
--    which Postgres answers with a BitmapOr of `orders_order_number_trgm_idx`
--    and the existing (store_id, customer_id) btree. Every arm of each OR
--    must be indexed or the planner scans anyway — hence all four user
--    columns. Measured at 50k orders/store + 20k users: 150-270 ms -> < 5 ms
--    per query (the list runs it twice: findMany + count).
--    NOTE: these indexes do NOTHING for the old Prisma shape (four LEFT JOINs
--    with an OR spanning both tables) — verified, the plan did not change. The
--    query rewrite and the indexes ship together.
--
-- 2. ai_usage (created_at, cached_hit). The platform-wide AI quota check
--    (lib/ai-quota.ts, before every AI call) and the super-admin AI dashboard
--    count `created_at >= <day|month start> AND cached_hit = ...` across ALL
--    stores. The only indexes led with store_id / feature / model, so each
--    count was a full sequential scan: production pg_stat_user_tables showed
--    ai_usage as the #1 table by tuples read (16,756 seq scans, 140.5M tuples,
--    25k rows growing ~8k/month). Now an index-only range scan.
--
-- 3. cart_bundles (bundle_id). The ONLY foreign key of 203 in production with
--    no index leading on its column (pg_constraint vs pg_index, 2026-10-01).
--    ON DELETE CASCADE from bundles, so deleting a bundle seq-scanned
--    cart_bundles under the parent row lock. The (cart_id, bundle_id) unique
--    has bundle_id second, which the RI trigger cannot use.
--
-- LOCK NOTE: plain CREATE INDEX, not CONCURRENTLY — Prisma runs each migration
-- in a transaction and CONCURRENTLY cannot run inside one. Each statement holds
-- a SHARE lock that blocks WRITES (not reads) on its table for the build, and
-- FWB applies migrations in the Railway pre-deploy step. Production sizes on
-- 2026-10-01: orders 188 rows, users 15, ai_usage 25k (11 MB), cart_bundles 0
-- — every build is milliseconds. For scale: at 100k orders the order_number
-- GIN built in 0.7 s and each users GIN (20k rows) in < 0.1 s on a local PG16.
-- The runbook for when a table is big enough that the write block matters
-- (pre-build CONCURRENTLY on DIRECT_URL, then this migration is a no-op
-- through IF NOT EXISTS) is docs/DB-INDEX-MIGRATIONS.md.
--
-- Prisma drift: the trigram (GIN, gin_trgm_ops) indexes are raw SQL only, like
-- 20260902120000_products_search_trgm_gin; the two btree indexes are also
-- declared as @@index in schema.prisma. Do not let a `migrate dev` drop the
-- trigram ones. Rollback: rollback.sql alongside this file.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "orders_order_number_trgm_idx"
  ON "orders" USING gin ("order_number" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "users_first_name_trgm_idx"
  ON "users" USING gin ("first_name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "users_last_name_trgm_idx"
  ON "users" USING gin ("last_name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "users_email_trgm_idx"
  ON "users" USING gin ("email" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "users_phone_trgm_idx"
  ON "users" USING gin ("phone" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "ai_usage_created_at_cached_hit_idx"
  ON "ai_usage" ("created_at", "cached_hit");

CREATE INDEX IF NOT EXISTS "cart_bundles_bundle_id_idx"
  ON "cart_bundles" ("bundle_id");
