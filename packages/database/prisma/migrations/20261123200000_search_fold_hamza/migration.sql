-- Hamza search fold (fold A) beside the unchanged original fold (fold B). Ruling F7-HAMZA-2 (supersedes F7-HAMZA-1).
--
-- WHAT: ADDITIVE. public.ebda_ar_norm (fold B, the original) and its three indexes are NOT touched: no body change, no reindex, no lock on
--   existing objects. New: public.ebda_ar_norm_h(text) (fold A): normalize(t, NFKC); delete tashkeel U+064B-U+065F, dagger alef U+0670, tatweel
--   U+0640; translate() the B table with U+0626 (ئ) and U+0624 (ؤ) and U+0621 (ء) all to و; collapse a run of و to one و; collapse
--   [ \t\n\r U+00A0]+ to U+0020, trim U+0020. Twin of foldArabicHamza (packages/shared/src/foundation/text.ts, vendored from ebda-foundation): the
--   translate() strings below ARE AR_FOLD_H_FROM / AR_FOLD_H_TO byte for byte (tests/integration/search-normalize-parity.test.ts reads THIS file).
--   Also new: ebda_product_search_doc_h / ebda_product_name_doc_h, two trigram GIN expression indexes on them, and
--   ebda_product_search_ids_h (the SECURITY DEFINER candidate function of 20261024000300, over the fold-A docs, no SKU arm: the SKU stays on fold B).
--   The app runs BOTH functions and ORs the ids (productSearchSql): a query word matches under fold B OR under fold A.
-- WHY: Egyptian shoppers write مسئول and مسؤول interchangeably (fold A) AND ي for ئ (سايل for سائل, fold B). No single fold has both.
--   normalize(text, NFKC) is IMMUTABLE (pg_proc.provolatile = 'i', verified on PostgreSQL 17.11) and needs a UTF8 database (Neon is).
-- LOCK: the two indexes below are plain CREATE INDEX IF NOT EXISTS because Prisma runs this file in one transaction (SHARE lock on `products` while they
--   build: instant before launch, on an empty or small table). Post-launch pre-build them CONCURRENTLY on DIRECT_URL in psql autocommit, off-peak
--   (docs/DB-INDEX-MIGRATIONS.md, "Hamza fold indexes"); this file then re-runs every statement as IF NOT EXISTS / CREATE OR REPLACE, a no-op.
-- AFTER DEPLOY: the Durable Object search index of each store gains fold-A columns; ensureSearchIndex rebuilds it lazily from the dirty queue, run
--   reindexStore per store to do it eagerly (verifyProductIndex lists the stale rows).
-- Rollback: rollback.sql (code first). Migration number assigned by the author; the controller may renumber.

CREATE OR REPLACE FUNCTION public.ebda_ar_norm_h(t text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT btrim(regexp_replace(
    regexp_replace(
      translate(
        regexp_replace(normalize(t, NFKC), E'[\u064B-\u065F\u0670\u0640]', '', 'g'),
        'أإآٱىیئؤةکABCDEFGHIJKLMNOPQRSTUVWXYZ٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹ء',
        'ااااييووهكabcdefghijklmnopqrstuvwxyz01234567890123456789و'
      ),
      E'\u0648{2,}', E'\u0648', 'g'
    ),
    E'[ \t\n\r\u00A0]+', ' ', 'g'
  ), ' ')
$$;

CREATE OR REPLACE FUNCTION public.ebda_product_search_doc_h(
  p_name text, p_name_ar text, p_terms text, p_desc text, p_desc_ar text
) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT public.ebda_ar_norm_h(
    coalesce(p_name, '') || ' ' || coalesce(p_name_ar, '') || ' ' || coalesce(p_terms, '') || ' ' ||
    coalesce(p_desc, '') || ' ' || coalesce(p_desc_ar, '')
  )
$$;

CREATE OR REPLACE FUNCTION public.ebda_product_name_doc_h(
  p_name text, p_name_ar text, p_terms text
) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT public.ebda_ar_norm_h(coalesce(p_name, '') || ' ' || coalesce(p_name_ar, '') || ' ' || coalesce(p_terms, ''))
$$;

CREATE INDEX IF NOT EXISTS "products_search_doc_h_trgm_idx" ON "products" USING gin
  (public.ebda_product_search_doc_h("name", "name_ar", "search_terms", "description", "description_ar") gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "products_name_doc_h_trgm_idx" ON "products" USING gin
  (public.ebda_product_name_doc_h("name", "name_ar", "search_terms") gin_trgm_ops);

CREATE OR REPLACE FUNCTION public.ebda_product_search_ids_h(
  p_store_id text,
  p_field text,
  p_with_sku boolean,
  p_only_active boolean,
  p_include_deleted boolean,
  p_word_start boolean,
  p_patterns text[]
)
RETURNS SETOF text
LANGUAGE plpgsql STABLE SECURITY DEFINER ROWS 500
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  doc text;
  v_scope text;
  arm text;
  b text;
  v_bounds text[] := ARRAY['', '% ', '%/', '%(', '%-', '%,', '%.', 'ا', '% ا', 'ال', '% ال'];
  arms text := '';
  n int := coalesce(array_length(p_patterns, 1), 0);
  i int;
BEGIN
  -- The store comes ONLY from the scoped session (app.current_store_id, set transaction-locally by
  -- the app), never from the argument. No scope at all is a programming error or a probe: refuse
  -- (42501). An argument naming any other store gets an empty answer, indistinguishable from "no
  -- match", so the function is not an existence oracle. There is no exemption for owner or
  -- BYPASSRLS sessions: the scope is the single source of the store.
  v_scope := nullif(current_setting('app.current_store_id', true), '');
  IF v_scope IS NULL THEN
    RAISE EXCEPTION 'ebda_product_search_ids: no store scope' USING ERRCODE = '42501';
  END IF;
  IF p_store_id IS DISTINCT FROM v_scope THEN
    RETURN;
  END IF;
  -- searchTokens() caps a query at 8 words; refuse anything else rather than build a huge AND.
  IF n < 1 OR n > 8 THEN
    RETURN;
  END IF;
  IF p_field = 'name' THEN
    doc := 'public.ebda_product_name_doc_h(p.name, p.name_ar, p.search_terms)';
  ELSIF p_field = 'all' THEN
    doc := 'public.ebda_product_search_doc_h(p.name, p.name_ar, p.search_terms, p.description, p.description_ar)';
  ELSE
    RETURN;
  END IF;
  -- p_word_start (Ruling SEARCH-T14-3): a query made only of words under 3 characters cannot use a
  -- trigram index as a substring, so the caller sends PREFIX patterns ('ab%') and the word must
  -- START a word of the document. "Starts a word" means, in the normalised document: at the start,
  -- after a space, after one of the punctuation marks that join sizes and lists (S/XL, (XL), a-b,
  -- a,b, a.b), or after the Arabic definite article / a one-letter prefix (a short word such as the
  -- two letters of "rice" must find the article form and the alef-hamza form, which folds to a
  -- plain alef). Each boundary is one LIKE arm; pg_trgm treats punctuation and spaces alike, so
  -- every arm extracts the same word-start trigrams and the same GIN index serves all of them
  -- (BitmapOr). Review I-1. Other prefixes and other punctuation are a residual, see the ruling.
  FOR i IN 1..n LOOP
    IF coalesce(p_word_start, false) THEN
      arm := '';
      FOREACH b IN ARRAY v_bounds LOOP
        arm := arm || CASE WHEN arm = '' THEN '' ELSE ' OR ' END
                   || format('%s LIKE (%L || $1[%s])', doc, b, i);
      END LOOP;
      arms := arms || ' AND (' || arm || ')';
    ELSE
      arms := arms || format(' AND %s LIKE $1[%s]', doc, i);
    END IF;
  END LOOP;
  RETURN QUERY EXECUTE
    'SELECT p.id FROM public.products p WHERE p.store_id = $2'
    || CASE WHEN coalesce(p_only_active, false) THEN ' AND p.status = ''active''' ELSE '' END
    || CASE WHEN coalesce(p_include_deleted, false) THEN '' ELSE ' AND p.deleted_at IS NULL' END
    || arms
    USING p_patterns, v_scope;
END
$fn$;

REVOKE ALL ON FUNCTION public.ebda_product_search_ids_h(text, text, boolean, boolean, boolean, boolean, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ebda_product_search_ids_h(text, text, boolean, boolean, boolean, boolean, text[]) TO ebda_app;
