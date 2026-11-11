-- Hand-written (Ruling SKIN-DEL-10, expand step of expand/contract). 0009 added two triggers that ABORT on a retired
-- template. Migrations apply BEFORE `wrangler deploy` (cf-api-deploy.yml), so for that window the previous release's
-- isolates still run, and a rollback (deploy-guard) leaves the new schema under the old code: either way a write of a
-- retired value turned into a 500 instead of being stored. A migration must never reject what the running release writes.
--   (a) drop the rejecting triggers. Readers already map any stored value (`normalizeLegacyTemplate`), so a retired value
--       in the column is harmless on screen. 0009's remap UPDATE stays (it is a one-time data move that changed nothing visible).
--   (b) 0010 added `stores.template_original`; fill it for the one row 0009 is known to have remapped (best effort: no other
--       original survives, 0009 kept none, and the Neon-side `stores.template` still holds the old value for pg stores).
-- The rejecting triggers return as migrations-pending/platform/0012_template_current_contract.sql, applied one release AFTER
-- the code has stopped writing retired values (gate in docs/rulings/SKIN-DEL-10.md). Idempotent.
DROP TRIGGER IF EXISTS "stores_template_current_insert";
DROP TRIGGER IF EXISTS "stores_template_current_update";

UPDATE "stores"
   SET "template_original" = 'modern'
 WHERE "slug" = 'qa-walk-store-1010' AND "template" = 'souq' AND "template_original" IS NULL;
