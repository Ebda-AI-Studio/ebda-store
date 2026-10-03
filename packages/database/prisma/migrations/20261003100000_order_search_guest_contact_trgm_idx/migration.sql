-- Migration: order_search_guest_contact_trgm_idx (index-audit follow-up,
-- docs/perf/index-audit-2026-10.md recommendation 3, approved 2026-10-03).
-- Index-only: no column, no data change, RLS unchanged.
--
-- The admin / Orders-PWA order search (`orderSearchWhere`,
-- apps/api/src/services/order.service.ts) matched the order number and the
-- REGISTERED customer's name / email / phone. 174 of 188 production orders are
-- GUEST orders (`customer_id IS NULL`), whose buyer contact exists only in the
-- `shipping_address` JSONB snapshot — the same keys `customerKeyOf`
-- (lib/customer-key.ts) and the `/customers/search` typeahead read — so a
-- merchant could not find them by name or phone. The search now also matches
-- `shipping_address ->> 'firstName' | 'lastName' | 'email' | 'phone'` with a
-- leading-wildcard ILIKE on guest orders.
--
-- Four partial expression GIN trigram indexes, one per key, because a BitmapOr
-- needs EVERY arm of the OR indexed (same reasoning as the users_*_trgm_idx
-- set in 20261002090000_order_search_trgm_and_fk_indexes). Each is:
--   * an expression index on `(shipping_address ->> '<key>')`: the query must
--     read the identical expression, which `guestOrderIdsMatching` does;
--   * PARTIAL on `customer_id IS NULL`: only guest orders are indexed (92 % of
--     rows today, but the index never carries a registered customer's order,
--     whose contact is matched through the users table as before), and the
--     query repeats the predicate so the planner can prove it;
--   * `gin_trgm_ops`: serves ILIKE '%term%' (terms of 3+ characters; shorter
--     terms fall back to the unindexed JSON filter in the service).
-- `store_id` and `deleted_at` are then a cheap filter on the few trigram hits.
-- Measured on a scratch PG 16 with 2 stores x 25,000 orders: see the PR body.
--
-- LOCK NOTE: plain CREATE INDEX, not CONCURRENTLY — Prisma runs each migration
-- in a transaction and CONCURRENTLY cannot run inside one. Each statement
-- holds a SHARE lock that blocks WRITES (not reads) on `orders` for the build.
-- Production on 2026-10-03 holds 188 orders, so every build is milliseconds;
-- at 50,000 orders the four builds took ~1 s together on a local PG 16 (the
-- PR body has the measurement). For a table large enough that the write block
-- matters, pre-build with CONCURRENTLY on DIRECT_URL first: this migration is
-- then a no-op through IF NOT EXISTS (docs/DB-INDEX-MIGRATIONS.md).
--
-- Prisma drift: like the other trigram indexes these are raw SQL and are not
-- declared in schema.prisma (Prisma cannot express an expression or partial
-- GIN trigram index). `prisma migrate diff` / `migrate dev` will propose
-- dropping them — never accept that (docs/DB-INDEX-MIGRATIONS.md).
-- Rollback: rollback.sql alongside this file.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "orders_guest_first_name_trgm_idx"
  ON "orders" USING gin (("shipping_address" ->> 'firstName') gin_trgm_ops)
  WHERE "customer_id" IS NULL;

CREATE INDEX IF NOT EXISTS "orders_guest_last_name_trgm_idx"
  ON "orders" USING gin (("shipping_address" ->> 'lastName') gin_trgm_ops)
  WHERE "customer_id" IS NULL;

CREATE INDEX IF NOT EXISTS "orders_guest_email_trgm_idx"
  ON "orders" USING gin (("shipping_address" ->> 'email') gin_trgm_ops)
  WHERE "customer_id" IS NULL;

CREATE INDEX IF NOT EXISTS "orders_guest_phone_trgm_idx"
  ON "orders" USING gin (("shipping_address" ->> 'phone') gin_trgm_ops)
  WHERE "customer_id" IS NULL;
