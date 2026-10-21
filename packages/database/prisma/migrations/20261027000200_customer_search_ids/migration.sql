-- Customer search that uses the normalised expression indexes under RLS (search program P2,
-- Task 16; builds ON 20261024000500_order_customer_search_ids and 20261027000100_admin_search_norm).
--
-- ebda_customer_search_ids(store, name_patterns, digits_pattern, email_pattern, user_limit, guest_limit)
-- returns (kind, id) rows of ONE store:
--   kind 'user'         registered customers: users with a live order in this store, or customer-role
--                       users registered on it (zero-order shoppers; the Customers page lists both)
--   kind 'guest_order'  live GUEST orders (customer_id IS NULL) whose shipping contact matches
-- A row matches when ANY arm matches: every name pattern LIKE the Arabic-normalised full name
-- (public.ebda_ar_norm, indexes users_name_norm_trgm_idx / orders_guest_name_norm_trgm_idx), OR the
-- digits pattern LIKE public.ebda_digits(phone) (…phone_digits_trgm_idx), OR the email pattern ILIKE
-- the email (the existing email trigram indexes). The patterns are BOUND values; the statements are
-- fixed text (only integer subscripts are spliced in).
-- SECURITY DEFINER and therefore NOT an oracle (same contract as ebda_order_search_ids): the store
-- is taken only from app.current_store_id (no scope: 42501; another store in the argument: empty);
-- it returns ids only; a 'user' must be one the `users` policy would show a store scope (same store,
-- the caller, the store's owner/staff, or a super admin). Callers re-read rows as ebda_app.
-- When no pattern is long enough for a trigram (every name token and the phone shorter than 3
-- characters) the user arm is evaluated over the store's own customer set instead of the global
-- users table, so a two-letter term never scans every store's users.
--
-- Additive (CREATE FUNCTION only). Rollback: rollback.sql (roll the CODE back first).

CREATE OR REPLACE FUNCTION public.ebda_customer_search_ids(
  p_store_id text,
  p_name_patterns text[],
  p_digits_pattern text,
  p_email_pattern text,
  p_user_limit integer,
  p_guest_limit integer
)
RETURNS TABLE(kind text, id text)
LANGUAGE plpgsql STABLE SECURITY DEFINER ROWS 200
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_scope text;
  v_names text[];
  v_n integer;
  v_name_u text := 'false';
  v_name_g text := 'false';
  v_pre_u text;
  v_pre_g text;
  v_phone_u text := 'false';
  v_phone_g text := 'false';
  v_email_u text := 'false';
  v_email_g text := 'false';
  v_trigram boolean := false;
  v_candidates text;
  i integer;
BEGIN
  v_scope := nullif(current_setting('app.current_store_id', true), '');
  IF v_scope IS NULL THEN
    RAISE EXCEPTION 'ebda_customer_search_ids: no store scope' USING ERRCODE = '42501';
  END IF;
  IF p_store_id IS DISTINCT FROM v_scope OR p_user_limit IS NULL OR p_user_limit < 1
     OR p_guest_limit IS NULL OR p_guest_limit < 1 THEN
    RETURN;
  END IF;
  p_user_limit := least(p_user_limit, 5000);
  p_guest_limit := least(p_guest_limit, 50000);

  -- at most 8 name tokens, none NULL
  SELECT coalesce(array_agg(p), ARRAY[]::text[]) INTO v_names
    FROM (SELECT p FROM unnest(coalesce(p_name_patterns, ARRAY[]::text[])) WITH ORDINALITY AS t(p, n)
           WHERE p IS NOT NULL ORDER BY n LIMIT 8) s;
  v_n := cardinality(v_names);
  IF v_n = 0 AND p_digits_pattern IS NULL AND p_email_pattern IS NULL THEN
    RETURN;
  END IF;

  IF v_n > 0 THEN
    v_pre_u := 'public.ebda_ar_norm(coalesce(u.first_name, '''') || '' '' || coalesce(u.last_name, ''''))';
    v_pre_g := 'public.ebda_ar_norm(coalesce(o.shipping_address ->> ''firstName'', '''') || '' '' || coalesce(o.shipping_address ->> ''lastName'', ''''))';
    v_name_u := '(' || v_pre_u || ' LIKE ($2)[1]';
    v_name_g := '(' || v_pre_g || ' LIKE ($2)[1]';
    FOR i IN 2..v_n LOOP
      v_name_u := v_name_u || ' AND ' || v_pre_u || ' LIKE ($2)[' || i || ']';
      v_name_g := v_name_g || ' AND ' || v_pre_g || ' LIKE ($2)[' || i || ']';
    END LOOP;
    v_name_u := v_name_u || ')';
    v_name_g := v_name_g || ')';
    -- a pattern is '%token%': the token is long enough for a trigram at 3+ characters
    SELECT bool_or(length(p) - 2 >= 3) INTO v_trigram FROM unnest(v_names) p;
  END IF;
  IF p_digits_pattern IS NOT NULL THEN
    v_phone_u := 'public.ebda_digits(u.phone) LIKE $3';
    v_phone_g := 'public.ebda_digits(o.shipping_address ->> ''phone'') LIKE $3';
    v_trigram := true; -- the phone term is always >= 4 digits
  END IF;
  IF p_email_pattern IS NOT NULL THEN
    v_email_u := 'u.email ILIKE $4';
    v_email_g := 'o.shipping_address ->> ''email'' ILIKE $4';
    v_trigram := v_trigram OR length(p_email_pattern) - 2 >= 3;
  END IF;

  -- the store's own customers: the bounded form for terms no trigram index can serve
  v_candidates := CASE WHEN v_trigram THEN '' ELSE
    ' AND u.id IN (SELECT o2.customer_id FROM public.orders o2 WHERE o2.store_id = $1 AND o2.deleted_at IS NULL AND o2.customer_id IS NOT NULL
                   UNION SELECT u2.id FROM public.users u2 WHERE u2.store_id = $1 AND u2.role = ''customer'' AND u2.deleted_at IS NULL)' END;

  RETURN QUERY EXECUTE
    'SELECT ''user''::text, u.id FROM public.users u
      WHERE (' || v_name_u || ' OR ' || v_phone_u || ' OR ' || v_email_u || ')' || v_candidates || '
        AND (EXISTS (SELECT 1 FROM public.orders o WHERE o.store_id = $1 AND o.deleted_at IS NULL AND o.customer_id = u.id)
             OR (u.store_id = $1 AND u.role = ''customer'' AND u.deleted_at IS NULL))
        AND (u.store_id = $1
             OR u.id = nullif(current_setting(''app.current_user_id'', true), '''')
             OR EXISTS (SELECT 1 FROM public.stores s WHERE s.owner_id = u.id AND s.id = $1)
             OR EXISTS (SELECT 1 FROM public.store_staff ss WHERE ss.user_id = u.id AND ss.store_id = $1)
             OR (SELECT public.ebda_is_super_admin()))
      LIMIT $5'
    USING v_scope, v_names, p_digits_pattern, p_email_pattern, p_user_limit;

  RETURN QUERY EXECUTE
    'SELECT ''guest_order''::text, o.id FROM public.orders o
      WHERE o.store_id = $1 AND o.customer_id IS NULL AND o.deleted_at IS NULL
        AND (' || v_name_g || ' OR ' || v_phone_g || ' OR ' || v_email_g || ')
      LIMIT $5'
    USING v_scope, v_names, p_digits_pattern, p_email_pattern, p_guest_limit;
END
$fn$;

REVOKE ALL ON FUNCTION public.ebda_customer_search_ids(text, text[], text, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ebda_customer_search_ids(text, text[], text, text, integer, integer) TO ebda_app;
