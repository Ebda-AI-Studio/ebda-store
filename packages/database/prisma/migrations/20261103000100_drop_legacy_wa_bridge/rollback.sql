-- rollback.sql for 20261103000100_drop_legacy_wa_bridge.
-- Recreates the SCHEMA only (the data was empty in production). Roll the CODE back first.
-- Then delete the _prisma_migrations row so a later `migrate deploy` re-applies it:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261103000100_drop_legacy_wa_bridge';

ALTER TABLE "stores"
  ADD COLUMN IF NOT EXISTS "wbs_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "wbs_client_id" TEXT,
  ADD COLUMN IF NOT EXISTS "wbs_templates" JSONB,
  ADD COLUMN IF NOT EXISTS "wbs_template_use_logo_header" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "wa_customer_ordering_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "bot_copy" JSONB,
  ADD COLUMN IF NOT EXISTS "bot_mode" TEXT NOT NULL DEFAULT 'legacy_chat',
  ADD COLUMN IF NOT EXISTS "bot_service_menu" JSONB,
  ADD COLUMN IF NOT EXISTS "meta_catalog_id" TEXT,
  ADD COLUMN IF NOT EXISTS "meta_business_id" TEXT;

ALTER TABLE "store_credentials"
  ADD COLUMN IF NOT EXISTS "wbs_api_key" TEXT,
  ADD COLUMN IF NOT EXISTS "meta_access_token" TEXT;

CREATE TABLE IF NOT EXISTS "whatsapp_templates" (
  "id"                TEXT NOT NULL PRIMARY KEY,
  "store_id"          TEXT NOT NULL,
  "source_key"        VARCHAR(64) NOT NULL,
  "language"          VARCHAR(8) NOT NULL,
  "meta_name"         VARCHAR(255) NOT NULL,
  "category"          VARCHAR(32) NOT NULL,
  "body"              TEXT NOT NULL,
  "status"            VARCHAR(32) NOT NULL DEFAULT 'draft',
  "rejection_reason"  TEXT NULL,
  "meta_template_id"  VARCHAR(255) NULL,
  "last_synced_at"    TIMESTAMP(3) NULL,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "whatsapp_templates_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_templates_store_source_lang"
  ON "whatsapp_templates" ("store_id", "source_key", "language");
CREATE INDEX IF NOT EXISTS "whatsapp_templates_store_status"
  ON "whatsapp_templates" ("store_id", "status");
ALTER TABLE whatsapp_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_templates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ebda_tenant_isolation ON whatsapp_templates;
CREATE POLICY ebda_tenant_isolation ON whatsapp_templates AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_templates TO ebda_app;

DROP FUNCTION IF EXISTS public.ebda_store_directory(boolean);
CREATE FUNCTION public.ebda_store_directory(p_include_deleted boolean DEFAULT false)
RETURNS TABLE (
  id text, slug text, name text, status text, plan text,
  accounting_enabled boolean, ai_features_enabled boolean, loyalty_enabled boolean,
  wbs_enabled boolean, has_domain boolean, has_pending_domain boolean
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT s.id, s.slug, s.name, s.status::text, s.plan::text, s.accounting_enabled, s.ai_features_enabled,
         s.loyalty_enabled, s.wbs_enabled, s.domain IS NOT NULL, s.pending_domain IS NOT NULL
  FROM public.stores s
  WHERE p_include_deleted OR s.deleted_at IS NULL
  ORDER BY s.id
$fn$;
REVOKE ALL ON FUNCTION public.ebda_store_directory(boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ebda_store_directory(boolean) TO ebda_app;

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
REVOKE ALL ON FUNCTION public.ebda_wbs_bridge_keys() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ebda_wbs_bridge_keys() TO ebda_app;
