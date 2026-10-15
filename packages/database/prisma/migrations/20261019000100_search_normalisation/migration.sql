-- Arabic search normalisation (search program P0, plan docs/plans/2026-10-15-semantic-search.md, Task 2).
--
-- WHAT: public.ebda_ar_norm(text) folds alef forms (أإآٱ->ا), ى/ی/ئ->ي, ؤ->و, ة->ه, Persian kaf->ك,
--   strips tashkeel (U+064B-U+065F), dagger alef (U+0670) and tatweel (U+0640), maps Arabic-Indic
--   and Persian digits to 0-9, lowercases ASCII A-Z only, collapses [ \t\n\r U+00A0]+ to one
--   U+0020 and trims U+0020 only at the edges (other Unicode spaces are kept).
--   Twin of normalizeArabicSearch (@ebda/shared, packages/shared/src/search/arabic-normalize.ts):
--   the translate() strings below ARE AR_FOLD_FROM / AR_FOLD_TO byte for byte, and both sides are
--   tested against NORMALIZE_VECTORS + a generated sample (tests/integration/search-normalize-parity.test.ts).
--   The regex classes are written as E'' escapes so they do not depend on standard_conforming_strings.
--   Two IMMUTABLE doc functions build the searched text; two trigram GIN EXPRESSION indexes
--   serve '%token%' LIKE on them. products.search_terms (merchant-editable; AI-filled in P1)
--   is added now so the doc functions' signature is final and P1 does not rebuild the indexes.
-- WHY: ILIKE does not fold Arabic letter variants: "احذيه" never matched "أحذية".
-- IMMUTABLE contract: changing a function body REQUIRES `REINDEX INDEX CONCURRENTLY` of both
--   indexes in the same change (the index stores the old output). Bodies call public.* fully
--   qualified so pg_restore (empty search_path) can rebuild the index.
-- concat_ws/array_to_string are STABLE, so the docs use coalesce(...) || ' ' || ... (immutable).
--
-- LOCK NOTE: Prisma runs this file in one transaction, so the indexes below are plain CREATE INDEX
--   (SHARE lock: blocks writes to `products` while they build). On production they are no-ops,
--   because the prerequisite below pre-builds them CONCURRENTLY and every statement here is
--   IF NOT EXISTS / CREATE OR REPLACE. No lock_timeout (docs/DB-INDEX-MIGRATIONS.md).
--
-- >>> PRODUCTION PREREQUISITE (do NOT skip; plan STOP-1): `products` is a live table. Before this
-- reaches production, run on DIRECT_URL in psql autocommit (no BEGIN), off-peak:
--   1. CREATE EXTENSION IF NOT EXISTS pg_trgm;
--   2. the three CREATE OR REPLACE FUNCTION statements below, verbatim;
--   3. ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "search_terms" TEXT;
--   4. CREATE INDEX CONCURRENTLY IF NOT EXISTS "products_search_doc_trgm_idx" ON "products" USING gin
--        (public.ebda_product_search_doc("name", "name_ar", "search_terms", "description", "description_ar") gin_trgm_ops);
--   5. CREATE INDEX CONCURRENTLY IF NOT EXISTS "products_name_doc_trgm_idx" ON "products" USING gin
--        (public.ebda_product_name_doc("name", "name_ar", "search_terms") gin_trgm_ops);
--   6. SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE NOT i.indisvalid;
--      must return 0 rows (else DROP INDEX CONCURRENTLY the invalid one and retry step 4/5).
--   The same runbook is in docs/DB-INDEX-MIGRATIONS.md § "Pre-build: search normalisation".
-- ADD COLUMN of a nullable TEXT without default is catalog-only (no rewrite).
-- KNOWN DRIFT: Prisma cannot declare expression indexes; never accept a `migrate dev` DROP of them.
-- Rollback: rollback.sql (drops the two indexes CONCURRENTLY; keeps the column and functions).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION public.ebda_ar_norm(t text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT btrim(regexp_replace(
    translate(
      regexp_replace(t, E'[\u064B-\u065F\u0670\u0640]', '', 'g'),
      'أإآٱىیئؤةکABCDEFGHIJKLMNOPQRSTUVWXYZ٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹',
      'اااايييوهكabcdefghijklmnopqrstuvwxyz01234567890123456789'
    ),
    E'[ \t\n\r\u00A0]+', ' ', 'g'
  ), ' ')
$$;

CREATE OR REPLACE FUNCTION public.ebda_product_search_doc(
  p_name text, p_name_ar text, p_terms text, p_desc text, p_desc_ar text
) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT public.ebda_ar_norm(
    coalesce(p_name, '') || ' ' || coalesce(p_name_ar, '') || ' ' || coalesce(p_terms, '') || ' ' ||
    coalesce(p_desc, '') || ' ' || coalesce(p_desc_ar, '')
  )
$$;

CREATE OR REPLACE FUNCTION public.ebda_product_name_doc(
  p_name text, p_name_ar text, p_terms text
) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT public.ebda_ar_norm(coalesce(p_name, '') || ' ' || coalesce(p_name_ar, '') || ' ' || coalesce(p_terms, ''))
$$;

ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "search_terms" TEXT;

CREATE INDEX IF NOT EXISTS "products_search_doc_trgm_idx" ON "products" USING gin
  (public.ebda_product_search_doc("name", "name_ar", "search_terms", "description", "description_ar") gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "products_name_doc_trgm_idx" ON "products" USING gin
  (public.ebda_product_name_doc("name", "name_ar", "search_terms") gin_trgm_ops);
