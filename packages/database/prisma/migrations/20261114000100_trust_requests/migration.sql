-- SELF-SERVICE trust and support (A13 AUP suspension reason + appeal, A14 in-product support request,
-- A16 protected brand slug claim + daily store-cap request).
--
--   trust_requests  NEW. One row per request a merchant files with Ebda staff, or per suspension reason a super
--                   admin records. kind: support | suspension | suspension_appeal | slug_claim | store_cap.
--                   A merchant can only INSERT 'open' rows of the filing kinds; deciding is a staff action.
--
-- Additive only. FK: store delete CASCADE (no NO ACTION child). store_id is NULL for slug_claim and store_cap
-- (filed before a store exists); those rows are reached through user_id.
-- One open appeal per store, one open slug claim per user + slug, one open cap request per user (partial UNIQUE).
-- Rollback: DROP TABLE trust_requests (docs/ROLLBACK.md); the merchant screens then answer 5xx until reverted.

CREATE TABLE "trust_requests" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "store_id" TEXT,
    "user_id" TEXT,
    "topic" TEXT,
    "message" TEXT,
    "page_url" TEXT,
    "slug" TEXT,
    "evidence_url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trust_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "trust_requests_kind_check" CHECK ("kind" IN ('support', 'suspension', 'suspension_appeal', 'slug_claim', 'store_cap')),
    CONSTRAINT "trust_requests_status_check" CHECK ("status" IN ('open', 'resolved', 'rejected')),
    CONSTRAINT "trust_requests_len_check" CHECK (length(coalesce("message", '')) <= 2000 AND length(coalesce("page_url", '')) <= 500 AND length(coalesce("evidence_url", '')) <= 500)
);

CREATE INDEX "trust_requests_store_id_kind_created_at_idx" ON "trust_requests"("store_id", "kind", "created_at" DESC);
CREATE INDEX "trust_requests_user_id_kind_status_idx" ON "trust_requests"("user_id", "kind", "status");

ALTER TABLE "trust_requests" ADD CONSTRAINT "trust_requests_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "trust_requests_one_open_appeal" ON "trust_requests"("store_id") WHERE "kind" = 'suspension_appeal' AND "status" = 'open';
CREATE UNIQUE INDEX "trust_requests_one_open_slug_claim" ON "trust_requests"("user_id", "slug") WHERE "kind" = 'slug_claim' AND "status" = 'open';
CREATE UNIQUE INDEX "trust_requests_one_open_store_cap" ON "trust_requests"("user_id") WHERE "kind" = 'store_cap' AND "status" = 'open';

-- Strict tenant isolation plus the platform operator, as ONE policy (shape of provider_activation_requests): the
-- store's own rows, the requester's own rows (the pre-store kinds), or any row for an ACTIVE super admin.
-- No contextless allowance: with no GUC set the predicate is false.
ALTER TABLE trust_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE trust_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON trust_requests AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), '') OR user_id = nullif(current_setting('app.current_user_id', true), '') OR public.ebda_is_super_admin())
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), '') OR user_id = nullif(current_setting('app.current_user_id', true), '') OR public.ebda_is_super_admin());
GRANT SELECT, INSERT, UPDATE, DELETE ON trust_requests TO ebda_app;
