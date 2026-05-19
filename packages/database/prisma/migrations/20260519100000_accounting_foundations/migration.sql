-- Accounting Batch 1: foundations
-- Pure hand-written: 3 enums, 4 new tables, 3 Store columns, CHECK constraints,
-- deferred DR=CR trigger, RLS policies. No diff cruft.

-- ============================================================================
-- New enums
-- ============================================================================

CREATE TYPE "AccountType" AS ENUM ('asset', 'liability', 'equity', 'revenue', 'expense');

CREATE TYPE "JournalEntrySource" AS ENUM (
  'order', 'refund', 'purchase_order', 'expense', 'stock_adjustment',
  'manual', 'period_close', 'opening_balance'
);

CREATE TYPE "JournalEntryStatus" AS ENUM ('posted', 'reversed', 'draft');

-- ============================================================================
-- Store accounting columns
-- ============================================================================

ALTER TABLE "stores"
  ADD COLUMN IF NOT EXISTS "accounting_enabled"      BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "default_tax_rate_bps"    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "fiscal_year_start_month" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "stores"
  ADD CONSTRAINT "stores_fiscal_year_start_month_range"
  CHECK (fiscal_year_start_month BETWEEN 1 AND 12);

-- ============================================================================
-- sequences
-- ============================================================================

CREATE TABLE "sequences" (
  "store_id"   TEXT         NOT NULL,
  "kind"       TEXT         NOT NULL,
  "next"       INTEGER      NOT NULL DEFAULT 1,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sequences_pkey" PRIMARY KEY ("store_id","kind"),
  CONSTRAINT "sequences_store_id_fkey" FOREIGN KEY ("store_id")
    REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- ============================================================================
-- accounts
-- ============================================================================

CREATE TABLE "accounts" (
  "id"         TEXT          NOT NULL,
  "store_id"   TEXT          NOT NULL,
  "code"       TEXT          NOT NULL,
  "name_en"    TEXT          NOT NULL,
  "name_ar"    TEXT,
  "type"       "AccountType" NOT NULL,
  "parent_id"  TEXT,
  "is_system"  BOOLEAN       NOT NULL DEFAULT false,
  "is_active"  BOOLEAN       NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3)  NOT NULL,
  CONSTRAINT "accounts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "accounts_store_id_fkey"  FOREIGN KEY ("store_id")
    REFERENCES "stores"("id")  ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "accounts_parent_id_fkey" FOREIGN KEY ("parent_id")
    REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "accounts_store_id_code_key" ON "accounts"("store_id","code");
CREATE INDEX        "accounts_store_id_type_idx" ON "accounts"("store_id","type");

-- ============================================================================
-- journal_entries
-- ============================================================================

CREATE TABLE "journal_entries" (
  "id"             TEXT                  NOT NULL,
  "store_id"       TEXT                  NOT NULL,
  "entry_number"   TEXT                  NOT NULL,
  "posted_at"      TIMESTAMP(3)          NOT NULL,
  "source"         "JournalEntrySource"  NOT NULL,
  "source_id"      TEXT,
  "reversed_by_id" TEXT,
  "memo"           TEXT,
  "memo_ar"        TEXT,
  "status"         "JournalEntryStatus"  NOT NULL DEFAULT 'posted',
  "posted_by"      TEXT,
  "created_at"     TIMESTAMP(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "journal_entries_store_id_fkey" FOREIGN KEY ("store_id")
    REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "journal_entries_reversed_by_id_fkey" FOREIGN KEY ("reversed_by_id")
    REFERENCES "journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "journal_entries_reversed_by_id_key" ON "journal_entries"("reversed_by_id");
CREATE UNIQUE INDEX "journal_entries_store_id_entry_number_key"
  ON "journal_entries"("store_id","entry_number");
CREATE INDEX        "journal_entries_store_id_posted_at_idx"
  ON "journal_entries"("store_id","posted_at" DESC);
CREATE INDEX        "journal_entries_source_source_id_idx"
  ON "journal_entries"("source","source_id");
CREATE INDEX        "journal_entries_store_id_status_idx"
  ON "journal_entries"("store_id","status");

-- ============================================================================
-- journal_lines
-- ============================================================================

CREATE TABLE "journal_lines" (
  "id"           TEXT         NOT NULL,
  "entry_id"     TEXT         NOT NULL,
  "account_id"   TEXT         NOT NULL,
  "debit"        INTEGER      NOT NULL DEFAULT 0,
  "credit"       INTEGER      NOT NULL DEFAULT 0,
  "currency"     TEXT         NOT NULL DEFAULT 'KWD',
  "line_memo"    TEXT,
  "line_memo_ar" TEXT,
  "ref_table"    TEXT,
  "ref_id"       TEXT,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "journal_lines_entry_id_fkey" FOREIGN KEY ("entry_id")
    REFERENCES "journal_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "journal_lines_account_id_fkey" FOREIGN KEY ("account_id")
    REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "journal_lines_debit_credit_nonneg"
    CHECK (debit >= 0 AND credit >= 0),
  CONSTRAINT "journal_lines_debit_xor_credit"
    CHECK ((debit = 0 AND credit > 0) OR (debit > 0 AND credit = 0))
);

CREATE INDEX "journal_lines_entry_id_idx"            ON "journal_lines"("entry_id");
CREATE INDEX "journal_lines_account_id_idx"          ON "journal_lines"("account_id");
CREATE INDEX "journal_lines_ref_table_ref_id_idx"    ON "journal_lines"("ref_table","ref_id");

-- ============================================================================
-- Deferred constraint trigger enforcing sum(DR) = sum(CR) per entry
-- ============================================================================

CREATE OR REPLACE FUNCTION journal_entry_dr_cr_balance_check() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  total_debit BIGINT;
  total_credit BIGINT;
BEGIN
  SELECT
    COALESCE(SUM(debit), 0),
    COALESCE(SUM(credit), 0)
  INTO total_debit, total_credit
  FROM journal_lines
  WHERE entry_id = NEW.id;

  IF total_debit <> total_credit THEN
    RAISE EXCEPTION 'Journal entry % is unbalanced: DR=% CR=%',
      NEW.id, total_debit, total_credit;
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER journal_entry_balanced
  AFTER INSERT OR UPDATE ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION journal_entry_dr_cr_balance_check();

-- ============================================================================
-- RLS policies — matches existing FWB tenant-context pattern
-- (runInTenantContext sets app.current_store_id GUC per request)
-- ============================================================================

ALTER TABLE "accounts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY accounts_tenant_isolation ON "accounts"
  USING (
    store_id::text = current_setting('app.current_store_id', true)
    OR current_setting('app.bypass_rls', true) = 'true'
  );

ALTER TABLE "journal_entries" ENABLE ROW LEVEL SECURITY;
CREATE POLICY journal_entries_tenant_isolation ON "journal_entries"
  USING (
    store_id::text = current_setting('app.current_store_id', true)
    OR current_setting('app.bypass_rls', true) = 'true'
  );

ALTER TABLE "journal_lines" ENABLE ROW LEVEL SECURITY;
CREATE POLICY journal_lines_tenant_isolation ON "journal_lines"
  USING (
    EXISTS (
      SELECT 1 FROM journal_entries e
      WHERE e.id = journal_lines.entry_id
        AND (
          e.store_id::text = current_setting('app.current_store_id', true)
          OR current_setting('app.bypass_rls', true) = 'true'
        )
    )
  );

ALTER TABLE "sequences" ENABLE ROW LEVEL SECURITY;
CREATE POLICY sequences_tenant_isolation ON "sequences"
  USING (
    store_id::text = current_setting('app.current_store_id', true)
    OR current_setting('app.bypass_rls', true) = 'true'
  );
