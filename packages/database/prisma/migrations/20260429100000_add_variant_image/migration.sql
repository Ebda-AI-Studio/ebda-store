-- Per-variant image URL.
--
-- Lets merchants attach a distinct image to each ProductVariant (e.g. a
-- 200g jar that visibly differs from the 50g version). The storefront
-- swaps the gallery's main image to this URL when a variant is selected
-- and reverts to the product's images when the variant is deselected.
--
-- Additive + nullable so legacy variants keep rendering against the
-- product's image set with no backfill required. The IF NOT EXISTS
-- clause makes this migration idempotent against environments where
-- the column was already provisioned by an earlier consolidated
-- migration.

ALTER TABLE "product_variants" ADD COLUMN IF NOT EXISTS "image_url" TEXT;
