-- Bilingual tag labels (Phase B3 fix wave 1): the skin-type / concern chips and the PLP title read the
-- Arabic label on an Arabic storefront. Additive nullable column: no existing row changes, RLS and the
-- tenant guard are untouched (the table keeps its store_id policy). Rollback: docs/ROLLBACK.md.
ALTER TABLE "tags" ADD COLUMN IF NOT EXISTS "name_ar" TEXT;
