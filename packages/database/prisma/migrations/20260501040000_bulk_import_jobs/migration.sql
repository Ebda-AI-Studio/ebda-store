-- Bulk product import jobs — backs the async import flow added in
-- the same commit. Routes enqueue an Inngest event keyed on
-- bulk_import_job.id; the function streams progress updates onto
-- this row and the admin polls a /import-jobs/:id endpoint to
-- render a progress bar.

CREATE TYPE "BulkImportStatus" AS ENUM ('queued', 'running', 'completed', 'failed');

CREATE TABLE "bulk_import_jobs" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "user_id" TEXT,
    "status" "BulkImportStatus" NOT NULL DEFAULT 'queued',
    "csv_data" TEXT NOT NULL,
    "update_existing" BOOLEAN NOT NULL DEFAULT true,
    "total" INTEGER NOT NULL DEFAULT 0,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bulk_import_jobs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "bulk_import_jobs_store_id_created_at_idx"
  ON "bulk_import_jobs" ("store_id", "created_at" DESC);

CREATE INDEX "bulk_import_jobs_status_idx"
  ON "bulk_import_jobs" ("status");

ALTER TABLE "bulk_import_jobs"
  ADD CONSTRAINT "bulk_import_jobs_store_id_fkey"
  FOREIGN KEY ("store_id") REFERENCES "stores"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
