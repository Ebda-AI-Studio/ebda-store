-- Provider activation on request (PROVIDERS-ACTIVATION).
--
--   provider_activation_requests  NEW, store-scoped. A merchant's request to have Ebda switch on a
--                                 payment gateway / shipping carrier the catalog does not list as
--                                 verified. status 'activated' is the per-store override the enable
--                                 gates accept; only a super admin sets it.
--
-- Additive only. FK: store delete CASCADE (no NO ACTION child added).
-- One live request per store + provider: partial UNIQUE (store_id, provider) WHERE status IN
-- ('requested', 'activated'), so a double click is one row and a rejected request can be re-filed.
-- Rollback: DROP TABLE provider_activation_requests (docs/ROLLBACK.md); every store then falls
-- back to the catalog's `verified` flag, i.e. activated providers stop being enable-able.

CREATE TABLE "provider_activation_requests" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "note" TEXT,
    "requested_by_id" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_activation_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "provider_activation_requests_store_id_idx" ON "provider_activation_requests"("store_id");
CREATE INDEX "provider_activation_requests_status_requested_at_idx" ON "provider_activation_requests"("status", "requested_at");

ALTER TABLE "provider_activation_requests" ADD CONSTRAINT "provider_activation_requests_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "provider_activation_requests_one_live" ON "provider_activation_requests"("store_id", "provider") WHERE "status" IN ('requested', 'activated');

ALTER TABLE "provider_activation_requests" ADD CONSTRAINT "provider_activation_requests_status_check" CHECK ("status" IN ('requested', 'activated', 'rejected'));

-- Strict tenant isolation (R-EBDA-001) plus the platform operator, as ONE policy: the store's own
-- rows, or any row for an ACTIVE super admin (ebda_is_super_admin() reads app.current_user_id and
-- checks users.role in the same transaction). No contextless allowance: with neither GUC set the
-- predicate is false.
ALTER TABLE provider_activation_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_activation_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON provider_activation_requests AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), '') OR public.ebda_is_super_admin())
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), '') OR public.ebda_is_super_admin());
