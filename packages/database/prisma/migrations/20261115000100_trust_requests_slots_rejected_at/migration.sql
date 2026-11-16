-- trust_requests: atomic daily support cap + appeal rejection timestamp (additive, nullable).
--   cap_day / cap_slot  support rows claim slot 1..5 per store per UTC day; the partial UNIQUE settles a burst.
--   rejected_at         set by the super-admin reject route; the appeal cooldown keys on it.
-- Backend-neutral on purpose: the table moves to D1 (model-split.json), so no advisory lock.
ALTER TABLE "trust_requests" ADD COLUMN "rejected_at" TIMESTAMP(3);
ALTER TABLE "trust_requests" ADD COLUMN "cap_day" TEXT;
ALTER TABLE "trust_requests" ADD COLUMN "cap_slot" INTEGER;
ALTER TABLE "trust_requests" ADD CONSTRAINT "trust_requests_cap_slot_check" CHECK ("cap_slot" IS NULL OR "cap_slot" BETWEEN 1 AND 5);
CREATE UNIQUE INDEX "trust_requests_support_cap_slot" ON "trust_requests"("store_id", "cap_day", "cap_slot") WHERE "kind" = 'support' AND "cap_slot" IS NOT NULL;
