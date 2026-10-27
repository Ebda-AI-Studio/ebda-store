-- Ruling WA-PKG-1 (Ahmad 2026-10-24): the Business plan includes the Ebda WhatsApp package, so its
-- `whatsappAutomation` entitlement is true (the flag now means "this plan includes the package").
-- Mirrors DEFAULT_PLAN_SEEDS in packages/shared/src/schemas/plan-limits.ts. Idempotent.
UPDATE "plans"
   SET "limits" = jsonb_set("limits", '{whatsappAutomation}', 'true'::jsonb)
 WHERE "code" = 'business'
   AND COALESCE("limits" ->> 'whatsappAutomation', 'false') <> 'true';
