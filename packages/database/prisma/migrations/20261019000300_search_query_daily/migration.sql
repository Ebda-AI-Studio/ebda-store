-- First-party storefront search log (search program P0, Task 5; Ruling SEARCH-4).
--
--   search_query_daily   NEW, store-scoped. One row per (store, Cairo day, NORMALISED term): a
--                        counter, not an event log. No user id, session id, IP or user agent is
--                        stored; phone / email / national-id / order-number / id / link shaped
--                        terms are dropped before insert (apps/api/src/services/search-log.service.ts).
--                        At most 1000 distinct terms per store per day (bloat cap, same file).
--                        updated_at is DAY granularity (midnight of the Cairo day last counted):
--                        no exact search time is kept (Ruling SEARCH-T5-6). Free-text terms can
--                        still contain a typed name/place; never linked to a user/session/IP/order.
--
-- Viewer: admin /stores/[id]/insights/searches + the analytics "searches with no results" card.
-- Retention: 90 days (Inngest search-log-purge-daily). Store delete CASCADEs (FK below); no
-- NO ACTION child is added. Customer erasure: nothing to remove (no identity).
-- Lock note: new empty table, additive only; no lock on any existing table beyond the FK's
-- brief SHARE ROW EXCLUSIVE on "stores" while the constraint is added.
-- Rollback: rollback.sql (DROP TABLE search_query_daily; loses only the search counters).

-- CreateTable
CREATE TABLE "search_query_daily" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "term" VARCHAR(100) NOT NULL,
    "searches" INTEGER NOT NULL DEFAULT 0,
    "zero_results" INTEGER NOT NULL DEFAULT 0,
    "last_result_count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_DATE,

    CONSTRAINT "search_query_daily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "search_query_daily_store_id_date_term_key" ON "search_query_daily"("store_id", "date", "term");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "search_query_daily_store_id_date_idx" ON "search_query_daily"("store_id", "date" DESC);

-- AddForeignKey
ALTER TABLE "search_query_daily" ADD CONSTRAINT "search_query_daily_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Strict tenant isolation (R-EBDA-001): the same single policy every store_id table carries.
ALTER TABLE search_query_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_query_daily FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON search_query_daily AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
GRANT SELECT, INSERT, UPDATE, DELETE ON search_query_daily TO ebda_app;
