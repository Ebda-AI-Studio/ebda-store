-- 20261017000100_legal_acceptances_and_notices (Ruling LEGAL-4)
--
--   legal_acceptances        NEW, user-keyed. What each user accepted (signup click-wrap, dashboard
--                            "Got it"). Append-only for ebda_app: UPDATE/DELETE revoked below; the
--                            users FK cascade still removes them (referential actions are not
--                            subject to the referencing role's grants or RLS).
--   legal_notice_sends       NEW, platform-global (documented exception in
--                            tests/integration/rls-ebda-app.test.ts): one row per announced version.
--   legal_notice_deliveries  NEW, user-keyed. Email fan-out ledger, one row per recipient per version.
--
-- Additive only, all three tables empty at creation, so plain CREATE INDEX is correct
-- (docs/DB-INDEX-MIGRATIONS.md); no lock_timeout. FKs: users CASCADE (no NO ACTION child added).
-- Plain DDL (no IF NOT EXISTS), matching repo convention (B0 size_charts): the tables are new, so a
-- re-run on a half-applied database should fail loudly rather than silently skip.
-- ebda_app gets SELECT/INSERT/UPDATE/DELETE from the default privileges of
-- 20261004000000_ebda_strict_rls. Rollback: rollback.sql next to this file.

CREATE TABLE "legal_acceptances" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "doc_key" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "accepted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "user_agent" TEXT,
    "source" TEXT NOT NULL,

    CONSTRAINT "legal_acceptances_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "legal_acceptances_source_check" CHECK ("source" IN ('signup', 'notice_ack'))
);
CREATE UNIQUE INDEX "legal_acceptances_user_id_doc_key_version_key" ON "legal_acceptances"("user_id", "doc_key", "version");
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "legal_notice_sends" (
    "id" TEXT NOT NULL,
    "doc_key" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_by" TEXT NOT NULL,
    "recipient_count" INTEGER,

    CONSTRAINT "legal_notice_sends_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "legal_notice_sends_doc_key_version_key" ON "legal_notice_sends"("doc_key", "version");

CREATE TABLE "legal_notice_deliveries" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "doc_key" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "legal_notice_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "legal_notice_deliveries_status_check" CHECK ("status" IN ('queued', 'sending', 'sent', 'failed'))
);
CREATE UNIQUE INDEX "legal_notice_deliveries_user_id_doc_key_version_key" ON "legal_notice_deliveries"("user_id", "doc_key", "version");
CREATE INDEX "legal_notice_deliveries_doc_key_version_status_idx" ON "legal_notice_deliveries"("doc_key", "version", "status");
ALTER TABLE "legal_notice_deliveries" ADD CONSTRAINT "legal_notice_deliveries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- User-keyed strict RLS, same shape as refresh_tokens (20261008000100_tenant_defence_contract):
-- the row's user, or an ACTIVE super_admin (the fan-out runs as the operator who pressed send).
DO $legal_user_keyed$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['legal_acceptances', 'legal_notice_deliveries'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS ebda_user_isolation ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY ebda_user_isolation ON public.%I AS PERMISSIVE FOR ALL TO ebda_app '
      'USING (user_id = nullif(current_setting(''app.current_user_id'', true), '''') OR public.ebda_is_super_admin()) '
      'WITH CHECK (user_id = nullif(current_setting(''app.current_user_id'', true), '''') OR public.ebda_is_super_admin())',
      t
    );
  END LOOP;
END
$legal_user_keyed$;

-- Acceptance is a legal record: the app may add rows, never rewrite or remove them.
REVOKE UPDATE, DELETE ON "legal_acceptances" FROM ebda_app;
