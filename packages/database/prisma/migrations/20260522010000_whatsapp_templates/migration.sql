-- Phase 7: FWB-driven WhatsApp template management.
--
-- One row per (store, sourceKey, language). The 6 canonical sourceKeys
-- (orderPaid / orderShipped / orderDelivered / welcomeBack /
--  cartAbandoned / paymentLink) are defined in
-- apps/api/src/lib/wa-templates/definitions.ts; new sourceKeys can be
-- added without a schema change since sourceKey is a free-form varchar.
--
-- Status lifecycle:
--   draft     → not yet submitted to Meta
--   pending   → submitted, waiting for Meta review
--   approved  → can be sent
--   rejected  → rejection_reason populated; can be resubmitted after edit
--   paused    → Meta paused due to quality/policy concerns
--   disabled  → merchant disabled in the FWB admin

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
    FOREIGN KEY ("store_id") REFERENCES "Store"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_templates_store_source_lang"
  ON "whatsapp_templates" ("store_id", "source_key", "language");

CREATE INDEX IF NOT EXISTS "whatsapp_templates_store_status"
  ON "whatsapp_templates" ("store_id", "status");
