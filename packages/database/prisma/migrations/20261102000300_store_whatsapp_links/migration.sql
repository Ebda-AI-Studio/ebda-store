-- Server-owned link state of Ebda WhatsApp per store (Store <-> WhatsApp contract 2026-10-24).
-- A flag inside the merchant-writable stores.settings JSON would let a store owner switch the
-- integration on; this table is written only by WhatsAppLinkService (no merchant route touches it).
CREATE TABLE "store_whatsapp_links" (
  "store_id" TEXT NOT NULL,
  "linked" BOOLEAN NOT NULL DEFAULT false,
  "owner_user_id" TEXT,
  "linked_at" TIMESTAMP(3),
  "entitlement_version" INTEGER NOT NULL DEFAULT 0,
  "entitlement_package_id" TEXT,
  "entitlement_automation" BOOLEAN NOT NULL DEFAULT false,
  "entitlement_status" TEXT,
  "entitlement_valid_until" TIMESTAMP(3),
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "store_whatsapp_links_pkey" PRIMARY KEY ("store_id"),
  CONSTRAINT "store_whatsapp_links_entitlement_status_check" CHECK ("entitlement_status" IS NULL OR "entitlement_status" IN ('trialing', 'active', 'past_due', 'cancelled', 'expired'))
);
ALTER TABLE "store_whatsapp_links" ADD CONSTRAINT "store_whatsapp_links_store_id_fkey"
  FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE store_whatsapp_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_whatsapp_links FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON store_whatsapp_links AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "store_whatsapp_links" TO ebda_app;
