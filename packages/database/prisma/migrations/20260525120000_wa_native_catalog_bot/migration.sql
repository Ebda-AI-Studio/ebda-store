-- WhatsApp Native Catalog Bot — Store config + Customer addresses
-- Phase A (2026-05-25)
--
-- All columns use IF NOT EXISTS / CREATE TABLE IF NOT EXISTS to be
-- idempotent on re-run (e.g. manual rollback + re-deploy).
--
-- Table names are the @@map() plural forms per FWB convention
-- (feedback-prisma-migration-uses-mapped-table-names.md).

-- Store columns (safe for existing rows — all nullable or have defaults)
ALTER TABLE "stores"
  ADD COLUMN IF NOT EXISTS "bot_mode"          TEXT    NOT NULL DEFAULT 'legacy_chat',
  ADD COLUMN IF NOT EXISTS "bot_service_menu"  JSONB,
  ADD COLUMN IF NOT EXISTS "meta_catalog_id"   TEXT,
  ADD COLUMN IF NOT EXISTS "meta_business_id"  TEXT,
  ADD COLUMN IF NOT EXISTS "meta_access_token" TEXT;

-- Customer columns (nullable — existing customers get NULL, sticky only after first bot interaction)
ALTER TABLE "customers"
  ADD COLUMN IF NOT EXISTS "preferred_locale"  TEXT,
  ADD COLUMN IF NOT EXISTS "last_locale_choice" TIMESTAMP(3);

-- CustomerAddress table
CREATE TABLE IF NOT EXISTS "customer_addresses" (
  "id"              TEXT         NOT NULL,
  "customer_id"     TEXT         NOT NULL,
  "label"           TEXT,
  "street"          TEXT         NOT NULL,
  "block"           TEXT,
  "area"            TEXT         NOT NULL,
  "governorate"     TEXT,
  "building_number" TEXT,
  "notes"           TEXT,
  "is_default"      BOOLEAN      NOT NULL DEFAULT FALSE,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "customer_addresses_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "customer_addresses_customer_id_idx"
  ON "customer_addresses"("customer_id");

-- FK: customer_addresses → customers (cascade delete so orphan rows are impossible)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'customer_addresses_customer_id_fkey'
  ) THEN
    ALTER TABLE "customer_addresses"
      ADD CONSTRAINT "customer_addresses_customer_id_fkey"
        FOREIGN KEY ("customer_id") REFERENCES "customers"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
