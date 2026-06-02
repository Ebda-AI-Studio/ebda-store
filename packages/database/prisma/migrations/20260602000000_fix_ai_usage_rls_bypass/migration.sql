-- Fix RLS bypass for tables added in 20260522000000_rls_for_8_missing_tables.
--
-- Context
-- -------
-- Migration 20260522000000 added RLS policies for ai_usage, bulk_ai_jobs,
-- ai_recommendation, blog_posts, store_faqs, store_howtos, and product_faqs.
-- Those policies used the OLD "escape-hatch" pattern:
--
--   USING (current_store_id() IS NULL OR store_id = current_store_id())
--
-- This pattern relies on `current_store_id()` returning NULL when no tenant
-- GUC is set.  It works for normal super-admin requests but is fragile:
-- if `app.current_store_id` has any session-level value on a reused pooled
-- connection, `current_store_id()` returns that stale value and RLS filters
-- to a single tenant — causing the cross-tenant aggregate to return wrong or
-- empty data (ai-usage/summary dashboard 500 symptom).
--
-- The accounting tables (added May 19–20) used the correct pattern that
-- checks the explicit bypass GUC:
--
--   USING (store_id = current_setting('app.current_store_id', true)
--          OR current_setting('app.bypass_rls', true) = 'true')
--
-- This migration replaces the old policies on the affected tables with the
-- new pattern so withRlsBypass() reliably bypasses them regardless of any
-- stale GUC on the connection.
--
-- ai_usage is the table that drives the super-admin AI usage dashboard.
-- bulk_ai_jobs and ai_recommendation are also cross-tenant-readable by
-- super-admin endpoints.  blog_posts, store_faqs, store_howtos are
-- store-scoped but included for consistency and future-proofing.
--
-- product_faqs uses an EXISTS join (no direct store_id column); its policy
-- already correctly passes through when the parent product passes — kept
-- as-is since adding bypass_rls to the EXISTS path would require an extra
-- sub-select.  Documented here for completeness.
--
-- Idempotent: DROP POLICY IF EXISTS + CREATE POLICY is safe to re-run.

-- ─── ai_usage ───────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS rls_ai_usage_tenant ON ai_usage;
CREATE POLICY rls_ai_usage_tenant ON ai_usage
  FOR ALL TO force_app
  USING (
    store_id = current_setting('app.current_store_id', true)
    OR current_setting('app.bypass_rls', true) = 'true'
  )
  WITH CHECK (
    store_id = current_setting('app.current_store_id', true)
    OR current_setting('app.bypass_rls', true) = 'true'
  );

-- ─── bulk_ai_jobs ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS rls_bulk_ai_jobs_tenant ON bulk_ai_jobs;
CREATE POLICY rls_bulk_ai_jobs_tenant ON bulk_ai_jobs
  FOR ALL TO force_app
  USING (
    store_id = current_setting('app.current_store_id', true)
    OR current_setting('app.bypass_rls', true) = 'true'
  )
  WITH CHECK (
    store_id = current_setting('app.current_store_id', true)
    OR current_setting('app.bypass_rls', true) = 'true'
  );

-- ─── ai_recommendation ──────────────────────────────────────────────────────
DROP POLICY IF EXISTS rls_ai_recommendation_tenant ON ai_recommendation;
CREATE POLICY rls_ai_recommendation_tenant ON ai_recommendation
  FOR ALL TO force_app
  USING (
    store_id = current_setting('app.current_store_id', true)
    OR current_setting('app.bypass_rls', true) = 'true'
  )
  WITH CHECK (
    store_id = current_setting('app.current_store_id', true)
    OR current_setting('app.bypass_rls', true) = 'true'
  );

-- ─── blog_posts ──────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS rls_blog_posts_tenant ON blog_posts;
CREATE POLICY rls_blog_posts_tenant ON blog_posts
  FOR ALL TO force_app
  USING (
    store_id = current_setting('app.current_store_id', true)
    OR current_setting('app.bypass_rls', true) = 'true'
  )
  WITH CHECK (
    store_id = current_setting('app.current_store_id', true)
    OR current_setting('app.bypass_rls', true) = 'true'
  );

-- ─── store_faqs ──────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS rls_store_faqs_tenant ON store_faqs;
CREATE POLICY rls_store_faqs_tenant ON store_faqs
  FOR ALL TO force_app
  USING (
    store_id = current_setting('app.current_store_id', true)
    OR current_setting('app.bypass_rls', true) = 'true'
  )
  WITH CHECK (
    store_id = current_setting('app.current_store_id', true)
    OR current_setting('app.bypass_rls', true) = 'true'
  );

-- ─── store_howtos ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS rls_store_howtos_tenant ON store_howtos;
CREATE POLICY rls_store_howtos_tenant ON store_howtos
  FOR ALL TO force_app
  USING (
    store_id = current_setting('app.current_store_id', true)
    OR current_setting('app.bypass_rls', true) = 'true'
  )
  WITH CHECK (
    store_id = current_setting('app.current_store_id', true)
    OR current_setting('app.bypass_rls', true) = 'true'
  );

-- product_faqs: policy left unchanged (no direct store_id column; uses
-- EXISTS join through products table which already has correct RLS).
