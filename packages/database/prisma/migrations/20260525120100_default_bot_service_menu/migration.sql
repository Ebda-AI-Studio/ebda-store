-- Back-fill bot_service_menu for existing stores that were created before
-- the native-catalog bot column was added. New stores get this default via
-- the wa-bridge DEFAULT_SERVICE_MENU constant (applied in the service-menu
-- GET endpoint), but the DB column stays NULL until the first PUT so the
-- bot treats NULL as "use defaults". This migration materialises the defaults
-- so admin UI can always read a fully-shaped JSON object without a null check.
--
-- Idempotent: WHERE bot_service_menu IS NULL means re-running is safe.

UPDATE "stores"
SET "bot_service_menu" = jsonb_build_object(
  'orderNow',          true,
  'subscriptionBoxes', false,
  'locationsHours',    true,
  'chatWithAgent',     true,
  'labels',            jsonb_build_object('en', '{}'::jsonb, 'ar', '{}'::jsonb)
)
WHERE "bot_service_menu" IS NULL;
