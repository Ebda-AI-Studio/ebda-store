-- Catalogue field sweeps (2026-07-03): add Product.excerpt / excerptAr so the
-- bulk-ai-excerpt sweep has somewhere to write its 1-2 sentence short
-- description. Nullable, additive-only — no backfill needed.
ALTER TABLE "products" ADD COLUMN "excerpt" TEXT;
ALTER TABLE "products" ADD COLUMN "excerpt_ar" TEXT;
