-- AEO content lives in dedicated columns alongside the SEO ones, not on
-- top of them. The SEO sweep writes metaDescription / metaDescriptionAr
-- (traditional 50-160 char SEO copy). The AEO sweep writes
-- metaDescriptionAeo / metaDescriptionAeoAr (conversational answer-engine
-- copy). The storefront coalesces at render time: AEO > SEO > null.
--
-- Benefits over a single field with a source-tracking flag:
--   * No data loss — re-running AEO doesn't clobber SEO content
--   * Easy rollback — clear AEO column and SEO is intact
--   * Merchant can edit each independently from the admin form
--   * Forward-compatible to a future GEO column (metaDescriptionGeo)
--
-- All three entities (stores, products, categories) gain the AEO columns
-- so the meta-aeo sweep matches the SEO sweep's coverage.
--
-- Table names are the @@map'd plural form (stores / products / categories),
-- not the singular Prisma model names. IF NOT EXISTS guards make the
-- migration idempotent for any local environment that partially applied
-- an earlier copy of this file.

ALTER TABLE "stores"     ADD COLUMN IF NOT EXISTS "meta_description_aeo"    TEXT;
ALTER TABLE "stores"     ADD COLUMN IF NOT EXISTS "meta_description_aeo_ar" TEXT;
ALTER TABLE "products"   ADD COLUMN IF NOT EXISTS "meta_description_aeo"    TEXT;
ALTER TABLE "products"   ADD COLUMN IF NOT EXISTS "meta_description_aeo_ar" TEXT;
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "meta_description_aeo"    TEXT;
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "meta_description_aeo_ar" TEXT;
