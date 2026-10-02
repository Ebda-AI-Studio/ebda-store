-- Manual rollback for 20261001140000_sms_marketing_consents (issue 206).
-- Drops every recorded SMS-marketing consent. Run only after the API code
-- that reads the table has been rolled back; promotional SMS then fails
-- closed (no consent row = no send), which is the safe direction.
DROP TABLE IF EXISTS "sms_marketing_consents";
DROP TYPE IF EXISTS "SmsConsentSource";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261001140000_sms_marketing_consents';
