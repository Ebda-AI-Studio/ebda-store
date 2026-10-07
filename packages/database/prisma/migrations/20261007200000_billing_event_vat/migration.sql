-- Ebda platform VAT on subscription billing events (Ruling EBDA-BILLFU-3).
-- Expand-only: a NOT NULL column with a constant default is a metadata-only
-- change on PG 11+ (no table rewrite), and the JSON snapshot is nullable.
-- Existing rows read as "no VAT" (vat_minor = 0, vat = NULL), which is what
-- they were: platform VAT has been OFF since billing_events was created.
ALTER TABLE "billing_events" ADD COLUMN "vat_minor" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "billing_events" ADD COLUMN "vat" JSONB;
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_vat_minor_range"
  CHECK ("vat_minor" >= 0 AND "vat_minor" <= "amount_minor");
