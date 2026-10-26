DROP TRIGGER IF EXISTS "billing_grants_guard_update" ON "billing_grants";
DROP TRIGGER IF EXISTS "billing_grants_guard_delete" ON "billing_grants";
DROP FUNCTION IF EXISTS billing_grants_guard();
DROP TABLE IF EXISTS "billing_grants";
DROP TABLE IF EXISTS "billing_referrals";
