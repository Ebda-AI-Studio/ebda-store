-- B2B wholesale pricing, part 1 of 2: the two NEW tenant tables (docs/plans/2026-10-21-b2b-wholesale.md, Task 1).
-- Previous migration on any branch: 20261027000100_admin_search_norm (this branch's tip: 20261022000200_product_embed_failures).
-- Split from part 2 (columns on hot tables) so part 2 can be reverted alone.
--
--   product_price_tiers      NEW. "From min_qty units the unit price is price_minor." variant_id NULL = product-level,
--                            group_id NULL = every buyer (a PUBLIC tier). Unique on
--                            (product, COALESCE(variant), COALESCE(group), min_qty): Prisma cannot express COALESCE,
--                            so the index lives here only (cart_items partial-index precedent). priceMinor <= base
--                            price is a service rule (needs the product row); the resolver clamps at read time.
--   wholesale_applications   NEW. A signed-in shopper applies, the merchant approves/rejects. user_id is the
--                            authenticated users.id (Ruling B2B-2), never a typed phone/email. PII table
--                            (business name, phone, commercial reg. no.): customer export + erasure cover it (Task 5).
--                            At most one PENDING application per (store, user): partial unique index.
--
-- FKs: tiers -> store/product/variant/group ON DELETE CASCADE (deleting a group deletes its tiers; the admin confirm
-- shows the count). applications -> store/user CASCADE, group SET NULL (history survives a deleted group).
-- Lock note: both tables are new and empty, so plain CREATE INDEX; the FKs take a brief SHARE ROW EXCLUSIVE on the
-- referenced tables while they are added. No lock_timeout (docs/DB-INDEX-MIGRATIONS.md).
-- Rollback: rollback.sql.

-- CreateTable
CREATE TABLE "product_price_tiers" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "variant_id" TEXT,
    "group_id" TEXT,
    "min_qty" INTEGER NOT NULL,
    "price_minor" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_price_tiers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "product_price_tiers_min_qty_chk" CHECK ("min_qty" >= 2),
    CONSTRAINT "product_price_tiers_price_minor_chk" CHECK ("price_minor" >= 0)
);

-- CreateTable
CREATE TABLE "wholesale_applications" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "business_name" TEXT NOT NULL,
    "commercial_reg_no" TEXT,
    "phone" TEXT NOT NULL,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "group_id" TEXT,
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wholesale_applications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "wholesale_applications_status_chk" CHECK ("status" IN ('pending', 'approved', 'rejected', 'revoked'))
);

-- CreateIndex
CREATE INDEX "product_price_tiers_store_id_product_id_idx" ON "product_price_tiers"("store_id", "product_id");
CREATE INDEX "product_price_tiers_variant_id_idx" ON "product_price_tiers"("variant_id");
CREATE INDEX "product_price_tiers_group_id_idx" ON "product_price_tiers"("group_id");

-- One tier per (product, variant|all, group|all, min_qty). COALESCE makes NULL scopes collide.
CREATE UNIQUE INDEX "product_price_tiers_scope_min_qty_key" ON "product_price_tiers"(
    "product_id",
    COALESCE("variant_id", '00000000-0000-0000-0000-000000000000'),
    COALESCE("group_id", '00000000-0000-0000-0000-000000000000'),
    "min_qty"
);

CREATE INDEX "wholesale_applications_store_id_status_created_at_idx" ON "wholesale_applications"("store_id", "status", "created_at");
CREATE INDEX "wholesale_applications_user_id_idx" ON "wholesale_applications"("user_id");
CREATE INDEX "wholesale_applications_group_id_idx" ON "wholesale_applications"("group_id");

-- At most one open (pending) application per shopper per store.
CREATE UNIQUE INDEX "wholesale_applications_one_pending_key" ON "wholesale_applications"("store_id", "user_id") WHERE "status" = 'pending';

-- AddForeignKey
ALTER TABLE "product_price_tiers" ADD CONSTRAINT "product_price_tiers_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_price_tiers" ADD CONSTRAINT "product_price_tiers_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_price_tiers" ADD CONSTRAINT "product_price_tiers_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_price_tiers" ADD CONSTRAINT "product_price_tiers_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "customer_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "wholesale_applications" ADD CONSTRAINT "wholesale_applications_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "wholesale_applications" ADD CONSTRAINT "wholesale_applications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "wholesale_applications" ADD CONSTRAINT "wholesale_applications_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "customer_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Strict tenant isolation (R-EBDA-001): the same single policy every store_id table carries.
ALTER TABLE product_price_tiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_price_tiers FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON product_price_tiers AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
GRANT SELECT, INSERT, UPDATE, DELETE ON product_price_tiers TO ebda_app;

ALTER TABLE wholesale_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE wholesale_applications FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON wholesale_applications AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
GRANT SELECT, INSERT, UPDATE, DELETE ON wholesale_applications TO ebda_app;
