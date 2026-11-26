-- Hand-written (Ruling AI-OVERSELL-1). manual_payment_claims.status gains 'reserved': an InstaPay AI-pack reservation
-- (reference issued, no receipt yet). SQLite cannot alter a CHECK, so the table is rebuilt for a D1 that already ran
-- 0001 (a fresh D1 gets the new CHECK from the regenerated 0001_init.sql).
-- Rebuild rules: the new table is the PRODUCTION definition read from sqlite_master on 2026-11-17 (only the status CHECK
-- changes); rows are copied with an explicit column list; every index the table had is recreated (the unique
-- method+payer_reference key, store_id+created_at DESC, status). The table has no triggers and no table references it
-- (sqlite_master checked on production, 2026-11-17). Its own FK to stores is kept.
-- ROLLBACK: D1 Time Travel to the bookmark recorded right before this migration is applied (see the PR body).
PRAGMA defer_foreign_keys = true;

CREATE TABLE "manual_payment_claims__new" (
  "id" TEXT NOT NULL,
  "store_id" TEXT NOT NULL,
  "subscription_id" TEXT,
  "plan_code" TEXT NOT NULL,
  "billing_interval" TEXT NOT NULL,
  "amount_minor" INTEGER NOT NULL,
  "method" TEXT NOT NULL DEFAULT 'instapay',
  "payment_reference" TEXT NOT NULL,
  "payer_reference" TEXT NOT NULL,
  "proof_url" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "review_note" TEXT,
  "reviewed_by" TEXT,
  "reviewed_at" INTEGER,
  "billing_event_id" TEXT,
  "created_at" INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  "updated_at" INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  CONSTRAINT "manual_payment_claims_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "manual_payment_claims_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "manual_payment_claims_amount_check" CHECK ("amount_minor" > 0),
  CONSTRAINT "manual_payment_claims_status_check" CHECK ("status" IN ('pending', 'confirmed', 'rejected', 'reserved')),
  CONSTRAINT "manual_payment_claims_method_check" CHECK ("method" IN ('instapay', 'bank', 'cash'))
);

INSERT INTO "manual_payment_claims__new" ("id", "store_id", "subscription_id", "plan_code", "billing_interval", "amount_minor", "method", "payment_reference", "payer_reference", "proof_url", "status", "review_note", "reviewed_by", "reviewed_at", "billing_event_id", "created_at", "updated_at")
SELECT "id", "store_id", "subscription_id", "plan_code", "billing_interval", "amount_minor", "method", "payment_reference", "payer_reference", "proof_url", "status", "review_note", "reviewed_by", "reviewed_at", "billing_event_id", "created_at", "updated_at"
FROM "manual_payment_claims";

DROP TABLE "manual_payment_claims";
ALTER TABLE "manual_payment_claims__new" RENAME TO "manual_payment_claims";

CREATE UNIQUE INDEX "manual_payment_claims_method_payer_reference_key" ON "manual_payment_claims" ("method", "payer_reference");
CREATE INDEX "manual_payment_claims_store_id_created_at_idx" ON "manual_payment_claims" ("store_id", "created_at" DESC);
CREATE INDEX "manual_payment_claims_status_idx" ON "manual_payment_claims" ("status");
