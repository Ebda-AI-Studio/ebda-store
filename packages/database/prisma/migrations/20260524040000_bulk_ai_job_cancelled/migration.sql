-- Add 'cancelled' value to the BulkAiJobStatus enum so merchants can
-- cancel an in-progress bulk AI sweep via POST /stores/:id/ai/jobs/:jobId/cancel.
-- The cancel endpoint does an updateMany with status IN ('queued','running'),
-- so the job row transitions cleanly to cancelled without a completed-at
-- timestamp gap. The sweep functions check this status cooperatively every
-- 5 items and break out of their loops when they see it.

ALTER TYPE "BulkAiJobStatus" ADD VALUE IF NOT EXISTS 'cancelled';
