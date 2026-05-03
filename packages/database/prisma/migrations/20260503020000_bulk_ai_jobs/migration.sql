-- Catalogue-wide AI sweep tracking. One row per merchant-initiated
-- bulk operation (translate missing fields, generate missing SEO),
-- updated incrementally by the Inngest function as it processes
-- entities. The admin AI Tools page polls these for progress.

CREATE TYPE "BulkAiJobKind" AS ENUM ('translate', 'seo');
CREATE TYPE "BulkAiJobStatus" AS ENUM ('queued', 'running', 'completed', 'failed');

CREATE TABLE "bulk_ai_jobs" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "user_id" TEXT,
    "kind" "BulkAiJobKind" NOT NULL,
    "status" "BulkAiJobStatus" NOT NULL DEFAULT 'queued',
    "direction" TEXT,
    "total" INTEGER NOT NULL DEFAULT 0,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "filled" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bulk_ai_jobs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "bulk_ai_jobs_store_id_created_at_idx"
  ON "bulk_ai_jobs" ("store_id", "created_at" DESC);

CREATE INDEX "bulk_ai_jobs_status_idx"
  ON "bulk_ai_jobs" ("status");

ALTER TABLE "bulk_ai_jobs"
  ADD CONSTRAINT "bulk_ai_jobs_store_id_fkey"
  FOREIGN KEY ("store_id") REFERENCES "stores"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
