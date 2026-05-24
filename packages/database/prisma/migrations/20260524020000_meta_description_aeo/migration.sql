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
-- All three entities (store, product, category) gain the AEO columns so
-- the meta-aeo sweep matches the SEO sweep's coverage.

ALTER TABLE "store"     ADD COLUMN "meta_description_aeo"    TEXT;
ALTER TABLE "store"     ADD COLUMN "meta_description_aeo_ar" TEXT;
ALTER TABLE "product"   ADD COLUMN "meta_description_aeo"    TEXT;
ALTER TABLE "product"   ADD COLUMN "meta_description_aeo_ar" TEXT;
ALTER TABLE "category"  ADD COLUMN "meta_description_aeo"    TEXT;
ALTER TABLE "category"  ADD COLUMN "meta_description_aeo_ar" TEXT;
