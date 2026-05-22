-- RLS for 8 tables that were added after the initial RLS migration
-- (20260404000000_add_rls_policies) and missed the policy sweep.
--
-- Surfaced by the 2026-05-22 comprehensive SaaS audit (P1-1):
--   blog_posts, store_faqs, store_howtos, product_faqs,
--   ai_recommendation, bulk_ai_jobs, ai_usage, onesignal_subscriptions
--
-- All 8 are tenant-scoped (have store_id FK) and the application code
-- already filters on storeId — but without DB-level RLS there is no
-- backstop if a future query bug or super_admin route forgets the WHERE.
--
-- Policy shape matches the existing `current_store_id() IS NULL OR
-- store_id = current_store_id()` pattern from the initial migration.
-- The IS NULL branch = "no tenant context set" → allow (super_admin /
-- migrations / Inngest withRlsBypass paths).

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

-- ─── product_faqs ───────────────────────────────────────────────────────
ALTER TABLE product_faqs ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_product_faqs_tenant ON product_faqs
  FOR ALL TO force_app
  USING (current_store_id() IS NULL OR store_id = current_store_id())
  WITH CHECK (current_store_id() IS NULL OR store_id = current_store_id());

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

-- ─── onesignal_subscriptions ───────────────────────────────────────────
ALTER TABLE onesignal_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_onesignal_subscriptions_tenant ON onesignal_subscriptions
  FOR ALL TO force_app
  USING (current_store_id() IS NULL OR store_id = current_store_id())
  WITH CHECK (current_store_id() IS NULL OR store_id = current_store_id());
