-- Add per-store country to shipping area rates so a merchant can build a custom
-- country -> province (governorate) -> area hierarchy. Existing rows are all
-- Kuwait, so the NOT NULL defaults backfill cleanly and the new unique key does
-- not collide.
ALTER TABLE "shipping_area_rates" ADD COLUMN IF NOT EXISTS "country" TEXT NOT NULL DEFAULT 'Kuwait';
ALTER TABLE "shipping_area_rates" ADD COLUMN IF NOT EXISTS "country_ar" TEXT NOT NULL DEFAULT 'الكويت';

-- Widen the uniqueness to include country (a custom area under a custom country
-- must not collide with a same-named area under Kuwait).
DROP INDEX IF EXISTS "shipping_area_rates_store_id_governorate_area_key";
CREATE UNIQUE INDEX IF NOT EXISTS "shipping_area_rates_store_id_country_governorate_area_key"
  ON "shipping_area_rates"("store_id", "country", "governorate", "area");
