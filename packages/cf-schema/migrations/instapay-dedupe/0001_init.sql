-- D1 ebda-instapay-dedupe (Ruling INSTAPAY-AUTO-1a): the platform-global InstaPay duplicate index shared by Store and Chat.
-- Byte-for-byte the vendored foundation DEDUPE_SCHEMA_SQL (tests/unit/instapay-dedupe-wiring.test.ts pins it). Idempotent.
CREATE TABLE IF NOT EXISTS instapay_dedupe (
  kind TEXT NOT NULL CHECK (kind IN ('ref','img')),
  key TEXT NOT NULL,
  product TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('held','burned')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (kind, key)
);
CREATE INDEX IF NOT EXISTS instapay_dedupe_payment ON instapay_dedupe (payment_id);
