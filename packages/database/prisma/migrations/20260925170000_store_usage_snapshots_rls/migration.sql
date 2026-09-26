-- store_usage_snapshots RLS (#1059, closing the gap Ruling MCP-1 deferred).
--
-- Ruling MCP-1 (docs/RULINGS.md, merchant_api_keys PR) named this table as
-- carrying the same RLS omission as merchant_api_keys, fixed that PR's own
-- table, and explicitly left store_usage_snapshots for "its own change, its
-- own probe, its own rollback" — enabling RLS on a table that already holds
-- production rows is a production action with its own blast radius, and
-- doing it inside an unrelated PR is how a table goes dark on a Friday.
--
-- This IS that dedicated change. Verified before writing it, not assumed:
-- every current reader/writer of store_usage_snapshots already wraps its
-- query in withRlsBypass —
--   - apps/api/src/lib/inngest/functions/store-usage-snapshot.ts:180 (the
--     monthly cron's upsert, inside withRlsBypass — "there is no HTTP tenant
--     GUC on a cron")
--   - apps/api/src/routes/admin.routes.ts:1401 (GET /admin/super-admin/
--     usage-history, "Cross-tenant by nature — withRlsBypass, same as the
--     ai-usage summary")
-- so this migration is enabling a lock that both callers already hold the
-- key to — it changes no runtime behaviour today, and closes the class for
-- whatever reads this table next without remembering to bypass explicitly.
--
-- Same policy shape as merchant_api_keys (20260911190000): store_id is a
-- direct column (not a parent-join like bundle_items/cart_bundles), so this
-- gets 4 explicit policies rather than one FOR ALL, matching that precedent.

ALTER TABLE "store_usage_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "store_usage_snapshots" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "store_usage_snapshots_app_select" ON "store_usage_snapshots";
CREATE POLICY "store_usage_snapshots_app_select" ON "store_usage_snapshots" FOR SELECT
  USING (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());

DROP POLICY IF EXISTS "store_usage_snapshots_app_insert" ON "store_usage_snapshots";
CREATE POLICY "store_usage_snapshots_app_insert" ON "store_usage_snapshots" FOR INSERT
  WITH CHECK (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());

DROP POLICY IF EXISTS "store_usage_snapshots_app_update" ON "store_usage_snapshots";
CREATE POLICY "store_usage_snapshots_app_update" ON "store_usage_snapshots" FOR UPDATE
  USING (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id())
  WITH CHECK (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());

DROP POLICY IF EXISTS "store_usage_snapshots_app_delete" ON "store_usage_snapshots";
CREATE POLICY "store_usage_snapshots_app_delete" ON "store_usage_snapshots" FOR DELETE
  USING (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());
