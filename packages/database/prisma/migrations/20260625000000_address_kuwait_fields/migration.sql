-- Add Kuwait-specific address fields to the `addresses` table.
--
-- The `address.routes.ts` Zod schema was missing `governorate` /
-- `governorateAr` / `areaAr`, so those fields were silently stripped when a
-- customer saved an address from the checkout form.  This migration adds the
-- three nullable columns so the data can be persisted.  Existing rows are
-- unaffected (columns default to NULL / empty string).
--
-- Mirrors the fields already present on the `orders` shippingAddress JSON
-- column and the `order.routes.ts` + `public.routes.ts` Zod schemas.

ALTER TABLE "addresses"
  ADD COLUMN IF NOT EXISTS "governorate"    TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "governorate_ar" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "area_ar"        TEXT NOT NULL DEFAULT '';
