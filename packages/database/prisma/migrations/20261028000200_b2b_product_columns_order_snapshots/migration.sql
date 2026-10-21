-- B2B wholesale pricing, part 2 of 2: columns on existing tables (docs/plans/2026-10-21-b2b-wholesale.md, Task 1).
-- Previous migration: 20261028000100_b2b_pricing_tables. Split from it so these hot-table columns can be reverted alone.
--
--   customer_groups  += pricing_mode ('none'|'percent_off'), discount_bps (0..9000), requires_approval, is_wholesale
--   products         += moq (NULL or >= 2), audience ('public'|'wholesale_only')
--   order_items      += list_price, price_source ('base'|'tier'|'group'), price_tier_min_qty   (all nullable)
--   orders           += price_group_name                                                       (nullable)
--
-- Every new column is nullable or has a CONSTANT default, so PG 11+ adds it without a table rewrite. The CHECKs are
-- added NOT VALID then VALIDATEd: existing rows satisfy them by construction (defaults / NULL), and the two-step form
-- keeps the ACCESS EXCLUSIVE window to the catalog change only. No lock_timeout (docs/DB-INDEX-MIGRATIONS.md).
-- No index on products(store_id, audience): the Task 6 listing query is verified against EXPLAIN there; add it then if needed.
-- order_items / orders carry no policy change (order_items is covered via orders; orders is already strict-RLS).
--   plans            limits JSON += "wholesalePricing" (Ruling B2B-1): true for business + comped, false elsewhere. A
--                    plans.limits blob without the key already parses to false (planLimitsSchema .default(false)),
--                    but writing the key explicitly keeps the stored blob equal to DEFAULT_PLAN_SEEDS.
-- Rollback: rollback.sql.

-- AlterTable
ALTER TABLE "customer_groups"
  ADD COLUMN "pricing_mode" TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN "discount_bps" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "requires_approval" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "is_wholesale" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "customer_groups"
  ADD CONSTRAINT "customer_groups_pricing_mode_chk" CHECK ("pricing_mode" IN ('none', 'percent_off')) NOT VALID,
  ADD CONSTRAINT "customer_groups_discount_bps_chk" CHECK ("discount_bps" BETWEEN 0 AND 9000) NOT VALID;
ALTER TABLE "customer_groups" VALIDATE CONSTRAINT "customer_groups_pricing_mode_chk";
ALTER TABLE "customer_groups" VALIDATE CONSTRAINT "customer_groups_discount_bps_chk";

-- AlterTable
ALTER TABLE "products"
  ADD COLUMN "moq" INTEGER,
  ADD COLUMN "audience" TEXT NOT NULL DEFAULT 'public';

ALTER TABLE "products"
  ADD CONSTRAINT "products_moq_chk" CHECK ("moq" IS NULL OR "moq" >= 2) NOT VALID,
  ADD CONSTRAINT "products_audience_chk" CHECK ("audience" IN ('public', 'wholesale_only')) NOT VALID;
ALTER TABLE "products" VALIDATE CONSTRAINT "products_moq_chk";
ALTER TABLE "products" VALIDATE CONSTRAINT "products_audience_chk";

-- AlterTable (snapshots: NULL on every order placed before B2B reads as source 'base')
ALTER TABLE "order_items"
  ADD COLUMN "list_price" INTEGER,
  ADD COLUMN "price_source" TEXT,
  ADD COLUMN "price_tier_min_qty" INTEGER;

ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_price_source_chk" CHECK ("price_source" IS NULL OR "price_source" IN ('base', 'tier', 'group')) NOT VALID;
ALTER TABLE "order_items" VALIDATE CONSTRAINT "order_items_price_source_chk";

-- AlterTable
ALTER TABLE "orders" ADD COLUMN "price_group_name" TEXT;

-- Plan entitlement (Ruling B2B-1, Ahmad 2026-10-21: Business plan only; comped = everything on). `||` merges one key and
-- leaves every other limit untouched; plans that do not exist are simply not updated.
UPDATE "plans" SET "limits" = "limits" || '{"wholesalePricing":true}'::jsonb WHERE "code" IN ('business', 'comped');
UPDATE "plans" SET "limits" = "limits" || '{"wholesalePricing":false}'::jsonb WHERE "code" NOT IN ('business', 'comped');
