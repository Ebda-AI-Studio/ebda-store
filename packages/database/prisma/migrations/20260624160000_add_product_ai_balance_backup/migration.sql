-- Snapshot of pre-balance description values for the AI language-balancer revert.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "ai_balance_backup" JSONB DEFAULT '{}';
-- New bulk-AI job kinds for the balance sweep + its revert (idempotent-guarded).
ALTER TYPE "BulkAiJobKind" ADD VALUE IF NOT EXISTS 'description_balance';
ALTER TYPE "BulkAiJobKind" ADD VALUE IF NOT EXISTS 'description_revert';
