-- Per-store, per-device credential for the MERCHANT-ADMIN MCP surface.
-- Distinct from stores.agent_api_key (the BUYER surface's single per-store key):
-- hashed rather than encrypted, many-per-store, attributable to a user, scoped.

CREATE TABLE "merchant_api_keys" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "scopes" TEXT[],
    "last_used_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchant_api_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "merchant_api_keys_key_hash_key" ON "merchant_api_keys"("key_hash");
CREATE INDEX "merchant_api_keys_store_id_revoked_at_idx" ON "merchant_api_keys"("store_id", "revoked_at");
-- FK-only index so the User delete RI check does not sequential-scan.
CREATE INDEX "merchant_api_keys_user_id_idx" ON "merchant_api_keys"("user_id");

ALTER TABLE "merchant_api_keys" ADD CONSTRAINT "merchant_api_keys_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "merchant_api_keys" ADD CONSTRAINT "merchant_api_keys_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security, matching 20260906120000_product_bundles.
--
-- Every tenant table carries this. Today it is inert (production connects as a
-- BYPASSRLS role), so the risk this closes is the RLS cutover: a later sweep
-- that enables RLS with the deny-all default from 20260702170000 would leave
-- this table policy-less and take the whole merchant MCP surface dark for
-- every valid key.
--
-- The credential-resolution read is the sharp edge. `verifyMerchantKey` looks a
-- key up BEFORE any store is known — that lookup is what determines the tenant
-- — so it cannot set `app.current_store_id` first and runs under
-- `withRlsBypass`, the same category as `requireStoreAccess`'s staff lookup.
ALTER TABLE "merchant_api_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "merchant_api_keys" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "merchant_api_keys_app_select" ON "merchant_api_keys";
CREATE POLICY "merchant_api_keys_app_select" ON "merchant_api_keys" FOR SELECT
  USING (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());

DROP POLICY IF EXISTS "merchant_api_keys_app_insert" ON "merchant_api_keys";
CREATE POLICY "merchant_api_keys_app_insert" ON "merchant_api_keys" FOR INSERT
  WITH CHECK (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());

DROP POLICY IF EXISTS "merchant_api_keys_app_update" ON "merchant_api_keys";
CREATE POLICY "merchant_api_keys_app_update" ON "merchant_api_keys" FOR UPDATE
  USING (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id())
  WITH CHECK (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());

DROP POLICY IF EXISTS "merchant_api_keys_app_delete" ON "merchant_api_keys";
CREATE POLICY "merchant_api_keys_app_delete" ON "merchant_api_keys" FOR DELETE
  USING (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());
