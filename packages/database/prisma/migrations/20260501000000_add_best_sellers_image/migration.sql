-- Best Sellers virtual category cover image.
--
-- The Best Sellers section is rendered as a virtual category on the
-- storefront (driven by Product.isBestSeller, no physical category
-- row). Until now its tile in the categories grid had no image —
-- merchants asked for the same visual treatment as their real
-- categories, so we store an optional URL on the Store row and the
-- categories list endpoint picks it up when emitting the virtual
-- entry.
--
-- Additive + nullable: legacy stores keep their text-only Best Sellers
-- tile until the merchant uploads an image.

ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "best_sellers_image" TEXT;
