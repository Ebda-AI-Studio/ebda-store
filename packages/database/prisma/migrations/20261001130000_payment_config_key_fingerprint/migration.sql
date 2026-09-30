-- #2010: non-secret display fingerprint for payment credentials.
-- The last 4 characters of the PLAINTEXT api key / merchant id, written at
-- save time next to the encrypted value, so the admin shows `****abcd` without
-- any read path decrypting. Nullable: existing rows have no fingerprint until
-- the merchant re-saves the key (the admin shows `****` + a re-save hint).
-- Additive only — no backfill (a backfill would have to decrypt every key).
ALTER TABLE "payment_configs" ADD COLUMN "api_key_last4" TEXT;
ALTER TABLE "payment_configs" ADD COLUMN "merchant_id_last4" TEXT;
