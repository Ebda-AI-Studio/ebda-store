-- NEON-ZERO-1 N-10b: the payment-webhook inbox moves to D1. While its copy is being taken (the cutover freeze) a provider
-- callback is recorded straight into D1, but it must not create a second row for an event Postgres already holds: this
-- READ-ONLY lookup by idempotency key lets the API return the existing row's id instead.
-- UNGUARDED ON PURPOSE like ebda_webhook_inbox_record (the callback has no principal); it returns an id and a status, never
-- the payload, signature or raw body.
CREATE OR REPLACE FUNCTION public.ebda_webhook_inbox_by_key(p_key text)
RETURNS TABLE (id text, status text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT w.id, w.status FROM public.webhook_events w WHERE p_key IS NOT NULL AND w.idempotency_key = p_key
$fn$;

REVOKE ALL ON FUNCTION public.ebda_webhook_inbox_by_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ebda_webhook_inbox_by_key(text) TO ebda_app;
