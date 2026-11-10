-- Hand-written (Ruling SKIN-DEL-9, R20 cleanup). The five retired skins (modern, classic, minimal, bold, elegant) were
-- deleted from the code (SKIN-DEL-8), but D1 still accepted them: 0001's `stores_template_chk` is generated from the
-- Prisma enum, which keeps the old values. This migration
--   (a) moves every store still on a retired skin to the Ebda template it ALREADY renders as. Readers map a retired value
--       through `normalizeLegacyTemplate` (packages/shared/src/templates/legacy-skin-map.ts), so writing that same value
--       changes nothing on screen: modern/minimal -> souq, classic -> dahab, bold/elegant -> qamar. `look` is left as it
--       is (NULL = the template's default look, which is what the mapped read showed). A unit test pins this CASE to
--       `normalizeLegacyTemplate`, so the two cannot drift.
--   (b) refuses a retired (or any unknown) template on every later INSERT and UPDATE, with two triggers.
-- Why triggers and not a rebuilt CHECK: changing a CHECK in SQLite means rebuilding `stores`, and on D1 a rebuild drops
-- the old table. Foreign keys cannot be switched off on D1 (only deferred), and DROP TABLE runs an implicit DELETE whose
-- ON DELETE CASCADE actions still fire: 14 child tables (billing_events, store_subscriptions, store_staff, ...) would lose
-- every row. The triggers enforce the same rule with no table rebuild. 0002_invariants already enforces invariants this
-- way. The old CHECK stays as a looser, harmless superset.
-- Idempotent (UPDATE of nothing, IF NOT EXISTS), applied once by `wrangler d1 migrations apply` (d1_migrations ledger).
UPDATE "stores"
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
