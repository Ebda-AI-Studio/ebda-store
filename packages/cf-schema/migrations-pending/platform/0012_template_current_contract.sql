-- CONTRACT step (Ruling SKIN-DEL-10). NOT APPLIED: this directory is outside `migrations/`, which is what
-- `wrangler d1 migrations apply` reads. Move it to migrations/platform/0012_template_current_contract.sql ONLY when ALL hold:
--   1. the release that stopped writing retired templates (every writer maps/rejects at the API) has been live for one full
--      release, and the previous release (which may still be a rollback target) writes none either;
--   2. `SELECT count(*) FROM stores WHERE template NOT IN ('dahab','qamar','souq','jasmine','lamma')` is 0 on prod D1
--      (otherwise the remap below runs on live rows: acceptable, but look first);
--   3. the last backup of the previous release has been restored in the drill (docs/DB-BACKUP-RESTORE.md).
-- Doing it earlier brings back the failure SKIN-DEL-10 removed (old isolates and rollbacks abort on a retired value).
UPDATE "stores"
   SET "template" = CASE "template"
         WHEN 'modern' THEN 'souq'
         WHEN 'minimal' THEN 'souq'
         WHEN 'classic' THEN 'dahab'
         WHEN 'bold' THEN 'qamar'
         WHEN 'elegant' THEN 'qamar'
         ELSE 'qamar'
       END,
       "template_original" = COALESCE("template_original", "template"),
       "updated_at" = CAST(unixepoch('subsec') * 1000 AS INTEGER)
 WHERE "template" NOT IN ('dahab', 'qamar', 'souq', 'jasmine', 'lamma');

CREATE TRIGGER IF NOT EXISTS "stores_template_current_insert" BEFORE INSERT ON "stores"
WHEN NEW."template" NOT IN ('dahab', 'qamar', 'souq', 'jasmine', 'lamma')
BEGIN
  SELECT RAISE(ABORT, 'stores.template must be a current Ebda template (dahab, qamar, souq, jasmine, lamma)');
END;

CREATE TRIGGER IF NOT EXISTS "stores_template_current_update" BEFORE UPDATE OF "template" ON "stores"
WHEN NEW."template" NOT IN ('dahab', 'qamar', 'souq', 'jasmine', 'lamma')
BEGIN
  SELECT RAISE(ABORT, 'stores.template must be a current Ebda template (dahab, qamar, souq, jasmine, lamma)');
END;
