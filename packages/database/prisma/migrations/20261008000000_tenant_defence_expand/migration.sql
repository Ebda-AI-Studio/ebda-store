-- Tenant defence, EXPAND step (R-EBDA-005; closes R-EBDA-002 together with the
-- contract migration that follows it).
--
-- Expand-then-contract (CF-MIGRATE-1: migrations run BEFORE the Worker deploy, so
-- the still-running old Worker must keep working against this schema). Everything
-- here is ADDITIVE:
--   1. `store_credentials`: the encrypted provider credentials move out of the
--      `stores` routing table into a store-scoped table under strict RLS.
--      Backfilled from `stores`; a trigger mirrors any write the OLD Worker still
--      makes to the old columns until the contract step drops them.
--   2. SECURITY DEFINER functions for every read of `stores` that runs BEFORE a
--      store or user scope exists (host/slug/id resolution, slug/domain
--      uniqueness, the cron store directory, the WhatsApp-bridge key lookup).
--      The new code reads `stores` ONLY through these or inside a store/user
--      scope, so it is correct both before and after `stores` gets RLS.
-- The old columns, the mirror trigger and RLS on `stores` are the CONTRACT step
-- (20261008000100_stores_rls_contract), shipped separately after this deploy.

-- ---------------------------------------------------------------------------
-- 1. store_credentials
-- ---------------------------------------------------------------------------
CREATE TABLE "store_credentials" (
    "store_id" TEXT NOT NULL,
    "wbs_api_key" TEXT,
    "meta_access_token" TEXT,
    "agent_api_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "store_credentials_pkey" PRIMARY KEY ("store_id")
);

ALTER TABLE "store_credentials" ADD CONSTRAINT "store_credentials_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill (0 merchants in production on 2026-10-07; written anyway).
INSERT INTO "store_credentials" ("store_id", "wbs_api_key", "meta_access_token", "agent_api_key")
SELECT s.id, s.wbs_api_key, s.meta_access_token, s.agent_api_key
FROM "stores" s
WHERE s.wbs_api_key IS NOT NULL OR s.meta_access_token IS NOT NULL OR s.agent_api_key IS NOT NULL
ON CONFLICT ("store_id") DO NOTHING;

ALTER TABLE "store_credentials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "store_credentials" FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON "store_credentials" AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "store_credentials" TO ebda_app;

-- Mirror the OLD Worker's writes (it still writes stores.wbs_api_key & co. for the
-- seconds between this migration and the deploy). Runs as the table owner, so RLS
-- on store_credentials does not apply to it. Dropped by the contract step.
CREATE OR REPLACE FUNCTION public.store_credentials_mirror()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF NEW.wbs_api_key IS NULL AND NEW.meta_access_token IS NULL AND NEW.agent_api_key IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.store_credentials c WHERE c.store_id = NEW.id) THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.store_credentials (store_id, wbs_api_key, meta_access_token, agent_api_key, updated_at)
  VALUES (NEW.id, NEW.wbs_api_key, NEW.meta_access_token, NEW.agent_api_key, CURRENT_TIMESTAMP)
  ON CONFLICT (store_id) DO UPDATE
    SET wbs_api_key = EXCLUDED.wbs_api_key,
        meta_access_token = EXCLUDED.meta_access_token,
        agent_api_key = EXCLUDED.agent_api_key,
        updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.store_credentials_mirror() FROM PUBLIC;

CREATE TRIGGER stores_credentials_mirror
  AFTER INSERT OR UPDATE OF wbs_api_key, meta_access_token, agent_api_key ON "stores"
  FOR EACH ROW EXECUTE FUNCTION public.store_credentials_mirror();

-- ---------------------------------------------------------------------------
-- 2. Pre-scope reads of `stores` (SECURITY DEFINER, fixed search_path).
--    Each returns routing facts only (ids, slugs, status, feature flags), never a
--    credential, except 2.5 which returns CIPHERTEXT for one named purpose.
-- ---------------------------------------------------------------------------

-- 2.1 Resolve ONE store by id, slug or VERIFIED custom domain, among the given
--     statuses, not soft-deleted. Precedence: id, then slug, then domain.
--     UNGUARDED ON PURPOSE: it runs before any scope exists (public storefront
--     routes, CORS origin check, MCP slug, the x-store-id header) and returns
--     (id, status) only.
CREATE OR REPLACE FUNCTION public.ebda_store_lookup(
  p_id text, p_slug text, p_domain text, p_statuses text[]
)
RETURNS TABLE (id text, status text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT s.id, s.status::text
  FROM public.stores s
  WHERE s.deleted_at IS NULL
    AND s.status::text = ANY (p_statuses)
    AND ((p_id IS NOT NULL AND s.id = p_id)
      OR (p_slug IS NOT NULL AND s.slug = p_slug)
      OR (p_domain IS NOT NULL AND s.domain = p_domain AND s.domain_status = 'active'))
  ORDER BY (p_id IS NOT NULL AND s.id = p_id) DESC, (p_slug IS NOT NULL AND s.slug = p_slug) DESC
  LIMIT 1
$fn$;

-- 2.2 Uniqueness probes for signup, provisioning, slug/domain edits and domain
--     claims: which store (if any) holds this slug / verified domain / pending
--     claim. Deleted rows count (the unique indexes cover them). Ids only.
CREATE OR REPLACE FUNCTION public.ebda_store_id_by_slug(p_slug text)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT s.id FROM public.stores s WHERE s.slug = p_slug LIMIT 1
$fn$;

CREATE OR REPLACE FUNCTION public.ebda_store_id_by_domain(p_domain text)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT s.id FROM public.stores s WHERE s.domain = p_domain LIMIT 1
$fn$;

CREATE OR REPLACE FUNCTION public.ebda_store_ids_claiming_domain(p_domain text)
RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT s.id FROM public.stores s WHERE s.pending_domain = p_domain
$fn$;

-- 2.3 The store directory for crons and platform sweeps (`acrossStores` and the
--     Inngest fan-outs): every store that is not soft-deleted, with the flags the
--     sweeps filter on. The sweep then works on each store inside its OWN tenant
--     transaction. UNGUARDED ON PURPOSE (crons have no principal); routing facts
--     and booleans only.
CREATE OR REPLACE FUNCTION public.ebda_store_directory()
RETURNS TABLE (
  id text,
  slug text,
  status text,
  plan text,
  accounting_enabled boolean,
  ai_features_enabled boolean,
  loyalty_enabled boolean,
  wbs_enabled boolean,
  has_domain boolean,
  has_pending_domain boolean
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT s.id, s.slug, s.status::text, s.plan::text, s.accounting_enabled, s.ai_features_enabled,
         s.loyalty_enabled, s.wbs_enabled, s.domain IS NOT NULL, s.pending_domain IS NOT NULL
  FROM public.stores s
  WHERE s.deleted_at IS NULL
  ORDER BY s.id
$fn$;

-- 2.4 Stores a user owns (live, not soft-deleted): plan limits and signup state
--     run this before any store scope. GUARDED: only for the acting user
--     (app.current_user_id) or a super_admin.
CREATE OR REPLACE FUNCTION public.ebda_owned_store_ids(p_owner_id text)
RETURNS SETOF text
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF NOT (coalesce(p_owner_id = nullif(current_setting('app.current_user_id', true), ''), false)
          OR public.ebda_is_super_admin()) THEN
    RAISE EXCEPTION 'ebda_owned_store_ids: caller is not that user' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT s.id FROM public.stores s
    WHERE s.owner_id = p_owner_id AND s.deleted_at IS NULL ORDER BY s.id;
END
$fn$;

-- 2.5 The WhatsApp bridge authenticates a request by its API key BEFORE it knows
--     the store, by decrypting each bridge-enabled store's key and comparing in
--     constant time (apps/api/src/middleware/wa-bridge-auth.ts). This returns the
--     CIPHERTEXT of those keys (useless without ENCRYPTION_KEY) for that one
--     purpose; the plaintext key never reaches SQL.
CREATE OR REPLACE FUNCTION public.ebda_wbs_bridge_keys()
RETURNS TABLE (store_id text, wbs_api_key text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT s.id, c.wbs_api_key
  FROM public.stores s
  JOIN public.store_credentials c ON c.store_id = s.id
  WHERE s.wbs_enabled AND s.deleted_at IS NULL AND c.wbs_api_key IS NOT NULL
$fn$;

-- ---------------------------------------------------------------------------
-- 3. Function privileges: nobody but ebda_app (same rule as the strict-RLS migration).
-- ---------------------------------------------------------------------------
DO $priv$
DECLARE
  f RECORD;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('ebda_store_lookup', 'ebda_store_id_by_slug', 'ebda_store_id_by_domain',
                        'ebda_store_ids_claiming_domain', 'ebda_store_directory',
                        'ebda_owned_store_ids', 'ebda_wbs_bridge_keys')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ebda_app', f.sig);
  END LOOP;
END
$priv$;
