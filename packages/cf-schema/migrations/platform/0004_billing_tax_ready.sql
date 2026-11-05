-- Hand-written (NEON-ZERO-1 FOLD TAX-1, 9.1). The columns themselves are GENERATED (0003_late_columns.sql, declared once in
-- scripts/cf-additions.mjs). This file fills them for history and polices them on every write, so no writer needs to know them:
--   gross = net + vat, vat = round(net * rate / 10000) within 1 minor unit, the money columns are frozen once filled.
-- Triggers (not CHECKs): SQLite cannot add a CHECK to an existing table, and the backfilled history is not re-judged.

-- Backfill: the ledger already stores the VAT carved out of the gross amount (rate in the vat JSON, basis points).
UPDATE "billing_events"
   SET "gross_minor" = "amount_minor",
       "net_minor" = "amount_minor" - "vat_minor",
       "vat_rate_bp" = CASE WHEN "vat_minor" = 0 THEN 0 ELSE COALESCE(CAST(json_extract("vat", '$.rateBps') AS INTEGER), 0) END;

-- A row written by a caller that does not know the new columns (the whole API today) gets them filled from amount / vat.
CREATE TRIGGER IF NOT EXISTS "billing_events_tax_fill" AFTER INSERT ON "billing_events"
WHEN NEW."gross_minor" = 0 AND NEW."amount_minor" > 0
BEGIN
  UPDATE "billing_events"
     SET "gross_minor" = NEW."amount_minor",
         "net_minor" = NEW."amount_minor" - NEW."vat_minor",
         "vat_rate_bp" = CASE WHEN NEW."vat_minor" = 0 THEN 0 ELSE COALESCE(CAST(json_extract(NEW."vat", '$.rateBps') AS INTEGER), 0) END
   WHERE "id" = NEW."id";
END;

-- An explicit net / gross must add up. (Insert-only: the backfilled history is not re-judged.)
CREATE TRIGGER IF NOT EXISTS "billing_events_tax_consistent_insert" AFTER INSERT ON "billing_events"
WHEN NEW."gross_minor" <> 0 AND NEW."gross_minor" <> NEW."net_minor" + NEW."vat_minor"
BEGIN
  SELECT RAISE(ABORT, 'billing_events: gross_minor must equal net_minor + vat_minor');
END;

CREATE TRIGGER IF NOT EXISTS "billing_events_tax_rate_insert" AFTER INSERT ON "billing_events"
WHEN NEW."vat_rate_bp" > 0 AND NEW."net_minor" > 0
  AND abs(NEW."vat_minor" - ((NEW."net_minor" * NEW."vat_rate_bp" + 5000) / 10000)) > 1
BEGIN
  SELECT RAISE(ABORT, 'billing_events: vat_minor is not round(net_minor * vat_rate_bp / 10000) within 1 minor unit');
END;

CREATE TRIGGER IF NOT EXISTS "billing_events_tax_consistent_update" AFTER UPDATE OF "net_minor", "gross_minor", "vat_minor" ON "billing_events"
WHEN NEW."gross_minor" <> NEW."net_minor" + NEW."vat_minor"
BEGIN
  SELECT RAISE(ABORT, 'billing_events: gross_minor must equal net_minor + vat_minor');
END;

-- The append-only guard (0002) now also freezes the new money columns. The one allowed change is the fill above:
-- from the unset state (gross_minor = 0) to the amounts, once.
DROP TRIGGER IF EXISTS "billing_events_guard_update";
CREATE TRIGGER "billing_events_guard_update" BEFORE UPDATE ON "billing_events"
WHEN NEW."store_id" IS NOT OLD."store_id"
  OR NEW."type" IS NOT OLD."type"
  OR NEW."amount_minor" IS NOT OLD."amount_minor"
  OR NEW."currency" IS NOT OLD."currency"
  OR NEW."provider" IS NOT OLD."provider"
  OR NEW."idempotency_key" IS NOT OLD."idempotency_key"
  OR NEW."created_at" IS NOT OLD."created_at"
  OR (OLD."gross_minor" <> 0 AND (
        NEW."net_minor" IS NOT OLD."net_minor"
     OR NEW."gross_minor" IS NOT OLD."gross_minor"
     OR NEW."vat_rate_bp" IS NOT OLD."vat_rate_bp"
     OR NEW."vat_minor" IS NOT OLD."vat_minor"))
BEGIN
  SELECT RAISE(ABORT, 'billing_events is append-only (immutable column changed)');
END;
