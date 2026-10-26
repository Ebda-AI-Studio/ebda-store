-- M-003 / M-025 (P11): InstaPay receipt retention. The screenshot is deleted on approval and on a schedule; the personal
-- fields (payer / receiver / note / what the AI read) are scrubbed on a schedule and on the shopper's erasure. Both are
-- recorded on the row; amount, reference, transfer time, flags and status stay as financial evidence.
ALTER TABLE "instapay_receipts" ADD COLUMN "image_deleted_at" TIMESTAMP(3);
ALTER TABLE "instapay_receipts" ADD COLUMN "personal_scrubbed_at" TIMESTAMP(3);
CREATE INDEX "instapay_receipts_retention_idx" ON "instapay_receipts"("status", "reviewed_at")
  WHERE "image_deleted_at" IS NULL OR "personal_scrubbed_at" IS NULL;
