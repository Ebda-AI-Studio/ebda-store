-- Force AI Store ↔ WBS bridge (2026-05-19)
-- Per-store opt-in configuration for sending WhatsApp order notifications
-- through the merchant's Force AI WhatsApp Business Platform client.
--
-- wbs_api_key is stored AES-GCM encrypted via encryption.service.ts.
-- wbs_templates is JSONB: { orderPaid?, orderShipped?, orderDelivered? }
--   each entry: { name: string, languageCode: string }

ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS wbs_enabled   BOOLEAN  NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS wbs_client_id TEXT,
  ADD COLUMN IF NOT EXISTS wbs_api_key   TEXT,
  ADD COLUMN IF NOT EXISTS wbs_templates JSONB;
