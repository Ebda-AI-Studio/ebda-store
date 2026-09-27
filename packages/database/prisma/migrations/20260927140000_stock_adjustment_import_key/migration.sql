-- Migration: stock_adjustment_import_key
--
-- Idempotency key for the CSV bulk stock-adjustment import (#226).
--
-- POST /stores/:storeId/stock-adjustments/csv-import creates AND posts an
-- adjustment in one request: inventory writes plus a GL journal, neither of
-- which is reversible. A double-click or a network retry therefore created a
-- second adjustment, and in delta mode the second one re-resolved "current
-- stock" after the first had already moved it, applying the delta twice.
--
-- The admin client now sends one key per file it loads; the route stores it
-- here and a repeat of the same key replays the first result instead of
-- importing again. A deliberate re-import of the same file after a success
-- gets a new key, so repeating a real count is still possible.
--
-- ADDITIVE AND NULLABLE. Every existing row gets NULL and there is no
-- backfill. Postgres treats NULLs as distinct in a unique index, so the manual
-- (key-less) adjustments and every historical row never collide; only two rows
-- carrying the SAME non-null key in the same store do, which is the point: the
-- second concurrent request's INSERT blocks on the first and then fails with a
-- unique violation the route turns into a replay.
--
-- RLS: none needed — a column on stock_adjustments inherits its existing
-- store-scoped policies.

ALTER TABLE "stock_adjustments" ADD COLUMN "import_key" VARCHAR(64);

CREATE UNIQUE INDEX "stock_adjustments_store_id_import_key_key"
  ON "stock_adjustments"("store_id", "import_key");
