-- Egypt VAT gate, phase 1 (ruling TAX-2; design docs/plans/2026-10-07-egypt-vat-and-eta.md).
--
-- A merchant may charge VAT only once a super-admin has VERIFIED its VAT
-- registration (tax card / VAT certificate + tax registration number). Issuing
-- a VAT invoice while unregistered is tax evasion (Law 67/2016 Art. 68 item 8).
--
-- EXPAND ONLY (Ruling CF-MIGRATE-1: migrations run before the Worker deploy, so
-- the previous release must keep working against this schema):
--   * two new tables + two new enums, nothing the old code reads;
--   * three NULLABLE columns on `orders` the old code never writes;
--   * NO data rewrite: a store with `tax_enabled = true` and no verified profile
--     keeps its row untouched; the new resolver treats it as off (ruling TAX-3).
--
-- RLS: both tables carry `store_id` and get the same single strict policy every
-- store_id table has (R-EBDA-001, 20261004000000_ebda_strict_rls), so
-- tests/integration/rls-ebda-app.test.ts enumerates them automatically.
--
-- Defence in depth for the approval itself: a trigger refuses, for the runtime
-- role `ebda_app`, any transition INTO verified/rejected/revoked (and any edit of
-- a verified profile's identity) unless the caller is an active super_admin
-- (`ebda_is_super_admin()`, which reads `app.current_user_id`). An application
-- bug in a merchant route therefore cannot self-verify a store.

-- CreateEnum
CREATE TYPE "TaxProfileStatus" AS ENUM ('none', 'pending', 'verified', 'rejected', 'revoked');

-- CreateEnum
CREATE TYPE "TaxDocumentKind" AS ENUM ('tax_card', 'vat_certificate', 'other');

-- AlterTable (nullable, expand-only)
ALTER TABLE "orders" ADD COLUMN "seller_tax_registration_number" TEXT,
ADD COLUMN "seller_tax_legal_name" TEXT,
ADD COLUMN "tax_rate_bps" INTEGER;

-- CreateTable
CREATE TABLE "store_tax_profiles" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "status" "TaxProfileStatus" NOT NULL DEFAULT 'none',
    "tax_registration_number" TEXT,
    "legal_name" TEXT,
    "attested_at" TIMESTAMP(3),
    "submitted_at" TIMESTAMP(3),
    "submitted_by" TEXT,
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "verified_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "store_tax_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_tax_documents" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,
    "kind" "TaxDocumentKind" NOT NULL,
    "storage_key" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploaded_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_tax_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "store_tax_profiles_store_id_key" ON "store_tax_profiles"("store_id");
CREATE INDEX "store_tax_profiles_status_submitted_at_idx" ON "store_tax_profiles"("status", "submitted_at");
CREATE INDEX "store_tax_profiles_tax_registration_number_idx" ON "store_tax_profiles"("tax_registration_number");
CREATE INDEX "store_tax_documents_store_id_idx" ON "store_tax_documents"("store_id");
CREATE INDEX "store_tax_documents_profile_id_idx" ON "store_tax_documents"("profile_id");

-- AddForeignKey
ALTER TABLE "store_tax_profiles" ADD CONSTRAINT "store_tax_profiles_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "store_tax_documents" ADD CONSTRAINT "store_tax_documents_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "store_tax_documents" ADD CONSTRAINT "store_tax_documents_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "store_tax_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Strict tenant isolation (R-EBDA-001): the same single policy every store_id table carries.
ALTER TABLE store_tax_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_tax_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON store_tax_profiles AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE store_tax_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_tax_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON store_tax_documents AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));

-- Approval guard (see header). Runs as the invoker; only the runtime role is
-- checked, so migrations, ops scripts and test fixtures (owner role) are free.
CREATE OR REPLACE FUNCTION public.tax_profile_review_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  old_status "TaxProfileStatus" := 'none';
BEGIN
  IF current_user <> 'ebda_app' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    old_status := OLD.status;
  END IF;
  IF NEW.status IS DISTINCT FROM old_status
     AND NEW.status IN ('verified', 'rejected', 'revoked')
     AND NOT public.ebda_is_super_admin() THEN
    RAISE EXCEPTION 'tax profile: only a super_admin may set status %', NEW.status
      USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'verified' AND NEW.status = 'verified'
     AND (NEW.tax_registration_number IS DISTINCT FROM OLD.tax_registration_number
          OR NEW.legal_name IS DISTINCT FROM OLD.legal_name)
     AND NOT public.ebda_is_super_admin() THEN
    RAISE EXCEPTION 'tax profile: a verified identity is changed only by a super_admin'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER store_tax_profiles_review_guard
  BEFORE INSERT OR UPDATE ON store_tax_profiles
  FOR EACH ROW EXECUTE FUNCTION public.tax_profile_review_guard();

-- Super-admin review queue: profiles across every store (strict RLS shows a
-- request one store at a time). Super_admin only (the function checks), fixed
-- search_path, no dynamic SQL. `duplicate_trn_stores` = OTHER stores holding the
-- same TRN in pending/verified — a reviewer signal, not a block (one legal
-- entity may own several stores).
CREATE OR REPLACE FUNCTION public.ebda_tax_profiles_for_review(p_status text)
RETURNS TABLE (
  store_id text,
  store_name text,
  store_slug text,
  status text,
  tax_registration_number text,
  legal_name text,
  submitted_at timestamp(3),
  reviewed_at timestamp(3),
  verified_at timestamp(3),
  rejection_reason text,
  document_count bigint,
  duplicate_trn_stores bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF NOT public.ebda_is_super_admin() THEN
    RAISE EXCEPTION 'ebda_tax_profiles_for_review: caller is not a super_admin' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT p.store_id, s.name, s.slug, p.status::text, p.tax_registration_number, p.legal_name,
           p.submitted_at, p.reviewed_at, p.verified_at, p.rejection_reason,
           (SELECT count(*) FROM public.store_tax_documents d WHERE d.profile_id = p.id),
           (SELECT count(*) FROM public.store_tax_profiles o
             WHERE o.tax_registration_number = p.tax_registration_number
               AND o.store_id <> p.store_id
               AND o.status IN ('pending', 'verified'))
    FROM public.store_tax_profiles p
    JOIN public.stores s ON s.id = p.store_id
    WHERE (p_status IS NULL AND p.status <> 'none') OR p.status::text = p_status
    ORDER BY p.submitted_at ASC NULLS LAST
    LIMIT 500;
END
$fn$;

REVOKE ALL ON FUNCTION public.ebda_tax_profiles_for_review(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ebda_tax_profiles_for_review(text) TO ebda_app;

-- Ebda's OWN VAT on subscriptions is a super-admin platform setting
-- (`system_settings` key `ebda.vat`, ruling TAX-6). `system_settings` is
-- platform-global with a `true` policy for ebda_app, so the route authz is the
-- only guard there; this trigger adds the database-side one for this key:
-- for the runtime role, only an active super_admin may write it.
CREATE OR REPLACE FUNCTION public.platform_vat_setting_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF current_user <> 'ebda_app' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF ((TG_OP <> 'INSERT' AND OLD.key = 'ebda.vat') OR (TG_OP <> 'DELETE' AND NEW.key = 'ebda.vat'))
     AND NOT public.ebda_is_super_admin() THEN
    RAISE EXCEPTION 'ebda.vat: only a super_admin may change the platform VAT setting'
      USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$fn$;

CREATE TRIGGER system_settings_platform_vat_guard
  BEFORE INSERT OR UPDATE OR DELETE ON system_settings
  FOR EACH ROW EXECUTE FUNCTION public.platform_vat_setting_guard();
