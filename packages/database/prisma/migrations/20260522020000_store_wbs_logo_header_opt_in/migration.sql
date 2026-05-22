-- Phase 7 opt-in: store logo as WhatsApp template HEADER image.
-- When true, the per-store template builder includes a HEADER IMAGE
-- component pinned to Store.logo. Customer sees the merchant's logo at
-- the top of every order-update WhatsApp message.
--
-- Defaults false because the resumable Meta upload + handle maintenance
-- adds complexity per template re-submission. Merchants opt in from
-- /stores/[id]/wa-templates → "Use logo as header image" toggle.

ALTER TABLE "stores"
  ADD COLUMN IF NOT EXISTS "wbs_template_use_logo_header" BOOLEAN NOT NULL DEFAULT false;
