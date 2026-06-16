-- Migration: add_bank_reconciliation
-- Adds BankStatement + BankTransaction models with RLS policies
-- mirroring the existing tenant-table pattern.
-- All money stored as integer fils (1 KWD = 1000 fils).

-- ─── Enums ────────────────────────────────────────────────────────────────────

CREATE TYPE "BankStatementStatus" AS ENUM ('pending', 'reconciling', 'reconciled');
CREATE TYPE "BankTransactionDirection" AS ENUM ('debit', 'credit');
CREATE TYPE "BankMatchStatus" AS ENUM ('unmatched', 'auto_matched', 'manual_matched', 'ignored');

-- ─── bank_statements ──────────────────────────────────────────────────────────

CREATE TABLE "bank_statements" (
  "id"            TEXT          NOT NULL DEFAULT gen_random_uuid()::text,
  "store_id"      TEXT          NOT NULL,
  "gl_account_id" TEXT          NOT NULL,
  "file_name"     TEXT          NOT NULL,
  "imported_at"   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  "period_start"  TIMESTAMPTZ,
  "period_end"    TIMESTAMPTZ,
  "status"        "BankStatementStatus" NOT NULL DEFAULT 'pending',
  "created_at"    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT "bank_statements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bank_statements_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE,
  CONSTRAINT "bank_statements_gl_account_id_fkey"
    FOREIGN KEY ("gl_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT
);

CREATE INDEX "bank_statements_store_id_status_idx"    ON "bank_statements"("store_id", "status");
CREATE INDEX "bank_statements_store_id_imported_at_idx" ON "bank_statements"("store_id", "imported_at" DESC);

-- ─── bank_transactions ────────────────────────────────────────────────────────

CREATE TABLE "bank_transactions" (
  "id"                       TEXT          NOT NULL DEFAULT gen_random_uuid()::text,
  "statement_id"             TEXT          NOT NULL,
  "store_id"                 TEXT          NOT NULL,
  "date"                     TIMESTAMPTZ   NOT NULL,
  "description"              TEXT          NOT NULL,
  "amount_fils"              INTEGER       NOT NULL,
  "direction"                "BankTransactionDirection" NOT NULL,
  "external_ref"             TEXT,
  "row_hash"                 VARCHAR(64)   NOT NULL,
  "matched_journal_entry_id" TEXT,
  "match_status"             "BankMatchStatus" NOT NULL DEFAULT 'unmatched',
  "confidence"               INTEGER       NOT NULL DEFAULT 0,
  "created_at"               TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT "bank_transactions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bank_transactions_statement_id_fkey"
    FOREIGN KEY ("statement_id") REFERENCES "bank_statements"("id") ON DELETE CASCADE,
  CONSTRAINT "bank_transactions_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE,
  CONSTRAINT "bank_transactions_matched_journal_entry_id_fkey"
    FOREIGN KEY ("matched_journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE SET NULL,
  CONSTRAINT "bank_transactions_store_id_row_hash_key" UNIQUE ("store_id", "row_hash")
);

CREATE INDEX "bank_transactions_statement_id_idx"        ON "bank_transactions"("statement_id");
CREATE INDEX "bank_transactions_store_id_match_status_idx" ON "bank_transactions"("store_id", "match_status");
CREATE INDEX "bank_transactions_store_id_date_idx"       ON "bank_transactions"("store_id", "date");

-- ─── RLS policies ─────────────────────────────────────────────────────────────
-- Mirror the pattern from 20260609000000_complete_force_rls_coverage.
-- FWB convention: current_store_id() = NULLIF(current_setting('app.current_store_id',''),'')
-- (set by runInTenantContext); app.bypass_rls='true' set by withRlsBypass. A WRONG
-- GUC name (app.current_client_id) would make the policy always-false → 0 rows.

ALTER TABLE "bank_statements"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bank_statements"   FORCE ROW LEVEL SECURITY;
ALTER TABLE "bank_transactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bank_transactions" FORCE ROW LEVEL SECURITY;

-- bank_statements: tenant can only see their own rows
CREATE POLICY "bank_statements_tenant_isolation" ON "bank_statements"
  FOR ALL TO force_app
  USING (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR store_id::text = current_store_id()
  );

-- bank_transactions: tenant isolation via store_id (also enforced by statement FK)
CREATE POLICY "bank_transactions_tenant_isolation" ON "bank_transactions"
  FOR ALL TO force_app
  USING (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR store_id::text = current_store_id()
  );
