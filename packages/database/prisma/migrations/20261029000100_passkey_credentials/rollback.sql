-- Rollback of 20261029000100_passkey_credentials: drops the table (every registered passkey is lost; users
-- fall back to password + TOTP, which this feature never touched). Revert the code (API, admin, web) and
-- redeploy BEFORE dropping, or the passkey routes 500 in between.
DROP FUNCTION IF EXISTS public.ebda_passkeys_delete(text);
DROP FUNCTION IF EXISTS public.ebda_passkey_lookup(text);
DROP TABLE IF EXISTS "passkey_credentials";

-- Then delete the migration's row, or a later `prisma migrate deploy` treats it as applied:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261029000100_passkey_credentials';
