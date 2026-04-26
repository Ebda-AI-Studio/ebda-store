-- Add admin-curated best-seller flag. Driven from the admin product edit
-- form so a merchant can mark items independently of actual sales data.
ALTER TABLE "products" ADD COLUMN "is_best_seller" BOOLEAN NOT NULL DEFAULT false;

-- Composite index lets the storefront's "Best Sellers" carousel resolve in
-- a single index scan: WHERE store_id = X AND is_best_seller = true.
CREATE INDEX "products_store_id_is_best_seller_idx" ON "products"("store_id", "is_best_seller");
