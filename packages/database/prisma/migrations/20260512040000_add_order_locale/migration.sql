-- Add locale column to orders table.
-- Stores the buyer's UI locale at checkout time (e.g. 'en', 'ar') so
-- order-driven transactional emails are sent in the buyer's language
-- regardless of the store's defaultLanguage setting.
-- Nullable so existing rows are unaffected; email fallback path reads
-- store.settings.defaultLanguage when locale IS NULL.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "locale" TEXT;
