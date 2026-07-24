-- Promotions engine + coupon targeting.
--
-- Adds a shared targeting field set to coupons and a new `promotions` table
-- (automatic, code-less discounts), plus order audit columns for the applied
-- promotion. All coupon targeting columns are nullable / default-empty, so
-- existing coupons keep targeting everyone. RLS: promotions is tenant data —
-- FORCE RLS + one policy per command, canonical hybrid predicate copied from
-- 20260609000000. Bypass value is 'true', never 'on'.

-- ── coupons: targeting columns ────────────────────────────────────────────────
ALTER TABLE "coupons"
  ADD COLUMN "customer_group_id"  TEXT,
  ADD COLUMN "first_order_only"   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "min_quantity"       INTEGER,
  ADD COLUMN "scope_product_ids"  TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN "scope_category_ids" TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE "coupons"
  ADD CONSTRAINT "coupons_customer_group_id_fkey"
  FOREIGN KEY ("customer_group_id") REFERENCES "customer_groups"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "coupons_store_id_customer_group_id_idx"
  ON "coupons" ("store_id", "customer_group_id");

-- ── promotions ────────────────────────────────────────────────────────────────
CREATE TABLE "promotions" (
  "id"                 TEXT         NOT NULL,
  "store_id"           TEXT         NOT NULL,
  "name"               TEXT         NOT NULL,
  "name_ar"            TEXT,
  "description"        TEXT,
  "description_ar"     TEXT,
  "type"               "CouponType" NOT NULL DEFAULT 'percentage',
  "value"              INTEGER      NOT NULL,
  "max_discount"       INTEGER,
  "priority"           INTEGER      NOT NULL DEFAULT 0,
  "is_active"          BOOLEAN      NOT NULL DEFAULT true,
  "starts_at"          TIMESTAMP(3),
  "expires_at"         TIMESTAMP(3),
  "customer_group_id"  TEXT,
  "first_order_only"   BOOLEAN      NOT NULL DEFAULT false,
  "min_order_amount"   INTEGER,
  "min_quantity"       INTEGER,
  "scope_product_ids"  TEXT[]       NOT NULL DEFAULT '{}',
  "scope_category_ids" TEXT[]       NOT NULL DEFAULT '{}',
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "promotions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "promotions_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "promotions_customer_group_id_fkey"
    FOREIGN KEY ("customer_group_id") REFERENCES "customer_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "promotions_store_id_is_active_idx" ON "promotions" ("store_id", "is_active");
CREATE INDEX "promotions_store_id_customer_group_id_idx" ON "promotions" ("store_id", "customer_group_id");

-- ── orders: applied-promotion audit ───────────────────────────────────────────
ALTER TABLE "orders"
  ADD COLUMN "promotion_discount"  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "applied_promotion_id" TEXT;

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_applied_promotion_id_fkey"
  FOREIGN KEY ("applied_promotion_id") REFERENCES "promotions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ── RLS ───────────────────────────────────────────────────────────────────────
ALTER TABLE "promotions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "promotions" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "promotions_app_select" ON "promotions";
CREATE POLICY "promotions_app_select" ON "promotions" FOR SELECT
  USING (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());

DROP POLICY IF EXISTS "promotions_app_insert" ON "promotions";
CREATE POLICY "promotions_app_insert" ON "promotions" FOR INSERT
  WITH CHECK (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());

DROP POLICY IF EXISTS "promotions_app_update" ON "promotions";
CREATE POLICY "promotions_app_update" ON "promotions" FOR UPDATE
  USING (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id())
  WITH CHECK (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());

DROP POLICY IF EXISTS "promotions_app_delete" ON "promotions";
CREATE POLICY "promotions_app_delete" ON "promotions" FOR DELETE
  USING (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());
