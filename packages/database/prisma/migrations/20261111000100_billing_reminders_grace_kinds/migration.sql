-- S2-13 / Ruling BILL-NOTICE-1: grace-period notice stages share billing_reminders (one row per stage, UNIQUE
-- subscription + due date + kind). Widen the kind check; no data change.
ALTER TABLE "billing_reminders" DROP CONSTRAINT "billing_reminders_kind_check";
ALTER TABLE "billing_reminders" ADD CONSTRAINT "billing_reminders_kind_check"
  CHECK ("kind" IN ('d7', 'd3', 'd1', 'd0', 'suspended', 'grace_start', 'grace_d1'));
