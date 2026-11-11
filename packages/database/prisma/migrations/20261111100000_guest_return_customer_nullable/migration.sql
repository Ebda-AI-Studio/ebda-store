-- GUEST-RET-1 (S2-7): a guest (no customer row) can request a return. Returns.customer_id was NOT NULL, so a guest
-- order could never have one. NULL = guest return; the merchant reads the order contact. Metadata-only change.
ALTER TABLE "returns" ALTER COLUMN "customer_id" DROP NOT NULL;
