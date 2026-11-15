-- AITOOLS-4: the undo history of an AI "replace existing" run (NEVER-OVERWRITE-1). One row per entity + field per run, written
-- BEFORE the stored value is replaced. The StoreDO twin is cf-0008.
CREATE TABLE IF NOT EXISTS "ai_replace_backups" (
  "id" TEXT NOT NULL,
  "store_id" TEXT NOT NULL,
  "job_id" TEXT,
  "tool" TEXT NOT NULL,
  "entity_kind" TEXT NOT NULL,
  "entity_id" TEXT NOT NULL,
  "product_id" TEXT,
  "field" TEXT NOT NULL,
  "previous_value" TEXT,
  "new_value" TEXT,
  "user_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "restored_at" TIMESTAMP(3),
  "restored_by" TEXT,
  CONSTRAINT "ai_replace_backups_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ai_replace_backups_job_id_entity_kind_entity_id_field_key" ON "ai_replace_backups"("job_id", "entity_kind", "entity_id", "field");
CREATE INDEX IF NOT EXISTS "ai_replace_backups_store_id_created_at_idx" ON "ai_replace_backups"("store_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "ai_replace_backups_store_id_product_id_idx" ON "ai_replace_backups"("store_id", "product_id");
ALTER TABLE "ai_replace_backups" ADD CONSTRAINT "ai_replace_backups_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE ai_replace_backups ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_replace_backups FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON ai_replace_backups AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
