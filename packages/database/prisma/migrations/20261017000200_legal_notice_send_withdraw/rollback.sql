-- ORDER: this file FIRST, then 20261017000100_legal_acceptances_and_notices/rollback.sql. After
-- each, `npx prisma migrate resolve --rolled-back <migration_name>`. Revert the code (API AND
-- admin) and redeploy before running either: the send route calls this function.
-- Rollback of 20261017000200_legal_notice_send_withdraw. Revert the service change first.
DROP FUNCTION IF EXISTS public.ebda_withdraw_legal_notice_send(text);

-- After running this, delete the migration's row too, or a later `prisma migrate deploy` treats it
-- as applied and never recreates what was rolled back:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261017000200_legal_notice_send_withdraw';
