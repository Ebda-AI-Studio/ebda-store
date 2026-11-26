-- Ruling AI-OVERSELL-1: an InstaPay AI-pack reservation is a claim with status 'reserved' (reference issued, no receipt
-- yet). A distinct status keeps every existing reader that filters status = 'pending' (approval queue, counts, merchant
-- list) blind to reservations by default: fail closed. Receipt submit flips 'reserved' -> 'pending'.
-- Two statements on purpose: packages/cf-schema/scripts/pg-raw.mjs applies ADD before DROP inside ONE ALTER.
ALTER TABLE "manual_payment_claims" DROP CONSTRAINT "manual_payment_claims_status_check";
ALTER TABLE "manual_payment_claims"
  ADD CONSTRAINT "manual_payment_claims_status_check" CHECK ("status" IN ('pending', 'confirmed', 'rejected', 'reserved'));
