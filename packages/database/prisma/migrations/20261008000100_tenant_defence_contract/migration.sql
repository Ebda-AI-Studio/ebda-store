-- Tenant defence, CONTRACT step (R-EBDA-005, closes R-EBDA-002). Ships AFTER the
-- expand step (20261008000000_tenant_defence_expand) and the code that uses it are
-- deployed and verified: the Worker running when this migration applies (CF-MIGRATE-1)
-- must already be the one that reads `stores` only through the definers or inside a
-- store/user scope, and the user-keyed token tables only as their user.
--
-- 1. `stores` drops the three credential columns (moved to `store_credentials`) and
--    the mirror trigger that kept them in sync for the old Worker.
-- 2. `stores` gets STRICT RLS: a row is visible / writable only to its own store
--    scope, its owner, a staff member of it, or an active super_admin principal.
--    No contextless allowance: a contextless read returns no stores.
-- 3. The user-keyed tables (`refresh_tokens`, `verification_tokens`,
--    `onesignal_subscriptions`) get STRICT RLS keyed on app.current_user_id (plus an
--    active super_admin). Their pre-identity lookups use the expand step's definers.
-- After this, the only public tables without RLS are platform-global (plans,
-- answer_engine_provider_configs, billing_webhook_events) and _prisma_migrations;
-- tests/integration/rls-ebda-app.test.ts holds that list.

-- 1. credentials out of the routing table
DROP TRIGGER IF EXISTS stores_credentials_mirror ON "stores";
DROP FUNCTION IF EXISTS public.store_credentials_mirror();
ALTER TABLE "stores" DROP COLUMN IF EXISTS "wbs_api_key";
ALTER TABLE "stores" DROP COLUMN IF EXISTS "meta_access_token";
ALTER TABLE "stores" DROP COLUMN IF EXISTS "agent_api_key";

-- 2. stores
ALTER TABLE "stores" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stores" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ebda_store_access ON "stores";
CREATE POLICY ebda_store_access ON "stores" AS PERMISSIVE FOR ALL TO ebda_app
  USING (
    id = nullif(current_setting('app.current_store_id', true), '')
    OR owner_id = nullif(current_setting('app.current_user_id', true), '')
    OR EXISTS (
      SELECT 1 FROM public.store_staff ss
      WHERE ss.store_id = stores.id
        AND ss.user_id = nullif(current_setting('app.current_user_id', true), '')
    )
    OR public.ebda_is_super_admin()
  )
  WITH CHECK (
    id = nullif(current_setting('app.current_store_id', true), '')
    OR owner_id = nullif(current_setting('app.current_user_id', true), '')
    OR public.ebda_is_super_admin()
  );

-- 3. user-keyed tables
DO $user_keyed$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['refresh_tokens', 'verification_tokens', 'onesignal_subscriptions'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS ebda_user_isolation ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY ebda_user_isolation ON public.%I AS PERMISSIVE FOR ALL TO ebda_app '
      'USING (user_id = nullif(current_setting(''app.current_user_id'', true), '''') OR public.ebda_is_super_admin()) '
      'WITH CHECK (user_id = nullif(current_setting(''app.current_user_id'', true), '''') OR public.ebda_is_super_admin())',
      t
    );
  END LOOP;
END
$user_keyed$;
