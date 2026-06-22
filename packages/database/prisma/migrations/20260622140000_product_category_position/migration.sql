-- Migration: add position column to product_categories
--
-- Adds merchant-controllable ordering of products within a category.
-- Existing rows default to 0 (stable tie-break; actual order determined
-- by the secondary sort — createdAt desc — until the merchant reorders).
-- The composite index on (category_id, position) makes ordered category
-- listings O(log n) on the join table regardless of catalog size.

ALTER TABLE "product_categories" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "product_categories_category_id_position_idx"
  ON "product_categories" ("category_id", "position");
