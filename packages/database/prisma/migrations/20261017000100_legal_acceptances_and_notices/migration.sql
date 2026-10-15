-- 20261017000100_legal_acceptances_and_notices (Ruling LEGAL-4)
--
--   legal_acceptances        NEW, user-keyed. What each user accepted (signup click-wrap, dashboard
--                            "Got it"). Append-only for ebda_app: UPDATE/DELETE revoked below; the
--                            users FK cascade still removes them (referential actions are not
--                            subject to the referencing role's grants or RLS).
--   legal_notice_sends       NEW, platform-global (no user data) but under RLS: any signed-in user reads it
--                            (the banner), only a super_admin writes. One row per announced version.
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

-- Strict RLS, one FOR ALL policy per table (tests/integration/rls-ebda-app.test.ts requires every policy to
-- carry USING and WITH CHECK, both reading the user GUC). "cur" = nullif(current_setting('app.current_user_id',
-- true), ''); a super-admin is an ACTIVE super_admin per public.ebda_is_super_admin(), and the operator
-- paths (send route, fan-out) always carry a user id, so "super-admin AND cur is set" is that path.
--   legal_acceptances       USING own row or super_admin (reads); WITH CHECK own row ONLY, so there is no
--                           super_admin insert path: an acceptance is the user's own consent record.
--   legal_notice_deliveries USING own row or super_admin; WITH CHECK super_admin: a merchant reads its row
--                           but can never insert or rewrite it (the fan-out is the sole writer).
--   legal_notice_sends      USING any request that carries a user (the merchant banner reads it; a
--                           contextless connection sees nothing); WITH CHECK super_admin.
-- DELETE is revoked on all three below (a FOR ALL USING would otherwise let a reader delete); user deletion
-- still cascades because referential actions skip the referencing role's grants and RLS.
ALTER TABLE "legal_acceptances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "legal_acceptances" FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_user_isolation ON "legal_acceptances" AS PERMISSIVE FOR ALL TO ebda_app
  USING (user_id = nullif(current_setting('app.current_user_id', true), '') OR public.ebda_is_super_admin())
  WITH CHECK (user_id = nullif(current_setting('app.current_user_id', true), ''));

ALTER TABLE "legal_notice_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "legal_notice_deliveries" FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_user_isolation ON "legal_notice_deliveries" AS PERMISSIVE FOR ALL TO ebda_app
  USING (user_id = nullif(current_setting('app.current_user_id', true), '') OR public.ebda_is_super_admin())
  WITH CHECK (nullif(current_setting('app.current_user_id', true), '') IS NOT NULL AND public.ebda_is_super_admin());

ALTER TABLE "legal_notice_sends" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "legal_notice_sends" FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_user_isolation ON "legal_notice_sends" AS PERMISSIVE FOR ALL TO ebda_app
  USING (nullif(current_setting('app.current_user_id', true), '') IS NOT NULL)
  WITH CHECK (nullif(current_setting('app.current_user_id', true), '') IS NOT NULL AND public.ebda_is_super_admin());

-- Acceptance is a legal record: the app may add rows, never rewrite or remove them.
REVOKE UPDATE, DELETE ON "legal_acceptances" FROM ebda_app;
REVOKE DELETE ON "legal_notice_deliveries" FROM ebda_app;
REVOKE DELETE ON "legal_notice_sends" FROM ebda_app;
