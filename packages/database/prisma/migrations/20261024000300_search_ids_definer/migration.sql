-- Lexical product search that can use its trigram indexes under RLS (search program P1, Task 14
-- load-test finding; Ruling SEARCH-T14-1).
--
-- Problem (measured, `ebda_app`, 20 000 products in one store): the storefront / typeahead / admin
-- statement `WHERE ebda_product_search_doc(...) LIKE '%x%'` never touched
-- products_search_doc_trgm_idx / products_name_doc_trgm_idx / products_sku_norm_trgm_idx. The
-- tenant policy is a security barrier, and Postgres lets a user qual run before it (so be an index
-- condition) only if every function in it is LEAKPROOF. btrim, regexp_replace, translate and
-- texticlike are not (pg_proc.proleakproof = f) and a non-superuser cannot mark anything
-- leakproof, so the statement became a store_id scan that normalised every row of the store:
-- 80 ms at 2 000 products, 740 ms at 20 000 (one query, idle machine), and it saturates the
-- database long before the application. The planner tests ran as the owner (BYPASSRLS), so they
-- never saw it.
--
-- Fix: ebda_product_search_ids(store, field, with_sku, only_active, include_deleted, word_start, patterns)
-- returns the candidate product ids of ONE store. It is SECURITY DEFINER (owner-run, like every
-- other ebda_* function, and for the same reason: the owner bypasses RLS, so the indexes are
-- usable) and therefore checks its caller exactly as the policy does: the store id must equal the
-- transaction-local app.current_store_id, else it returns nothing. The patterns are BOUND values
-- ($1[i] inside the dynamic statement); the only text built by format() is a fixed column
-- expression chosen from two literals and the loop index. The application keeps joining the ids
-- back to `products` as ebda_app, so RLS, soft-delete, status, ordering and the tenant guard all
-- still apply to the final rows.
--
-- Additive (CREATE FUNCTION only): safe to deploy before the code that calls it.
-- Rollback: rollback.sql (roll the CODE back first).

CREATE OR REPLACE FUNCTION public.ebda_product_search_ids(
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
  arms text := '';
  n int := coalesce(array_length(p_patterns, 1), 0);
  i int;
BEGIN
  -- The RLS policy's own predicate: only the store this transaction is scoped to. A session whose
  -- role bypasses RLS anyway (the owner: migrations, scripts, owner-role test fixtures) is not
  -- restricted by the policy, so it is not restricted here either; session_user cannot be forged
  -- and ebda_app is neither superuser nor BYPASSRLS.
  IF p_store_id IS NULL THEN
    RETURN;
  END IF;
  IF p_store_id IS DISTINCT FROM nullif(current_setting('app.current_store_id', true), '')
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r
                     WHERE r.rolname = session_user AND (r.rolsuper OR r.rolbypassrls)) THEN
    RETURN;
  END IF;
  -- searchTokens() caps a query at 8 words; refuse anything else rather than build a huge AND.
  IF n < 1 OR n > 8 THEN
    RETURN;
  END IF;
  IF p_field = 'name' THEN
    doc := 'public.ebda_product_name_doc(p.name, p.name_ar, p.search_terms)';
  ELSIF p_field = 'all' THEN
    doc := 'public.ebda_product_search_doc(p.name, p.name_ar, p.search_terms, p.description, p.description_ar)';
  ELSE
    RETURN;
  END IF;
  -- p_word_start (Ruling SEARCH-T14-3): a query made only of words under 3 characters cannot use a
  -- trigram index as a substring, so the caller sends PREFIX patterns ('ab%') and the word must
  -- START a word of the document: `doc LIKE 'ab%' OR doc LIKE '% ab%'`. Both arms are
  -- trigram-indexable (the blank before the word is part of the pg_trgm word boundary), so a
  -- 20,000-product store answers in milliseconds instead of normalising every row. The SKU arm
  -- becomes a SKU prefix.
  FOR i IN 1..n LOOP
    IF coalesce(p_word_start, false) THEN
      arms := arms || format(' AND (%s LIKE $1[%s] OR %s LIKE (''%% '' || $1[%s])', doc, i, doc, i);
      IF coalesce(p_with_sku, false) THEN
        arms := arms || format(' OR public.ebda_ar_norm(coalesce(p.sku, '''')) LIKE $1[%s]', i);
      END IF;
      arms := arms || ')';
    ELSIF coalesce(p_with_sku, false) THEN
      arms := arms || format(
        ' AND (%s LIKE $1[%s] OR public.ebda_ar_norm(coalesce(p.sku, '''')) LIKE $1[%s])', doc, i, i);
    ELSE
      arms := arms || format(' AND %s LIKE $1[%s]', doc, i);
    END IF;
  END LOOP;
  RETURN QUERY EXECUTE
    'SELECT p.id FROM public.products p WHERE p.store_id = $2'
    || CASE WHEN coalesce(p_only_active, false) THEN ' AND p.status = ''active''' ELSE '' END
    || CASE WHEN coalesce(p_include_deleted, false) THEN '' ELSE ' AND p.deleted_at IS NULL' END
    || arms
    USING p_patterns, p_store_id;
END
$fn$;

REVOKE ALL ON FUNCTION public.ebda_product_search_ids(text, text, boolean, boolean, boolean, boolean, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ebda_product_search_ids(text, text, boolean, boolean, boolean, boolean, text[]) TO ebda_app;
