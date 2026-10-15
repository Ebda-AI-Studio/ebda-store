-- Migration: personalisation (Task 5, Phase B0)
--
-- products.personalisation  = PersonalisationConfig JSON (@ebda/shared), null = off.
-- cart_items.note           = the customer's personalisation text for that line.
-- order_items.personalisation = snapshot of the cart line's note.
-- No lock_timeout (docs/DB-INDEX-MIGRATIONS.md): a timeout records the migration as FAILED and
-- blocks later deploys until a manual migrate resolve. The locks (column adds, the cart_items
-- index swap) are brief: production cart_items has 0 rows and order_items is small.

ALTER TABLE "products" ADD COLUMN "personalisation" JSONB;
ALTER TABLE "cart_items" ADD COLUMN "note" TEXT;
ALTER TABLE "order_items" ADD COLUMN "personalisation" TEXT;

-- A personalised line is its own line: "Sara" and "Omar" on the same abaya are two
-- lines. Same text merges. COALESCE keeps the null-note case enforcing (see
-- 20260622000000_cart_item_null_variant_unique for why NULLs need care).
-- No existing row can collide: every row has note NULL, so the new keys are as
-- unique as the old ones.
DROP INDEX IF EXISTS "cart_items_cart_id_product_id_no_variant";
DROP INDEX IF EXISTS "cart_items_cart_id_product_id_variant_id_with_variant";
CREATE UNIQUE INDEX "cart_items_line_no_variant"
  ON "cart_items" ("cart_id", "product_id", (COALESCE("note", '')))
  WHERE "variant_id" IS NULL;
CREATE UNIQUE INDEX "cart_items_line_with_variant"
  ON "cart_items" ("cart_id", "product_id", "variant_id", (COALESCE("note", '')))
  WHERE "variant_id" IS NOT NULL;
