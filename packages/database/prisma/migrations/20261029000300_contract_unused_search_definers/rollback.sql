-- rollback.sql for 20261029000300_contract_unused_search_definers.
-- Roll the CODE back first only if you are going back to a release that still calls the 5-argument
-- embed doc or the 'guest' / 'customers' order-search kinds (none of the current code does).
-- Recreates the 5-argument ebda_product_embed_doc and the three-kind ebda_order_search_ids exactly
-- as 20261022000100 / 20261024000500 defined them.

CREATE OR REPLACE FUNCTION public.ebda_product_embed_doc(
  p_name text, p_name_ar text, p_terms text, p_desc text, p_desc_ar text
) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  -- Every part is trimmed of ALL whitespace (\s: space, tab, CR, LF...), not just spaces (btrim).
  -- Descriptions: an HTML tag (`<` + letter, `</`, or `<!`) becomes a space so block tags do not
  -- fuse words; a bare `<` / `>` ("price < 50") is text and stays; whitespace runs collapse to one
  -- space; then the 1500-char cap. Entities (&amp;) are not decoded.
  -- Only IMMUTABLE operators (||, coalesce, nullif, btrim, rtrim, left, regexp_replace): concat_ws
  -- and array_to_string are STABLE, which would make the IMMUTABLE label a lie and stop inlining.
  -- NULL (never '') when every part is empty: Task 11 skips a NULL doc rather than embed md5('').
  SELECT nullif(rtrim(
    coalesce(nullif(regexp_replace(p_name_ar, '^\s+|\s+$', '', 'g'), '') || E'\n', '') ||
    coalesce(nullif(regexp_replace(p_name, '^\s+|\s+$', '', 'g'), '') || E'\n', '') ||
    coalesce(nullif(regexp_replace(p_terms, '^\s+|\s+$', '', 'g'), '') || E'\n', '') ||
    coalesce(nullif(btrim(left(btrim(regexp_replace(regexp_replace(p_desc_ar,
      '</?[A-Za-z][^<>]*>|<![^<>]*>', ' ', 'g'), '\s+', ' ', 'g')), 1500)), '') || E'\n', '') ||
    coalesce(nullif(btrim(left(btrim(regexp_replace(regexp_replace(p_desc,
      '</?[A-Za-z][^<>]*>|<![^<>]*>', ' ', 'g'), '\s+', ' ', 'g')), 1500)), '') || E'\n', ''),
    E'\n'
  ), '')
$$;

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
  ELSIF p_kind = 'guest' THEN
    RETURN QUERY EXECUTE
      'SELECT o.id FROM public.orders o
        WHERE o.store_id = $1 AND o.customer_id IS NULL AND o.deleted_at IS NULL
          AND (o.shipping_address ->> ''firstName'' ILIKE $2
            OR o.shipping_address ->> ''lastName''  ILIKE $2
            OR o.shipping_address ->> ''email''     ILIKE $2
            OR o.shipping_address ->> ''phone''     ILIKE $2)
        LIMIT $3' USING v_scope, p_pattern, p_limit;
  ELSIF p_kind = 'customers' THEN
    RETURN QUERY EXECUTE
      'SELECT u.id FROM public.users u
        WHERE (u.first_name ILIKE $2 OR u.last_name ILIKE $2 OR u.email ILIKE $2 OR u.phone ILIKE $2)
          AND EXISTS (SELECT 1 FROM public.orders o
                       WHERE o.store_id = $1 AND o.deleted_at IS NULL AND o.customer_id = u.id)
          AND (u.store_id = $1
               OR u.id = nullif(current_setting(''app.current_user_id'', true), '''')
               OR EXISTS (SELECT 1 FROM public.stores s WHERE s.owner_id = u.id AND s.id = $1)
               OR EXISTS (SELECT 1 FROM public.store_staff ss WHERE ss.user_id = u.id AND ss.store_id = $1)
               OR (SELECT public.ebda_is_super_admin()))
        LIMIT $3' USING v_scope, p_pattern, p_limit;
  END IF;
END
$fn$;

REVOKE ALL ON FUNCTION public.ebda_order_search_ids(text, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ebda_order_search_ids(text, text, text, integer) TO ebda_app;

-- After running this, delete the migration's row too, or a later `prisma migrate deploy` treats it
-- as applied and never recreates what was rolled back:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261029000300_contract_unused_search_definers';
