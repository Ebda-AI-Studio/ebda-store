-- Provider catalog, step 1 of 2 (EXPAND). Rulings PROVIDERS-1 / PROVIDERS-2 (2026-10-07),
-- plan docs/plans/2026-10-07-egypt-payments-shipping-integrations.md section 4.
--
--   payment_configs.provider           enum "PaymentProvider" -> TEXT, validated against the code
--                                      catalog (packages/shared/src/providers) instead of the DB, so
--                                      a new gateway is a catalog entry + adapter, not a migration.
--                                      A CHECK keeps the value a lowercase code.
--   payment_configs.credentials        NEW. AES-256-GCM ciphertext (encryption.service, ENCRYPTION_KEY)
--                                      of ONE JSON blob {"sandbox": {field: value}, "live": {...}}: the
--                                      provider's credential fields per mode, named by the catalog.
--   payment_configs.credential_hints   NEW. Non-secret display data per mode and field: {set, last4}
--                                      for a secret field, {set, value} for a public one. Never a secret.
--   payment_configs.connection_test    NEW. Last "Test connection" result {ok, code, mode, at,
--                                      fingerprint}. Enabling requires ok=true for the CURRENT
--                                      credentials (fingerprint = keyed HMAC of mode + fields).
--
-- Additive for the credentials: the legacy encrypted columns (api_key, secret_key, merchant_id,
-- webhook_secret, *_last4) stay readable; a row whose `credentials` is NULL is read from them
-- (apps/api/src/services/payment-providers/credentials.ts). Step 2 (CONTRACT, a later migration,
-- after every row has a `credentials` blob) drops those columns and the "PaymentProvider" type.
-- The enum type is deliberately NOT dropped here, so a rollback can cast the column back.
--
-- Rollback (docs/ROLLBACK.md): drop the three new columns and the CHECK, then
--   ALTER TABLE "payment_configs" ALTER COLUMN "provider" TYPE "PaymentProvider"
--     USING ("provider"::"PaymentProvider");
-- which fails loudly if a row carries a code outside the enum (delete or re-key it first).

ALTER TABLE "payment_configs"
  ALTER COLUMN "provider" TYPE TEXT USING ("provider"::text);

ALTER TABLE "payment_configs"
  ADD CONSTRAINT "payment_configs_provider_code_check"
  CHECK ("provider" ~ '^[a-z][a-z0-9_]{1,31}$');

ALTER TABLE "payment_configs" ADD COLUMN "credentials" TEXT;
ALTER TABLE "payment_configs" ADD COLUMN "credential_hints" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "payment_configs" ADD COLUMN "connection_test" JSONB;
