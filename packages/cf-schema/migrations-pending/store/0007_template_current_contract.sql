-- CONTRACT step (Ruling SKIN-DEL-10), StoreDO twin of migrations-pending/platform/0012. NOT APPLIED: outside `migrations/`,
-- and not listed in STORE_MIGRATIONS. Gate: same three conditions as the platform file. To ship it, move it to
-- migrations/store/0007_template_current_contract.sql and add it to emitStoreMigrationsTs in scripts/generate.mjs.
UPDATE "store_profile"
   SET "template" = CASE "template"
         WHEN 'modern' THEN 'souq'
         WHEN 'minimal' THEN 'souq'
         WHEN 'classic' THEN 'dahab'
         WHEN 'bold' THEN 'qamar'
         WHEN 'elegant' THEN 'qamar'
         ELSE 'qamar'
       END,
       "updated_at" = CAST(unixepoch('subsec') * 1000 AS INTEGER)
 WHERE "template" NOT IN ('dahab', 'qamar', 'souq', 'jasmine', 'lamma');

CREATE TRIGGER IF NOT EXISTS "store_profile_template_current_insert" BEFORE INSERT ON "store_profile"
WHEN NEW."template" NOT IN ('dahab', 'qamar', 'souq', 'jasmine', 'lamma')
BEGIN
  SELECT RAISE(ABORT, 'store_profile.template must be a current Ebda template (dahab, qamar, souq, jasmine, lamma)');
END;

CREATE TRIGGER IF NOT EXISTS "store_profile_template_current_update" BEFORE UPDATE OF "template" ON "store_profile"
WHEN NEW."template" NOT IN ('dahab', 'qamar', 'souq', 'jasmine', 'lamma')
BEGIN
  SELECT RAISE(ABORT, 'store_profile.template must be a current Ebda template (dahab, qamar, souq, jasmine, lamma)');
END;
