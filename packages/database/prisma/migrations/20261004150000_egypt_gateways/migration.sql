-- SP6b: the Egyptian gateways (Paymob, Kashier, Fawry).
--
--   payment_configs.provider   + paymob | kashier | fawry
--
-- The enum values are only ADDED here and never used in this file (a new enum
-- value cannot be referenced in the transaction that adds it).
--
-- Also here: the guarded definer behind GET /payments/:id/events and
-- /payments/events/:id/payload, so the admin payment timeline can find a payment's
-- store under strict RLS without a store scope.

ALTER TYPE "PaymentProvider" ADD VALUE IF NOT EXISTS 'paymob';
ALTER TYPE "PaymentProvider" ADD VALUE IF NOT EXISTS 'kashier';
ALTER TYPE "PaymentProvider" ADD VALUE IF NOT EXISTS 'fawry';

-- A payment (or one of its events) -> the store that owns it, for the admin
-- payment timeline. GUARDED by DATA, not by a flag: the acting user must be an
-- active super_admin, or the owner / a staff member of that payment's store.
-- Anyone else (and an unknown id) gets no row, which the route answers as 404.
-- Returns ids only, never row data.
CREATE OR REPLACE FUNCTION public.ebda_payment_events_store(
  p_actor_user_id text, p_payment_id text, p_event_id text)
RETURNS TABLE (store_id text, payment_id text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT o.store_id, p.id
  FROM public.payments p
  JOIN public.orders o ON o.id = p.order_id
  WHERE p_actor_user_id IS NOT NULL
    AND (
      (p_payment_id IS NOT NULL AND p.id = p_payment_id)
      OR (p_event_id IS NOT NULL AND p.id = (
            SELECT e.payment_id FROM public.payment_events e WHERE e.id = p_event_id))
    )
    AND (
      EXISTS (
        SELECT 1 FROM public.users u
        WHERE u.id = p_actor_user_id AND u.role = 'super_admin'
          AND u.status = 'active' AND u.deleted_at IS NULL)
      OR EXISTS (
        SELECT 1 FROM public.stores s WHERE s.id = o.store_id AND s.owner_id = p_actor_user_id)
      OR EXISTS (
        SELECT 1 FROM public.store_staff ss
        WHERE ss.store_id = o.store_id AND ss.user_id = p_actor_user_id)
    )
  LIMIT 1
$fn$;

REVOKE ALL ON FUNCTION public.ebda_payment_events_store(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ebda_payment_events_store(text, text, text) TO ebda_app;
