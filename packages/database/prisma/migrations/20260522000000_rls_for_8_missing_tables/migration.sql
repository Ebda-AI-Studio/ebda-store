-- RLS for tables that were added after the initial RLS migration
-- (20260404000000_add_rls_policies) and missed the policy sweep.
--
-- Surfaced by the 2026-05-22 comprehensive SaaS audit (P1-1).
--
-- Original audit listed 8 tables. Two corrections after schema inspection:
--   - product_faqs is scoped through product_id → product.store_id (no
--     direct store_id column). Policy uses EXISTS join to Product.
--   - onesignal_subscriptions is USER-scoped (user_id → User), not
--     store-scoped. Each user manages their own push subscriptions
--     across whichever store they're authenticated to. Tenant
--     isolation here happens at the user-auth layer, not the store
--     boundary. EXCLUDED from this migration.
--
-- The 6 directly-tenant-scoped tables follow the standard policy
-- pattern from the initial RLS migration: current_store_id() IS NULL
-- OR store_id = current_store_id(). The IS NULL branch = "no tenant
-- context set" → allow (super_admin / migrations / withRlsBypass).

-- ─── blog_posts ─────────────────────────────────────────────────────────
ALTER TABLE blog_posts ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_blog_posts_tenant ON blog_posts
  FOR ALL TO force_app
  USING (current_store_id() IS NULL OR store_id = current_store_id())
  WITH CHECK (current_store_id() IS NULL OR store_id = current_store_id());

-- ─── store_faqs ─────────────────────────────────────────────────────────
ALTER TABLE store_faqs ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_store_faqs_tenant ON store_faqs
  FOR ALL TO force_app
  USING (current_store_id() IS NULL OR store_id = current_store_id())
  WITH CHECK (current_store_id() IS NULL OR store_id = current_store_id());

-- ─── store_howtos ───────────────────────────────────────────────────────
ALTER TABLE store_howtos ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_store_howtos_tenant ON store_howtos
  FOR ALL TO force_app
  USING (current_store_id() IS NULL OR store_id = current_store_id())
  WITH CHECK (current_store_id() IS NULL OR store_id = current_store_id());

-- ─── product_faqs (transitive store via products.product_id) ───────────
-- product_faqs has no direct store_id; tenant link goes through the
-- product foreign key. Policy uses EXISTS to verify the parent product
-- belongs to the current tenant context. SELECT-only access to products
-- here is implicit via the same RLS context; the cross-table lookup is
-- bounded (one row per row being read).
ALTER TABLE product_faqs ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_product_faqs_tenant ON product_faqs
  FOR ALL TO force_app
  USING (
    current_store_id() IS NULL OR EXISTS (
      SELECT 1 FROM products p
      WHERE p.id = product_faqs.product_id
        AND p.store_id = current_store_id()
    )
  )
  WITH CHECK (
    current_store_id() IS NULL OR EXISTS (
      SELECT 1 FROM products p
      WHERE p.id = product_faqs.product_id
        AND p.store_id = current_store_id()
    )
  );

-- ─── ai_recommendation ──────────────────────────────────────────────────
ALTER TABLE ai_recommendation ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_ai_recommendation_tenant ON ai_recommendation
  FOR ALL TO force_app
  USING (current_store_id() IS NULL OR store_id = current_store_id())
  WITH CHECK (current_store_id() IS NULL OR store_id = current_store_id());

-- ─── bulk_ai_jobs ───────────────────────────────────────────────────────
ALTER TABLE bulk_ai_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_bulk_ai_jobs_tenant ON bulk_ai_jobs
  FOR ALL TO force_app
  USING (current_store_id() IS NULL OR store_id = current_store_id())
  WITH CHECK (current_store_id() IS NULL OR store_id = current_store_id());

-- ─── ai_usage ───────────────────────────────────────────────────────────
ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_ai_usage_tenant ON ai_usage
  FOR ALL TO force_app
  USING (current_store_id() IS NULL OR store_id = current_store_id())
  WITH CHECK (current_store_id() IS NULL OR store_id = current_store_id());
