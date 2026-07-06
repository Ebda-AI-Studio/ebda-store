-- PR2 (crash-resumable bulk-AI sweeps): persist the event's `force` flag on
-- the job row itself (survives the per-batch `errors` column overwrites) and
-- track how many times queue-depth-watch has auto-resumed a stuck job so the
-- auto-resume loop is capped instead of retrying forever.
ALTER TABLE "bulk_ai_jobs" ADD COLUMN "force" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "bulk_ai_jobs" ADD COLUMN "auto_resume_count" INTEGER NOT NULL DEFAULT 0;
