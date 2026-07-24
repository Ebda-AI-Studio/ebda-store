-- Answer Engine Insights (AEO): check history + provider config
--
-- AnswerEngineCheck is an append-only audit trail (mirrors order_events):
-- each scheduled check run inserts one row per store/engine/prompt recording
-- whether the AI answer engine (Gemini/Perplexity/OpenAI) cited the store.
-- No updates after insert.
--
-- AnswerEngineProviderConfig is a PLATFORM-level table (no store_id) holding
-- the encrypted API key + enabled toggle for Perplexity/OpenAI. Gemini uses
-- the platform default key and needs no row here. Not tenant data.

CREATE TABLE "answer_engine_checks" (
    "id"              TEXT        NOT NULL,
    "store_id"        TEXT        NOT NULL,
    "engine"          TEXT        NOT NULL,
    "prompt_text"     TEXT        NOT NULL,
    "locale"          TEXT        NOT NULL DEFAULT 'en',
    "cited"           BOOLEAN     NOT NULL DEFAULT false,
    "rank"            INTEGER,
    "snippet"         TEXT,
    "cited_urls"      JSONB       NOT NULL DEFAULT '[]',
    "competitor_urls" JSONB       NOT NULL DEFAULT '[]',
    "run_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "answer_engine_checks_pkey" PRIMARY KEY ("id")
);

-- FK: store (cascade-delete the check history when the store is removed)
ALTER TABLE "answer_engine_checks"
    ADD CONSTRAINT "answer_engine_checks_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "answer_engine_checks_store_id_run_at_idx"
    ON "answer_engine_checks"("store_id", "run_at" DESC);

CREATE INDEX "answer_engine_checks_store_id_engine_run_at_idx"
    ON "answer_engine_checks"("store_id", "engine", "run_at" DESC);

-- ── Row Level Security (hybrid tenant predicate, mirrors 20260609000000 / order_events) ──
-- Allow when no tenant context is set (webhook / super-admin / scheduled job
-- via withRlsBypass), when app.bypass_rls='true' (Inngest / cron), OR when
-- the store matches the GUC. current_store_id() =
-- NULLIF(current_setting('app.current_store_id',true),'').
DROP POLICY IF EXISTS rls_answer_engine_checks_tenant ON answer_engine_checks;
ALTER TABLE answer_engine_checks ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_answer_engine_checks_tenant ON answer_engine_checks
  FOR ALL TO force_app
  USING (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR store_id::text = current_store_id()
  )
  WITH CHECK (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR store_id::text = current_store_id()
  );
ALTER TABLE answer_engine_checks FORCE ROW LEVEL SECURITY;

-- Platform-level config (no store_id, no RLS) — one row per non-Gemini engine.
CREATE TABLE "answer_engine_provider_configs" (
    "id"         TEXT        NOT NULL,
    "engine"     TEXT        NOT NULL,
    "api_key"    TEXT,
    "enabled"    BOOLEAN     NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "answer_engine_provider_configs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "answer_engine_provider_configs_engine_key"
    ON "answer_engine_provider_configs"("engine");
