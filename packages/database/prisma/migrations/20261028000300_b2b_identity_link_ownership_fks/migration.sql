-- B2B wholesale, design-review fixes C1 + C3 (docs/plans/2026-10-21-b2b-wholesale.md, "Design review 2026-10-21").
-- Previous migration: 20261028000200_b2b_product_columns_order_snapshots. Kept separate (not amended into 0100/0200)
-- so the unmerged pair stays reviewable as shipped and this one can be reverted alone.
--
-- C1 (Ruling B2B-2c): a wholesale price is granted ONLY through customers.user_id, a link to the session user. An
--   email / phone match on customers can be steered by typed input (assignByIdentity matches phone first and then
--   overwrites email), so it must never decide a price.
--     customers.user_id          NULL = a CRM / guest row (grants no price). Set only by wholesale approval (Task 5) or
--                                by the merchant's group dropdown on a REGISTERED shopper's profile.
--     (store_id, user_id) -> users(store_id, id) ON DELETE SET NULL (user_id): erasing the user unlinks the row and the
--                                store_id column is kept (PG15+ column-list SET NULL).
--     unique (store_id, user_id) WHERE user_id IS NOT NULL: one CRM row per user per store.
--   Backfill: ONLY an exact case-insensitive email match against an email_verified customer-role user of the SAME store,
--   and only when that is unambiguous (one user <-> one customer row, the oldest). Ebda is pre-launch; there are no
--   group-priced orders to protect.
--
-- C3 (Ruling B2B-TEN-1): ownership is enforced by composite FKs, not only by the service. A tier, group or application row
--   can no longer point at another store's product / group / user, or at a variant of another product. Needed unique
--   targets: products(store_id,id), product_variants(product_id,id), customer_groups(store_id,id), users(store_id,id).
--   The old single-column FKs are KEPT (redundant, same delete rule) because the Prisma relations are declared on them.
--   MATCH SIMPLE skips a composite FK whose nullable column is NULL, which is exactly right for variant_id / group_id.
--   customers (store_id, group_id) -> customer_groups ON DELETE SET NULL (group_id) is added too: group membership is now
--   money-critical and a cross-store group id on a customer must be impossible.
--
-- Lock note: plain CREATE UNIQUE INDEX on products / product_variants / customer_groups / users (pre-launch, small tables;
-- docs/DB-INDEX-MIGRATIONS.md). Adding the FKs validates existing rows: if any violating row existed the migration would
-- fail loudly and roll back, which is the intended behaviour; the pre-flight SELECTs are in the integration test.
-- Rollback: rollback.sql.

-- ── unique targets for the composite FKs ─────────────────────────────────────
CREATE UNIQUE INDEX "products_store_id_id_key" ON "products"("store_id", "id");
CREATE UNIQUE INDEX "product_variants_product_id_id_key" ON "product_variants"("product_id", "id");
CREATE UNIQUE INDEX "customer_groups_store_id_id_key" ON "customer_groups"("store_id", "id");
CREATE UNIQUE INDEX "users_store_id_id_key" ON "users"("store_id", "id");

-- ── C1: customers.user_id ────────────────────────────────────────────────────
ALTER TABLE "customers" ADD COLUMN "user_id" TEXT;

CREATE UNIQUE INDEX "customers_store_id_user_id_key" ON "customers"("store_id", "user_id") WHERE "user_id" IS NOT NULL;

ALTER TABLE "customers"
  ADD CONSTRAINT "customers_store_id_user_id_fkey"
  FOREIGN KEY ("store_id", "user_id") REFERENCES "users"("store_id", "id") ON DELETE SET NULL ("user_id") ON UPDATE CASCADE;

-- Backfill: one verified customer-role user <-> its OLDEST same-store customer row with that exact (case-insensitive) email.
WITH ranked AS (
  SELECT c.id AS customer_id,
         u.id AS user_id,
         row_number() OVER (PARTITION BY u.id ORDER BY c.created_at, c.id) AS rn_for_user,
         count(*)     OVER (PARTITION BY c.id) AS users_for_customer
    FROM "customers" c
    JOIN "users" u
      ON u."store_id" = c."store_id"
     AND u."role" = 'customer'
     AND u."email_verified" = true
     AND u."deleted_at" IS NULL
     AND lower(u."email") = lower(c."email")
   WHERE c."email" IS NOT NULL
)
UPDATE "customers" c
   SET "user_id" = r.user_id
  FROM ranked r
 WHERE c.id = r.customer_id
   AND r.rn_for_user = 1
   AND r.users_for_customer = 1;

-- ── C3: ownership FKs ────────────────────────────────────────────────────────
ALTER TABLE "product_price_tiers"
  ADD CONSTRAINT "product_price_tiers_store_product_fkey"
  FOREIGN KEY ("store_id", "product_id") REFERENCES "products"("store_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_price_tiers"
  ADD CONSTRAINT "product_price_tiers_product_variant_fkey"
  FOREIGN KEY ("product_id", "variant_id") REFERENCES "product_variants"("product_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_price_tiers"
  ADD CONSTRAINT "product_price_tiers_store_group_fkey"
  FOREIGN KEY ("store_id", "group_id") REFERENCES "customer_groups"("store_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "wholesale_applications"
  ADD CONSTRAINT "wholesale_applications_store_user_fkey"
  FOREIGN KEY ("store_id", "user_id") REFERENCES "users"("store_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "wholesale_applications"
  ADD CONSTRAINT "wholesale_applications_store_group_fkey"
  FOREIGN KEY ("store_id", "group_id") REFERENCES "customer_groups"("store_id", "id") ON DELETE SET NULL ("group_id") ON UPDATE CASCADE;

ALTER TABLE "customers"
  ADD CONSTRAINT "customers_store_group_fkey"
  FOREIGN KEY ("store_id", "group_id") REFERENCES "customer_groups"("store_id", "id") ON DELETE SET NULL ("group_id") ON UPDATE CASCADE;
