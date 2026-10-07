-- Signup funnel (Ruling EBDA-FUNNEL-1): card on file + 14-day Growth trial.
--
-- 1. Card display details for the merchant and super-admin billing pages. The
--    token itself stays encrypted in provider_payment_method_ref; last4/brand are
--    what the provider reports (nullable: a provider may not send them).
-- 2. `card_setup` ledger rows: a card saved with NOTHING charged (amount 0).
--    Additive only: no existing row changes, the RLS policies on both tables are
--    unchanged (the new columns inherit the table's strict store policy).

ALTER TABLE "store_subscriptions"
  ADD COLUMN "payment_method_last4" TEXT,
  ADD COLUMN "payment_method_brand" TEXT,
  ADD COLUMN "payment_method_saved_at" TIMESTAMP(3);

ALTER TABLE "store_subscriptions"
  ADD CONSTRAINT "store_subscriptions_payment_method_last4_check"
  CHECK ("payment_method_last4" IS NULL OR "payment_method_last4" ~ '^[0-9]{4}$');


-- 3. How a subscription is paid (Rulings EBDA-FUNNEL-8/9): `card` (saved card,
--    charged by the provider) or `instapay` (manual transfer recorded by a
--    super-admin). NULL = not chosen yet (or an operator-assigned row).
--    `payment_reference` is the unique code the merchant writes on an InstaPay
--    transfer so the super-admin can match it.
ALTER TABLE "store_subscriptions"
  ADD COLUMN "billing_method" TEXT,
  ADD COLUMN "payment_reference" TEXT;
ALTER TABLE "store_subscriptions"
  ADD CONSTRAINT "store_subscriptions_billing_method_check"
  CHECK ("billing_method" IS NULL OR "billing_method" IN ('card', 'instapay'));
CREATE UNIQUE INDEX "store_subscriptions_payment_reference_key"
  ON "store_subscriptions"("payment_reference");

-- 4. Billing suspension of a store (EBDA-FUNNEL-10/11). The store's `status` is
--    set to `suspended` (storefront shows the neutral maintenance page); this
--    column says WHY, so only a billing suspension is ever lifted automatically
--    (a super-admin suspension has reason NULL and stays until an operator acts).
ALTER TABLE "stores"
  ADD COLUMN "billing_suspended_reason" TEXT,
  ADD COLUMN "billing_suspended_at" TIMESTAMP(3);
ALTER TABLE "stores"
  ADD CONSTRAINT "stores_billing_suspended_reason_check"
  CHECK ("billing_suspended_reason" IS NULL OR "billing_suspended_reason" IN ('unpaid', 'over_store_limit'));

-- 5. Manual payments in the ledger (super-admin "Record manual payment & activate").
ALTER TABLE "billing_events" DROP CONSTRAINT "billing_events_type_check";
ALTER TABLE "billing_events"
  ADD CONSTRAINT "billing_events_type_check"
  CHECK ("type" IN ('checkout', 'renewal', 'upgrade', 'refund', 'card_setup', 'manual_payment'));

-- 6. A merchant's "I paid by InstaPay" claim. NEVER activates anything by itself:
--    a super-admin confirms it with the manual-payment action (or rejects it).
CREATE TABLE "manual_payment_claims" (
  "id" TEXT NOT NULL,
  "store_id" TEXT NOT NULL,
  "subscription_id" TEXT,
  "plan_code" TEXT NOT NULL,
  "billing_interval" TEXT NOT NULL,
  "amount_minor" INTEGER NOT NULL,
  "method" TEXT NOT NULL DEFAULT 'instapay',
  "payment_reference" TEXT NOT NULL,
  "payer_reference" TEXT NOT NULL,
  "proof_url" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "review_note" TEXT,
  "reviewed_by" TEXT,
  "reviewed_at" TIMESTAMP(3),
  "billing_event_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "manual_payment_claims_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "manual_payment_claims_amount_check" CHECK ("amount_minor" > 0),
  CONSTRAINT "manual_payment_claims_status_check" CHECK ("status" IN ('pending', 'confirmed', 'rejected')),
  CONSTRAINT "manual_payment_claims_method_check" CHECK ("method" IN ('instapay', 'bank', 'cash'))
);
CREATE UNIQUE INDEX "manual_payment_claims_method_payer_reference_key"
  ON "manual_payment_claims"("method", "payer_reference");
CREATE INDEX "manual_payment_claims_store_id_created_at_idx"
  ON "manual_payment_claims"("store_id", "created_at" DESC);
CREATE INDEX "manual_payment_claims_status_idx" ON "manual_payment_claims"("status");
ALTER TABLE "manual_payment_claims" ADD CONSTRAINT "manual_payment_claims_store_id_fkey"
  FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE manual_payment_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE manual_payment_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON manual_payment_claims AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));

-- 7. One row per (subscription, due date, reminder kind): the daily job sends a
--    reminder only by winning this insert, so a second run the same day sends
--    nothing (idempotent), and a skipped day never replays older reminders.
CREATE TABLE "billing_reminders" (
  "id" TEXT NOT NULL,
  "store_id" TEXT NOT NULL,
  "subscription_id" TEXT NOT NULL,
  "due_at" TIMESTAMP(3) NOT NULL,
  "kind" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "billing_reminders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_reminders_kind_check" CHECK ("kind" IN ('d7', 'd3', 'd1', 'd0', 'suspended'))
);
CREATE UNIQUE INDEX "billing_reminders_subscription_id_due_at_kind_key"
  ON "billing_reminders"("subscription_id", "due_at", "kind");
CREATE INDEX "billing_reminders_store_id_idx" ON "billing_reminders"("store_id");
ALTER TABLE "billing_reminders" ADD CONSTRAINT "billing_reminders_store_id_fkey"
  FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE billing_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_reminders FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON billing_reminders AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
