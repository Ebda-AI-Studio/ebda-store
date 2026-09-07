-- Product bundles — schema only. Nothing reads any of this yet; the
-- pricing library, API, cart, checkout and UI land in later tasks.
--
-- Strictly additive: three new tables (bundles, bundle_items, cart_bundles)
-- plus nullable/defaulted columns on order_items and orders. No existing
-- table is dropped, retyped, or made NOT NULL, and cart_items is untouched.
--
-- cart_items is deliberately untouched: its two partial unique indexes
-- enforce (cart_id, product_id) WHERE variant_id IS NULL. Expanding a bundle
-- into cart_items rows would violate that the moment a bundle contained a
-- product already in the customer's cart, so a bundle in the cart is
-- represented by a row in the new cart_bundles table instead.
--
-- bundle_items.product_id is ON DELETE RESTRICT (not CASCADE): deleting a
-- product that is a live bundle component must fail loudly, not silently
-- gut the bundle.

-- ── CreateEnum ──────────────────────────────────────────────────────────────
CREATE TYPE "BundlePricingType" AS ENUM ('fixed_price', 'percentage', 'fixed');

-- ── CreateTable: bundles ──────────────────────────────────────────────────
CREATE TABLE "bundles" (
  "id"             TEXT                 NOT NULL,
  "store_id"       TEXT                 NOT NULL,
  "name"           TEXT                 NOT NULL,
  "name_ar"        TEXT,
  "slug"           TEXT                 NOT NULL,
  "description"    TEXT,
  "description_ar" TEXT,
  "image"          TEXT,
  "pricing_type"   "BundlePricingType"  NOT NULL,
  "pricing_value"  INTEGER              NOT NULL,
  "is_active"      BOOLEAN              NOT NULL DEFAULT true,
  "starts_at"      TIMESTAMP(3),
  "expires_at"     TIMESTAMP(3),
  "created_at"     TIMESTAMP(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMP(3)         NOT NULL,
  CONSTRAINT "bundles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "bundles_store_id_slug_key" ON "bundles" ("store_id", "slug");
CREATE INDEX "bundles_store_id_is_active_idx" ON "bundles" ("store_id", "is_active");

ALTER TABLE "bundles"
  ADD CONSTRAINT "bundles_store_id_fkey"
  FOREIGN KEY ("store_id") REFERENCES "stores"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── CreateTable: bundle_items ─────────────────────────────────────────────
CREATE TABLE "bundle_items" (
  "id"         TEXT    NOT NULL,
  "bundle_id"  TEXT    NOT NULL,
  "product_id" TEXT    NOT NULL,
  "variant_id" TEXT,
  "quantity"   INTEGER NOT NULL,
  CONSTRAINT "bundle_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bundle_items_quantity_range" CHECK (quantity >= 1 AND quantity <= 1000)
);

CREATE UNIQUE INDEX "bundle_items_bundle_id_product_id_variant_id_key"
  ON "bundle_items" ("bundle_id", "product_id", "variant_id");
CREATE INDEX "bundle_items_bundle_id_idx" ON "bundle_items" ("bundle_id");
CREATE INDEX "bundle_items_product_id_idx" ON "bundle_items" ("product_id");
CREATE INDEX "bundle_items_variant_id_idx" ON "bundle_items" ("variant_id");

ALTER TABLE "bundle_items"
  ADD CONSTRAINT "bundle_items_bundle_id_fkey"
  FOREIGN KEY ("bundle_id") REFERENCES "bundles"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Intentionally RESTRICT, not CASCADE: a merchant deleting a product must
-- not silently delete it out from under a live bundle. See header note.
ALTER TABLE "bundle_items"
  ADD CONSTRAINT "bundle_items_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "bundle_items"
  ADD CONSTRAINT "bundle_items_variant_id_fkey"
  FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── CreateTable: cart_bundles ─────────────────────────────────────────────
CREATE TABLE "cart_bundles" (
  "id"         TEXT         NOT NULL,
  "cart_id"    TEXT         NOT NULL,
  "bundle_id"  TEXT         NOT NULL,
  "quantity"   INTEGER      NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "cart_bundles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cart_bundles_cart_id_bundle_id_key" ON "cart_bundles" ("cart_id", "bundle_id");
CREATE INDEX "cart_bundles_cart_id_idx" ON "cart_bundles" ("cart_id");

ALTER TABLE "cart_bundles"
  ADD CONSTRAINT "cart_bundles_cart_id_fkey"
  FOREIGN KEY ("cart_id") REFERENCES "carts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "cart_bundles"
  ADD CONSTRAINT "cart_bundles_bundle_id_fkey"
  FOREIGN KEY ("bundle_id") REFERENCES "bundles"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── order_items: bundle tagging (snapshot, not a join) ────────────────────
-- Nullable — every existing row and every non-bundle order stays NULL.
-- bundleName/bundleNameAr are snapshots exactly like product_name and
-- cost_price already are: a six-month-old invoice must still read
-- "Ramadan Box" after the bundle is renamed or deleted.
ALTER TABLE "order_items"
  ADD COLUMN "bundle_id"        TEXT,
  ADD COLUMN "bundle_group_id"  TEXT,
  ADD COLUMN "bundle_name"      TEXT,
  ADD COLUMN "bundle_name_ar"   TEXT;

CREATE INDEX "order_items_bundle_group_id_idx" ON "order_items" ("bundle_group_id");

-- ── orders: bundle discount total ─────────────────────────────────────────
ALTER TABLE "orders"
  ADD COLUMN "bundle_discount" INTEGER NOT NULL DEFAULT 0;

-- ── RLS ───────────────────────────────────────────────────────────────────────
-- bundles carries store_id and is directly queryable, so it is a
-- promotions-shaped table — RLS mirrors 20260722140000's promotions block
-- exactly. bundle_items and cart_bundles get no RLS: neither carries
-- store_id, and both are reachable only via an RLS-protected parent (bundles
-- / carts), the same call already made for cart_items.
ALTER TABLE "bundles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bundles" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "bundles_app_select" ON "bundles";
CREATE POLICY "bundles_app_select" ON "bundles" FOR SELECT
  USING (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());

DROP POLICY IF EXISTS "bundles_app_insert" ON "bundles";
CREATE POLICY "bundles_app_insert" ON "bundles" FOR INSERT
  WITH CHECK (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());

DROP POLICY IF EXISTS "bundles_app_update" ON "bundles";
CREATE POLICY "bundles_app_update" ON "bundles" FOR UPDATE
  USING (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id())
  WITH CHECK (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());

DROP POLICY IF EXISTS "bundles_app_delete" ON "bundles";
CREATE POLICY "bundles_app_delete" ON "bundles" FOR DELETE
  USING (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());
