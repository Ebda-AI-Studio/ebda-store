-- Money fixes batch B (rulings MONEYB-1..4). EXPAND ONLY: new nullable/defaulted
-- columns and new tables; nothing existing is altered or dropped, so the
-- previous API release keeps working against this schema (it never reads them).
--
-- 1. orders.cod_fee / orders.taxable_amount — the COD fee is frozen at creation
--    (quoted before the order is placed) and the VAT base (goods after discount
--    + shipping + COD fee) is frozen next to `tax`. Existing rows: cod_fee 0
--    (their fee, if any, was folded into total after submit), taxable_amount
--    NULL (taxed on goods only; read code rebuilds the legacy base).
-- 2. fiscal_documents + fiscal_document_counters — issued tax invoices /
--    receipts / credit notes / refund receipts with gap-free serials per store
--    and document type, plus store-deletion archive records. NO foreign keys to
--    stores/orders: a deleted store keeps its tax documents for 6 years.
-- 3. Immutability trigger: no DELETE before retain_until; UPDATE only of the
--    cancellation and ETA columns.
-- 4. Strict tenant RLS on both tables (R-EBDA-001) + a super-admin definer to
--    read the archive of a store that no longer exists.

ALTER TABLE "orders" ADD COLUMN "cod_fee" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "orders" ADD COLUMN "taxable_amount" INTEGER;
ALTER TABLE "orders" ADD CONSTRAINT "orders_cod_fee_nonneg" CHECK ("cod_fee" >= 0);

CREATE TYPE "FiscalDocType" AS ENUM (
  'tax_invoice', 'receipt', 'credit_note', 'refund_receipt', 'order_record', 'billing_record'
);

CREATE TABLE "fiscal_documents" (
  "id" TEXT NOT NULL,
  "store_id" TEXT NOT NULL,
  "order_id" TEXT,
  "doc_type" "FiscalDocType" NOT NULL,
  "serial" INTEGER,
  "number" TEXT,
  "status" TEXT NOT NULL DEFAULT 'issued',
  "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cancelled_at" TIMESTAMP(3),
  "original_document_id" TEXT,
  "original_number" TEXT,
  "original_issued_at" TIMESTAMP(3),
  "currency" TEXT NOT NULL DEFAULT 'EGP',
  "net_amount" INTEGER NOT NULL,
  "vat_amount" INTEGER NOT NULL DEFAULT 0,
  "total_amount" INTEGER NOT NULL,
  "vat_rate_bps" INTEGER,
  "seller_trn" TEXT,
  "payload" JSONB NOT NULL,
  "refund_ref" TEXT,
  "eta_uuid" TEXT,
  "eta_submission_id" TEXT,
  "eta_status" TEXT,
  "eta_submitted_at" TIMESTAMP(3),
  "retain_until" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "fiscal_documents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fiscal_documents_status_check" CHECK ("status" IN ('issued', 'cancelled')),
  -- Numbered types carry a serial + number; archive records never do.
  CONSTRAINT "fiscal_documents_serial_check" CHECK (
    ("doc_type" IN ('order_record', 'billing_record') AND "serial" IS NULL AND "number" IS NULL)
    OR ("doc_type" NOT IN ('order_record', 'billing_record') AND "serial" >= 1 AND "number" IS NOT NULL)
  ),
  -- A credit note / refund receipt always names the document it adjusts.
  CONSTRAINT "fiscal_documents_original_check" CHECK (
    "doc_type" NOT IN ('credit_note', 'refund_receipt')
    OR ("original_number" IS NOT NULL AND "original_issued_at" IS NOT NULL)
  ),
  CONSTRAINT "fiscal_documents_amounts_check" CHECK (
    "vat_amount" >= 0 AND "net_amount" >= 0 AND "total_amount" >= 0
  )
);

CREATE UNIQUE INDEX "fiscal_documents_store_id_doc_type_serial_key"
  ON "fiscal_documents"("store_id", "doc_type", "serial");
CREATE UNIQUE INDEX "fiscal_documents_store_id_refund_ref_key"
  ON "fiscal_documents"("store_id", "refund_ref");
CREATE INDEX "fiscal_documents_store_id_order_id_idx" ON "fiscal_documents"("store_id", "order_id");
CREATE INDEX "fiscal_documents_store_id_issued_at_idx" ON "fiscal_documents"("store_id", "issued_at" DESC);

CREATE TABLE "fiscal_document_counters" (
  "store_id" TEXT NOT NULL,
  "doc_type" "FiscalDocType" NOT NULL,
  "last_serial" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "fiscal_document_counters_pkey" PRIMARY KEY ("store_id", "doc_type"),
  CONSTRAINT "fiscal_document_counters_last_serial_check" CHECK ("last_serial" >= 0)
);

-- Immutability (UTPL 206/2020 Art. 37: numbered, no erasure; cancelled originals
-- kept). Applies to EVERY role, owner included: there is no in-app delete path,
-- and a purge after retain_until is the only way out.
CREATE OR REPLACE FUNCTION public.fiscal_documents_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.retain_until > now() THEN
      RAISE EXCEPTION 'fiscal_documents: % % is retained until %', OLD.doc_type, coalesce(OLD.number, OLD.id), OLD.retain_until
        USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  -- UPDATE: only cancellation (issued -> cancelled, once) and ETA bookkeeping.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.store_id IS DISTINCT FROM OLD.store_id
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.doc_type IS DISTINCT FROM OLD.doc_type
     OR NEW.serial IS DISTINCT FROM OLD.serial
     OR NEW.number IS DISTINCT FROM OLD.number
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
     OR NEW.original_document_id IS DISTINCT FROM OLD.original_document_id
     OR NEW.original_number IS DISTINCT FROM OLD.original_number
     OR NEW.original_issued_at IS DISTINCT FROM OLD.original_issued_at
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.net_amount IS DISTINCT FROM OLD.net_amount
     OR NEW.vat_amount IS DISTINCT FROM OLD.vat_amount
     OR NEW.total_amount IS DISTINCT FROM OLD.total_amount
     OR NEW.vat_rate_bps IS DISTINCT FROM OLD.vat_rate_bps
     OR NEW.seller_trn IS DISTINCT FROM OLD.seller_trn
     OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.refund_ref IS DISTINCT FROM OLD.refund_ref
     OR NEW.retain_until IS DISTINCT FROM OLD.retain_until
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'fiscal_documents: an issued document is immutable (fix it with a credit note)'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'issued' AND NEW.status = 'cancelled') THEN
    RAISE EXCEPTION 'fiscal_documents: status may only move issued -> cancelled'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER fiscal_documents_immutable
  BEFORE UPDATE OR DELETE ON "fiscal_documents"
  FOR EACH ROW EXECUTE FUNCTION public.fiscal_documents_immutable();

-- Strict tenant isolation (R-EBDA-001).
ALTER TABLE fiscal_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON fiscal_documents AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE fiscal_document_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_document_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON fiscal_document_counters AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));

-- The runtime role may never delete an issued document (the trigger also refuses
-- it before retain_until for every role). Default privileges granted DELETE.
REVOKE DELETE ON fiscal_documents FROM ebda_app;

-- Super-admin read of the tax archive, including stores that no longer exist
-- (no store scope can be opened for a deleted store). Read-only, capped.
CREATE OR REPLACE FUNCTION public.ebda_fiscal_archive(p_store_id text)
RETURNS TABLE (
  id text,
  store_id text,
  order_id text,
  doc_type text,
  number text,
  status text,
  issued_at timestamp(3),
  cancelled_at timestamp(3),
  original_number text,
  currency text,
  net_amount integer,
  vat_amount integer,
  total_amount integer,
  vat_rate_bps integer,
  seller_trn text,
  payload jsonb,
  retain_until timestamp(3)
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF NOT public.ebda_is_super_admin() THEN
    RAISE EXCEPTION 'ebda_fiscal_archive: caller is not a super_admin' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT d.id, d.store_id, d.order_id, d.doc_type::text, d.number, d.status, d.issued_at,
           d.cancelled_at, d.original_number, d.currency, d.net_amount, d.vat_amount,
           d.total_amount, d.vat_rate_bps, d.seller_trn, d.payload, d.retain_until
    FROM public.fiscal_documents d
    WHERE d.store_id = p_store_id
    ORDER BY d.issued_at DESC, d.serial DESC NULLS LAST
    LIMIT 5000;
END
$fn$;

REVOKE ALL ON FUNCTION public.ebda_fiscal_archive(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ebda_fiscal_archive(text) TO ebda_app;

-- Stores that have archived documents but no longer exist (super-admin index).
CREATE OR REPLACE FUNCTION public.ebda_fiscal_archive_stores()
RETURNS TABLE (store_id text, store_name text, document_count bigint, last_issued_at timestamp(3), store_exists boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF NOT public.ebda_is_super_admin() THEN
    RAISE EXCEPTION 'ebda_fiscal_archive_stores: caller is not a super_admin' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT d.store_id,
           max(d.payload #>> '{seller,name}'),
           count(*),
           max(d.issued_at),
           EXISTS (SELECT 1 FROM public.stores s WHERE s.id = d.store_id)
    FROM public.fiscal_documents d
    GROUP BY d.store_id
    ORDER BY max(d.issued_at) DESC
    LIMIT 1000;
END
$fn$;

REVOKE ALL ON FUNCTION public.ebda_fiscal_archive_stores() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ebda_fiscal_archive_stores() TO ebda_app;
