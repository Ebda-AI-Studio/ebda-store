-- Hand-written. Row guards that must hold even against a buggy repo method (plan section 2.7, 2.8).
-- Everything else that was a Postgres function becomes a StoreDO method (docs/fn-map.json).

-- fiscal_documents_immutable (20261008160000_fiscal_documents_expand): numbered documents are never
-- erased before retain_until, and only issued -> cancelled (once) plus ETA bookkeeping may change.
CREATE TRIGGER IF NOT EXISTS "fiscal_documents_immutable_delete" BEFORE DELETE ON "fiscal_documents"
WHEN OLD."retain_until" > CAST(unixepoch('subsec') * 1000 AS INTEGER)
BEGIN
  SELECT RAISE(ABORT, 'fiscal_documents: document is retained until its retain_until date');
END;

CREATE TRIGGER IF NOT EXISTS "fiscal_documents_immutable_update" BEFORE UPDATE ON "fiscal_documents"
WHEN NEW."id" IS NOT OLD."id"
  OR NEW."store_id" IS NOT OLD."store_id"
  OR NEW."order_id" IS NOT OLD."order_id"
  OR NEW."doc_type" IS NOT OLD."doc_type"
  OR NEW."serial" IS NOT OLD."serial"
  OR NEW."number" IS NOT OLD."number"
  OR NEW."issued_at" IS NOT OLD."issued_at"
  OR NEW."original_document_id" IS NOT OLD."original_document_id"
  OR NEW."original_number" IS NOT OLD."original_number"
  OR NEW."original_issued_at" IS NOT OLD."original_issued_at"
  OR NEW."currency" IS NOT OLD."currency"
  OR NEW."net_amount" IS NOT OLD."net_amount"
  OR NEW."vat_amount" IS NOT OLD."vat_amount"
  OR NEW."total_amount" IS NOT OLD."total_amount"
  OR NEW."vat_rate_bps" IS NOT OLD."vat_rate_bps"
  OR NEW."seller_trn" IS NOT OLD."seller_trn"
  OR NEW."payload" IS NOT OLD."payload"
  OR NEW."refund_ref" IS NOT OLD."refund_ref"
  OR NEW."retain_until" IS NOT OLD."retain_until"
  OR NEW."created_at" IS NOT OLD."created_at"
BEGIN
  SELECT RAISE(ABORT, 'fiscal_documents: an issued document is immutable (fix it with a credit note)');
END;

CREATE TRIGGER IF NOT EXISTS "fiscal_documents_status_move" BEFORE UPDATE OF "status" ON "fiscal_documents"
WHEN NEW."status" IS NOT OLD."status" AND NOT (OLD."status" = 'issued' AND NEW."status" = 'cancelled')
BEGIN
  SELECT RAISE(ABORT, 'fiscal_documents: status may only move issued -> cancelled');
END;

-- Gold price guard (Ruling B5-13): the price of a gold-rate product or variant is written only by the
-- repricer, which sets do_flags.gold_reprice = 1 inside the same transactionSync (the GUC app.gold_reprice).
CREATE TRIGGER IF NOT EXISTS "ebda_gold_price_guard_products_insert" BEFORE INSERT ON "products"
WHEN NEW."pricing_mode" = 'gold_rate' AND COALESCE((SELECT "value" FROM "do_flags" WHERE "name" = 'gold_reprice'), 0) <> 1
BEGIN
  SELECT RAISE(ABORT, 'GOLD_PRICE_MANAGED: the price of a gold-rate product is written only by the repricer');
END;

CREATE TRIGGER IF NOT EXISTS "ebda_gold_price_guard_products_update" BEFORE UPDATE OF "price", "compare_at_price", "pricing_mode" ON "products"
WHEN NEW."pricing_mode" = 'gold_rate'
  AND COALESCE((SELECT "value" FROM "do_flags" WHERE "name" = 'gold_reprice'), 0) <> 1
  AND (OLD."pricing_mode" IS NOT NEW."pricing_mode" OR OLD."price" IS NOT NEW."price" OR OLD."compare_at_price" IS NOT NEW."compare_at_price")
BEGIN
  SELECT RAISE(ABORT, 'GOLD_PRICE_MANAGED: the price of a gold-rate product is written only by the repricer');
END;

CREATE TRIGGER IF NOT EXISTS "ebda_gold_price_guard_variants_insert" BEFORE INSERT ON "product_variants"
WHEN COALESCE(NEW."pricing_mode", (SELECT "pricing_mode" FROM "products" WHERE "id" = NEW."product_id")) = 'gold_rate'
  AND COALESCE((SELECT "value" FROM "do_flags" WHERE "name" = 'gold_reprice'), 0) <> 1
BEGIN
  SELECT RAISE(ABORT, 'GOLD_PRICE_MANAGED: the price of a gold-rate variant is written only by the repricer');
END;

CREATE TRIGGER IF NOT EXISTS "ebda_gold_price_guard_variants_update" BEFORE UPDATE OF "price", "compare_at_price", "pricing_mode" ON "product_variants"
WHEN COALESCE(NEW."pricing_mode", (SELECT "pricing_mode" FROM "products" WHERE "id" = NEW."product_id")) = 'gold_rate'
  AND COALESCE((SELECT "value" FROM "do_flags" WHERE "name" = 'gold_reprice'), 0) <> 1
  AND (OLD."pricing_mode" IS NOT NEW."pricing_mode" OR OLD."price" IS NOT NEW."price" OR OLD."compare_at_price" IS NOT NEW."compare_at_price")
BEGIN
  SELECT RAISE(ABORT, 'GOLD_PRICE_MANAGED: the price of a gold-rate variant is written only by the repricer');
END;

-- commerce_outcomes is append-only (CI-1): only exported_at may change (plus buyer_key -> NULL while do_flags.erasure = 1, the PDPL erasure path), rows are never deleted by the app.
CREATE TRIGGER IF NOT EXISTS "commerce_outcomes_no_delete" BEFORE DELETE ON "commerce_outcomes"
BEGIN
  SELECT RAISE(ABORT, 'commerce_outcomes is append-only (delete refused)');
END;

CREATE TRIGGER IF NOT EXISTS "commerce_outcomes_only_export_stamp" BEFORE UPDATE ON "commerce_outcomes"
WHEN NEW."id" IS NOT OLD."id" OR NEW."store_id" IS NOT OLD."store_id" OR NEW."kind" IS NOT OLD."kind"
  OR NEW."order_id" IS NOT OLD."order_id" OR (NEW."buyer_key" IS NOT OLD."buyer_key" AND NOT (NEW."buyer_key" IS NULL AND COALESCE((SELECT "value" FROM "do_flags" WHERE "name" = 'erasure'), 0) = 1)) OR NEW."area_key" IS NOT OLD."area_key"
  OR NEW."carrier" IS NOT OLD."carrier" OR NEW."payment_method" IS NOT OLD."payment_method" OR NEW."amount" IS NOT OLD."amount"
  OR NEW."reason_code" IS NOT OLD."reason_code" OR NEW."reason_raw" IS NOT OLD."reason_raw" OR NEW."source" IS NOT OLD."source"
  OR NEW."occurred_at" IS NOT OLD."occurred_at"
BEGIN
  SELECT RAISE(ABORT, 'commerce_outcomes is append-only (immutable column changed)');
END;
