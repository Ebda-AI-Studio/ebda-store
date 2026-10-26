-- Roll the code back first (apps/api/src/lib/definer.ts calls this function).
DROP FUNCTION IF EXISTS public.ebda_webhook_resolve_store_scoped(text, text, text, text);
