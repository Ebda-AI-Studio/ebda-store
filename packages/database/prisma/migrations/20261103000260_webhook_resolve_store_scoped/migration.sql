-- Webhook routing: resolve the owning store of a provider reference WITHIN the provider, preferring the
-- store the per-store webhook URL names (Ruling ITEST-14).
--
-- ebda_webhook_resolve_store(p_transaction_id, p_invoice_id) matches payments.transaction_id / invoice_id with
-- no provider filter and `LIMIT 1` with no ORDER BY. Two payments that share a reference string (another
-- provider's, another merchant's own gateway account, or the small repeating ids the test stubs mint) made the
-- answer arbitrary: the delivery to the RIGHT store's URL was then judged "belongs to another store" and
-- ignored with 200, so a paid order stayed pending. The new function filters by provider when given and ranks
-- the preferred store first, then the newest payment. Same exposure as the old one: returns a store id only,
-- for an exact provider reference; UNGUARDED ON PURPOSE for the same reason (a callback names a reference,
-- not a principal). The old function stays for the callers that have neither provider nor URL.
-- Additive. Rollback: rollback.sql (roll the code back first).

CREATE OR REPLACE FUNCTION public.ebda_webhook_resolve_store_scoped(
  p_transaction_id text,
  p_invoice_id text,
  p_provider text,
  p_prefer_store text
)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT o.store_id
  FROM public.payments p
  JOIN public.orders o ON o.id = p.order_id
  WHERE ((p_transaction_id IS NOT NULL AND p.transaction_id = p_transaction_id)
      OR (p_invoice_id IS NOT NULL AND p.invoice_id = p_invoice_id))
    AND (p_provider IS NULL OR p.provider = p_provider)
  ORDER BY (p_prefer_store IS NOT NULL AND o.store_id = p_prefer_store) DESC, p.created_at DESC, p.id
  LIMIT 1
$fn$;

REVOKE ALL ON FUNCTION public.ebda_webhook_resolve_store_scoped(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ebda_webhook_resolve_store_scoped(text, text, text, text) TO ebda_app;
