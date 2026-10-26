-- Versioned publish (builder Phase 3): who made a page revision live, and when.
--   published_by       user id of the publisher/restorer (no FK, like created_by: an erased user must not
--                      take a store's page history with them)
--   published_by_name  name snapshot at publish time (history needs no cross-user read); merchant PII,
--                      pseudonymised with the user on offboarding (OFFBOARD-1)
-- Additive and nullable: existing revisions simply show no publisher. RLS is unchanged (the table's
-- strict store_id policy covers new columns).
-- Rollback: ALTER TABLE "store_page_revisions" DROP COLUMN "published_by", DROP COLUMN "published_by_name";

ALTER TABLE "store_page_revisions"
  ADD COLUMN "published_by" TEXT,
  ADD COLUMN "published_by_name" TEXT;
