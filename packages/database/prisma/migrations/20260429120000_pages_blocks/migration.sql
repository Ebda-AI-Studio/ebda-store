-- Pages CMS: replace markdown columns with structured block arrays.
--
-- Verified pre-deploy that `store_pages` has zero rows in production
-- (psql ... SELECT FROM store_pages -> 0), so we can drop the markdown
-- text columns and add the new JSONB columns without writing a backfill.
--
-- The block schema lives in apps/api/src/services/pages.service.ts as a
-- discriminated union (heading | paragraph | bullets | numbered | image
-- | button). The API renders blocks to HTML server-side and every text
-- input is HTML-escaped so the storefront can use the output directly.
--
-- IF EXISTS / IF NOT EXISTS clauses keep the migration idempotent in
-- environments that already partially rolled the change.

ALTER TABLE "store_pages" DROP COLUMN IF EXISTS "content_md";
ALTER TABLE "store_pages" DROP COLUMN IF EXISTS "content_md_ar";

ALTER TABLE "store_pages" ADD COLUMN IF NOT EXISTS "content_blocks" JSONB;
ALTER TABLE "store_pages" ADD COLUMN IF NOT EXISTS "content_blocks_ar" JSONB;
