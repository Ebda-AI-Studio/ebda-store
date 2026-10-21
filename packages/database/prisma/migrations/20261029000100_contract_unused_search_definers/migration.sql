-- CONTRACT migration for the search program (Rulings SEARCH-T13-8 and SEARCH-P2-5).
--
-- Both halves were expand-only on purpose (CF-MIGRATE-1: `migrate deploy` runs before
-- `wrangler deploy`, and an auto-rollback leaves the database migrated), so the old forms were
-- KEPT until the code that stopped calling them was verified live. Search PR4 (#100) is live in
-- production, so they go now.
--
-- 1. public.ebda_product_embed_doc(text, text, text, text, text), the 5-argument embedding input
--    that appended the AI search words (replaced by the 4-argument form of 20261024000100).
--    Callers: none. apps/api/src/services/product-index.service.ts and lib/search/reindex.ts use
--    the 4-argument form (tests/unit/embed-doc-callers.test.ts pins it); no migration, view,
--    trigger or index expression references the 5-argument signature.
-- 2. The `'guest'` and `'customers'` kinds of public.ebda_order_search_ids (SEARCH-P2-5). Their
--    only caller was the old order/customer search; since search P2 every customer/guest lookup
--    goes through ebda_customer_search_ids and the order list calls this function with
--    `'order_number'` only (apps/api/src/lib/order-search-ids.ts, services/order.service.ts).
--    The function keeps its signature, grants and `'order_number'` behaviour; an unknown kind
--    now returns the empty set (as it always did for a kind it did not know).
--
-- NOT touched here: the six per-key trigram indexes (orders_guest_*_trgm_idx, users_*_trgm_idx)
-- named by SEARCH-P2-5. They are indexes, not definer kinds; their drop stays tracked.
--
-- Lock note: function DDL only; no table is touched.
-- Rollback: rollback.sql (recreates both; roll the CODE back first).

DROP FUNCTION IF EXISTS public.ebda_product_embed_doc(text, text, text, text, text);

CREATE OR REPLACE FUNCTION public.ebda_order_search_ids(
  p_store_id text,
  p_kind text,
  p_pattern text,
  p_limit integer
)
RETURNS SETOF text
LANGUAGE plpgsql STABLE SECURITY DEFINER ROWS 200
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_scope text;
BEGIN
  -- The store comes ONLY from the scoped session (see ebda_product_search_ids): no scope = refused
  -- (42501), an argument naming another store = empty, no exemption for owner/BYPASSRLS sessions.
  v_scope := nullif(current_setting('app.current_store_id', true), '');
  IF v_scope IS NULL THEN
    RAISE EXCEPTION 'ebda_order_search_ids: no store scope' USING ERRCODE = '42501';
  END IF;
  IF p_store_id IS DISTINCT FROM v_scope OR p_pattern IS NULL OR p_limit IS NULL OR p_limit < 1 THEN
    RETURN;
  END IF;
  p_limit := least(p_limit, 5000);
  IF p_kind = 'order_number' THEN
    RETURN QUERY EXECUTE
      'SELECT o.id FROM public.orders o
        WHERE o.store_id = $1 AND o.deleted_at IS NULL AND o.order_number ILIKE $2
        LIMIT $3' USING v_scope, p_pattern, p_limit;
  END IF;
END
$fn$;

REVOKE ALL ON FUNCTION public.ebda_order_search_ids(text, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ebda_order_search_ids(text, text, text, integer) TO ebda_app;
