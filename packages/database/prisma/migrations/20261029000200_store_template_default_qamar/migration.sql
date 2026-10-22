-- New stores start on Qamar, the only built Ebda template, instead of the retired Force skin
-- 'modern'. Column DEFAULT only: no existing row changes (stores keep the skin they have), and
-- the 'qamar' enum value was added and committed by 20261023000100_store_template_qamar.
-- Rollback: ALTER TABLE "stores" ALTER COLUMN "template" SET DEFAULT 'modern';
ALTER TABLE "stores" ALTER COLUMN "template" SET DEFAULT 'qamar';
