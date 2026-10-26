-- Roll the code back first (apps/api/src/lib/definer.ts calls this function).
BEGIN;
DROP FUNCTION IF EXISTS public.ebda_webhook_resolve_store_scoped(text, text, text, text);
-- Forget the migration so a later `prisma migrate deploy` applies it again.
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261103000300_webhook_resolve_store_scoped';
COMMIT;
