-- CONTRACT migration for the legacy WhatsApp bridge (Ruling WA-LEGACY-1, 2026-10-25).
--
-- Ships AFTER the code PR that deleted every reader and writer of these objects is live
-- (CF-MIGRATE-1: `migrate deploy` runs before `wrangler deploy`, so the Worker running when this
-- applies must already be the one that never selects them). Production held zero rows of data in
-- all of it (stores.wbs_enabled, store_credentials.wbs_api_key, whatsapp StoreFeature rows,
-- whatsapp_templates, bot_copy: read-only counts, all 0).
--
-- 1. public.ebda_wbs_bridge_keys(): the bridge's pre-scope key lookup. No caller left.
-- 2. public.ebda_store_directory(): loses its wbs_enabled column (RETURNS TABLE cannot change in
--    place, so DROP + CREATE; privileges re-applied exactly as 20261008000010 did).
-- 3. whatsapp_templates: the Meta template mirror, used only by the bridge. Its RLS policies and
--    indexes go with it.
-- 4. stores: the wbs_*, wa_customer_ordering_enabled, bot_* and meta_catalog/business columns.
-- 5. store_credentials: wbs_api_key and meta_access_token (agent_api_key stays).
--
-- NOT touched: customer_addresses (account erasure + RLS suites use it), stores.business_hours and
-- google_maps_url (the store routes serve them), every meta_title/meta_description SEO column.
--
-- Lock note: DROP COLUMN is metadata-only; DROP TABLE takes a brief ACCESS EXCLUSIVE on an empty table.
-- Rollback: rollback.sql (recreates the schema, NOT the data; roll the CODE back first).

DROP FUNCTION IF EXISTS public.ebda_wbs_bridge_keys();

DROP FUNCTION IF EXISTS public.ebda_store_directory(boolean);
CREATE FUNCTION public.ebda_store_directory(p_include_deleted boolean DEFAULT false)
RETURNS TABLE (
  id text,
  slug text,
  name text,
  status text,
  plan text,
  accounting_enabled boolean,
  ai_features_enabled boolean,
  loyalty_enabled boolean,
  has_domain boolean,
  has_pending_domain boolean
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT s.id, s.slug, s.name, s.status::text, s.plan::text, s.accounting_enabled, s.ai_features_enabled,
         s.loyalty_enabled, s.domain IS NOT NULL, s.pending_domain IS NOT NULL
  FROM public.stores s
  WHERE p_include_deleted OR s.deleted_at IS NULL
  ORDER BY s.id
$fn$;
REVOKE ALL ON FUNCTION public.ebda_store_directory(boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ebda_store_directory(boolean) TO ebda_app;

DROP TABLE IF EXISTS "whatsapp_templates";

ALTER TABLE "stores"
  DROP COLUMN IF EXISTS "wbs_enabled",
  DROP COLUMN IF EXISTS "wbs_client_id",
  DROP COLUMN IF EXISTS "wbs_templates",
  DROP COLUMN IF EXISTS "wbs_template_use_logo_header",
  DROP COLUMN IF EXISTS "wa_customer_ordering_enabled",
  DROP COLUMN IF EXISTS "bot_copy",
  DROP COLUMN IF EXISTS "bot_mode",
  DROP COLUMN IF EXISTS "bot_service_menu",
  DROP COLUMN IF EXISTS "meta_catalog_id",
  DROP COLUMN IF EXISTS "meta_business_id";

ALTER TABLE "store_credentials"
  DROP COLUMN IF EXISTS "wbs_api_key",
  DROP COLUMN IF EXISTS "meta_access_token";
