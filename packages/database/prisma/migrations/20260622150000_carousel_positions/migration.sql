-- Migration: add carousel position columns to products
--
-- Adds merchant-controllable ordering of products within the New Arrivals
-- and Best Sellers homepage carousels. Existing rows default to 0
-- (stable tie-break; actual order determined by the secondary sort —
-- createdAt desc — until the merchant sets an explicit order).
--
-- The composite filtered indexes make ordered carousel queries O(log n)
-- regardless of catalog size, by only covering the rows relevant to
-- each carousel (is_new=true / is_best_seller=true).

ALTER TABLE "products" ADD COLUMN "new_arrival_position" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "products" ADD COLUMN "best_seller_position" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "products_store_id_is_new_new_arrival_position_idx"
  ON "products" ("store_id", "is_new", "new_arrival_position")
  WHERE "is_new" = true;

CREATE INDEX "products_store_id_is_best_seller_best_seller_position_idx"
  ON "products" ("store_id", "is_best_seller", "best_seller_position")
  WHERE "is_best_seller" = true;
