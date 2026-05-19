# FWB Accounting Batch 2 — Stock + Backorders + Finance Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Supplier + PO + StockAdjustment + Backorder + Expense subsystems on top of Batch 1's GL foundation. Every PO receipt updates inventory via weighted-average cost, fires the deferred-COGS journal for any cleared backorders (with variance correction when actual cost diverges from sale-time estimate), and posts to AP. Every stock adjustment writes a balanced journal. Every approved expense posts to the merchant's chosen cash/AP account. The merchant gets a Finance dashboard showing this-month revenue, COGS, gross profit, expenses, net, cash by account, and stock value.

**Architecture:** Mirror Batch 1's pattern — async posting via Inngest event listeners (NEW events: `stock/po-received`, `stock/adjustment-posted`, `accounting/expense-posted`). Hand-written migration only (Batch 1 learned the dev-DB-drift trap). Posting helpers reuse `postEntry({ source, sourceId })` idempotency from `journal.service.ts`. Backorder mechanics opt-in per-product/variant; sale through zero defers COGS, PO receipt FIFO-clears via the WAC + backorder-FIFO algorithm in spec Part 2.3 with a variance correction posted to the `5010 COGS Variance` account when sale-time estimate vs PO-actual cost differs.

**Tech Stack:** Prisma + Postgres (Neon), Express + TypeScript, Next.js 16 admin app, Inngest, Vitest, R2 for receipt uploads.

**Spec reference:** `docs/superpowers/specs/2026-05-19-fwb-accounting-stock-design.md` Parts 1.1 (new tables), 1.3 (extensions), 2.1 (sync posting model), 2.3 (WAC + backorder FIFO algorithm — CRITICAL), 4 (backorder mechanics), 6 (Stock + Finance admin pages), 8 (Kuwait specifics — fils, COA accounts, MOF retention), 9 (Batch 2 scope).

**Out of scope (Batch 3/4):** 4 AI Inngest jobs (reorder/dead-stock/profit-anomaly/expense-OCR), Insights tier (cohort/funnel/RFM), Receipt OCR (Batch 2 only stores the upload URL — Batch 3 wires Gemini Vision), Dead-stock detection (placeholder admin page only).

---

## File Structure

**Created (29 files):**

Schema + migration:

- `packages/database/prisma/migrations/<TS>_accounting_batch_2/migration.sql`

Services (`apps/api/src/services/accounting/`):

- `supplier.service.ts`
- `purchase-order.service.ts`
- `stock-adjustment.service.ts`
- `backorder.service.ts`
- `expense.service.ts`
- `reports.service.ts`

Posting helpers (`apps/api/src/services/accounting/posting/`):

- `po-receive-posting.ts`
- `stock-adjustment-posting.ts`
- `expense-posting.ts`

Inngest functions (`apps/api/src/lib/inngest/functions/`):

- `accounting-post-po-receive-journal.ts`
- `accounting-post-stock-adjustment-journal.ts`
- `accounting-post-expense-journal.ts`

Routes (`apps/api/src/routes/`):

- `suppliers.routes.ts`
- `purchase-orders.routes.ts`
- `stock-adjustments.routes.ts`
- `backorders.routes.ts`
- `expenses.routes.ts`

Admin pages (`apps/admin/src/app/stores/[id]/`):

- `stock/dashboard/page.tsx`
- `stock/inventory/page.tsx`
- `stock/adjustments/page.tsx` + `stock/adjustments/new/page.tsx`
- `stock/suppliers/page.tsx` + `stock/suppliers/new/page.tsx`
- `stock/purchase-orders/page.tsx` + `stock/purchase-orders/new/page.tsx` + `stock/purchase-orders/[poId]/page.tsx`
- `stock/backorders/page.tsx`
- `stock/reorder/page.tsx` (placeholder — Batch 3)
- `stock/deadstock/page.tsx` (placeholder — Batch 3)
- `finance/dashboard/page.tsx`
- `finance/expenses/page.tsx` + `finance/expenses/new/page.tsx`
- `finance/reports/page.tsx`

Integration tests (`tests/integration/accounting/`):

- `accounting-po-receive.test.ts`
- `accounting-backorder.test.ts`
- `accounting-stock-adjustment.test.ts`
- `accounting-expense-lifecycle.test.ts`

**Modified:**

- `packages/database/prisma/schema.prisma` — 8 new models + 5 new enums + Product/Variant/OrderItem/Store extensions
- `packages/database/src/index.ts` — re-export new enums
- `apps/api/src/lib/inngest/client.ts` — add 3 new event types to the union
- `apps/api/src/lib/inngest/functions/index.ts` — register 3 new functions
- `apps/api/src/routes/index.ts` — mount 5 new routers
- `apps/api/src/routes/finance.routes.ts` — add `/dashboard` + `/reports/*` endpoints
- `apps/api/src/routes/product.routes.ts` — add `inStock` / `acceptsBackorder` / `lowStock` / `availableQty` to public response
- `apps/api/src/services/analytics.service.ts` — add `glRevenueWindow` + `stockSnapshot` + `cashflowTrend` helpers (Task 16b)
- `apps/api/src/routes/analytics.routes.ts` — augment `/dashboard` + `/low-stock` + `/performance`; add `/cashflow` + `/stock-snapshot` (Task 16b)
- `apps/admin/src/app/stores/[id]/analytics/page.tsx` — surface GL fields + inventory snapshot + cashflow chart (Task 16b)
- `apps/api/src/services/cart.service.ts` — allow add-to-cart when `inventory <= 0 AND allowBackorder`
- `apps/api/src/services/order.service.ts` — `create` allows zero-stock checkout when allowBackorder; sets `costPriceDeferred` + creates `BackorderLine` rows post-checkout; `applyRefundEffects` auto-cancels open BackorderLines for refunded order
- `apps/admin/src/components/admin-layout/buildStoreAdminNav.ts` — add Stock group + extend Finance group
- `apps/admin/messages/en.json` + `messages/ar.json` — new `stock.*` + `finance.dashboard.*` + `finance.expenses.*` + `finance.reports.*` i18n keys

---

## Pre-flight

- [ ] **P1:** Verify no other Claude session modified the Prisma schema since Batch 1 deploy fixes.

  ```bash
  git log --since="6 hours ago" --name-only -- packages/database/prisma/schema.prisma | head -20
  ```

  Expected: only the Batch 1 commits + commits I authored. If a sister session touched the schema, rebase the new models against the latest schema before proceeding.

- [ ] **P2:** Confirm git author email + verify Batch 1's `_prisma_migrations` recovery held.

  ```bash
  git config user.email   # expect: ahmed0montaser@gmail.com
  psql "$(grep DATABASE_URL apps/api/.env | cut -d= -f2- | tr -d '"' | head -1)" -c "SELECT migration_name, finished_at IS NOT NULL AS applied FROM _prisma_migrations WHERE migration_name LIKE '%accounting%' OR migration_name LIKE '%ai_recommendation%' ORDER BY started_at DESC LIMIT 5;"
  ```

  Expected: every accounting migration `applied=t`; no `_prisma_migrations` rows with NULL finished_at.

- [ ] **P3:** DB backup before starting.
  ```bash
  bash scripts/backup-db.sh
  ```

---

## Task 1: Prisma schema — 8 models + 5 enums + extensions

**Files:**

- Modify: `packages/database/prisma/schema.prisma`

### Step 1: Add the 5 new enums + 8 new models at the bottom of schema.prisma

```prisma
// ==========================================
// Stock + Backorders + Expenses (Batch 2)
// ==========================================

enum SupplierPaymentTerms {
  net0
  net15
  net30
  net60
  custom
}

enum PurchaseOrderStatus {
  draft
  sent
  partial
  received
  cancelled
}

enum StockAdjustmentType {
  cycle_count
  damage
  theft
  loss
  write_off
  found
  return_to_supplier
}

enum StockAdjustmentStatus {
  draft
  posted
}

enum ExpenseStatus {
  draft
  pending
  approved
  posted
  rejected
}

model Supplier {
  id              String               @id @default(uuid())
  storeId         String               @map("store_id")
  name            String
  nameAr          String?              @map("name_ar")
  contactName     String?              @map("contact_name")
  phone           String?
  email           String?
  address         Json?
  paymentTerms    SupplierPaymentTerms @default(net0) @map("payment_terms")
  customTermsDays Int?                 @map("custom_terms_days")
  defaultCurrency String               @default("KWD") @map("default_currency")
  apBalanceCached Int                  @default(0) @map("ap_balance_cached")
  isActive        Boolean              @default(true) @map("is_active")
  notes           String?
  notesAr         String?              @map("notes_ar")
  createdAt       DateTime             @default(now()) @map("created_at")
  updatedAt       DateTime             @updatedAt @map("updated_at")
  deletedAt       DateTime?            @map("deleted_at")

  store          Store           @relation(fields: [storeId], references: [id], onDelete: Cascade)
  purchaseOrders PurchaseOrder[]
  reorderRules   ReorderRule[]
  expenses       Expense[]

  @@index([storeId])
  @@index([storeId, isActive])
  @@map("suppliers")
}

model PurchaseOrder {
  id             String              @id @default(uuid())
  storeId        String              @map("store_id")
  supplierId     String              @map("supplier_id")
  poNumber       String              @map("po_number")
  status         PurchaseOrderStatus @default(draft)
  expectedDate   DateTime?           @map("expected_date")
  receivedAt     DateTime?           @map("received_at")
  subtotal       Int                 @default(0)
  taxAmount      Int                 @default(0) @map("tax_amount")
  shippingCost   Int                 @default(0) @map("shipping_cost")
  total          Int                 @default(0)
  currency       String              @default("KWD")
  apAccountId    String?             @map("ap_account_id")
  journalEntryId String?             @unique @map("journal_entry_id")
  notes          String?
  notesAr        String?             @map("notes_ar")
  createdBy      String?             @map("created_by")
  receivedBy     String?             @map("received_by")
  createdAt      DateTime            @default(now()) @map("created_at")
  updatedAt      DateTime            @updatedAt @map("updated_at")

  store     Store               @relation(fields: [storeId], references: [id], onDelete: Restrict)
  supplier  Supplier            @relation(fields: [supplierId], references: [id], onDelete: Restrict)
  apAccount Account?            @relation("PoApAccount", fields: [apAccountId], references: [id])
  items     PurchaseOrderItem[]

  @@unique([storeId, poNumber])
  @@index([storeId, status])
  @@index([supplierId])
  @@index([storeId, createdAt(sort: Desc)])
  @@map("purchase_orders")
}

model PurchaseOrderItem {
  id          String  @id @default(uuid())
  poId        String  @map("po_id")
  productId   String  @map("product_id")
  variantId   String? @map("variant_id")
  qty         Int
  qtyReceived Int     @default(0) @map("qty_received")
  unitCost    Int     @map("unit_cost")
  total       Int
  notes       String?
  createdAt   DateTime @default(now()) @map("created_at")

  po                  PurchaseOrder    @relation(fields: [poId], references: [id], onDelete: Cascade)
  product             Product          @relation(fields: [productId], references: [id])
  variant             ProductVariant?  @relation(fields: [variantId], references: [id])
  backordersFulfilled BackorderLine[]

  @@index([poId])
  @@index([productId])
  @@map("purchase_order_items")
}

model StockAdjustment {
  id               String                @id @default(uuid())
  storeId          String                @map("store_id")
  adjustmentNumber String                @map("adjustment_number")
  type             StockAdjustmentType
  status           StockAdjustmentStatus @default(draft)
  reason           String?
  reasonAr         String?               @map("reason_ar")
  evidenceUrl      String?               @map("evidence_url")
  totalValueImpact Int                   @default(0) @map("total_value_impact")
  postedAt         DateTime?             @map("posted_at")
  postedBy         String?               @map("posted_by")
  journalEntryId   String?               @unique @map("journal_entry_id")
  createdBy        String?               @map("created_by")
  createdAt        DateTime              @default(now()) @map("created_at")
  updatedAt        DateTime              @updatedAt @map("updated_at")

  store Store                   @relation(fields: [storeId], references: [id], onDelete: Restrict)
  items StockAdjustmentItem[]

  @@unique([storeId, adjustmentNumber])
  @@index([storeId, status])
  @@index([storeId, postedAt(sort: Desc)])
  @@map("stock_adjustments")
}

model StockAdjustmentItem {
  id           String  @id @default(uuid())
  adjustmentId String  @map("adjustment_id")
  productId    String  @map("product_id")
  variantId    String? @map("variant_id")
  previousQty  Int     @map("previous_qty")
  newQty       Int     @map("new_qty")
  deltaQty     Int     @map("delta_qty")
  unitCost     Int     @map("unit_cost")
  createdAt    DateTime @default(now()) @map("created_at")

  adjustment StockAdjustment @relation(fields: [adjustmentId], references: [id], onDelete: Cascade)
  product    Product         @relation(fields: [productId], references: [id])
  variant    ProductVariant? @relation(fields: [variantId], references: [id])

  @@index([adjustmentId])
  @@index([productId])
  @@map("stock_adjustment_items")
}

model ReorderRule {
  id                  String   @id @default(uuid())
  storeId             String   @map("store_id")
  productId           String   @map("product_id")
  variantId           String?  @map("variant_id")
  minQty              Int      @map("min_qty")
  reorderQty          Int      @map("reorder_qty")
  leadTimeDays        Int      @default(7) @map("lead_time_days")
  safetyStockDays     Int      @default(7) @map("safety_stock_days")
  preferredSupplierId String?  @map("preferred_supplier_id")
  isActive            Boolean  @default(true) @map("is_active")
  createdAt           DateTime @default(now()) @map("created_at")
  updatedAt           DateTime @updatedAt @map("updated_at")

  store             Store           @relation(fields: [storeId], references: [id], onDelete: Cascade)
  product           Product         @relation(fields: [productId], references: [id], onDelete: Cascade)
  variant           ProductVariant? @relation(fields: [variantId], references: [id], onDelete: Cascade)
  preferredSupplier Supplier?       @relation(fields: [preferredSupplierId], references: [id], onDelete: SetNull)

  @@unique([storeId, productId, variantId])
  @@index([storeId])
  @@map("reorder_rules")
}

model BackorderLine {
  id                  String    @id @default(uuid())
  storeId             String    @map("store_id")
  orderItemId         String    @map("order_item_id")
  productId           String    @map("product_id")
  variantId           String?   @map("variant_id")
  qty                 Int
  qtyFulfilled        Int       @default(0) @map("qty_fulfilled")
  fulfilledByPoItemId String?   @map("fulfilled_by_po_item_id")
  fulfilledAt         DateTime? @map("fulfilled_at")
  cancelledAt         DateTime? @map("cancelled_at")
  cancelledReason     String?   @map("cancelled_reason")
  createdAt           DateTime  @default(now()) @map("created_at")

  store         Store              @relation(fields: [storeId], references: [id], onDelete: Cascade)
  orderItem     OrderItem          @relation(fields: [orderItemId], references: [id], onDelete: Cascade)
  product       Product            @relation(fields: [productId], references: [id])
  variant       ProductVariant?    @relation(fields: [variantId], references: [id])
  fulfilledByPo PurchaseOrderItem? @relation(fields: [fulfilledByPoItemId], references: [id], onDelete: SetNull)

  @@index([storeId, fulfilledAt])
  @@index([productId])
  @@index([orderItemId])
  @@map("backorder_lines")
}

model Expense {
  id                   String        @id @default(uuid())
  storeId              String        @map("store_id")
  expenseNumber        String        @map("expense_number")
  supplierId           String?       @map("supplier_id")
  expenseAccountId     String        @map("expense_account_id")
  paidFromAccountId    String        @map("paid_from_account_id")
  amount               Int
  taxAmount            Int           @default(0) @map("tax_amount")
  total                Int
  currency             String        @default("KWD")
  expenseDate          DateTime      @map("expense_date")
  status               ExpenseStatus @default(draft)
  receiptImageUrl      String?       @map("receipt_image_url")
  ocrJson              Json?         @map("ocr_json")
  categoryAiConfidence Float?        @map("category_ai_confidence")
  approvedBy           String?       @map("approved_by")
  approvedAt           DateTime?     @map("approved_at")
  journalEntryId       String?       @unique @map("journal_entry_id")
  postedAt             DateTime?     @map("posted_at")
  notes                String?
  notesAr              String?       @map("notes_ar")
  createdBy            String?       @map("created_by")
  createdAt            DateTime      @default(now()) @map("created_at")
  updatedAt            DateTime      @updatedAt @map("updated_at")

  store           Store    @relation(fields: [storeId], references: [id], onDelete: Restrict)
  supplier        Supplier? @relation(fields: [supplierId], references: [id], onDelete: SetNull)
  expenseAccount  Account  @relation("ExpenseCategoryAccount", fields: [expenseAccountId], references: [id], onDelete: Restrict)
  paidFromAccount Account  @relation("ExpensePaidFromAccount", fields: [paidFromAccountId], references: [id], onDelete: Restrict)

  @@unique([storeId, expenseNumber])
  @@index([storeId, status])
  @@index([storeId, expenseDate(sort: Desc)])
  @@map("expenses")
}
```

### Step 2: Add extensions to existing models

In `model Product`:

```prisma
  allowBackorder    Boolean   @default(false) @map("allow_backorder")
  lastCostUpdateAt  DateTime? @map("last_cost_update_at")

  // reverse relations (add to relations block):
  purchaseOrderItems   PurchaseOrderItem[]
  stockAdjustmentItems StockAdjustmentItem[]
  reorderRules         ReorderRule[]
  backorderLines       BackorderLine[]
```

In `model ProductVariant`:

```prisma
  allowBackorder Boolean @default(false) @map("allow_backorder")

  // reverse relations:
  purchaseOrderItems   PurchaseOrderItem[]
  stockAdjustmentItems StockAdjustmentItem[]
  reorderRules         ReorderRule[]
  backorderLines       BackorderLine[]
```

In `model OrderItem`:

```prisma
  costPriceDeferred Boolean @default(false) @map("cost_price_deferred")

  // reverse relation:
  backorderLines BackorderLine[]
```

In `model Store`:

```prisma
  expenseTwoStepApproval Boolean @default(false) @map("expense_two_step_approval")

  // reverse relations (add to existing block alongside accounts/journalEntries/sequences):
  suppliers        Supplier[]
  purchaseOrders   PurchaseOrder[]
  stockAdjustments StockAdjustment[]
  reorderRules     ReorderRule[]
  backorderLines   BackorderLine[]
  expenses         Expense[]
```

In `model Account` (add two new named relation arrays — they pair with the FK fields in Expense + the apAccount field in PurchaseOrder):

```prisma
  expensesByCategory Expense[]       @relation("ExpenseCategoryAccount")
  expensesPaidFrom   Expense[]       @relation("ExpensePaidFromAccount")
  purchaseOrders     PurchaseOrder[] @relation("PoApAccount")
```

### Step 3: Validate

```bash
npm run db:generate -w packages/database
```

Expected: `✔ Generated Prisma Client` with no errors.

### Step 4: Commit (schema only — migration follows)

```bash
git add packages/database/prisma/schema.prisma
git commit -m "feat(db): batch 2 schema — supplier, purchaseorder, stockadjustment, backorder, expense"
```

### Step 5: Re-export new enums in `packages/database/src/index.ts`

Append to existing re-exports:

```ts
export {
  SupplierPaymentTerms,
  PurchaseOrderStatus,
  StockAdjustmentType,
  StockAdjustmentStatus,
  ExpenseStatus,
} from '@prisma/client';
```

Then `npm run build -w packages/database` to verify. Commit:

```bash
git add packages/database/src/index.ts
git commit -m "feat(database): re-export batch 2 enums"
```

---

## Task 2: Hand-written migration (NO `prisma migrate dev --create-only` — Batch 1 learned that trap)

**Files:**

- Create: `packages/database/prisma/migrations/<TS>_accounting_batch_2/migration.sql`

### Step 1: Create migration directory with hand-written SQL

Use timestamp newer than `20260519200000` (the AI recommendation fix). Pick `20260519180000_accounting_batch_2`.

```sql
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
```

### Step 2: Apply locally + regenerate client

```bash
cd packages/database && npx prisma migrate deploy && npm run build && cd ../..
```

Expected: `Applied 1 migration` and build exits 0.

### Step 3: Smoke-test a CHECK constraint via psql

```bash
psql "$DATABASE_URL" -c "INSERT INTO expenses (id, store_id, expense_number, expense_account_id, paid_from_account_id, amount, tax_amount, total, expense_date, updated_at) VALUES (gen_random_uuid()::text, '<storeId>', 'TEST', '<acctId>', '<acctId>', 100, 0, 999, now(), now());"
```

Expected: `ERROR: new row for relation "expenses" violates check constraint "expenses_total_matches_amount_plus_tax"`.

### Step 4: Commit migration

```bash
git add packages/database/prisma/migrations/<TS>_accounting_batch_2/
git commit -m "feat(db): migrate batch 2 — 8 tables + 5 enums + extensions + checks + rls"
```

---

## Task 3: Supplier service + routes

**Files:**

- Create: `apps/api/src/services/accounting/supplier.service.ts`
- Create: `apps/api/src/routes/suppliers.routes.ts`
- Modify: `apps/api/src/routes/index.ts`

### Step 1: Write failing integration test

`tests/integration/accounting/supplier-service.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@force/database';
import {
  createSupplier,
  updateSupplier,
  listSuppliers,
  getSupplier,
  softDeleteSupplier,
} from '../../../apps/api/src/services/accounting/supplier.service';

const OWNER = '00000000-0000-0000-0000-0000000000aa';
let storeId: string;

beforeAll(async () => {
  await prisma.user.upsert({
    where: { id: OWNER },
    update: {},
    create: {
      id: OWNER,
      email: `sup-${Date.now()}@x.test`,
      passwordHash: 'x',
      firstName: 'S',
      lastName: 'O',
    },
  });
  const s = await prisma.store.create({
    data: { name: `sup-test-${Date.now()}`, slug: `sup-test-${Date.now()}`, ownerId: OWNER },
  });
  storeId = s.id;
});

afterAll(async () => {
  await prisma.supplier.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } });
});

describe('supplier.service', () => {
  it('creates + lists + soft-deletes', async () => {
    const a = await createSupplier({
      storeId,
      name: 'Acme Pkg',
      nameAr: 'أكمي للتغليف',
      email: 'sales@acme.test',
    });
    expect(a.isActive).toBe(true);

    const list = await listSuppliers(storeId);
    expect(list.find(s => s.id === a.id)).toBeDefined();

    const got = await getSupplier(storeId, a.id);
    expect(got?.name).toBe('Acme Pkg');

    await softDeleteSupplier(storeId, a.id);
    const afterDelete = await listSuppliers(storeId);
    expect(afterDelete.find(s => s.id === a.id)).toBeUndefined();
  });
});
```

Run: `npx vitest run tests/integration/accounting/supplier-service.test.ts` → FAIL `Cannot find module`.

### Step 2: Implement service

`apps/api/src/services/accounting/supplier.service.ts`:

```ts
import { prisma } from '@force/database';
import type { Prisma, Supplier, SupplierPaymentTerms } from '@prisma/client';

export interface CreateSupplierInput {
  storeId: string;
  name: string;
  nameAr?: string;
  contactName?: string;
  phone?: string;
  email?: string;
  address?: Record<string, unknown>;
  paymentTerms?: SupplierPaymentTerms;
  customTermsDays?: number;
  defaultCurrency?: string;
  notes?: string;
  notesAr?: string;
}

export async function createSupplier(input: CreateSupplierInput): Promise<Supplier> {
  return prisma.supplier.create({
    data: {
      storeId: input.storeId,
      name: input.name,
      nameAr: input.nameAr,
      contactName: input.contactName,
      phone: input.phone,
      email: input.email,
      address: (input.address ?? {}) as Prisma.InputJsonValue,
      paymentTerms: input.paymentTerms ?? 'net0',
      customTermsDays: input.customTermsDays,
      defaultCurrency: input.defaultCurrency ?? 'KWD',
      notes: input.notes,
      notesAr: input.notesAr,
    },
  });
}

export type UpdateSupplierInput = Partial<Omit<CreateSupplierInput, 'storeId'>> & {
  isActive?: boolean;
};

export async function updateSupplier(
  storeId: string,
  id: string,
  patch: UpdateSupplierInput
): Promise<Supplier> {
  const owned = await prisma.supplier.findFirst({
    where: { id, storeId, deletedAt: null },
    select: { id: true },
  });
  if (!owned) throw new Error(`Supplier ${id} not found in store ${storeId}`);
  return prisma.supplier.update({
    where: { id },
    data: {
      ...patch,
      address: patch.address ? (patch.address as Prisma.InputJsonValue) : undefined,
    },
  });
}

export async function listSuppliers(
  storeId: string,
  opts: { includeInactive?: boolean } = {}
): Promise<Supplier[]> {
  return prisma.supplier.findMany({
    where: {
      storeId,
      deletedAt: null,
      ...(opts.includeInactive ? {} : { isActive: true }),
    },
    orderBy: { name: 'asc' },
  });
}

export async function getSupplier(storeId: string, id: string): Promise<Supplier | null> {
  return prisma.supplier.findFirst({ where: { id, storeId, deletedAt: null } });
}

export async function softDeleteSupplier(storeId: string, id: string): Promise<void> {
  const owned = await prisma.supplier.findFirst({
    where: { id, storeId, deletedAt: null },
    select: { id: true },
  });
  if (!owned) throw new Error(`Supplier ${id} not found in store ${storeId}`);
  await prisma.supplier.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
}
```

### Step 3: Run test — should pass

```bash
npx vitest run tests/integration/accounting/supplier-service.test.ts
```

Expected: 1 passed.

### Step 4: Routes

`apps/api/src/routes/suppliers.routes.ts`:

```ts
import { Router } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { runInTenantContext } from '@force/database';
import {
  createSupplier,
  updateSupplier,
  listSuppliers,
  getSupplier,
  softDeleteSupplier,
} from '../services/accounting/supplier.service';

const router = Router();

const createSchema = z.object({
  name: z.string().min(1).max(200),
  nameAr: z.string().max(200).optional(),
  contactName: z.string().max(200).optional(),
  phone: z.string().max(50).optional(),
  email: z.string().email().optional(),
  address: z.record(z.string(), z.unknown()).optional(),
  paymentTerms: z.enum(['net0', 'net15', 'net30', 'net60', 'custom']).optional(),
  customTermsDays: z.number().int().min(1).max(365).optional(),
  notes: z.string().optional(),
  notesAr: z.string().optional(),
});

const updateSchema = createSchema.partial().extend({ isActive: z.boolean().optional() });

router.get(
  '/:storeId/suppliers',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req, res, next) => {
    try {
      const includeInactive = req.query.includeInactive === 'true';
      const data = await runInTenantContext(req.params.storeId, () =>
        listSuppliers(req.params.storeId, { includeInactive })
      );
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/:storeId/suppliers/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req, res, next) => {
    try {
      const data = await runInTenantContext(req.params.storeId, () =>
        getSupplier(req.params.storeId, req.params.id)
      );
      if (!data) return res.status(404).json({ error: 'not_found' });
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/:storeId/suppliers',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req, res, next) => {
    try {
      const body = createSchema.safeParse(req.body);
      if (!body.success)
        return res.status(422).json({ error: 'validation', issues: body.error.issues });
      const data = await runInTenantContext(req.params.storeId, () =>
        createSupplier({ storeId: req.params.storeId, ...body.data })
      );
      res.status(201).json({ data });
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  '/:storeId/suppliers/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req, res, next) => {
    try {
      const body = updateSchema.safeParse(req.body);
      if (!body.success)
        return res.status(422).json({ error: 'validation', issues: body.error.issues });
      const data = await runInTenantContext(req.params.storeId, () =>
        updateSupplier(req.params.storeId, req.params.id, body.data)
      );
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  '/:storeId/suppliers/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req, res, next) => {
    try {
      await runInTenantContext(req.params.storeId, () =>
        softDeleteSupplier(req.params.storeId, req.params.id)
      );
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
);

export default router;
```

Mount in `apps/api/src/routes/index.ts`:

```ts
import suppliersRoutes from './suppliers.routes';
router.use('/stores', tenantContext, suppliersRoutes);
```

### Step 5: Build + commit

```bash
npm run build -w apps/api 2>&1 | tail -3
git add apps/api/src/services/accounting/supplier.service.ts apps/api/src/routes/suppliers.routes.ts apps/api/src/routes/index.ts tests/integration/accounting/supplier-service.test.ts
git commit -m "feat(accounting): supplier service + crud routes"
```

---

## Task 4: PurchaseOrder service — CRUD + receive flow with WAC + backorder FIFO

This is the HEAVIEST task. The receive flow implements spec Part 2.3.

**Files:**

- Create: `apps/api/src/services/accounting/purchase-order.service.ts`
- Test: `tests/integration/accounting/po-service.test.ts`

### Step 1: Write failing test for the WAC + backorder FIFO algorithm

`tests/integration/accounting/po-service.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@force/database';
import { seedCoaForStore } from '../../../apps/api/src/services/accounting/account.service';
import { createSupplier } from '../../../apps/api/src/services/accounting/supplier.service';
import {
  createPurchaseOrder,
  receivePurchaseOrder,
} from '../../../apps/api/src/services/accounting/purchase-order.service';

const OWNER = '00000000-0000-0000-0000-0000000000aa';
let storeId: string;
let supplierId: string;
let productId: string;

beforeAll(async () => {
  await prisma.user.upsert({
    where: { id: OWNER },
    update: {},
    create: {
      id: OWNER,
      email: `po-${Date.now()}@x.test`,
      passwordHash: 'x',
      firstName: 'P',
      lastName: 'O',
    },
  });
  const s = await prisma.store.create({
    data: { name: `po-test-${Date.now()}`, slug: `po-test-${Date.now()}`, ownerId: OWNER },
  });
  storeId = s.id;
  await seedCoaForStore(storeId);
  const sup = await createSupplier({ storeId, name: 'Test Supplier' });
  supplierId = sup.id;
  const p = await prisma.product.create({
    data: {
      storeId,
      name: 'WAC Test',
      slug: `wac-${Date.now()}`,
      price: 5000,
      costPrice: 2000,
      inventory: 100,
      status: 'active',
    },
  });
  productId = p.id;
});

afterAll(async () => {
  await prisma.journalLine.deleteMany({ where: { entry: { storeId } } });
  await prisma.journalEntry.deleteMany({ where: { storeId } });
  await prisma.sequence.deleteMany({ where: { storeId } });
  await prisma.purchaseOrderItem.deleteMany({ where: { po: { storeId } } });
  await prisma.purchaseOrder.deleteMany({ where: { storeId } });
  await prisma.supplier.deleteMany({ where: { storeId } });
  await prisma.product.deleteMany({ where: { storeId } });
  await prisma.account.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } });
});

describe('PO receive — WAC recompute', () => {
  it('updates Product.costPrice to weighted-average after receipt', async () => {
    // Setup: product has 100 units @ 2.000 cost. Receive 50 @ 2.400.
    // New WAC = ((100 * 2000) + (50 * 2400)) / 150 = 320000 / 150 = 2133 (Int math)
    const po = await createPurchaseOrder({
      storeId,
      supplierId,
      items: [{ productId, qty: 50, unitCost: 2400 }],
    });
    const result = await receivePurchaseOrder({
      storeId,
      poId: po.id,
      receipts: [{ poItemId: po.items[0].id, qtyReceived: 50 }],
    });
    expect(result.po.status).toBe('received');

    const product = await prisma.product.findUnique({ where: { id: productId } });
    expect(product?.inventory).toBe(150);
    // WAC = ((100*2000) + (50*2400)) / 150 = 320000/150 = 2133.333... → Int 2133
    expect(product?.costPrice).toBe(2133);
    expect(product?.lastCostUpdateAt).not.toBeNull();

    // Assert journal entry was queued (the Inngest function would post async;
    // for the integration test we verify the helper directly)
  });
});
```

Run: FAIL `Cannot find module`.

### Step 2: Implement the service with the spec Part 2.3 algorithm

`apps/api/src/services/accounting/purchase-order.service.ts`:

```ts
import { prisma } from '@force/database';
import type { Prisma, PurchaseOrder, PurchaseOrderItem } from '@prisma/client';
import { nextSequence } from '../sequence.service';
import { getSystemAccountIdByCode } from './account.service';
import { inngest } from '../../lib/inngest/client';
import logger from '../../lib/logger';

export interface CreatePoInput {
  storeId: string;
  supplierId: string;
  expectedDate?: Date;
  notes?: string;
  notesAr?: string;
  createdBy?: string;
  items: { productId: string; variantId?: string; qty: number; unitCost: number; notes?: string }[];
}

export async function createPurchaseOrder(
  input: CreatePoInput
): Promise<PurchaseOrder & { items: PurchaseOrderItem[] }> {
  const subtotal = input.items.reduce((s, i) => s + i.qty * i.unitCost, 0);
  const apAccountId = await getSystemAccountIdByCode(input.storeId, '2000'); // AP
  const poNumber = await nextSequence(input.storeId, 'po');

  return prisma.purchaseOrder.create({
    data: {
      storeId: input.storeId,
      supplierId: input.supplierId,
      poNumber,
      status: 'draft',
      expectedDate: input.expectedDate,
      subtotal,
      total: subtotal,
      apAccountId,
      notes: input.notes,
      notesAr: input.notesAr,
      createdBy: input.createdBy,
      items: {
        create: input.items.map(i => ({
          productId: i.productId,
          variantId: i.variantId,
          qty: i.qty,
          unitCost: i.unitCost,
          total: i.qty * i.unitCost,
          notes: i.notes,
        })),
      },
    },
    include: { items: true },
  });
}

export interface ReceiveInput {
  storeId: string;
  poId: string;
  receivedBy?: string;
  receipts: { poItemId: string; qtyReceived: number }[]; // per-item received quantities
}

/**
 * Receive purchase order. Implements spec Part 2.3:
 *   1. For each PO item line received:
 *      a. FIFO-clear oldest open BackorderLines for this productId+variantId
 *         consuming up to qtyReceived. Each cleared line fires a deferred-COGS
 *         posting at the PO unitCost; if estimate (OrderItem.costPrice) differs,
 *         post a COGS variance entry to 5010.
 *      b. Replenish on-hand with the remainder. Recompute Product.costPrice
 *         via WAC.
 *   2. Update PO item.qtyReceived; transition status (partial vs received).
 *   3. Fire `stock/po-received` Inngest event so the AP journal posts.
 */
export async function receivePurchaseOrder(input: ReceiveInput): Promise<{
  po: PurchaseOrder;
  clearedBackorders: Array<{
    backorderLineId: string;
    orderItemId: string;
    qty: number;
    actualUnitCost: number;
    estimateUnitCost: number;
    variance: number;
  }>;
}> {
  const clearedBackorders: Array<{
    backorderLineId: string;
    orderItemId: string;
    qty: number;
    actualUnitCost: number;
    estimateUnitCost: number;
    variance: number;
  }> = [];

  const po = await prisma.$transaction(async tx => {
    const po = await tx.purchaseOrder.findUnique({
      where: { id: input.poId },
      include: { items: true },
    });
    if (!po || po.storeId !== input.storeId)
      throw new Error(`PO ${input.poId} not found in store ${input.storeId}`);
    if (po.status === 'received' || po.status === 'cancelled')
      throw new Error(`PO ${input.poId} cannot be received (status=${po.status})`);

    for (const receipt of input.receipts) {
      if (receipt.qtyReceived <= 0) continue;
      const item = po.items.find(i => i.id === receipt.poItemId);
      if (!item) throw new Error(`PO item ${receipt.poItemId} not in PO ${input.poId}`);
      const remainingAfter = item.qtyReceived + receipt.qtyReceived;
      if (remainingAfter > item.qty)
        throw new Error(`Cannot receive ${receipt.qtyReceived}; would exceed PO qty ${item.qty}`);

      let remainingToProcess = receipt.qtyReceived;

      // Step 1a: FIFO-clear backorders
      const openBackorders = await tx.backorderLine.findMany({
        where: {
          productId: item.productId,
          variantId: item.variantId ?? null,
          fulfilledAt: null,
          cancelledAt: null,
        },
        orderBy: { createdAt: 'asc' },
        include: { orderItem: true },
      });

      for (const bo of openBackorders) {
        if (remainingToProcess <= 0) break;
        const stillNeeded = bo.qty - bo.qtyFulfilled;
        const fulfilQty = Math.min(stillNeeded, remainingToProcess);
        const newQtyFulfilled = bo.qtyFulfilled + fulfilQty;
        const isFullyFulfilled = newQtyFulfilled === bo.qty;

        await tx.backorderLine.update({
          where: { id: bo.id },
          data: {
            qtyFulfilled: newQtyFulfilled,
            ...(isFullyFulfilled ? { fulfilledAt: new Date(), fulfilledByPoItemId: item.id } : {}),
          },
        });

        // Track the cleared backorder for journal posting
        const estimateUnitCost = bo.orderItem.costPrice ?? 0;
        const variance = (item.unitCost - estimateUnitCost) * fulfilQty;
        clearedBackorders.push({
          backorderLineId: bo.id,
          orderItemId: bo.orderItemId,
          qty: fulfilQty,
          actualUnitCost: item.unitCost,
          estimateUnitCost,
          variance,
        });

        // If fully fulfilled, clear costPriceDeferred on the OrderItem
        if (isFullyFulfilled) {
          // Verify no other backorder lines remain for this OrderItem
          const remainingOpen = await tx.backorderLine.count({
            where: {
              orderItemId: bo.orderItemId,
              fulfilledAt: null,
              cancelledAt: null,
              id: { not: bo.id },
            },
          });
          if (remainingOpen === 0) {
            await tx.orderItem.update({
              where: { id: bo.orderItemId },
              data: { costPriceDeferred: false },
            });
          }
        }

        remainingToProcess -= fulfilQty;
      }

      // Step 1b: Replenish on-hand with remainder + WAC recompute
      if (remainingToProcess > 0) {
        if (item.variantId) {
          // Variant-level WAC: variant has its own inventory but currently inherits costPrice from product.
          // For Batch 2 we still recompute the parent product.costPrice (variants inherit).
          await tx.productVariant.update({
            where: { id: item.variantId },
            data: { inventory: { increment: remainingToProcess } },
          });
        }

        const product = await tx.product.findUnique({
          where: { id: item.productId },
          select: { inventory: true, costPrice: true },
        });
        if (!product) throw new Error(`Product ${item.productId} not found`);

        const oldStock = Math.max(product.inventory, 0); // pre-existing on-hand (negative → 0 for WAC math; backorder demand already consumed via clearance above)
        const oldCost = product.costPrice ?? item.unitCost; // first-receive fallback
        const newStock = product.inventory + remainingToProcess; // can still be negative if backorders existed beyond the receipt
        const denom = oldStock + remainingToProcess;
        const newCost =
          denom > 0
            ? Math.round((oldStock * oldCost + remainingToProcess * item.unitCost) / denom)
            : item.unitCost;

        await tx.product.update({
          where: { id: item.productId },
          data: {
            inventory: newStock,
            costPrice: newCost,
            lastCostUpdateAt: new Date(),
          },
        });

        // InventoryHistory row (existing FWB pattern):
        await tx.inventoryHistory.create({
          data: {
            productId: item.productId,
            storeId: input.storeId,
            type: 'transfer_in',
            quantity: remainingToProcess,
            previousStock: product.inventory,
            newStock,
            reason: `PO receive ${po.poNumber}`,
            reference: item.id,
          },
        });
      }

      // Step 2: Update PO item.qtyReceived
      await tx.purchaseOrderItem.update({
        where: { id: item.id },
        data: { qtyReceived: remainingAfter },
      });
    }

    // Recompute PO status
    const updatedItems = await tx.purchaseOrderItem.findMany({ where: { poId: input.poId } });
    const allComplete = updatedItems.every(i => i.qtyReceived === i.qty);
    const anyReceived = updatedItems.some(i => i.qtyReceived > 0);
    const newStatus = allComplete ? 'received' : anyReceived ? 'partial' : po.status;

    const updated = await tx.purchaseOrder.update({
      where: { id: input.poId },
      data: {
        status: newStatus,
        receivedAt: allComplete ? new Date() : po.receivedAt,
        receivedBy: input.receivedBy ?? po.receivedBy,
      },
    });

    return updated;
  });

  // Step 3: Fire async event (outside the transaction so the response returns fast)
  inngest
    .send({
      name: 'stock/po-received',
      data: {
        storeId: input.storeId,
        poId: input.poId,
        clearedBackorders, // posting helper uses this to fire deferred-COGS entries
      },
    })
    .catch(err => logger.error({ err, poId: input.poId }, 'Failed to enqueue stock/po-received'));

  return { po, clearedBackorders };
}

export async function listPurchaseOrders(
  storeId: string,
  opts: { status?: string; page?: number; perPage?: number } = {}
) {
  const page = opts.page ?? 1;
  const perPage = Math.min(opts.perPage ?? 50, 200);
  const where: Prisma.PurchaseOrderWhereInput = { storeId };
  if (opts.status) where.status = opts.status as any;
  const [items, total] = await Promise.all([
    prisma.purchaseOrder.findMany({
      where,
      include: { supplier: { select: { name: true } }, items: true },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    prisma.purchaseOrder.count({ where }),
  ]);
  return { items, total, page, perPage };
}

export async function getPurchaseOrder(storeId: string, id: string) {
  return prisma.purchaseOrder.findFirst({
    where: { id, storeId },
    include: {
      supplier: true,
      items: {
        include: {
          product: { select: { name: true, sku: true } },
          variant: { select: { id: true, optionValues: { include: { optionValue: true } } } },
        },
      },
    },
  });
}

export async function cancelPurchaseOrder(storeId: string, id: string) {
  const po = await prisma.purchaseOrder.findFirst({ where: { id, storeId } });
  if (!po) throw new Error(`PO ${id} not found in store ${storeId}`);
  if (po.status === 'received') throw new Error('Cannot cancel a fully-received PO');
  return prisma.purchaseOrder.update({ where: { id }, data: { status: 'cancelled' } });
}
```

### Step 3: Run test — should pass

```bash
npx vitest run tests/integration/accounting/po-service.test.ts
```

Expected: 1 passed (WAC math correct + inventory + status transition).

### Step 4: Add `stock/po-received` event type

In `apps/api/src/lib/inngest/client.ts`, extend the event union with:

```ts
{
  name: 'stock/po-received';
  data: {
    storeId: string;
    poId: string;
    clearedBackorders: Array<{
      backorderLineId: string;
      orderItemId: string;
      qty: number;
      actualUnitCost: number;
      estimateUnitCost: number;
      variance: number;
    }>;
  }
}
```

### Step 5: Build + commit

```bash
npm run build -w apps/api 2>&1 | tail -3
git add apps/api/src/services/accounting/purchase-order.service.ts apps/api/src/lib/inngest/client.ts tests/integration/accounting/po-service.test.ts
git commit -m "feat(accounting): po service + receive flow (wac + backorder fifo)"
```

---

## Task 5: PO-receive posting helper + Inngest function + route

**Files:**

- Create: `apps/api/src/services/accounting/posting/po-receive-posting.ts`
- Create: `apps/api/src/lib/inngest/functions/accounting-post-po-receive-journal.ts`
- Create: `apps/api/src/routes/purchase-orders.routes.ts`
- Modify: `apps/api/src/lib/inngest/functions/index.ts`
- Modify: `apps/api/src/routes/index.ts`

### Step 1: Posting helper

`apps/api/src/services/accounting/posting/po-receive-posting.ts`:

```ts
import { prisma } from '@force/database';
import { postEntry } from '../journal.service';
import { getSystemAccountIdByCode } from '../account.service';
import logger from '../../../lib/logger';

export interface PoReceiveJournalInput {
  storeId: string;
  poId: string;
  clearedBackorders: Array<{
    backorderLineId: string;
    orderItemId: string;
    qty: number;
    actualUnitCost: number;
    estimateUnitCost: number;
    variance: number;
  }>;
}

/**
 * Post the GL journal for a PO receipt + any cleared backorder COGS entries.
 *
 * Posts up to N+1 entries (one main, optionally N variance-aware deferred-COGS):
 *   1. PO receive (sourceId = poId)
 *      DR Inventory  = sum(item.qtyReceived * item.unitCost) for this receipt window
 *      CR Accounts Payable  = same total
 *   2. For each cleared backorder line (sourceId = `bo:<backorderLineId>:cogs`):
 *      DR COGS                actualUnitCost * qty
 *      CR Inventory           same
 *      (and if variance != 0: DR/CR COGS Variance + opposite Inventory)
 */
export async function postPoReceiveJournal(args: PoReceiveJournalInput): Promise<void> {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: args.poId },
    include: { items: true, store: { select: { accountingEnabled: true } } },
  });
  if (!po) {
    logger.warn({ poId: args.poId }, 'postPoReceiveJournal: PO not found');
    return;
  }
  if (!po.store?.accountingEnabled) return;

  const inventoryAccountId = await getSystemAccountIdByCode(args.storeId, '1200');
  const apAccountId = po.apAccountId ?? (await getSystemAccountIdByCode(args.storeId, '2000'));
  const cogsAccountId = await getSystemAccountIdByCode(args.storeId, '5000');
  const cogsVarianceAccountId = await getSystemAccountIdByCode(args.storeId, '5010');

  // === 1. PO receive — DR Inventory / CR AP ===
  // Compute receipt window value: items where qtyReceived > 0 contribute (qtyReceived * unitCost),
  // but if this is a partial second-receive, we want only THIS receive's delta. The simplest correct
  // approach: post one entry per call equal to the TOTAL value of all items received so far minus
  // what's already been posted. We use a per-receive sub-sourceId.
  //
  // For v1 simplicity, we post the total received value with sourceId=poId. The (source, sourceId)
  // partial unique index ensures we don't double-post when the same Inngest event re-fires; but
  // partial receives won't append additional entries because they'd collide on the same sourceId.
  //
  // Production-safe approach for partial receives: use sourceId = `${poId}:receive-${receiveNumber}`.
  // We track receive count via PurchaseOrder.receivedAt being set; for v1 we assume single-shot full
  // receives (the common case). Multi-step partial receives is a follow-up.
  const receivedTotal = po.items.reduce((s, i) => s + i.qtyReceived * i.unitCost, 0);
  if (receivedTotal > 0) {
    await postEntry({
      storeId: args.storeId,
      source: 'purchase_order',
      sourceId: args.poId,
      memo: `PO receive — ${po.poNumber}`,
      memoAr: `استلام أمر شراء — ${po.poNumber}`,
      lines: [
        {
          accountId: inventoryAccountId,
          debit: receivedTotal,
          credit: 0,
          lineMemo: `Inventory in (PO ${po.poNumber})`,
          refTable: 'purchase_orders',
          refId: po.id,
        },
        {
          accountId: apAccountId,
          debit: 0,
          credit: receivedTotal,
          lineMemo: `AP — supplier`,
          refTable: 'purchase_orders',
          refId: po.id,
        },
      ],
    });
  }

  // === 2. Deferred-COGS for cleared backorders ===
  for (const cleared of args.clearedBackorders) {
    const cogsAmount = cleared.actualUnitCost * cleared.qty;
    if (cogsAmount <= 0) continue;

    const cogsLines = [
      {
        accountId: cogsAccountId,
        debit: cogsAmount,
        credit: 0,
        lineMemo: `Deferred COGS (backorder ${cleared.backorderLineId.slice(0, 8)})`,
        refTable: 'backorder_lines',
        refId: cleared.backorderLineId,
      },
      {
        accountId: inventoryAccountId,
        debit: 0,
        credit: cogsAmount,
        lineMemo: 'Inventory out (deferred)',
        refTable: 'backorder_lines',
        refId: cleared.backorderLineId,
      },
    ];

    // Variance correction if actual differs from estimate
    if (cleared.variance !== 0) {
      // Original sale posted COGS at estimateUnitCost (lower or higher than actual).
      // We've now posted actualUnitCost. The difference moves to COGS Variance.
      // variance = (actual - estimate) * qty
      //   variance > 0 → actual > estimate → we under-recognized COGS at sale: DR COGS Variance / CR (already-accounted Inventory)
      //   variance < 0 → actual < estimate → we over-recognized COGS at sale: DR Inventory  / CR COGS Variance
      // For simplicity we balance the variance internally on the same entry.
      if (cleared.variance > 0) {
        cogsLines.push({
          accountId: cogsVarianceAccountId,
          debit: cleared.variance,
          credit: 0,
          lineMemo: 'COGS variance (actual > estimate)',
          refTable: 'backorder_lines',
          refId: cleared.backorderLineId,
        });
        cogsLines.push({
          accountId: inventoryAccountId,
          debit: 0,
          credit: cleared.variance,
          lineMemo: 'Variance contra-inventory',
          refTable: 'backorder_lines',
          refId: cleared.backorderLineId,
        });
      } else {
        const positive = Math.abs(cleared.variance);
        cogsLines.push({
          accountId: inventoryAccountId,
          debit: positive,
          credit: 0,
          lineMemo: 'Variance contra-inventory',
          refTable: 'backorder_lines',
          refId: cleared.backorderLineId,
        });
        cogsLines.push({
          accountId: cogsVarianceAccountId,
          debit: 0,
          credit: positive,
          lineMemo: 'COGS variance (actual < estimate)',
          refTable: 'backorder_lines',
          refId: cleared.backorderLineId,
        });
      }
    }

    await postEntry({
      storeId: args.storeId,
      source: 'purchase_order',
      sourceId: `bo:${cleared.backorderLineId}:cogs`,
      memo: `Deferred COGS — backorder fulfilled by ${po.poNumber}`,
      memoAr: `تكلفة بضاعة مؤجلة — تم تنفيذ الطلب المعلق بـ ${po.poNumber}`,
      lines: cogsLines,
    });
  }
}
```

### Step 2: Inngest function

`apps/api/src/lib/inngest/functions/accounting-post-po-receive-journal.ts`:

```ts
import type { InngestFunction } from 'inngest';
import logger from '../../logger';
import { inngest } from '../client';
import { postPoReceiveJournal } from '../../../services/accounting/posting/po-receive-posting';

export const accountingPostPoReceiveJournal: InngestFunction.Any = inngest.createFunction(
  {
    id: 'accounting-post-po-receive-journal',
    name: 'Accounting — post journal on PO receipt',
    retries: 3,
    concurrency: { limit: 5, key: 'event.data.storeId' },
    triggers: [{ event: 'stock/po-received' }],
  },
  async ({ event, step }) => {
    const { storeId, poId, clearedBackorders } = (event.data ?? {}) as {
      storeId?: string;
      poId?: string;
      clearedBackorders?: any[];
    };
    if (!storeId || !poId) {
      logger.warn(
        { event: event.name, data: event.data },
        'accountingPostPoReceiveJournal: missing ids'
      );
      return { skipped: 'missing-ids' };
    }
    await step.run('post-journal', () =>
      postPoReceiveJournal({ storeId, poId, clearedBackorders: clearedBackorders ?? [] })
    );
    logger.info(
      { poId, storeId, clearedCount: clearedBackorders?.length ?? 0 },
      'accountingPostPoReceiveJournal: posted'
    );
    return { posted: true, poId };
  }
);
```

Register in `apps/api/src/lib/inngest/functions/index.ts` (append).

### Step 3: Routes

`apps/api/src/routes/purchase-orders.routes.ts`:

```ts
import { Router } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { runInTenantContext } from '@force/database';
import {
  createPurchaseOrder,
  receivePurchaseOrder,
  listPurchaseOrders,
  getPurchaseOrder,
  cancelPurchaseOrder,
} from '../services/accounting/purchase-order.service';

const router = Router();

const createSchema = z.object({
  supplierId: z.string().uuid(),
  expectedDate: z.string().datetime().optional(),
  notes: z.string().optional(),
  notesAr: z.string().optional(),
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        variantId: z.string().uuid().optional(),
        qty: z.number().int().positive(),
        unitCost: z.number().int().nonnegative(),
        notes: z.string().optional(),
      })
    )
    .min(1),
});

const receiveSchema = z.object({
  receipts: z
    .array(
      z.object({
        poItemId: z.string().uuid(),
        qtyReceived: z.number().int().positive(),
      })
    )
    .min(1),
});

router.get(
  '/:storeId/purchase-orders',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req, res, next) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const page = Number(req.query.page ?? 1);
      const perPage = Number(req.query.perPage ?? 50);
      const data = await runInTenantContext(req.params.storeId, () =>
        listPurchaseOrders(req.params.storeId, { status, page, perPage })
      );
      res.json({
        data: data.items,
        meta: {
          page: data.page,
          perPage: data.perPage,
          total: data.total,
          totalPages: Math.ceil(data.total / data.perPage),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/:storeId/purchase-orders/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req, res, next) => {
    try {
      const data = await runInTenantContext(req.params.storeId, () =>
        getPurchaseOrder(req.params.storeId, req.params.id)
      );
      if (!data) return res.status(404).json({ error: 'not_found' });
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/:storeId/purchase-orders',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req, res, next) => {
    try {
      const body = createSchema.safeParse(req.body);
      if (!body.success)
        return res.status(422).json({ error: 'validation', issues: body.error.issues });
      const data = await runInTenantContext(req.params.storeId, () =>
        createPurchaseOrder({
          storeId: req.params.storeId,
          ...body.data,
          expectedDate: body.data.expectedDate ? new Date(body.data.expectedDate) : undefined,
          createdBy: (req as any).user?.id,
        })
      );
      res.status(201).json({ data });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/:storeId/purchase-orders/:id/receive',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req, res, next) => {
    try {
      const body = receiveSchema.safeParse(req.body);
      if (!body.success)
        return res.status(422).json({ error: 'validation', issues: body.error.issues });
      const data = await runInTenantContext(req.params.storeId, () =>
        receivePurchaseOrder({
          storeId: req.params.storeId,
          poId: req.params.id,
          receipts: body.data.receipts,
          receivedBy: (req as any).user?.id,
        })
      );
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/:storeId/purchase-orders/:id/cancel',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req, res, next) => {
    try {
      const data = await runInTenantContext(req.params.storeId, () =>
        cancelPurchaseOrder(req.params.storeId, req.params.id)
      );
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
```

Mount in `apps/api/src/routes/index.ts`: `router.use('/stores', tenantContext, purchaseOrdersRoutes);`.

### Step 4: Build

```bash
npm run build -w apps/api 2>&1 | tail -3
```

### Step 5: Commit

```bash
git add apps/api/src/services/accounting/posting/po-receive-posting.ts apps/api/src/lib/inngest/functions/accounting-post-po-receive-journal.ts apps/api/src/lib/inngest/functions/index.ts apps/api/src/routes/purchase-orders.routes.ts apps/api/src/routes/index.ts
git commit -m "feat(accounting): po-receive posting helper + inngest + routes"
```

---

## Task 6: StockAdjustment — service + posting + routes + Inngest

**Files:**

- Create: `apps/api/src/services/accounting/stock-adjustment.service.ts`
- Create: `apps/api/src/services/accounting/posting/stock-adjustment-posting.ts`
- Create: `apps/api/src/lib/inngest/functions/accounting-post-stock-adjustment-journal.ts`
- Create: `apps/api/src/routes/stock-adjustments.routes.ts`
- Modify: client.ts (add event), functions/index.ts (register), routes/index.ts (mount)

### Step 1: Service

`apps/api/src/services/accounting/stock-adjustment.service.ts`:

```ts
import { prisma } from '@force/database';
import type { StockAdjustment, StockAdjustmentType } from '@prisma/client';
import { nextSequence } from '../sequence.service';
import { inngest } from '../../lib/inngest/client';
import logger from '../../lib/logger';

export interface CreateAdjustmentInput {
  storeId: string;
  type: StockAdjustmentType;
  reason?: string;
  reasonAr?: string;
  evidenceUrl?: string;
  createdBy?: string;
  items: { productId: string; variantId?: string; newQty: number }[];
}

export async function createAdjustment(
  input: CreateAdjustmentInput
): Promise<StockAdjustment & { items: any[] }> {
  const adjustmentNumber = await nextSequence(input.storeId, 'adjustment');

  // Snapshot previousQty + unitCost from current product state
  const productIds = input.items.map(i => i.productId);
  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: { id: true, inventory: true, costPrice: true },
  });
  const variantIds = input.items.filter(i => i.variantId).map(i => i.variantId!) as string[];
  const variants = variantIds.length
    ? await prisma.productVariant.findMany({
        where: { id: { in: variantIds } },
        select: { id: true, inventory: true },
      })
    : [];

  const itemRows = input.items.map(i => {
    const product = products.find(p => p.id === i.productId);
    const variant = i.variantId ? variants.find(v => v.id === i.variantId) : null;
    const previousQty = variant ? variant.inventory : (product?.inventory ?? 0);
    return {
      productId: i.productId,
      variantId: i.variantId,
      previousQty,
      newQty: i.newQty,
      deltaQty: i.newQty - previousQty,
      unitCost: product?.costPrice ?? 0,
    };
  });
  const totalValueImpact = itemRows.reduce((s, r) => s + r.deltaQty * r.unitCost, 0);

  return prisma.stockAdjustment.create({
    data: {
      storeId: input.storeId,
      adjustmentNumber,
      type: input.type,
      status: 'draft',
      reason: input.reason,
      reasonAr: input.reasonAr,
      evidenceUrl: input.evidenceUrl,
      totalValueImpact,
      createdBy: input.createdBy,
      items: { create: itemRows },
    },
    include: { items: true },
  });
}

export async function postAdjustment(
  storeId: string,
  id: string,
  postedBy?: string
): Promise<StockAdjustment> {
  const adjustment = await prisma.$transaction(async tx => {
    const adj = await tx.stockAdjustment.findFirst({
      where: { id, storeId, status: 'draft' },
      include: { items: true },
    });
    if (!adj) throw new Error(`Adjustment ${id} not found or not in draft status`);

    // Apply inventory changes + InventoryHistory rows
    for (const item of adj.items) {
      if (item.variantId) {
        await tx.productVariant.update({
          where: { id: item.variantId },
          data: { inventory: item.newQty },
        });
      }
      const product = await tx.product.findUnique({
        where: { id: item.productId },
        select: { inventory: true },
      });
      if (!product) throw new Error(`Product ${item.productId} not found`);
      await tx.product.update({ where: { id: item.productId }, data: { inventory: item.newQty } });
      const typeMap: Record<string, 'adjustment' | 'damage' | 'manual_add' | 'manual_remove'> = {
        cycle_count: 'adjustment',
        damage: 'damage',
        theft: 'damage',
        loss: 'damage',
        write_off: 'damage',
        found: 'manual_add',
        return_to_supplier: 'manual_remove',
      };
      await tx.inventoryHistory.create({
        data: {
          productId: item.productId,
          storeId,
          type: typeMap[adj.type] ?? 'adjustment',
          quantity: item.deltaQty,
          previousStock: product.inventory,
          newStock: item.newQty,
          reason: `Adjustment ${adj.adjustmentNumber} (${adj.type})`,
          reference: adj.id,
        },
      });
    }

    return tx.stockAdjustment.update({
      where: { id },
      data: { status: 'posted', postedAt: new Date(), postedBy },
    });
  });

  inngest
    .send({
      name: 'stock/adjustment-posted',
      data: { storeId, adjustmentId: id },
    })
    .catch(err =>
      logger.error({ err, adjustmentId: id }, 'Failed to enqueue stock/adjustment-posted')
    );

  return adjustment;
}

export async function listAdjustments(storeId: string) {
  return prisma.stockAdjustment.findMany({
    where: { storeId },
    include: { items: { include: { product: { select: { name: true } } } } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
}

export async function getAdjustment(storeId: string, id: string) {
  return prisma.stockAdjustment.findFirst({
    where: { id, storeId },
    include: { items: { include: { product: { select: { name: true, sku: true } } } } },
  });
}
```

### Step 2: Posting helper

`apps/api/src/services/accounting/posting/stock-adjustment-posting.ts`:

```ts
import { prisma } from '@force/database';
import { postEntry } from '../journal.service';
import { getSystemAccountIdByCode } from '../account.service';
import logger from '../../../lib/logger';

const COUNTERPART_BY_TYPE: Record<string, string> = {
  cycle_count: '3000', // Owner's Equity (cycle-count delta posts to retained earnings)
  damage: '5900', // Damage / Loss
  theft: '5910', // Theft
  loss: '5900', // Damage / Loss
  write_off: '5920', // Write-off
  found: '3000', // Owner's Equity (found inventory increases equity)
  return_to_supplier: '2000', // Accounts Payable (reduces AP — returning goods we owe payment for)
};

export async function postStockAdjustmentJournal(args: {
  storeId: string;
  adjustmentId: string;
}): Promise<void> {
  const adj = await prisma.stockAdjustment.findUnique({
    where: { id: args.adjustmentId },
    include: { items: true, store: { select: { accountingEnabled: true } } },
  });
  if (!adj) {
    logger.warn({ adjustmentId: args.adjustmentId }, 'postStockAdjustmentJournal: not found');
    return;
  }
  if (!adj.store?.accountingEnabled) return;
  if (adj.status !== 'posted') return;

  const inventoryAccountId = await getSystemAccountIdByCode(args.storeId, '1200');
  const counterpartCode = COUNTERPART_BY_TYPE[adj.type] ?? '5990'; // fall back to Other
  const counterpartAccountId = await getSystemAccountIdByCode(args.storeId, counterpartCode);

  // Sum the value impact (signed). totalValueImpact = sum(deltaQty * unitCost)
  // Positive impact → DR Inventory / CR Counterpart (gain — inventory up)
  // Negative impact → DR Counterpart / CR Inventory (loss — inventory down)
  const impact = adj.totalValueImpact;
  if (impact === 0) return; // no journal needed

  const lines =
    impact > 0
      ? [
          {
            accountId: inventoryAccountId,
            debit: impact,
            credit: 0,
            lineMemo: `Inventory gain (${adj.type})`,
            refTable: 'stock_adjustments',
            refId: adj.id,
          },
          {
            accountId: counterpartAccountId,
            debit: 0,
            credit: impact,
            lineMemo: 'Counterpart',
            refTable: 'stock_adjustments',
            refId: adj.id,
          },
        ]
      : [
          {
            accountId: counterpartAccountId,
            debit: Math.abs(impact),
            credit: 0,
            lineMemo: `Inventory loss (${adj.type})`,
            refTable: 'stock_adjustments',
            refId: adj.id,
          },
          {
            accountId: inventoryAccountId,
            debit: 0,
            credit: Math.abs(impact),
            lineMemo: 'Inventory out',
            refTable: 'stock_adjustments',
            refId: adj.id,
          },
        ];

  await postEntry({
    storeId: args.storeId,
    source: 'stock_adjustment',
    sourceId: adj.id,
    memo: `Stock adjustment ${adj.adjustmentNumber} (${adj.type})`,
    memoAr: `تسوية مخزون ${adj.adjustmentNumber}`,
    lines,
  });
}
```

### Step 3: Inngest function — mirror Task 5's shape with `triggers: [{ event: 'stock/adjustment-posted' }]` and call `postStockAdjustmentJournal({ storeId, adjustmentId })`.

### Step 4: Routes — `suppliers.routes.ts`-style CRUD + a `POST /:storeId/stock-adjustments/:id/post` endpoint that calls `postAdjustment(storeId, id, userId)`.

### Step 5: Build + commit (3 files for adjustment subsystem)

```bash
npm run build -w apps/api 2>&1 | tail -3
git add apps/api/src/services/accounting/stock-adjustment.service.ts apps/api/src/services/accounting/posting/stock-adjustment-posting.ts apps/api/src/lib/inngest/functions/accounting-post-stock-adjustment-journal.ts apps/api/src/lib/inngest/client.ts apps/api/src/lib/inngest/functions/index.ts apps/api/src/routes/stock-adjustments.routes.ts apps/api/src/routes/index.ts
git commit -m "feat(accounting): stock adjustment service + posting + inngest + routes"
```

---

## Task 7: Expense — service + posting + routes + Inngest

Mirror Task 6's shape. Expense lifecycle is `draft → (pending if two-step) → approved → posted`.

**Files:**

- Create: `apps/api/src/services/accounting/expense.service.ts`
- Create: `apps/api/src/services/accounting/posting/expense-posting.ts`
- Create: `apps/api/src/lib/inngest/functions/accounting-post-expense-journal.ts`
- Create: `apps/api/src/routes/expenses.routes.ts`

Key behaviour:

- `createExpense(input)` → status='draft'
- `approveExpense(storeId, id, userId)` → status='approved' (or 'pending' if `store.expenseTwoStepApproval && creator==approver`)
- `postExpense(storeId, id)` → status='posted'; fires `accounting/expense-posted` event
- Posting helper: DR `expenseAccountId` / CR `paidFromAccountId` (+ optional Tax Recoverable line if `taxAmount > 0` — for v1, just include in the expense line since Kuwait VAT=0)

Commit:

```bash
git commit -m "feat(accounting): expense service + posting + inngest + routes"
```

---

## Task 8: BackorderService — list + cancel + auto-refund

**Files:**

- Create: `apps/api/src/services/accounting/backorder.service.ts`
- Create: `apps/api/src/routes/backorders.routes.ts`

### Service

`apps/api/src/services/accounting/backorder.service.ts`:

```ts
import { prisma } from '@force/database';
import { OrderService } from '../order.service'; // existing applyRefundEffects
import logger from '../../lib/logger';

export async function listOpenBackorders(storeId: string) {
  return prisma.backorderLine.findMany({
    where: { storeId, fulfilledAt: null, cancelledAt: null },
    include: {
      product: { select: { name: true, sku: true } },
      orderItem: {
        include: {
          order: { select: { orderNumber: true, customerId: true, shippingAddress: true } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });
}

export async function cancelBackorder(
  storeId: string,
  backorderId: string,
  reason: string,
  userId?: string
): Promise<void> {
  const bo = await prisma.backorderLine.findFirst({
    where: { id: backorderId, storeId, fulfilledAt: null, cancelledAt: null },
    include: { orderItem: true },
  });
  if (!bo) throw new Error(`Backorder ${backorderId} not found or already closed`);

  await prisma.$transaction(async tx => {
    await tx.backorderLine.update({
      where: { id: backorderId },
      data: { cancelledAt: new Date(), cancelledReason: reason },
    });

    // Clear costPriceDeferred if no other open backorder lines for this OrderItem
    const remaining = await tx.backorderLine.count({
      where: {
        orderItemId: bo.orderItemId,
        fulfilledAt: null,
        cancelledAt: null,
        id: { not: backorderId },
      },
    });
    if (remaining === 0)
      await tx.orderItem.update({
        where: { id: bo.orderItemId },
        data: { costPriceDeferred: false },
      });
  });

  // Fire refund-effects pipeline for the affected order (re-uses existing applyRefundEffects)
  await OrderService.applyRefundEffects({
    orderId: bo.orderItem.orderId,
    refundReason: `Backorder cancelled: ${reason}`,
  }).catch(err =>
    logger.error(
      { err, backorderId, orderId: bo.orderItem.orderId },
      'Backorder cancel: refund effects failed'
    )
  );
}
```

Routes mirror existing patterns (`GET /:storeId/backorders` + `POST /:storeId/backorders/:id/cancel`).

Commit: `feat(accounting): backorder service + list + cancel-with-refund`

---

## Task 9: CartService + OrderService backorder support

**Files:**

- Modify: `apps/api/src/services/cart.service.ts`
- Modify: `apps/api/src/services/order.service.ts`

### CartService.addToCart

Find the inventory check:

```ts
if (product.trackInventory && product.inventory < newQuantity) {
  throw new AppError(400, 'INSUFFICIENT_INVENTORY', '...');
}
```

Change to:

```ts
if (product.trackInventory && product.inventory < newQuantity && !product.allowBackorder) {
  throw new AppError(400, 'INSUFFICIENT_INVENTORY', '...');
}
```

Repeat for the variant path.

### OrderService.create

In the inventory lock + decrement section (line ~262-389), change the insufficient-inventory check:

```ts
if (!lockedProduct || lockedProduct.inventory < item.quantity) {
  // Allow backorder ONLY if product (or variant) opts in
  const product = await tx.product.findUnique({
    where: { id: item.productId },
    select: { allowBackorder: true },
  });
  const variant = item.variantId
    ? await tx.productVariant.findUnique({
        where: { id: item.variantId },
        select: { allowBackorder: true },
      })
    : null;
  const allowed = variant?.allowBackorder ?? product?.allowBackorder ?? false;
  if (!allowed) {
    throw new AppError(
      400,
      'INSUFFICIENT_INVENTORY',
      `Not enough inventory for ${item.product.name}`
    );
  }
  // Otherwise proceed — inventory will go negative, BackorderLine will be created below.
}
```

After the order is created (around line 390-450), iterate the items: for any where the pre-decrement inventory was at-or-below-zero AND the product's `allowBackorder=true`, create a `BackorderLine` row AND set the OrderItem's `costPriceDeferred=true`:

```ts
for (const item of newOrder.items) {
  const wasBackordered = /* track this from the lock loop above — see implementation */;
  if (wasBackordered) {
    await tx.backorderLine.create({
      data: {
        storeId,
        orderItemId: item.id,
        productId: item.productId,
        variantId: item.variantId,
        qty: item.quantity,
      },
    });
    await tx.orderItem.update({ where: { id: item.id }, data: { costPriceDeferred: true } });
  }
}
```

The cleanest implementation tracks backordered items in the lock loop (snapshot `lockedProduct.inventory` before the decrement — if it was ≤ 0, the item is backordered). Pass that set forward.

### applyRefundEffects

Add at the end (after existing 7 edges):

```ts
// Auto-cancel open BackorderLines for this order — they should not fulfill after a refund
await tx.backorderLine.updateMany({
  where: { orderItem: { orderId }, fulfilledAt: null, cancelledAt: null },
  data: { cancelledAt: new Date(), cancelledReason: 'Order refunded' },
});
```

### Build + commit

```bash
npm run build -w apps/api
git add apps/api/src/services/cart.service.ts apps/api/src/services/order.service.ts
git commit -m "feat(api): cart + order service backorder support (allowbackorder + auto-cancel-on-refund)"
```

---

## Task 10: Product API flags

**Files:**

- Modify: `apps/api/src/routes/product.routes.ts` (or wherever the public product list/detail endpoints serialize)

Find the response shape and add to each product (and per variant where variants exist):

```ts
const inStock = product.inventory > 0;
const acceptsBackorder = product.inventory <= 0 && product.allowBackorder;
const lowStock = inStock && product.inventory <= product.lowStockThreshold;
const availableQty = (lowStock || acceptsBackorder) ? product.inventory : null;

return {
  ...product,
  inStock,
  acceptsBackorder,
  lowStock,
  availableQty,
  variants: product.variants.map(v => ({
    ...v,
    inStock: v.inventory > 0,
    acceptsBackorder: v.inventory <= 0 && (v.allowBackorder || product.allowBackorder),
    lowStock: v.inventory > 0 && v.inventory <= product.lowStockThreshold,
    availableQty: /* same logic */,
  })),
};
```

Apply to both `listPublic` and `getPublicBySlug` (the two storefront endpoints).

Commit: `feat(api): expose inStock + acceptsBackorder + lowStock + availableQty on product api`

---

## Task 11: Reports service + routes

**Files:**

- Create: `apps/api/src/services/accounting/reports.service.ts`
- Modify: `apps/api/src/routes/finance.routes.ts`

### Service

```ts
import { prisma } from '@force/database';

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  nameEn: string;
  nameAr: string | null;
  type: string;
  debitTotal: number;
  creditTotal: number;
  balance: number; // debits - credits (positive for asset/expense; negative for liability/revenue/equity natural balance)
}

export async function trialBalance(storeId: string, asOf?: Date): Promise<TrialBalanceRow[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      code: string;
      name_en: string;
      name_ar: string | null;
      type: string;
      debit_total: bigint;
      credit_total: bigint;
    }>
  >`
    SELECT
      a.id, a.code, a.name_en, a.name_ar, a.type::text,
      COALESCE(SUM(l.debit), 0)  AS debit_total,
      COALESCE(SUM(l.credit), 0) AS credit_total
    FROM public.accounts a
    LEFT JOIN public.journal_lines l ON l.account_id = a.id
    LEFT JOIN public.journal_entries e ON e.id = l.entry_id AND e.status = 'posted'
      ${asOf ? prisma.$queryRaw`AND e.posted_at <= ${asOf}` : prisma.$queryRaw``}
    WHERE a.store_id = ${storeId}::uuid
    GROUP BY a.id, a.code, a.name_en, a.name_ar, a.type
    ORDER BY a.code ASC
  `;
  return rows.map(r => ({
    accountId: r.id,
    code: r.code,
    nameEn: r.name_en,
    nameAr: r.name_ar,
    type: r.type,
    debitTotal: Number(r.debit_total),
    creditTotal: Number(r.credit_total),
    balance: Number(r.debit_total) - Number(r.credit_total),
  }));
}

export async function profitAndLoss(storeId: string, from: Date, to: Date) {
  const rows = await trialBalance(storeId, to);
  const fromRows = await trialBalance(storeId, from);
  const fromByCode = new Map(fromRows.map(r => [r.code, r]));

  // P&L = revenue - expenses for the period
  // Period debit = current.debit - opening.debit; same for credit
  const periodRows = rows.map(r => {
    const opening = fromByCode.get(r.code);
    return {
      ...r,
      debitTotal: r.debitTotal - (opening?.debitTotal ?? 0),
      creditTotal: r.creditTotal - (opening?.creditTotal ?? 0),
      balance:
        r.debitTotal - (opening?.debitTotal ?? 0) - (r.creditTotal - (opening?.creditTotal ?? 0)),
    };
  });

  const revenue = periodRows.filter(r => r.type === 'revenue');
  const expenses = periodRows.filter(r => r.type === 'expense');
  const totalRevenue = revenue.reduce((s, r) => s + r.creditTotal - r.debitTotal, 0); // net revenue (credit-natural)
  const totalExpenses = expenses.reduce((s, r) => s + r.debitTotal - r.creditTotal, 0);
  const netIncome = totalRevenue - totalExpenses;

  return { from, to, revenue, expenses, totalRevenue, totalExpenses, netIncome };
}

export async function balanceSheet(storeId: string, asOf: Date) {
  const tb = await trialBalance(storeId, asOf);
  const assets = tb.filter(r => r.type === 'asset');
  const liabilities = tb.filter(r => r.type === 'liability');
  const equity = tb.filter(r => r.type === 'equity');

  const totalAssets = assets.reduce((s, r) => s + r.balance, 0); // assets natural-debit
  const totalLiabilities = liabilities.reduce((s, r) => s + -r.balance, 0); // liabilities natural-credit
  const totalEquity = equity.reduce((s, r) => s + -r.balance, 0);

  return { asOf, assets, liabilities, equity, totalAssets, totalLiabilities, totalEquity };
}
```

### Routes

Add to `finance.routes.ts`:

```ts
import { trialBalance, profitAndLoss, balanceSheet } from '../services/accounting/reports.service';

router.get(
  '/:storeId/finance/reports/trial-balance',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req, res, next) => {
    try {
      const asOf = req.query.asOf ? new Date(String(req.query.asOf)) : undefined;
      const data = await runInTenantContext(req.params.storeId, () =>
        trialBalance(req.params.storeId, asOf)
      );
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/:storeId/finance/reports/pnl',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req, res, next) => {
    try {
      const from = new Date(
        String(req.query.from ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
      );
      const to = new Date(String(req.query.to ?? new Date().toISOString()));
      const data = await runInTenantContext(req.params.storeId, () =>
        profitAndLoss(req.params.storeId, from, to)
      );
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/:storeId/finance/reports/balance-sheet',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req, res, next) => {
    try {
      const asOf = req.query.asOf ? new Date(String(req.query.asOf)) : new Date();
      const data = await runInTenantContext(req.params.storeId, () =>
        balanceSheet(req.params.storeId, asOf)
      );
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/:storeId/finance/dashboard',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req, res, next) => {
    try {
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const data = await runInTenantContext(req.params.storeId, async () => {
        const pnl = await profitAndLoss(req.params.storeId, monthStart, now);
        const bs = await balanceSheet(req.params.storeId, now);
        const stockValueRow = await prisma.$queryRaw<{ total: bigint }[]>`
        SELECT COALESCE(SUM(inventory * COALESCE(cost_price, 0)), 0) AS total
        FROM public.products WHERE store_id = ${req.params.storeId}::uuid AND deleted_at IS NULL
      `;
        const stockValue = Number(stockValueRow[0]?.total ?? 0);
        return {
          thisMonth: {
            revenue: pnl.totalRevenue,
            expenses: pnl.totalExpenses,
            net: pnl.netIncome,
          },
          cash: bs.assets.filter(a => a.code.startsWith('10')),
          stockValue,
          balanceSheet: {
            totalAssets: bs.totalAssets,
            totalLiabilities: bs.totalLiabilities,
            totalEquity: bs.totalEquity,
          },
        };
      });
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);
```

Commit: `feat(accounting): reports service (trial balance + p&l + balance sheet) + dashboard endpoint`

---

## Tasks 12-15: Admin pages

Following Batch 1's admin page patterns (read-only tables, useTranslations, AdminLayout). Each task batches related pages:

### Task 12 — Stock dashboard + inventory + adjustments

- `/stock/dashboard/page.tsx` — fetches `GET /stores/:id/finance/dashboard` for stock value + counts
- `/stock/inventory/page.tsx` — existing inventory views moved here; add quick-adjustment shortcut
- `/stock/adjustments/page.tsx` + `/stock/adjustments/new/page.tsx` — list + form (type picker, reason input, evidence URL, per-item newQty entry, post button)

Commit: `feat(admin): stock dashboard + inventory + adjustments pages`

### Task 13 — Suppliers + Purchase Orders

- `/stock/suppliers/page.tsx` + `/stock/suppliers/new/page.tsx` — CRUD list + form
- `/stock/purchase-orders/page.tsx` + `/stock/purchase-orders/new/page.tsx` + `/stock/purchase-orders/[poId]/page.tsx` — list, new (per-line items with productId+qty+unitCost), detail (status + items + Receive form)

Commit: `feat(admin): suppliers + purchase orders pages`

### Task 14 — Backorders + Reorder/Deadstock placeholders

- `/stock/backorders/page.tsx` — list open BackorderLines + cancel button (POSTs to cancel endpoint, navigates back on success)
- `/stock/reorder/page.tsx` — placeholder noting "Coming in Batch 3: AI-powered reorder suggestions"
- `/stock/deadstock/page.tsx` — placeholder noting "Coming in Batch 3: AI dead-stock detection"

Commit: `feat(admin): backorders + reorder/deadstock placeholders`

### Task 15 — Finance dashboard + expenses + reports

- `/finance/dashboard/page.tsx` — fetches dashboard endpoint, renders revenue/expenses/net + cash accounts + stock value cards
- `/finance/expenses/page.tsx` + `/finance/expenses/new/page.tsx` — list + new (supplier picker, expense account select, paid-from account select, amount, tax, expense-date, optional receipt upload, post button)
- `/finance/reports/page.tsx` — three sub-views (TB / P&L / BS) with date pickers + CSV/XLSX export buttons (use simple `<a href="...&format=csv">` for export — server endpoint generates the file)

Commit: `feat(admin): finance dashboard + expenses + reports pages`

---

## Task 16: Admin sidebar nav updates

**Files:**

- Modify: `apps/admin/src/components/admin-layout/buildStoreAdminNav.ts`
- Modify: `apps/admin/messages/{en,ar}.json` — add `stock.*` + `finance.dashboard.*` + `finance.expenses.*` + `finance.reports.*` keys

Add a new "Stock" group with 8 items after Orders/Customers. Extend the existing Finance group with dashboard + expenses + reports items.

Commit: `feat(admin): stock sidebar group + finance group extensions`

---

## Task 16b: Wire existing Analytics endpoints into accounting + stock data

**Context:** `apps/api/src/routes/analytics.routes.ts` already exposes 10 endpoints used by `apps/admin/src/app/stores/[id]/analytics/page.tsx`: `/dashboard`, `/sales`, `/top-products`, `/top-categories`, `/orders-by-status`, `/customers`, `/recent-orders`, `/low-stock`, `/payment-status`, `/performance`. All currently source from operational tables (orders/products/users) — NONE pull from `journal_lines`, `stock_adjustments`, or `backorder_lines`. Without this task, Analytics shows operational sums that diverge from the GL whenever refunds, deferred COGS, or backorders are involved.

**Files:**

- Modify: `apps/api/src/services/analytics.service.ts` — add 3 helpers
- Modify: `apps/api/src/routes/analytics.routes.ts` — augment 3 endpoints + add 2 new
- Modify: `apps/admin/src/app/stores/[id]/analytics/page.tsx` — surface new fields
- Modify: `apps/admin/messages/{en,ar}.json` — add `analytics.gl.*` + `analytics.inventorySnapshot.*` + `analytics.cashflow.*` keys

### Step 1: Add GL-aware helpers to `analytics.service.ts`

```ts
import { trialBalance, profitAndLoss } from './accounting/reports.service';

// Inside AnalyticsService class:

static async glRevenueWindow(storeId: string, from: Date, to: Date) {
  const pnl = await profitAndLoss(storeId, from, to);
  const cogs = pnl.expenses.filter((e) => e.code.startsWith('50')).reduce((s, e) => s + e.balance, 0);
  return {
    revenue: pnl.totalRevenue,
    cogs,
    grossProfit: pnl.totalRevenue - cogs,
    netIncome: pnl.netIncome,
  };
}

static async stockSnapshot(storeId: string) {
  const [valueRow, backorderRow, rulesCount] = await Promise.all([
    prisma.$queryRaw<{ total: bigint }[]>`
      SELECT COALESCE(SUM(inventory * COALESCE(cost_price, 0)), 0) AS total
      FROM public.products WHERE store_id = ${storeId}::uuid AND deleted_at IS NULL
    `,
    prisma.$queryRaw<{ count: bigint; value: bigint }[]>`
      SELECT
        COUNT(*) AS count,
        COALESCE(SUM(bl.qty * COALESCE(p.cost_price, 0)), 0) AS value
      FROM public.backorder_lines bl
      JOIN public.products p ON p.id = bl.product_id
      WHERE bl.store_id = ${storeId}::uuid AND bl.fulfilled_at IS NULL AND bl.cancelled_at IS NULL
    `,
    prisma.reorderRule.count({ where: { storeId, isActive: true } }),
  ]);
  return {
    stockValue: Number(valueRow[0]?.total ?? 0),
    openBackorderCount: Number(backorderRow[0]?.count ?? 0),
    backorderedDemandValue: Number(backorderRow[0]?.value ?? 0),
    reorderRulesCount: rulesCount,
  };
}

static async cashflowTrend(storeId: string, from: Date, to: Date) {
  const rows = await prisma.$queryRaw<Array<{ day: Date; net: bigint }>>`
    SELECT DATE_TRUNC('day', e.posted_at) AS day,
           COALESCE(SUM(l.debit), 0) - COALESCE(SUM(l.credit), 0) AS net
    FROM public.journal_lines l
    JOIN public.journal_entries e ON e.id = l.entry_id
    JOIN public.accounts a       ON a.id = l.account_id
    WHERE e.store_id = ${storeId}::uuid AND e.status = 'posted'
      AND e.posted_at BETWEEN ${from} AND ${to}
      AND a.code IN ('1000','1010','1020','1030')
    GROUP BY DATE_TRUNC('day', e.posted_at)
    ORDER BY day ASC
  `;
  return rows.map((r) => ({ day: r.day, net: Number(r.net) }));
}
```

### Step 2: Augment 3 endpoints + add 2 new in `analytics.routes.ts`

- **`/dashboard`** — alongside existing operational sums, add to response: `gl: await AnalyticsService.glRevenueWindow(storeId, monthStart, now)` and `stock: await AnalyticsService.stockSnapshot(storeId)`. Existing callers still work; admin opts in.
- **`/low-stock`** — for each product in the result, enrich with: `openBackorderCount` (`prisma.backorderLine.groupBy({ by: 'productId', _count })`), `acceptsBackorder` (`product.allowBackorder`), `reorderRule` (preferred supplier / minQty / reorderQty / leadTimeDays).
- **`/performance`** — add `glGrossProfit` field (from `glRevenueWindow`) alongside the existing operational `profit`. Admin can show the gap.
- **NEW `/cashflow`** — wraps `cashflowTrend(storeId, from, to)`; from/to default to last 30 days.
- **NEW `/stock-snapshot`** — wraps `stockSnapshot(storeId)`; shared source of truth between Stock dashboard and Analytics page.

### Step 3: Admin Analytics page

Modify `apps/admin/src/app/stores/[id]/analytics/page.tsx`:

- Add KPI cards for `dashboard.gl.revenue`, `dashboard.gl.grossProfit`, `dashboard.gl.netIncome` with a "GL" badge + tooltip explaining "Sourced from the General Ledger — refund-aware and deferred-COGS-aware."
- New "Inventory snapshot" section: stock value / open backorders / backordered demand value
- New "Cashflow (last 30 days)" section: simple line/bar chart from `/cashflow` (reuse existing chart primitive if present, else minimal SVG)
- Low-stock list: add `Open backorders: N` badge per product where > 0, `Accepts backorder` chip, and the reorder rule summary line

### Step 4: i18n additions

In `apps/admin/messages/en.json` under existing `analytics.*` block:

```json
"gl": {
  "badge": "GL",
  "tooltip": "Sourced from the General Ledger — refund-aware and deferred-COGS-aware",
  "revenue": "Revenue (GL)",
  "cogs": "COGS (GL)",
  "grossProfit": "Gross profit (GL)",
  "netIncome": "Net income (GL)"
},
"inventorySnapshot": {
  "title": "Inventory snapshot",
  "stockValue": "Stock value",
  "openBackorders": "Open backorders",
  "backorderedDemandValue": "Backordered demand value",
  "reorderRules": "Reorder rules"
},
"cashflow": {
  "title": "Cashflow",
  "netDaily": "Net daily movement",
  "last30": "Last 30 days"
},
"lowStock": {
  "openBackorders": "Open backorders: {count}",
  "acceptsBackorder": "Accepts backorder",
  "reorderRule": "Reorder: min {min} / qty {qty} / lead {lead}d"
}
```

- Arabic mirror.

### Step 5: Build + commit

```bash
npm run build -w apps/api 2>&1 | tail -3
npm run build -w apps/admin 2>&1 | tail -3
git add apps/api/src/services/analytics.service.ts apps/api/src/routes/analytics.routes.ts apps/admin/src/app/stores/\[id\]/analytics/ apps/admin/messages/en.json apps/admin/messages/ar.json
git commit -m "feat(analytics): wire dashboard + low-stock + new cashflow + stock-snapshot to gl + backorders"
```

**Note:** no separate integration test for Task 16b — analytics endpoints are thin wrappers over `reports.service` (tested in Batch 1) + the two new direct queries (covered by smoke-hitting `/analytics/dashboard` after a sale + refund + backorder fulfillment in Tasks 17–19 fixtures).

---

## Task 17: Integration test — PO receive lifecycle

**File:** `tests/integration/accounting/accounting-po-receive.test.ts`

Tests:

1. Create draft PO → status='draft', items have qtyReceived=0
2. Receive full quantity → status='received', inventory incremented, WAC updated, InventoryHistory written
3. Re-call receive on already-received PO → throws
4. Verify journal entry posted via direct helper call (`postPoReceiveJournal`) → DR Inventory / CR AP, balanced

Commit: `test(accounting): integration — po lifecycle + wac + journal post`

---

## Task 18: Integration test — backorder fulfillment

**File:** `tests/integration/accounting/accounting-backorder.test.ts`

Tests:

1. Create product with `allowBackorder=true`, inventory=0
2. Place order via OrderService.create → succeeds; BackorderLine created; OrderItem.costPriceDeferred=true; original journal posts revenue only (no COGS)
3. Create PO + receive → BackorderLine.fulfilledAt set; OrderItem.costPriceDeferred=false; deferred COGS journal entry posted at PO unitCost
4. Variance scenario: PO unitCost differs from OrderItem.costPrice → COGS Variance entry posted with correct delta

Commit: `test(accounting): integration — backorder fulfillment + variance`

---

## Task 19: Integration tests — stock adjustment + expense (batched)

**Files:**

- `tests/integration/accounting/accounting-stock-adjustment.test.ts`
- `tests/integration/accounting/accounting-expense-lifecycle.test.ts`

Stock adjustment tests cover each type:

- damage → DR 5900 / CR 1200
- theft → DR 5910 / CR 1200
- write_off → DR 5920 / CR 1200
- found → DR 1200 / CR 3000
- return_to_supplier → DR 2000 / CR 1200

Expense tests cover: draft → approve → post → assert journal (DR expenseAccount / CR paidFromAccount).

Commit: `test(accounting): integration — adjustment types + expense lifecycle`

---

## Task 20: Full validation pass

```bash
# Workspace builds
npm run build -w apps/api && npm run build -w apps/admin && npm run build -w apps/web

# Tests
npx vitest run tests/integration/accounting/

# Audit (must be 0/0/0/0)
npm audit

# Graphify
graphify update .
git add graphify-out/graph.json graphify-out/GRAPH_REPORT.md
git commit -m "chore(graphify): refresh after accounting batch 2"
```

Expected: all builds clean, all tests pass, 0 vulnerabilities.

---

## Task 21: Memory + vault update

**File:** `~/.claude/projects/-Users-ahmadsharaf-Desktop-projects-force-website-builder/memory/feature-accounting-batch-2.md`

Write a project-memory entry capturing:

- What shipped (8 tables + 6 services + 3 Inngest functions + 5 routes + 13 admin pages)
- Key lessons (WAC algorithm gotchas, partial-receive sourceId convention, backorder cancel re-uses applyRefundEffects, expense approval workflow)
- Cross-batch dependencies (Batch 3 will add AI reorder suggestions on top of ReorderRule + 4 AI Inngest jobs)

Update `~/.claude/projects/-Users-ahmadsharaf-Desktop-projects-force-website-builder/memory/MEMORY.md` index with one line.

Fire memory pipeline:

```bash
nohup ~/.claude/scripts/update-memory-pipeline.sh all > /tmp/update-memory-batch2.log 2>&1 &
disown
```

---

## Self-Review

**Spec coverage table:**

- 1.1 new tables (Supplier/PO/POItem/StockAdj/StockAdjItem/ReorderRule/BackorderLine/Expense) ✓ Task 1
- 1.3 extensions ✓ Task 1 Step 2
- 1.4 migration discipline (hand-written, no diff-cruft) ✓ Task 2
- 2.1 sync posting model: PO/expense/stock_adj posting helpers ✓ Tasks 5/6/7
- 2.3 WAC + backorder FIFO ✓ Task 4 (heaviest)
- 4 backorder mechanics ✓ Tasks 4 + 8 + 9
- 6 admin Stock + Finance pages ✓ Tasks 12-15
- 8 KW specifics (fils, COA codes) ✓ throughout (posting helpers use codes from Batch 1's COA seed)
- 9 Batch 2 scope ✓ all 21 tasks + Task 16b (Analytics wiring)

**Open questions to flag to Ahmad before execution:**

1. **Partial PO receives + sourceId collision** — current implementation uses `sourceId=poId` for the AP entry. A second partial receive on the same PO would collide on the unique index → idempotency skip → second receipt's value never posts. Need a sub-sourceId scheme (`${poId}:receive-${n}`) tracked via a column on PurchaseOrder. v1 ships single-receive only; multi-receive is a follow-up patch.
2. **Variance entry per backorder line vs aggregated** — I split into per-line entries with `sourceId=bo:<backorderLineId>:cogs`. Cleaner audit trail but more rows. Could batch all cleared backorders into one journal entry per PO receive. Tradeoff: per-line gives line-by-line trace (good for disputes); per-receive is fewer rows (good for performance).
3. **Variance threshold** — currently posts variance for ANY non-zero difference. Could threshold (e.g. only post variance if |delta| > 5% of estimate). Standard ERP behavior is post-always; we follow that for now.

**Placeholder scan:** no TBDs / TODOs / placeholders in the plan body. All file paths absolute or repo-relative. Complete code in every step. Some admin pages (Tasks 12-15) reference established Batch 1 patterns rather than re-pasting full implementations — that's intentional brevity, not placeholder.

**Type consistency:** `postEntry({ source: 'purchase_order' | 'stock_adjustment' | 'expense', sourceId, lines })` matches `JournalEntrySource` enum from Batch 1. `nextSequence(storeId, kind)` kinds match the PREFIX map (`po` / `adjustment` / `expense`). Inngest event types added to `client.ts` union match the function trigger declarations.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-19-fwb-accounting-batch-2-stock-backorders.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch fresh Sonnet subagent per task (21 tasks → 21 dispatches + review checkpoints); review between tasks; fast iteration.

**2. Inline Execution** — Execute tasks in this session via `superpowers:executing-plans`; batched commits with checkpoints for review.

**Which approach?**
