-- Hand-written (Ruling SKIN-DEL-9), the StoreDO twin of D1 0009_store_template_current.sql. A DO's `store_profile`
-- copy of `template` had the same generated CHECK that still allowed the five retired skins. Same two steps: move a
-- retired value to the template readers already map it to (`normalizeLegacyTemplate`), then refuse retired values with
-- triggers. `store_profile` has no child tables, but triggers keep the two databases on one rule and one shape.
-- Idempotent; the StoreDO records it in `_migrations` as cf-0004_template_current and applies it once.
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
