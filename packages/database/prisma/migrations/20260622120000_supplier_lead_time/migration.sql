-- AddColumn: lead_time_days on suppliers
-- Default 7 days matches the existing system-wide fallback in the reorder engine.
ALTER TABLE "suppliers" ADD COLUMN "lead_time_days" INTEGER NOT NULL DEFAULT 7;
