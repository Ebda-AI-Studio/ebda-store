-- Rollback for 20260925120000_email_campaigns.
--
-- Drops both tables and both enums. Dropping a table drops its policies,
-- indexes and FKs with it. DATA LOSS: every campaign and its send history is
-- deleted — take a PITR branch first if any campaign has been sent. No
-- existing table was altered by the forward migration, so nothing else needs
-- restoring.
--
-- The forward migration also set every `email_campaigns` row in
-- store_features to enabled = false. That is deliberately NOT reversed here:
-- the rows that were true (palora) came from when the flag was hidden and did
-- nothing, and blindly setting them back to true would turn campaigns on for
-- a store nobody chose to enable. Re-enabling is a manual super-admin toggle
-- on the features page, one store at a time.
--
-- After running it, also delete the row from _prisma_migrations so a later
-- `prisma migrate deploy` re-applies the forward migration:
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20260925120000_email_campaigns';

BEGIN;
DROP TABLE IF EXISTS "campaign_recipients";
DROP TABLE IF EXISTS "campaigns";
DROP TYPE IF EXISTS "CampaignRecipientStatus";
DROP TYPE IF EXISTS "CampaignStatus";
COMMIT;
