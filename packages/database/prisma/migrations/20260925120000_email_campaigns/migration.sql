-- D2 — Email Campaigns (docs/plans/2026-09-25-email-campaigns.md).
--
-- Creates two empty tables and schedules nothing. Its ONE data change is the
-- store_features reset at the bottom, which can only turn the feature OFF.
-- A campaign only reaches Resend
-- after a merchant creates one and presses send on a store where the
-- `email_campaigns` feature is enabled (it is in no plan baseline, so it is
-- OFF for every store until a super-admin turns it on).
--
-- Additive: no existing table is altered. The only new references INTO
-- existing tables are campaign_recipients' FKs, whose ON DELETE behaviour is
-- CASCADE for the store/campaign and SET NULL for newsletter_subscribers and
-- customers, so no existing delete path can be blocked by these rows.
--
-- Rollback: rollback.sql in this directory.

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('draft', 'scheduled', 'sending', 'sent', 'cancelled', 'failed');

-- CreateEnum
CREATE TYPE "CampaignRecipientStatus" AS ENUM ('queued', 'sent', 'failed', 'bounced', 'unsubscribed');

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "subject_ar" TEXT,
    "body_html" TEXT NOT NULL,
    "body_html_ar" TEXT,
    "locale_strategy" TEXT NOT NULL DEFAULT 'subscriber',
    "audience" JSONB NOT NULL DEFAULT '{"source":"newsletter"}',
    "status" "CampaignStatus" NOT NULL DEFAULT 'draft',
    "scheduled_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "recipient_count" INTEGER NOT NULL DEFAULT 0,
    "sent_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_recipients" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "subscriber_id" TEXT,
    "customer_id" TEXT,
    "locale" TEXT NOT NULL,
    "status" "CampaignRecipientStatus" NOT NULL DEFAULT 'queued',
    "provider_message_id" TEXT,
    "error" TEXT,
    "sent_at" TIMESTAMP(3),
    "unsubscribed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "campaigns_store_id_created_at_idx" ON "campaigns"("store_id", "created_at");

-- CreateIndex
CREATE INDEX "campaign_recipients_campaign_id_status_idx" ON "campaign_recipients"("campaign_id", "status");

-- CreateIndex
CREATE INDEX "campaign_recipients_store_id_status_sent_at_idx" ON "campaign_recipients"("store_id", "status", "sent_at");

-- CreateIndex
CREATE INDEX "campaign_recipients_subscriber_id_idx" ON "campaign_recipients"("subscriber_id");

-- CreateIndex
CREATE INDEX "campaign_recipients_customer_id_idx" ON "campaign_recipients"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_recipients_campaign_id_email_key" ON "campaign_recipients"("campaign_id", "email");

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_subscriber_id_fkey" FOREIGN KEY ("subscriber_id") REFERENCES "newsletter_subscribers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Row-level security, copying 20260911190000_merchant_api_keys exactly.
--
-- Inert today (production connects as a BYPASSRLS role); it closes the RLS
-- cutover risk that a policy-less tenant table goes dark under the deny-all
-- default from 20260702170000. The public unsubscribe endpoint knows the
-- store from the signed token and runs inside runInTenantContext(storeId),
-- so it needs no bypass.
ALTER TABLE "campaigns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "campaigns" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "campaigns_app_select" ON "campaigns";
CREATE POLICY "campaigns_app_select" ON "campaigns" FOR SELECT
  USING (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());

DROP POLICY IF EXISTS "campaigns_app_insert" ON "campaigns";
CREATE POLICY "campaigns_app_insert" ON "campaigns" FOR INSERT
  WITH CHECK (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());

DROP POLICY IF EXISTS "campaigns_app_update" ON "campaigns";
CREATE POLICY "campaigns_app_update" ON "campaigns" FOR UPDATE
  USING (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id())
  WITH CHECK (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());

DROP POLICY IF EXISTS "campaigns_app_delete" ON "campaigns";
CREATE POLICY "campaigns_app_delete" ON "campaigns" FOR DELETE
  USING (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());

ALTER TABLE "campaign_recipients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "campaign_recipients" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "campaign_recipients_app_select" ON "campaign_recipients";
CREATE POLICY "campaign_recipients_app_select" ON "campaign_recipients" FOR SELECT
  USING (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());

DROP POLICY IF EXISTS "campaign_recipients_app_insert" ON "campaign_recipients";
CREATE POLICY "campaign_recipients_app_insert" ON "campaign_recipients" FOR INSERT
  WITH CHECK (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());

DROP POLICY IF EXISTS "campaign_recipients_app_update" ON "campaign_recipients";
CREATE POLICY "campaign_recipients_app_update" ON "campaign_recipients" FOR UPDATE
  USING (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id())
  WITH CHECK (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());

DROP POLICY IF EXISTS "campaign_recipients_app_delete" ON "campaign_recipients";
CREATE POLICY "campaign_recipients_app_delete" ON "campaign_recipients" FOR DELETE
  USING (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());

-- Reset every existing email_campaigns override to OFF.
--
-- Until this release the key was `hidden: true` and did nothing, so an
-- enabled row could be left over from that period (production had one:
-- palora, enabled = true, checked read-only 2026-09-25). Without this reset
-- that store would get live campaign sending the moment this ships, without
-- anyone having decided to turn it on. From now on, enabling campaigns for a
-- store is a deliberate super-admin action on the features page.
--
-- It only ever sets false. Rows stay in place (with their history) so a
-- super-admin can re-enable with the usual toggle. The API reads the feature
-- map under a new Redis key prefix from this release on
-- (feature.service.ts CACHE_PREFIX), so a map cached before this UPDATE is
-- never served afterwards.
UPDATE "store_features" SET "enabled" = false WHERE "feature_key" = 'email_campaigns';
