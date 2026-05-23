-- Phase 2 bot intelligence: per-store WhatsApp bot copy overrides.
-- Merchants edit their bot's wording from the FWB admin UI → /whatsapp → Bot Copy tab.
-- Shape: Record<string, { en?: string; ar?: string }> keyed by state/purpose.
-- Absent keys fall back to canonical defaults in WBS botCopyDefaults.js.
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "bot_copy" JSONB;
