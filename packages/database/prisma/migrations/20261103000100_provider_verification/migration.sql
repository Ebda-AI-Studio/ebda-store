-- PROVIDERS-3: provider verification evidence (additive, platform-global, no tenant data).
--
--   provider_verifications        per-provider counters + verified_at (auto-set after N real successes)
--   provider_verification_events  append-only evidence; source_store_id is a plain string (NO FK) so a
--                                 store deletion never erases it; never holds a credential/body.
--
-- Policy `true` for ebda_app, exactly like system_settings (platform-global, no store_id semantics).
-- Rollback: DROP TABLE provider_verification_events, provider_verifications (docs/ROLLBACK.md);
-- providers simply fall back to the catalog's `verified` flag.

CREATE TABLE "provider_verifications" (
    "provider" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "success_count" INTEGER NOT NULL DEFAULT 0,
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_verifications_pkey" PRIMARY KEY ("provider")
);

CREATE TABLE "provider_verification_events" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "source_store_id" TEXT NOT NULL,
    "op" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "ref" TEXT,
    "error_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_verification_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "provider_verification_events_provider_created_at_idx" ON "provider_verification_events"("provider", "created_at");
CREATE INDEX "provider_verification_events_provider_source_store_id_idx" ON "provider_verification_events"("provider", "source_store_id");

ALTER TABLE provider_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_verifications FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON provider_verifications AS PERMISSIVE FOR ALL TO ebda_app
  USING (true)
  WITH CHECK (true);
ALTER TABLE provider_verification_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_verification_events FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON provider_verification_events AS PERMISSIVE FOR ALL TO ebda_app
  USING (true)
  WITH CHECK (true);
