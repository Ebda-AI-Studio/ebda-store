-- Hand-written (FOLD-VAT, data side of TAX-1). The seller snapshot (legal name + tax registration number) is carried in the
-- row's `vat` JSON by the charge code (trn, legalName) once VAT is switched on. Copy it into the real columns on insert so
-- an ETA submission reads columns, not JSON, and no writer has to know them. VAT OFF => `vat` is NULL => both stay NULL.
-- The fill trigger of 0004 is replaced (it already fills net / gross / rate for a caller that knows none of them).
DROP TRIGGER IF EXISTS "billing_events_tax_fill";
CREATE TRIGGER "billing_events_tax_fill" AFTER INSERT ON "billing_events"
WHEN NEW."gross_minor" = 0 AND NEW."amount_minor" > 0
BEGIN
  UPDATE "billing_events"
     SET "gross_minor" = NEW."amount_minor",
         "net_minor" = NEW."amount_minor" - NEW."vat_minor",
         "vat_rate_bp" = CASE WHEN NEW."vat_minor" = 0 THEN 0 ELSE COALESCE(CAST(json_extract(NEW."vat", '$.rateBps') AS INTEGER), 0) END,
         "seller_tax_id" = COALESCE(NEW."seller_tax_id", CASE WHEN NEW."vat_minor" = 0 THEN NULL ELSE json_extract(NEW."vat", '$.trn') END),
         "seller_legal_name" = COALESCE(NEW."seller_legal_name", CASE WHEN NEW."vat_minor" = 0 THEN NULL ELSE json_extract(NEW."vat", '$.legalName') END)
   WHERE "id" = NEW."id";
END;
