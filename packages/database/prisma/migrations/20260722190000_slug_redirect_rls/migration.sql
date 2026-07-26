-- SlugRedirect tenant isolation — mirror the standard tenant-table RLS pattern
-- (ENABLE + FORCE + hybrid policy TO force_app). The `current_store_id() IS NULL`
-- branch keeps system paths working:
--   - category/blog slug-redirect capture runs inside the request's ambient
--     tenant transaction (set up by the `tenantContext` middleware's
--     runInTenantContext), so store_id = current_store_id() and RLS is
--     enforced for those writes;
--   - product capture (prisma.$transaction) and bulk-import capture
--     (withMoneyTx) run context-free, per the repo's pre-existing write
--     pattern for those paths — for them the `current_store_id() IS NULL`
--     branch applies, and isolation is guaranteed instead by the composite
--     key (storeId, entityType, fromSlug) scoping every read/write;
--   - the public redirect resolver reads context-free (no tenant context set).
-- Matches rls_products_tenant exactly.

ALTER TABLE "SlugRedirect" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SlugRedirect" FORCE ROW LEVEL SECURITY;

CREATE POLICY "rls_slug_redirect_tenant" ON "SlugRedirect"
  FOR ALL TO force_app
  USING (current_store_id() IS NULL OR "storeId" = current_store_id())
  WITH CHECK (current_store_id() IS NULL OR "storeId" = current_store_id());
