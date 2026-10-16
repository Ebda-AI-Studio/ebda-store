-- Search normalisation follow-up (search program P0, plan docs/plans/2026-10-15-semantic-search.md, Task 3).
--
-- WHAT: (1) a trigram GIN EXPRESSION index on public.ebda_ar_norm(coalesce("sku", '')) so the admin
--   product search's SKU arm (`... OR public.ebda_ar_norm(coalesce(p.sku, '')) LIKE '%tok%'`) is
--   index-backed: a BitmapOr needs EVERY arm indexed, or the planner falls back to a sequential scan.
--   The expression is byte-for-byte the one apps/api/src/services/product-search.service.ts queries.
--   (2) CHECK (char_length(search_terms) <= 500) so every writer (merchant form, AI fill, bulk/CSV
--   import, duplicate) is capped by the database, not only by the routes that remember to validate.
-- WHY: Arabic-Indic digits and lower case in a SKU ("MUG-٧٧") must match "mug-77", and the search
--   doc indexes (20261019000100) do not cover the sku column.
-- IMMUTABLE contract: as in 20261019000100, changing public.ebda_ar_norm REQUIRES
--   `REINDEX INDEX CONCURRENTLY "products_sku_norm_trgm_idx"` too.
--
-- LOCK NOTE: Prisma runs this file in one transaction, so the index is a plain CREATE INDEX (SHARE
--   lock: blocks writes to `products` while it builds) and ADD CONSTRAINT scans the table under an
--   ACCESS EXCLUSIVE lock. No lock_timeout (docs/DB-INDEX-MIGRATIONS.md).
-- PRE-BUILD: post-launch only. Pre-launch (products is empty) the CONCURRENTLY pre-build is waived
--   (Ruling SEARCH-16); after launch, follow docs/DB-INDEX-MIGRATIONS.md § "Pre-build: search
--   normalisation" for this index too, and add the constraint as NOT VALID + VALIDATE CONSTRAINT.
-- KNOWN DRIFT: Prisma cannot declare expression indexes or CHECK constraints; never accept a
--   `migrate dev` DROP of either.
-- Rollback: rollback.sql (drops the index CONCURRENTLY and the constraint; no data loss).

CREATE INDEX IF NOT EXISTS "products_sku_norm_trgm_idx" ON "products" USING gin
  (public.ebda_ar_norm(coalesce("sku", '')) gin_trgm_ops);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'products_search_terms_len_chk' AND conrelid = 'public.products'::regclass
  ) THEN
    ALTER TABLE "products" ADD CONSTRAINT "products_search_terms_len_chk"
      CHECK (char_length("search_terms") <= 500);
  END IF;
END
$$;
