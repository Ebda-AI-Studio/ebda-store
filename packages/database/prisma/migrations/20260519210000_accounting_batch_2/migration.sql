-- Accounting Batch 2: stock + backorders + expenses
-- Pure hand-written: 5 new enums, 8 new tables, 5 column extensions
-- across Product/ProductVariant/OrderItem/Store, CHECK constraints, RLS
-- policies. No prisma-diff cruft.

-- ============================================================================
-- New enums
-- ============================================================================

CREATE TYPE "SupplierPaymentTerms" AS ENUM ('net0','net15','net30','net60','custom');

CREATE TYPE "PurchaseOrderStatus" AS ENUM ('draft','sent','partial','received','cancelled');

CREATE TYPE "StockAdjustmentType" AS ENUM ('cycle_count','damage','theft','loss','write_off','found','return_to_supplier');

CREATE TYPE "StockAdjustmentStatus" AS ENUM ('draft','posted');

CREATE TYPE "ExpenseStatus" AS ENUM ('draft','pending','approved','posted','rejected');

-- ============================================================================
-- Extensions on existing tables
-- ============================================================================

ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "allow_backorder" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "last_cost_update_at" TIMESTAMP(3);

ALTER TABLE "product_variants"
  ADD COLUMN IF NOT EXISTS "allow_backorder" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "order_items"
  ADD COLUMN IF NOT EXISTS "cost_price_deferred" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "stores"
  ADD COLUMN IF NOT EXISTS "expense_two_step_approval" BOOLEAN NOT NULL DEFAULT false;

-- ============================================================================
-- suppliers
-- ============================================================================

CREATE TABLE "suppliers" (
  "id"                  TEXT                   NOT NULL,
  "store_id"            TEXT                   NOT NULL,
  "name"                TEXT                   NOT NULL,
  "name_ar"             TEXT,
  "contact_name"        TEXT,
  "phone"               TEXT,
  "email"               TEXT,
  "address"             JSONB,
  "payment_terms"       "SupplierPaymentTerms" NOT NULL DEFAULT 'net0',
  "custom_terms_days"   INTEGER,
  "default_currency"    TEXT                   NOT NULL DEFAULT 'KWD',
  "ap_balance_cached"   INTEGER                NOT NULL DEFAULT 0,
  "is_active"           BOOLEAN                NOT NULL DEFAULT true,
  "notes"               TEXT,
  "notes_ar"            TEXT,
  "created_at"          TIMESTAMP(3)           NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMP(3)           NOT NULL,
  "deleted_at"          TIMESTAMP(3),
  CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "suppliers_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "suppliers_store_id_idx"           ON "suppliers"("store_id");
CREATE INDEX "suppliers_store_id_is_active_idx" ON "suppliers"("store_id","is_active");

-- ============================================================================
-- purchase_orders
-- ============================================================================

CREATE TABLE "purchase_orders" (
  "id"               TEXT                  NOT NULL,
  "store_id"         TEXT                  NOT NULL,
  "supplier_id"      TEXT                  NOT NULL,
  "po_number"        TEXT                  NOT NULL,
  "status"           "PurchaseOrderStatus" NOT NULL DEFAULT 'draft',
  "expected_date"    TIMESTAMP(3),
  "received_at"      TIMESTAMP(3),
  "subtotal"         INTEGER               NOT NULL DEFAULT 0,
  "tax_amount"       INTEGER               NOT NULL DEFAULT 0,
  "shipping_cost"    INTEGER               NOT NULL DEFAULT 0,
  "total"            INTEGER               NOT NULL DEFAULT 0,
  "currency"         TEXT                  NOT NULL DEFAULT 'KWD',
  "ap_account_id"    TEXT,
  "journal_entry_id" TEXT,
  "notes"            TEXT,
  "notes_ar"         TEXT,
  "created_by"       TEXT,
  "received_by"      TEXT,
  "created_at"       TIMESTAMP(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3)          NOT NULL,
  CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "purchase_orders_store_id_fkey"    FOREIGN KEY ("store_id")    REFERENCES "stores"("id")    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "purchase_orders_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "purchase_orders_ap_account_id_fkey" FOREIGN KEY ("ap_account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "purchase_orders_journal_entry_id_key"     ON "purchase_orders"("journal_entry_id");
CREATE UNIQUE INDEX "purchase_orders_store_id_po_number_key"   ON "purchase_orders"("store_id","po_number");
CREATE INDEX        "purchase_orders_store_id_status_idx"      ON "purchase_orders"("store_id","status");
CREATE INDEX        "purchase_orders_supplier_id_idx"          ON "purchase_orders"("supplier_id");
CREATE INDEX        "purchase_orders_store_id_created_at_idx"  ON "purchase_orders"("store_id","created_at" DESC);

-- ============================================================================
-- purchase_order_items
-- ============================================================================

CREATE TABLE "purchase_order_items" (
  "id"           TEXT         NOT NULL,
  "po_id"        TEXT         NOT NULL,
  "product_id"   TEXT         NOT NULL,
  "variant_id"   TEXT,
  "qty"          INTEGER      NOT NULL,
  "qty_received" INTEGER      NOT NULL DEFAULT 0,
  "unit_cost"    INTEGER      NOT NULL,
  "total"        INTEGER      NOT NULL,
  "notes"        TEXT,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "purchase_order_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "purchase_order_items_po_id_fkey"      FOREIGN KEY ("po_id")      REFERENCES "purchase_orders"("id")  ON DELETE CASCADE  ON UPDATE CASCADE,
  CONSTRAINT "purchase_order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id")         ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "purchase_order_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "purchase_order_items_qty_received_range" CHECK (qty_received >= 0 AND qty_received <= qty),
  CONSTRAINT "purchase_order_items_qty_positive" CHECK (qty > 0),
  CONSTRAINT "purchase_order_items_unit_cost_nonneg" CHECK (unit_cost >= 0)
);

CREATE INDEX "purchase_order_items_po_id_idx"      ON "purchase_order_items"("po_id");
CREATE INDEX "purchase_order_items_product_id_idx" ON "purchase_order_items"("product_id");

-- ============================================================================
-- stock_adjustments + items
-- ============================================================================

CREATE TABLE "stock_adjustments" (
  "id"                  TEXT                    NOT NULL,
  "store_id"            TEXT                    NOT NULL,
  "adjustment_number"   TEXT                    NOT NULL,
  "type"                "StockAdjustmentType"   NOT NULL,
  "status"              "StockAdjustmentStatus" NOT NULL DEFAULT 'draft',
  "reason"              TEXT,
  "reason_ar"           TEXT,
  "evidence_url"        TEXT,
  "total_value_impact"  INTEGER                 NOT NULL DEFAULT 0,
  "posted_at"           TIMESTAMP(3),
  "posted_by"           TEXT,
  "journal_entry_id"    TEXT,
  "created_by"          TEXT,
  "created_at"          TIMESTAMP(3)            NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMP(3)            NOT NULL,
  CONSTRAINT "stock_adjustments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "stock_adjustments_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "stock_adjustments_journal_entry_id_key"          ON "stock_adjustments"("journal_entry_id");
CREATE UNIQUE INDEX "stock_adjustments_store_id_adjustment_number_key" ON "stock_adjustments"("store_id","adjustment_number");
CREATE INDEX        "stock_adjustments_store_id_status_idx"            ON "stock_adjustments"("store_id","status");
CREATE INDEX        "stock_adjustments_store_id_posted_at_idx"         ON "stock_adjustments"("store_id","posted_at" DESC);

CREATE TABLE "stock_adjustment_items" (
  "id"            TEXT         NOT NULL,
  "adjustment_id" TEXT         NOT NULL,
  "product_id"    TEXT         NOT NULL,
  "variant_id"    TEXT,
  "previous_qty"  INTEGER      NOT NULL,
  "new_qty"       INTEGER      NOT NULL,
  "delta_qty"     INTEGER      NOT NULL,
  "unit_cost"     INTEGER      NOT NULL,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stock_adjustment_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "stock_adjustment_items_adjustment_id_fkey" FOREIGN KEY ("adjustment_id") REFERENCES "stock_adjustments"("id") ON DELETE CASCADE  ON UPDATE CASCADE,
  CONSTRAINT "stock_adjustment_items_product_id_fkey"    FOREIGN KEY ("product_id")    REFERENCES "products"("id")         ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "stock_adjustment_items_variant_id_fkey"    FOREIGN KEY ("variant_id")    REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "stock_adjustment_items_delta_matches_qty"  CHECK (delta_qty = new_qty - previous_qty)
);

CREATE INDEX "stock_adjustment_items_adjustment_id_idx" ON "stock_adjustment_items"("adjustment_id");
CREATE INDEX "stock_adjustment_items_product_id_idx"    ON "stock_adjustment_items"("product_id");

-- ============================================================================
-- reorder_rules
-- ============================================================================

CREATE TABLE "reorder_rules" (
  "id"                    TEXT         NOT NULL,
  "store_id"              TEXT         NOT NULL,
  "product_id"            TEXT         NOT NULL,
  "variant_id"            TEXT,
  "min_qty"               INTEGER      NOT NULL,
  "reorder_qty"           INTEGER      NOT NULL,
  "lead_time_days"        INTEGER      NOT NULL DEFAULT 7,
  "safety_stock_days"     INTEGER      NOT NULL DEFAULT 7,
  "preferred_supplier_id" TEXT,
  "is_active"             BOOLEAN      NOT NULL DEFAULT true,
  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMP(3) NOT NULL,
  CONSTRAINT "reorder_rules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "reorder_rules_store_id_fkey"   FOREIGN KEY ("store_id")   REFERENCES "stores"("id")           ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "reorder_rules_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id")         ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "reorder_rules_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "reorder_rules_preferred_supplier_id_fkey" FOREIGN KEY ("preferred_supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "reorder_rules_store_product_variant_key" ON "reorder_rules"("store_id","product_id","variant_id");
CREATE INDEX        "reorder_rules_store_id_idx"              ON "reorder_rules"("store_id");

-- ============================================================================
-- backorder_lines
-- ============================================================================

CREATE TABLE "backorder_lines" (
  "id"                     TEXT         NOT NULL,
  "store_id"               TEXT         NOT NULL,
  "order_item_id"          TEXT         NOT NULL,
  "product_id"             TEXT         NOT NULL,
  "variant_id"             TEXT,
  "qty"                    INTEGER      NOT NULL,
  "qty_fulfilled"          INTEGER      NOT NULL DEFAULT 0,
  "fulfilled_by_po_item_id" TEXT,
  "fulfilled_at"           TIMESTAMP(3),
  "cancelled_at"           TIMESTAMP(3),
  "cancelled_reason"       TEXT,
  "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "backorder_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "backorder_lines_store_id_fkey"      FOREIGN KEY ("store_id")      REFERENCES "stores"("id")               ON DELETE CASCADE  ON UPDATE CASCADE,
  CONSTRAINT "backorder_lines_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id")          ON DELETE CASCADE  ON UPDATE CASCADE,
  CONSTRAINT "backorder_lines_product_id_fkey"    FOREIGN KEY ("product_id")    REFERENCES "products"("id")             ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "backorder_lines_variant_id_fkey"    FOREIGN KEY ("variant_id")    REFERENCES "product_variants"("id")     ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "backorder_lines_fulfilled_by_po_item_id_fkey" FOREIGN KEY ("fulfilled_by_po_item_id") REFERENCES "purchase_order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "backorder_lines_qty_fulfilled_range" CHECK (qty_fulfilled >= 0 AND qty_fulfilled <= qty),
  CONSTRAINT "backorder_lines_qty_positive"        CHECK (qty > 0)
);

CREATE INDEX "backorder_lines_store_id_fulfilled_at_idx" ON "backorder_lines"("store_id","fulfilled_at");
CREATE INDEX "backorder_lines_product_id_idx"            ON "backorder_lines"("product_id");
CREATE INDEX "backorder_lines_order_item_id_idx"         ON "backorder_lines"("order_item_id");

-- ============================================================================
-- expenses
-- ============================================================================

CREATE TABLE "expenses" (
  "id"                       TEXT            NOT NULL,
  "store_id"                 TEXT            NOT NULL,
  "expense_number"           TEXT            NOT NULL,
  "supplier_id"              TEXT,
  "expense_account_id"       TEXT            NOT NULL,
  "paid_from_account_id"     TEXT            NOT NULL,
  "amount"                   INTEGER         NOT NULL,
  "tax_amount"               INTEGER         NOT NULL DEFAULT 0,
  "total"                    INTEGER         NOT NULL,
  "currency"                 TEXT            NOT NULL DEFAULT 'KWD',
  "expense_date"             TIMESTAMP(3)    NOT NULL,
  "status"                   "ExpenseStatus" NOT NULL DEFAULT 'draft',
  "receipt_image_url"        TEXT,
  "ocr_json"                 JSONB,
  "category_ai_confidence"   DOUBLE PRECISION,
  "approved_by"              TEXT,
  "approved_at"              TIMESTAMP(3),
  "journal_entry_id"         TEXT,
  "posted_at"                TIMESTAMP(3),
  "notes"                    TEXT,
  "notes_ar"                 TEXT,
  "created_by"               TEXT,
  "created_at"               TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"               TIMESTAMP(3)    NOT NULL,
  CONSTRAINT "expenses_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "expenses_store_id_fkey"             FOREIGN KEY ("store_id")             REFERENCES "stores"("id")    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "expenses_supplier_id_fkey"          FOREIGN KEY ("supplier_id")          REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "expenses_expense_account_id_fkey"   FOREIGN KEY ("expense_account_id")   REFERENCES "accounts"("id")  ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "expenses_paid_from_account_id_fkey" FOREIGN KEY ("paid_from_account_id") REFERENCES "accounts"("id")  ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "expenses_total_matches_amount_plus_tax" CHECK (total = amount + tax_amount),
  CONSTRAINT "expenses_amount_nonneg" CHECK (amount >= 0 AND tax_amount >= 0)
);

CREATE UNIQUE INDEX "expenses_journal_entry_id_key"       ON "expenses"("journal_entry_id");
CREATE UNIQUE INDEX "expenses_store_id_expense_number_key" ON "expenses"("store_id","expense_number");
CREATE INDEX        "expenses_store_id_status_idx"         ON "expenses"("store_id","status");
CREATE INDEX        "expenses_store_id_expense_date_idx"   ON "expenses"("store_id","expense_date" DESC);

-- ============================================================================
-- RLS policies (matches Batch 1 pattern — documentation-only since
-- neondb_owner has rolbypassrls, but maintained for posture consistency)
-- ============================================================================

ALTER TABLE "suppliers"              ENABLE ROW LEVEL SECURITY;
CREATE POLICY suppliers_tenant_isolation ON "suppliers" USING (store_id::text = current_setting('app.current_store_id', true) OR current_setting('app.bypass_rls', true) = 'true');

ALTER TABLE "purchase_orders"        ENABLE ROW LEVEL SECURITY;
CREATE POLICY purchase_orders_tenant_isolation ON "purchase_orders" USING (store_id::text = current_setting('app.current_store_id', true) OR current_setting('app.bypass_rls', true) = 'true');

ALTER TABLE "purchase_order_items"   ENABLE ROW LEVEL SECURITY;
CREATE POLICY purchase_order_items_tenant_isolation ON "purchase_order_items" USING (EXISTS (SELECT 1 FROM purchase_orders po WHERE po.id = purchase_order_items.po_id AND (po.store_id::text = current_setting('app.current_store_id', true) OR current_setting('app.bypass_rls', true) = 'true')));

ALTER TABLE "stock_adjustments"      ENABLE ROW LEVEL SECURITY;
CREATE POLICY stock_adjustments_tenant_isolation ON "stock_adjustments" USING (store_id::text = current_setting('app.current_store_id', true) OR current_setting('app.bypass_rls', true) = 'true');

ALTER TABLE "stock_adjustment_items" ENABLE ROW LEVEL SECURITY;
CREATE POLICY stock_adjustment_items_tenant_isolation ON "stock_adjustment_items" USING (EXISTS (SELECT 1 FROM stock_adjustments sa WHERE sa.id = stock_adjustment_items.adjustment_id AND (sa.store_id::text = current_setting('app.current_store_id', true) OR current_setting('app.bypass_rls', true) = 'true')));

ALTER TABLE "reorder_rules"          ENABLE ROW LEVEL SECURITY;
CREATE POLICY reorder_rules_tenant_isolation ON "reorder_rules" USING (store_id::text = current_setting('app.current_store_id', true) OR current_setting('app.bypass_rls', true) = 'true');

ALTER TABLE "backorder_lines"        ENABLE ROW LEVEL SECURITY;
CREATE POLICY backorder_lines_tenant_isolation ON "backorder_lines" USING (store_id::text = current_setting('app.current_store_id', true) OR current_setting('app.bypass_rls', true) = 'true');

ALTER TABLE "expenses"               ENABLE ROW LEVEL SECURITY;
CREATE POLICY expenses_tenant_isolation ON "expenses" USING (store_id::text = current_setting('app.current_store_id', true) OR current_setting('app.bypass_rls', true) = 'true');
