-- Hand-written (Ruling BILL-NOTICE-1, S2-13). Grace-period notice stages share billing_reminders as one row per stage:
-- `grace_start` (InstaPay payment went overdue), `grace_d1` (one day before the pause), and `suspended` (already allowed).
-- 0001's `billing_reminders_kind_check` only allowed d7/d3/d1/d0/suspended, so claiming `grace_start` inside the past_due
-- transaction violated the CHECK and ROLLED THE TRANSITION BACK (no suspension). SQLite cannot ALTER a CHECK: rebuild.
-- Safe on D1: billing_reminders is a LEAF (nothing references it; its only FK points at stores), so the DROP's implicit
-- DELETE cascades to no child. Idempotent: the scratch table is IF NOT EXISTS, rows are INSERT OR IGNORE, and a re-run
-- just rebuilds the same table.
CREATE TABLE IF NOT EXISTS "billing_reminders_new" (
  "id" TEXT NOT NULL,
  "store_id" TEXT NOT NULL,
  "subscription_id" TEXT NOT NULL,
  "due_at" INTEGER NOT NULL,
  "kind" TEXT NOT NULL,
  "created_at" INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  CONSTRAINT "billing_reminders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_reminders_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "billing_reminders_kind_check" CHECK ("kind" IN ('d7', 'd3', 'd1', 'd0', 'suspended', 'grace_start', 'grace_d1'))
);
INSERT OR IGNORE INTO "billing_reminders_new" ("id", "store_id", "subscription_id", "due_at", "kind", "created_at")
  SELECT "id", "store_id", "subscription_id", "due_at", "kind", "created_at" FROM "billing_reminders";
DROP TABLE "billing_reminders";
ALTER TABLE "billing_reminders_new" RENAME TO "billing_reminders";
CREATE UNIQUE INDEX IF NOT EXISTS "billing_reminders_subscription_id_due_at_kind_key" ON "billing_reminders" ("subscription_id", "due_at", "kind");
CREATE INDEX IF NOT EXISTS "billing_reminders_store_id_idx" ON "billing_reminders" ("store_id");
