-- Versioned publish (builder Phase 3): who made a page revision live.
--   published_by  user id of the publisher/restorer (no FK, like created_by: an erased user must not take a
--                 store's page history with them). Pseudonymised on offboarding (OFFBOARD-1).
-- The name is NOT stored: history looks it up at read time, so an erased user's name cannot linger here.
-- Additive and nullable: existing revisions simply show no publisher. RLS is unchanged (the table's strict
-- store_id policy covers new columns).
-- Rollback: ALTER TABLE "store_page_revisions" DROP COLUMN "published_by";

ALTER TABLE "store_page_revisions" ADD COLUMN "published_by" TEXT;
