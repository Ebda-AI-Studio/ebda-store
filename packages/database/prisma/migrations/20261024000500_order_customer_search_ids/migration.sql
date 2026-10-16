-- Order / customer search that can use its trigram indexes under RLS (search program P1, Task 14,
-- Rule C: the same defect class as migration 20261024000300; Ruling SEARCH-T14-5).
--
-- Measured as `ebda_app` with 20 000 orders: none of the nine trigram indexes behind the admin order
-- search and the customer typeahead (orders.order_number, the four guest shipping-contact JSON
-- expressions, users first_name / last_name / email / phone) was ever scanned (idx_scan = 0 for
-- every one), because `ILIKE` and `->>` are not LEAKPROOF and the RLS policy is a security barrier.
-- The planner tests that said otherwise ran as the owner. The searches fell back to scanning every
-- order of the store.
--
-- ebda_order_search_ids(store, kind, pattern, limit) returns up to `limit` ids of ONE store:
--   'order_number'  live orders whose order_number ILIKE pattern
--   'guest'         live GUEST orders (customer_id IS NULL) whose shipping contact ILIKE pattern
--                   (first name, last name, email, phone; the partial expression indexes)
--   'customers'     users whose first name / last name / email / phone ILIKE pattern AND who have an
--                   order in this store (users.store_id is not what scopes them: a registered
--                   customer's store_id need not be the order's store)
-- SECURITY DEFINER with the same caller check as every other store-scoped definer: a session may
-- ask only for the store in app.current_store_id; a role that bypasses RLS anyway (the owner) is
-- not restricted. The pattern is a BOUND value ($2); the statements are fixed text chosen by `kind`.
-- Callers join the ids back to `orders` as ebda_app, so RLS, soft-delete and the tenant guard still
-- apply to the final rows.
--
-- Additive (CREATE FUNCTION only). Rollback: rollback.sql (roll the CODE back first).

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
BEGIN
  IF p_store_id IS NULL OR p_pattern IS NULL OR p_limit IS NULL OR p_limit < 1 THEN
    RETURN;
  END IF;
  IF p_store_id IS DISTINCT FROM nullif(current_setting('app.current_store_id', true), '')
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r
                     WHERE r.rolname = session_user AND (r.rolsuper OR r.rolbypassrls)) THEN
    RETURN;
  END IF;
  p_limit := least(p_limit, 5000);
  IF p_kind = 'order_number' THEN
    RETURN QUERY EXECUTE
      'SELECT o.id FROM public.orders o
        WHERE o.store_id = $1 AND o.deleted_at IS NULL AND o.order_number ILIKE $2
        LIMIT $3' USING p_store_id, p_pattern, p_limit;
  ELSIF p_kind = 'guest' THEN
    RETURN QUERY EXECUTE
      'SELECT o.id FROM public.orders o
        WHERE o.store_id = $1 AND o.customer_id IS NULL AND o.deleted_at IS NULL
          AND (o.shipping_address ->> ''firstName'' ILIKE $2
            OR o.shipping_address ->> ''lastName''  ILIKE $2
            OR o.shipping_address ->> ''email''     ILIKE $2
            OR o.shipping_address ->> ''phone''     ILIKE $2)
        LIMIT $3' USING p_store_id, p_pattern, p_limit;
  ELSIF p_kind = 'customers' THEN
    RETURN QUERY EXECUTE
      'SELECT u.id FROM public.users u
        WHERE (u.first_name ILIKE $2 OR u.last_name ILIKE $2 OR u.email ILIKE $2 OR u.phone ILIKE $2)
          AND EXISTS (SELECT 1 FROM public.orders o WHERE o.store_id = $1 AND o.customer_id = u.id)
        LIMIT $3' USING p_store_id, p_pattern, p_limit;
  END IF;
END
$fn$;

REVOKE ALL ON FUNCTION public.ebda_order_search_ids(text, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ebda_order_search_ids(text, text, text, integer) TO ebda_app;
