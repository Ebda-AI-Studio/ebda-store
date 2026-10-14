# FWB Accounting + Stock + Insights — Design

> **Correction (2026-09-22):** "Kuwait Law 13/2023" cited below does not exist. See docs/legal/gcc-data-protection.md for the verified GCC legal basis.

**Date:** 2026-05-19
**Status:** Approved by Ahmad 2026-05-19 (hybrid GL, single-warehouse, admin/backend only, weighted-average costing, all 4 AI features, opt-in backorders, Insights/BI tier added).
**Ships in:** four phased commit batches (Foundations → Stock → Smart Layer → Insights).
**Scope owner:** this session focuses on accounting + stock + insights. Two other Claude sessions own (a) FWB frontend, (b) FWB↔WBS integration. Clean lane separation: `apps/web` is untouched; we expose schema flags + Inngest events for the other sessions to consume.

---

## Goals

1. **Hybrid GL.** Real double-entry journal entries post under the hood (sale, refund, PO receipt, expense, stock adjustment); merchants see plain-English dashboards (revenue, COGS, gross profit, expenses, cashflow, stock value); accountants can export proper Trial Balance / P&L / Balance Sheet, Kuwait-MOF compatible.
2. **Single-warehouse stock ops.** `Product.inventory` stays the single count per SKU (no multi-warehouse v1). Add suppliers, purchase orders, stock adjustments, reorder rules, and opt-in backorders.
3. **Smart layer.** Four Gemini-Flash-Lite Inngest jobs: reorder suggestions, dead-stock detection, profit-anomaly alerts, expense-receipt OCR.
4. **Insights / BI tier.** Cohort retention, checkout funnel, RFM customer segmentation, SKU velocity, product affinity — derived from existing data via nightly Inngest rollups (no new event-tracking SDK needed v1).
5. **Opt-in backorders.** Per-product flag — when stock hits zero, customers can still buy; new stock arrivals FIFO-clear backorders before replenishing on-hand; revenue posts immediately, COGS deferred until cost is known at PO receipt.
6. **Platform-level, multi-tenant.** Every change works for every existing + future tenant out of the box. No tenant-specific code.

## Non-goals (v1)

- Multi-warehouse / multi-location.
- FIFO/LIFO costing (Weighted Average only).
- Accrual accounting (cash basis only).
- Payroll, fixed-asset depreciation, multi-currency consolidation.
- Bank reconciliation (planned v2 once KNET settlement files integration is scoped).
- B2B credit-terms AR aging beyond the standard "Accounts Receivable" account.
- Storefront UI for backorder badges (frontend session owns this — reads our schema flags).
- Per-session checkout-funnel attribution (v1 funnel is daily aggregate from existing timestamps; per-session needs the frontend session to wire an analytics SDK — deferred).
- Marketing-source attribution (UTM-aware), multi-touch attribution.

## Strategic alignment (per `CLAUDE.md`)

- **Customization granularity** — every smart suggestion is overridable; reorder rules sparse-set per product; COA editable by merchant for custom expense children.
- **AI-as-default** — all 4 AI jobs default-on per-store; bilingual outputs; quota-respecting.
- **Arabic-first** — every `Account`, `Expense`, `JournalEntry` memo, AI output carries `*Ar` sibling.
- **Kuwait-stack** — fils everywhere; KW retail COA template; KNET/Card/COD cash accounts; MOF-compatible journal retention; `defaultTaxRateBps=0` today but Tax Payable account exists for the day Kuwait activates VAT.

---

## Part 1 — Data model

### 1.1 New tables (11)

```prisma
// ==========================================
// Accounting
// ==========================================

model Account {
  id        String      @id @default(uuid())
  storeId   String      @map("store_id")
  code      String      // e.g. "1000" cash, "4000" sales — stable per template
  nameEn    String      @map("name_en")
  nameAr    String?     @map("name_ar")
  type      AccountType
  parentId  String?     @map("parent_id")
  isSystem  Boolean     @default(false) @map("is_system") // true = seeded, merchant cannot delete/rename
  isActive  Boolean     @default(true)  @map("is_active")
  createdAt DateTime    @default(now()) @map("created_at")
  updatedAt DateTime    @updatedAt      @map("updated_at")

  store    Store          @relation(fields: [storeId], references: [id], onDelete: Cascade)
  parent   Account?       @relation("AccountTree", fields: [parentId], references: [id])
  children Account[]      @relation("AccountTree")
  lines    JournalLine[]
  expensesByCategory Expense[] @relation("ExpenseCategoryAccount")
  expensesPaidFrom   Expense[] @relation("ExpensePaidFromAccount")
  poJournalsAp       PurchaseOrder[] @relation("PoApAccount")

  @@unique([storeId, code])
  @@index([storeId, type])
  @@map("accounts")
}

enum AccountType {
  asset
  liability
  equity
  revenue
  expense
}

model JournalEntry {
  id            String              @id @default(uuid())
  storeId       String              @map("store_id")
  entryNumber   String              @map("entry_number") // e.g. JE-2026-001234, per-store sequence
  postedAt      DateTime            @map("posted_at")
  source        JournalEntrySource
  sourceId      String?             @map("source_id") // Order.id / Payment.id / PurchaseOrder.id / Expense.id / StockAdjustment.id
  reversedById  String?             @unique @map("reversed_by_id") // if non-null, this entry was reversed by another
  reversesId    String?             @unique @map("reverses_id")    // points back to the original this reverses
  memo          String?
  memoAr        String?             @map("memo_ar")
  status        JournalEntryStatus  @default(posted)
  postedBy      String?             @map("posted_by") // User.id who triggered the post (null = system/webhook)
  createdAt     DateTime            @default(now()) @map("created_at")

  store        Store         @relation(fields: [storeId], references: [id], onDelete: Restrict)
  lines        JournalLine[]
  reversedBy   JournalEntry? @relation("Reversal", fields: [reversedById], references: [id])
  reverses     JournalEntry? @relation("Reversal", fields: [reversesId], references: [id])

  @@unique([storeId, entryNumber])
  @@index([storeId, postedAt(sort: Desc)])
  @@index([source, sourceId])
  @@index([storeId, status])
  @@map("journal_entries")
}

enum JournalEntrySource {
  order
  refund
  purchase_order
  expense
  stock_adjustment
  manual
  period_close
  opening_balance
}

enum JournalEntryStatus {
  posted
  reversed
  draft
}

model JournalLine {
  id          String  @id @default(uuid())
  entryId     String  @map("entry_id")
  accountId   String  @map("account_id")
  debit       Int     @default(0) // fils
  credit      Int     @default(0) // fils
  currency    String  @default("KWD")
  lineMemo    String? @map("line_memo")
  lineMemoAr  String? @map("line_memo_ar")
  // For traceability — which OrderItem/POItem/etc. this line represents.
  // Used by AI insights, not by accounting math.
  refTable    String? @map("ref_table")
  refId       String? @map("ref_id")
  createdAt   DateTime @default(now()) @map("created_at")

  entry   JournalEntry @relation(fields: [entryId], references: [id], onDelete: Cascade)
  account Account      @relation(fields: [accountId], references: [id], onDelete: Restrict)

  @@index([entryId])
  @@index([accountId])
  @@index([refTable, refId])
  @@map("journal_lines")
  // DB CHECK constraints (added via hand-written migration):
  //   CHECK (debit >= 0 AND credit >= 0)
  //   CHECK ((debit = 0 AND credit > 0) OR (debit > 0 AND credit = 0))
}

// Per-entry DR=CR enforcement uses a deferred constraint trigger added in the
// hand-written migration: after each JournalEntry insert/update, verify
// SUM(debit) = SUM(credit) across its lines or raise. Posting service writes
// header + lines in one transaction, so the trigger fires once at commit.

// ==========================================
// Suppliers & Purchase Orders
// ==========================================

model Supplier {
  id             String              @id @default(uuid())
  storeId        String              @map("store_id")
  name           String
  nameAr         String?             @map("name_ar")
  contactName    String?             @map("contact_name")
  phone          String?
  email          String?
  address        Json?               // free-form address (Kuwait area, block, street, etc.)
  paymentTerms   SupplierPaymentTerms @default(net0) @map("payment_terms")
  customTermsDays Int?               @map("custom_terms_days") // when paymentTerms = custom
  defaultCurrency String             @default("KWD") @map("default_currency")
  // Cached AP balance for fast supplier list rendering — recomputed on every
  // PO/Expense post via the journal-side trigger. Source of truth = journal lines.
  apBalanceCached Int                @default(0) @map("ap_balance_cached")
  isActive       Boolean             @default(true) @map("is_active")
  notes          String?
  notesAr        String?             @map("notes_ar")
  createdAt      DateTime            @default(now()) @map("created_at")
  updatedAt      DateTime            @updatedAt      @map("updated_at")
  deletedAt      DateTime?           @map("deleted_at") // soft delete

  store          Store           @relation(fields: [storeId], references: [id], onDelete: Cascade)
  purchaseOrders PurchaseOrder[]
  reorderRules   ReorderRule[]
  expenses       Expense[]

  @@index([storeId])
  @@index([storeId, isActive])
  @@map("suppliers")
}

enum SupplierPaymentTerms {
  net0   // cash on delivery / immediate
  net15
  net30
  net60
  custom
}

model PurchaseOrder {
  id             String              @id @default(uuid())
  storeId        String              @map("store_id")
  supplierId     String              @map("supplier_id")
  poNumber       String              @map("po_number") // PO-2026-001234, per-store sequence
  status         PurchaseOrderStatus @default(draft)
  expectedDate   DateTime?           @map("expected_date")
  receivedAt     DateTime?           @map("received_at")
  // Money in fils
  subtotal       Int                 @default(0)
  taxAmount      Int                 @default(0) @map("tax_amount")
  shippingCost   Int                 @default(0) @map("shipping_cost")
  total          Int                 @default(0)
  currency       String              @default("KWD")
  // AP account this PO will credit on receipt. Defaults to system 'Accounts Payable'.
  apAccountId    String?             @map("ap_account_id")
  // Journal entry that posted on receipt (null until received).
  journalEntryId String?             @unique @map("journal_entry_id")
  notes          String?
  notesAr        String?             @map("notes_ar")
  createdBy      String?             @map("created_by")
  receivedBy     String?             @map("received_by")
  createdAt      DateTime            @default(now()) @map("created_at")
  updatedAt      DateTime            @updatedAt      @map("updated_at")

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

enum PurchaseOrderStatus {
  draft       // merchant still editing
  sent        // sent to supplier, awaiting fulfilment
  partial     // partially received
  received    // fully received → inventory + journal posted
  cancelled
}

model PurchaseOrderItem {
  id           String  @id @default(uuid())
  poId         String  @map("po_id")
  productId    String  @map("product_id")
  variantId    String? @map("variant_id")
  qty          Int     // ordered
  qtyReceived  Int     @default(0) @map("qty_received")
  unitCost     Int     @map("unit_cost") // fils
  total        Int     // qty * unitCost
  notes        String?
  createdAt    DateTime @default(now()) @map("created_at")

  po       PurchaseOrder    @relation(fields: [poId], references: [id], onDelete: Cascade)
  product  Product          @relation(fields: [productId], references: [id])
  variant  ProductVariant?  @relation(fields: [variantId], references: [id])
  // Backorder lines this PO item fulfilled (FIFO on receipt).
  backordersFulfilled BackorderLine[]

  @@index([poId])
  @@index([productId])
  @@map("purchase_order_items")
}

// ==========================================
// Stock adjustments (manual stock corrections)
// ==========================================

model StockAdjustment {
  id              String                @id @default(uuid())
  storeId         String                @map("store_id")
  adjustmentNumber String               @map("adjustment_number") // ADJ-2026-001234
  type            StockAdjustmentType
  status          StockAdjustmentStatus @default(draft)
  reason          String?
  reasonAr        String?               @map("reason_ar")
  evidenceUrl     String?               @map("evidence_url") // R2 URL — photo of damaged stock, count sheet, etc.
  // Net value impact in fils — positive = inventory increased (rare: found),
  // negative = inventory decreased (loss/damage/write-off). Sum across items.
  totalValueImpact Int                  @default(0) @map("total_value_impact")
  postedAt        DateTime?             @map("posted_at")
  postedBy        String?               @map("posted_by")
  journalEntryId  String?               @unique @map("journal_entry_id")
  createdBy       String?               @map("created_by")
  createdAt       DateTime              @default(now()) @map("created_at")
  updatedAt       DateTime              @updatedAt      @map("updated_at")

  store Store                  @relation(fields: [storeId], references: [id], onDelete: Restrict)
  items StockAdjustmentItem[]

  @@unique([storeId, adjustmentNumber])
  @@index([storeId, status])
  @@index([storeId, postedAt(sort: Desc)])
  @@map("stock_adjustments")
}

enum StockAdjustmentType {
  cycle_count     // periodic physical count vs system delta
  damage          // damaged goods → inventory loss, posts to Loss/Damage expense
  theft           // theft loss
  loss            // unknown shrinkage
  write_off       // expired / obsolete
  found           // physical count higher than system (rare)
  return_to_supplier // sending goods back to supplier (reduces AP if posted within terms)
}

enum StockAdjustmentStatus {
  draft
  posted // inventory + journal updated, immutable thereafter
}

model StockAdjustmentItem {
  id            String  @id @default(uuid())
  adjustmentId  String  @map("adjustment_id")
  productId     String  @map("product_id")
  variantId     String? @map("variant_id")
  previousQty   Int     @map("previous_qty")
  newQty        Int     @map("new_qty")
  deltaQty      Int     @map("delta_qty") // newQty - previousQty
  unitCost      Int     @map("unit_cost") // fils, snapshotted from Product.costPrice at post time
  createdAt     DateTime @default(now()) @map("created_at")

  adjustment StockAdjustment @relation(fields: [adjustmentId], references: [id], onDelete: Cascade)
  product    Product         @relation(fields: [productId], references: [id])
  variant    ProductVariant? @relation(fields: [variantId], references: [id])

  @@index([adjustmentId])
  @@index([productId])
  @@map("stock_adjustment_items")
}

// ==========================================
// Reorder rules (sparse — only set when merchant overrides defaults)
// ==========================================

model ReorderRule {
  id                String   @id @default(uuid())
  storeId           String   @map("store_id")
  productId         String   @map("product_id")
  variantId         String?  @map("variant_id")
  minQty            Int      @map("min_qty")
  reorderQty        Int      @map("reorder_qty")
  leadTimeDays      Int      @default(7) @map("lead_time_days")
  safetyStockDays   Int      @default(7) @map("safety_stock_days")
  preferredSupplierId String? @map("preferred_supplier_id")
  isActive          Boolean  @default(true) @map("is_active")
  createdAt         DateTime @default(now()) @map("created_at")
  updatedAt         DateTime @updatedAt      @map("updated_at")

  store             Store           @relation(fields: [storeId], references: [id], onDelete: Cascade)
  product           Product         @relation(fields: [productId], references: [id], onDelete: Cascade)
  variant           ProductVariant? @relation(fields: [variantId], references: [id], onDelete: Cascade)
  preferredSupplier Supplier?       @relation(fields: [preferredSupplierId], references: [id], onDelete: SetNull)

  @@unique([storeId, productId, variantId])
  @@index([storeId])
  @@map("reorder_rules")
}

// ==========================================
// Backorders (opt-in — Product/Variant.allowBackorder gates this)
// ==========================================

model BackorderLine {
  id                  String    @id @default(uuid())
  storeId             String    @map("store_id")
  orderItemId         String    @map("order_item_id")
  productId           String    @map("product_id")
  variantId           String?   @map("variant_id")
  qty                 Int       // ordered while inventory ≤ 0
  qtyFulfilled        Int       @default(0) @map("qty_fulfilled")
  // FIFO fulfilment trace — the PO item that fulfilled this (or the most
  // recent one if multiple POs were needed). For multi-PO splits we update
  // qtyFulfilled progressively; final fulfilment sets fulfilledAt.
  fulfilledByPoItemId String?   @map("fulfilled_by_po_item_id")
  fulfilledAt         DateTime? @map("fulfilled_at")
  // True after merchant manually cancelled this backorder (triggers refund flow upstream).
  cancelledAt         DateTime? @map("cancelled_at")
  cancelledReason     String?   @map("cancelled_reason")
  createdAt           DateTime  @default(now()) @map("created_at")

  store          Store              @relation(fields: [storeId], references: [id], onDelete: Cascade)
  orderItem      OrderItem          @relation(fields: [orderItemId], references: [id], onDelete: Cascade)
  product        Product            @relation(fields: [productId], references: [id])
  variant        ProductVariant?    @relation(fields: [variantId], references: [id])
  fulfilledByPo  PurchaseOrderItem? @relation(fields: [fulfilledByPoItemId], references: [id], onDelete: SetNull)

  @@index([storeId, fulfilledAt]) // open backorders: where fulfilledAt IS NULL AND cancelledAt IS NULL
  @@index([productId])
  @@index([orderItemId])
  @@map("backorder_lines")
}

// ==========================================
// Expenses (with OCR draft support)
// ==========================================

model Expense {
  id                String        @id @default(uuid())
  storeId           String        @map("store_id")
  expenseNumber     String        @map("expense_number") // EXP-2026-001234
  supplierId        String?       @map("supplier_id")    // optional vendor reference
  expenseAccountId  String        @map("expense_account_id") // which expense category (Account.type=expense)
  paidFromAccountId String        @map("paid_from_account_id") // which cash account (or AP)
  amount            Int           // fils, ex tax
  taxAmount         Int           @default(0) @map("tax_amount")
  total             Int           // amount + taxAmount
  currency          String        @default("KWD")
  expenseDate       DateTime      @map("expense_date") // the date the expense was incurred (not posted)
  status            ExpenseStatus @default(draft)
  // OCR-related fields (when receipt was uploaded for AI parsing)
  receiptImageUrl    String?      @map("receipt_image_url")
  ocrJson            Json?        @map("ocr_json")            // full Gemini Vision response
  categoryAiConfidence Float?     @map("category_ai_confidence") // 0..1, AI's suggested category confidence
  // Approval workflow (single-user by default; two-step toggled per-store)
  approvedBy         String?      @map("approved_by")
  approvedAt         DateTime?    @map("approved_at")
  // Journal trail
  journalEntryId     String?      @unique @map("journal_entry_id")
  postedAt           DateTime?    @map("posted_at")
  notes              String?
  notesAr            String?      @map("notes_ar")
  createdBy          String?      @map("created_by")
  createdAt          DateTime     @default(now()) @map("created_at")
  updatedAt          DateTime     @updatedAt      @map("updated_at")

  store           Store    @relation(fields: [storeId], references: [id], onDelete: Restrict)
  supplier        Supplier? @relation(fields: [supplierId], references: [id], onDelete: SetNull)
  expenseAccount  Account  @relation("ExpenseCategoryAccount", fields: [expenseAccountId], references: [id], onDelete: Restrict)
  paidFromAccount Account  @relation("ExpensePaidFromAccount", fields: [paidFromAccountId], references: [id], onDelete: Restrict)

  @@unique([storeId, expenseNumber])
  @@index([storeId, status])
  @@index([storeId, expenseDate(sort: Desc)])
  @@map("expenses")
}

enum ExpenseStatus {
  draft       // OCR processed, awaiting merchant review
  pending     // submitted, awaiting approval (when two-step approval enabled)
  approved    // approved, ready to post
  posted      // journal entry created, immutable
  rejected
}
```

### 1.2 Insights / BI snapshot tables (Batch 4, +3 tables)

Materialized nightly by Inngest; admin reads from these instead of computing on-the-fly.

```prisma
// ==========================================
// Insights — cohort retention
// ==========================================

model CustomerCohortSnapshot {
  id               String   @id @default(uuid())
  storeId          String   @map("store_id")
  cohortMonth      String   @map("cohort_month")    // 'YYYY-MM' of customer's first order
  periodOffset     Int      @map("period_offset")   // 0 = cohort month itself, 1 = month +1, etc.
  customersTotal   Int      @map("customers_total") // size of cohort
  customersActive  Int      @map("customers_active") // active in this offset (placed ≥1 order)
  ordersInPeriod   Int      @map("orders_in_period")
  revenueInPeriod  Int      @map("revenue_in_period") // fils
  computedAt       DateTime @default(now()) @map("computed_at")

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@unique([storeId, cohortMonth, periodOffset])
  @@index([storeId, cohortMonth])
  @@map("customer_cohort_snapshots")
}

// ==========================================
// Insights — checkout funnel (daily aggregate, derived from existing tables)
// ==========================================

model FunnelSnapshot {
  id                  String   @id @default(uuid())
  storeId             String   @map("store_id")
  periodDate          DateTime @map("period_date") // day boundary, KW timezone
  productViews        Int      @map("product_views")        // sum of Product.viewCount delta that day
  cartsCreated        Int      @map("carts_created")        // distinct Cart rows created
  cartItemsAdded      Int      @map("cart_items_added")     // CartItem rows created
  checkoutsStarted    Int      @map("checkouts_started")    // AbandonedCart rows created (existing signal)
  ordersCompleted     Int      @map("orders_completed")     // Order.paymentStatus = paid
  ordersAbandoned     Int      @map("orders_abandoned")     // AbandonedCart never converted
  revenue             Int      @map("revenue")              // fils, completed orders only
  computedAt          DateTime @default(now()) @map("computed_at")

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@unique([storeId, periodDate])
  @@index([storeId, periodDate(sort: Desc)])
  @@map("funnel_snapshots")
}

// ==========================================
// Insights — RFM customer segments
// ==========================================

model CustomerRfmSnapshot {
  id              String      @id @default(uuid())
  storeId         String      @map("store_id")
  customerId      String      @map("customer_id") // User.id (registered) OR a hashed guest key (email/phone)
  isGuest         Boolean     @default(false) @map("is_guest")
  recencyDays     Int         @map("recency_days")
  frequencyOrders Int         @map("frequency_orders")
  monetaryFils    Int         @map("monetary_fils")
  rfmScore        Int         @map("rfm_score")        // 111..555 packed (R*100 + F*10 + M)
  segment         RfmSegment
  computedAt      DateTime    @default(now()) @map("computed_at")

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@unique([storeId, customerId])
  @@index([storeId, segment])
  @@map("customer_rfm_snapshots")
}

enum RfmSegment {
  vip            // recent + frequent + big spender
  loyal          // frequent + decent spender, not necessarily recent
  potential      // recent + decent spender, low frequency
  new            // first order recent, no repeat yet
  at_risk        // were frequent, gone quiet
  hibernating    // low everything
  lost           // > 365d since last order
}
```

### 1.3 Extensions to existing tables

```prisma
// Product
allowBackorder    Boolean   @default(false) @map("allow_backorder")
lastCostUpdateAt  DateTime? @map("last_cost_update_at") // bumped by WAC recompute on PO receipt

// ProductVariant
allowBackorder    Boolean   @default(false) @map("allow_backorder")

// OrderItem
// True when this line was sold while inventory was at or below zero AND the
// product had allowBackorder=true. COGS journal entry is deferred until a PO
// receipt fulfils the backorder (see Part 2). Flipped back to false by the
// PO-receipt posting service once all qty for this OrderItem is fulfilled.
costPriceDeferred Boolean   @default(false) @map("cost_price_deferred")
// Reverse relations (declared on OrderItem for Prisma's bidirectional check):
backorderLines    BackorderLine[]

// Product — also add reverse relations for the new tables:
purchaseOrderItems   PurchaseOrderItem[]
stockAdjustmentItems StockAdjustmentItem[]
reorderRules         ReorderRule[]
backorderLines       BackorderLine[]

// ProductVariant — same reverse relations:
purchaseOrderItems   PurchaseOrderItem[]
stockAdjustmentItems StockAdjustmentItem[]
reorderRules         ReorderRule[]
backorderLines       BackorderLine[]

// Store — reverse relations for the 11 new tables:
accounts                 Account[]
journalEntries           JournalEntry[]
suppliers                Supplier[]
purchaseOrders           PurchaseOrder[]
stockAdjustments         StockAdjustment[]
reorderRules             ReorderRule[]
backorderLines           BackorderLine[]
expenses                 Expense[]
customerCohortSnapshots  CustomerCohortSnapshot[]
funnelSnapshots          FunnelSnapshot[]
customerRfmSnapshots     CustomerRfmSnapshot[]

// Store
accountingEnabled    Boolean @default(true)  @map("accounting_enabled")
defaultTaxRateBps    Int     @default(0)     @map("default_tax_rate_bps") // basis points, KW=0 today
fiscalYearStartMonth Int     @default(1)     @map("fiscal_year_start_month")
// Two-step expense approval. When true, expenses go draft → pending → approved → posted.
// When false (default), draft → posted in one step.
expenseTwoStepApproval Boolean @default(false) @map("expense_two_step_approval")
```

### 1.4 Migration notes

- **No `deletedAt` on `JournalEntry` / `JournalLine` / `StockAdjustment` (after posted) / `Expense` (after posted).** MOF retention requires immutable financial records. Reversals link via `reversedById` / `reversesId`. This is non-negotiable; do not add soft-delete to these tables in any future migration.
- **DB-level CHECK constraints** on `journal_lines` enforce non-negative debit/credit and XOR (a line is debit OR credit, not both). Added via hand-written SQL in the migration, not Prisma (`@db.Check` is the new Prisma 5+ syntax but FWB pins to a version that doesn't support it).
- **Sum-DR=Sum-CR trigger** added as deferred constraint trigger fired at transaction commit, not row-by-row. Posting service builds header + N lines then commits — trigger runs once.
- **Per-store sequence generation** for `entryNumber` / `poNumber` / `adjustmentNumber` / `expenseNumber` uses a per-store counter row in a new `Sequence` table OR Postgres `nextval` with a per-store sequence name. Recommend the `Sequence` table approach — easier to backup/restore (no global sequence state mutation across Neon branches).
- **All 11 new tables follow the `storeId` + RLS pattern** already in place (`tenant-context.ts` AsyncLocalStorage → Postgres GUC). Add `ENABLE ROW LEVEL SECURITY` + the standard policy in the migration. Don't forget — `runInTenantContext` is the runtime guard.
- **Backfill on first migration**: seed the COA template for every existing `Store` row. See Part 5 for the template.

---

## Part 2 — Posting model (hybrid sync + async, locked as option C)

### 2.1 Synchronous posts (in the same Prisma `$transaction` as the operational write)

| Trigger                                                                               | Journal entries posted                                                                                                                                                                                                                                                                                                                                                                                                               | Notes                                                                                                                                  |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `order.complete` (payment webhook → Order.paymentStatus=paid)                         | (1) DR `Cash[provider]` / CR `Sales revenue` + CR `Tax payable` + CR `Shipping income`; CR `Discounts given` reduces revenue or DR if you prefer the gross-then-deduct model — we use **net revenue** (CR revenue net of discount). (2) DR `COGS` / CR `Inventory` per OrderItem **unless** `costPriceDeferred=true` for that line.                                                                                                  | Cash account chosen by `Payment.provider` (KNET vs Card vs COD). Order's existing `payment.applied` hook gains a journal-post step.    |
| `refund.applied` (via `OrderService.applyRefundEffects`, the existing 6-edge fan-out) | Reversal entry scoped to the refunded portion. DR `Sales returns` + DR `Tax payable refunded` / CR `Cash[provider refund]`. CR `Inventory` / DR `COGS reversal` if goods returned to stock (i.e. `Return.type=return` with `restocked=true`).                                                                                                                                                                                        | Becomes the 7th edge in `applyRefundEffects`. Existing concurrency-keyed Inngest concurrency on `order/refunded` prevents double-post. |
| `po.receive` (full or partial receipt)                                                | DR `Inventory` (sum of received qty × unitCost) / CR `Accounts Payable`. Followed by per-product WAC recompute. If any received qty FIFO-clears `BackorderLine` rows, fire the deferred COGS entry for each cleared line — DR `COGS` / CR `Inventory` at the PO unit cost (or weighted-blend if multiple POs partially cleared the line). If estimate on `OrderItem.costPrice` vs actual differs, post a `COGS variance` correction. | `costPrice` recompute formula in Part 2.3.                                                                                             |
| `expense.post` (approved expense transitions to posted)                               | DR `expenseAccount` / CR `paidFromAccount` (typically Cash[…] or AP if vendor terms apply). DR `Tax recoverable` if taxAmount > 0 and future VAT activation toggles it.                                                                                                                                                                                                                                                              |                                                                                                                                        |
| `stockAdjustment.post`                                                                | Cycle count delta: DR/CR `Inventory` (per item) + counterpart account. damage→`Damage/Loss expense`, theft→`Theft loss`, write_off→`Write-off expense`, found→`Inventory gain`, return_to_supplier→`Accounts Payable` (reduces AP).                                                                                                                                                                                                  | Counterpart account is `isSystem=true` in COA.                                                                                         |
| `journalEntry.manual`                                                                 | Merchant-entered adjusting entry (year-end, opening balance, etc.). Validated DR=CR before insert.                                                                                                                                                                                                                                                                                                                                   | Audit-logged with `postedBy`.                                                                                                          |

### 2.2 Asynchronous via Inngest (no operational data depends on these)

| Event                              | Job                                                                                                                                                                | Cadence             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| `accounting/daily-close`           | Snapshot current trial balance to `TrialBalanceSnapshot` cache for fast P&L queries. Verify sum(DR)=sum(CR) across all entries; if drift, fire P0 Telegram alert.  | Daily 01:00 KW      |
| `accounting/period-reconciliation` | Cross-check: sum(Order.total where paymentStatus=paid in period) vs sum(JournalLine credit on Sales revenue accounts in period). If drift > 1 fils total, fire P0. | Daily 01:30 KW      |
| `analytics/daily-rollup`           | Compute cohort retention, funnel snapshots, RFM segmentation; write to snapshot tables.                                                                            | Daily 02:00 KW      |
| `stock/reorder-scan`               | Compute reorder suggestions (Part 3.1).                                                                                                                            | Daily 06:00 KW      |
| `stock/deadstock-scan`             | Identify dead stock (Part 3.2).                                                                                                                                    | Weekly Sun 06:00 KW |
| `accounting/profit-anomaly`        | Compute margin trend, alert on drops (Part 3.3).                                                                                                                   | Daily 06:00 KW      |
| `accounting/expense-ocr-process`   | On-demand: parse receipt with Gemini Vision, draft Expense (Part 3.4).                                                                                             | Triggered by upload |

All async jobs share the existing `AI_DAILY_REQUEST_CAP` / `AI_MONTHLY_REQUEST_CAP` guard. Smart-skip: re-scan only if the underlying data (Product.updatedAt, Order.createdAt) has moved since last successful scan — recorded in `Store.settings.lastScanAt`.

### 2.3 Weighted-Average Cost (WAC) recompute on PO receipt

```
For each received PurchaseOrderItem (productId, qtyReceived, unitCost):
  product = Product or ProductVariant
  // 1. First FIFO-clear any open BackorderLine rows for this product
  openBackorders = BackorderLine where productId=X, fulfilledAt IS NULL, cancelledAt IS NULL
                   ORDER BY createdAt ASC
  remainingQty = qtyReceived
  for each backorder in openBackorders while remainingQty > 0:
    fulfilQty = min(backorder.qty - backorder.qtyFulfilled, remainingQty)
    backorder.qtyFulfilled += fulfilQty
    if backorder.qtyFulfilled == backorder.qty:
      backorder.fulfilledAt = now()
      backorder.fulfilledByPoItemId = poItem.id
      // Post deferred COGS at PO unitCost
      postDeferredCogs(backorder.orderItemId, fulfilQty, poItem.unitCost)
      // If estimate vs actual diverged > threshold, post variance entry
    remainingQty -= fulfilQty
  // 2. Replenish on-hand with remainder
  if remainingQty > 0:
    oldStock = product.inventory  // could be 0 or positive
    oldCost  = product.costPrice ?? poItem.unitCost  // fallback when no prior cost
    newStock = oldStock + remainingQty
    newCost  = ((max(oldStock, 0) * oldCost) + (remainingQty * poItem.unitCost))
               / (max(oldStock, 0) + remainingQty)
    product.inventory       = newStock
    product.costPrice       = newCost
    product.lastCostUpdateAt = now()
    // InventoryHistory row (existing pattern): type=transfer_in, qty=remainingQty, reference=poItem.id
```

`postDeferredCogs(orderItemId, qty, actualUnitCost)`:

- Looks up the OrderItem. If `costPriceDeferred=true`:
  - Compute estimate = `OrderItem.costPrice * qty` (estimate snapshotted at sale time).
  - Compute actual = `actualUnitCost * qty`.
  - Post DR `COGS` / CR `Inventory` for `actual`.
  - If `|estimate - actual| > 0`, post DR/CR `COGS variance` for the delta.
  - Clear `costPriceDeferred` on the OrderItem if all its qty has been fulfilled.

### 2.4 Integrity invariants

- **Posted lines are immutable.** No UPDATE on `journal_lines` after insert. Reversal entries handle corrections.
- **DR=CR per entry.** Enforced at transaction commit by a deferred constraint trigger.
- **All-or-nothing.** Operational write + journal post share one `$transaction`. If either fails, both roll back.
- **Idempotency.** Journal posting via webhook uses `JournalEntry.source` + `sourceId` as a uniqueness check — already-posted source/sourceId combinations are skipped (re-fired webhooks are safe).
- **Per-store RLS.** Every new table carries the standard RLS policy. Cross-store reads impossible at the DB level.

---

## Part 3 — Smart layer (4 AI jobs)

### 3.1 Reorder suggestions

**Inngest job:** `stock/reorder-scan`, daily 06:00 KW.

**Algorithm per product (with `trackInventory=true` AND `status=active`):**

```
velocity7d  = sum(OrderItem.quantity in last 7 days where productId=X, payment paid) / 7
velocity28d = sum(OrderItem.quantity in last 28 days where productId=X, payment paid) / 28
velocity    = max(velocity7d, velocity28d)  // be conservative — pick the higher rate

rule = ReorderRule for this product (or default)
  minQty          = rule?.minQty          ?? product.lowStockThreshold
  reorderQty      = rule?.reorderQty      ?? max(velocity * 14, minQty * 2)
  leadTimeDays    = rule?.leadTimeDays    ?? 7
  safetyStockDays = rule?.safetyStockDays ?? 7

onHand   = product.inventory  // may be negative if backorders open
onOrder  = sum(PurchaseOrderItem.qty - PurchaseOrderItem.qtyReceived where productId=X, po.status in (sent, partial))
backlog  = sum(BackorderLine.qty - BackorderLine.qtyFulfilled where productId=X, fulfilledAt IS NULL, cancelledAt IS NULL)

demandDuringLead = velocity * (leadTimeDays + safetyStockDays)
projectedStock   = onHand + onOrder - backlog - demandDuringLead

if projectedStock < minQty:
  // Reorder. Floor at (backlog + reorderQty) — must at least clear the backlog.
  suggestedQty = max(reorderQty, backlog + reorderQty - onHand - onOrder)
  emit ReorderSuggestion(productId, suggestedQty, urgencyDays, supplierId, reasoning)
```

**Output:** rows in a new lightweight `ReorderSuggestion` table (one per scan, per product needing reorder). Admin renders cards. Click → opens a draft PO pre-filled with the suggested quantity + supplier. Bilingual reasoning copy via Gemini ("Sold 40/wk in the last 4 weeks, only 15 left + 7d supplier lead — reorder 80 units").

**Note:** `ReorderSuggestion` is the only "scan output" table; we keep it short-lived (purge entries older than 30 days nightly) to avoid table bloat.

### 3.2 Dead-stock detection

**Inngest job:** `stock/deadstock-scan`, weekly Sunday 06:00 KW.

**Algorithm:** product with `status=active`, `inventory > 0`, `inventory * costPrice > KWD 50` (50000 fils), and `sum(OrderItem.qty in last 90 days) = 0` → flag as dead stock.

**Output:** populates an in-app banner on the Dead-Stock admin page; for each flagged product, Gemini generates a bilingual clearance copy snippet + suggested discount % (10-50% sliding scale based on age/stock value). Merchant can one-click "Run a 30%-off Clearance" — drafts a coupon scoped to those products.

### 3.3 Profit anomaly detection

**Inngest job:** `accounting/profit-anomaly`, daily 06:00 KW.

**Per product + per category:**

```
margin7d  = (revenue7d - cogs7d)  / revenue7d
margin28d = (revenue28d - cogs28d) / revenue28d
drop = (margin28d - margin7d) / margin28d  // positive = margin dropped
```

If `drop > 0.20` → admin badge on Finance dashboard. If `drop > 0.40` → P0 Telegram alert via existing `alerts.service`. AI summary explains the likely cause (supplier price hike via `costPrice` move, refund spike via `Refund` count, coupon abuse via `Coupon.usageCount`).

### 3.4 Expense OCR (Gemini Vision)

**Trigger:** merchant uploads a receipt image to the new expense form. The upload route writes to R2, then fires `accounting/expense-ocr-process` Inngest event.

**Inngest function:**

1. Fetch image from R2.
2. Call Gemini Flash Lite (vision-enabled model) with a structured prompt:

   ```
   You are a receipt parser for a Kuwait retailer. Extract:
   - vendor name (English + Arabic if visible)
   - invoice date (YYYY-MM-DD)
   - currency
   - subtotal, tax, total (in the currency shown — convert later)
   - line items: name, qty, unitPrice, total
   - suggested expense category from: [packaging, marketing, salaries, rent,
     utilities, software, courier, bank_fees, office_supplies, professional_services,
     other]
   - confidence score 0..1 for category suggestion

   Return strict JSON matching this schema: {...}
   ```

3. Resolve `expenseAccountId` from the suggested category (lookup by `Account.code` convention: 5100=packaging, 5200=marketing, etc.).
4. Insert `Expense` row with `status=draft`, `ocrJson` populated, `categoryAiConfidence` set.
5. Notify merchant via existing in-app NotificationLog: "1 new expense draft ready for review".

**Merchant flow:** opens `/finance/expenses`, sees draft, can edit any field, picks `paidFromAccountId` (Cash KNET / Cash Card / Cash COD / Bank), clicks Approve → posts journal.

### 3.5 Insights/BI rollups (Batch 4)

**Inngest job:** `analytics/daily-rollup`, daily 02:00 KW.

Three sub-rollups in sequence:

1. **Cohort snapshot.** For each store, for each cohort month from store launch to current month, for each periodOffset (0 to currentMonth - cohortMonth):
   - Identify cohort = distinct customers with their first paid order in cohortMonth.
   - For each periodOffset, count how many of those customers placed ≥1 paid order in (cohortMonth + offset months).
   - Sum orders + revenue.
   - Upsert into `CustomerCohortSnapshot`.

2. **Funnel snapshot.** For each store, for the previous day (KW timezone):
   - `productViews` = sum of `Product.viewCount` delta since prior snapshot.
   - `cartsCreated` = COUNT(`Cart` where createdAt in day).
   - `cartItemsAdded` = COUNT(`CartItem` where createdAt in day).
   - `checkoutsStarted` = COUNT(`AbandonedCart` where createdAt in day).
   - `ordersCompleted` = COUNT(`Order` where paymentStatus=paid AND createdAt in day).
   - `ordersAbandoned` = COUNT(`AbandonedCart` where convertedAt IS NULL AND createdAt < (day - 7d)).
   - `revenue` = SUM(`Order.total` for completed).
   - Upsert into `FunnelSnapshot`.

3. **RFM segmentation.** For each store, for each customer who has placed ≥1 paid order ever:
   - `recencyDays` = days since last paid order.
   - `frequencyOrders` = count of paid orders lifetime.
   - `monetaryFils` = sum of paid order totals lifetime.
   - Bucket each metric 1..5 by quintile relative to the store's customer base.
   - `rfmScore` = R*100 + F*10 + M.
   - Assign segment per the table:
     - VIP: R>=4 AND F>=4 AND M>=4
     - Loyal: F>=4 AND M>=3
     - Potential: R>=4 AND F<=2
     - New: R>=4 AND F=1
     - At risk: F>=3 AND R<=2
     - Hibernating: R<=2 AND F<=2 AND M<=2
     - Lost: R=1 AND recencyDays > 365
   - Upsert into `CustomerRfmSnapshot`.

After rollup, optional AI pass (rate-limited, only when something noteworthy changed):

- Top 3 cohorts ranked by month-3 retention delta vs prior cohorts → Gemini summary.
- Funnel drop-off change >X% vs trailing 7d avg → Gemini explains likely cause.
- Segment shift (e.g. 5 customers moved from VIP → At risk) → notify merchant.

---

## Part 4 — Backorder mechanics (new behavior, opt-in)

### 4.1 Opt-in surface

- `Product.allowBackorder` (default `false`) — admin product form gains a toggle: "Allow backorders when stock is zero". Per-variant override on `ProductVariant.allowBackorder` for variant-parent products.
- API exposes new boolean flags on the public product API response:
  - `inStock`: `inventory > 0`
  - `acceptsBackorder`: `inventory <= 0 AND allowBackorder`
  - `lowStock`: `inventory > 0 AND inventory <= lowStockThreshold`
- Frontend session uses these flags to show "Pre-order" badge / change CTA copy / disable cart-add when neither inStock nor acceptsBackorder. We do NOT touch storefront UI — schema contract is the integration surface.

### 4.2 Sale through zero

When `CartService.addToCart` and `OrderService.createOrder` would otherwise refuse for insufficient stock:

1. Check `product.allowBackorder` (or variant's). If false → existing "out of stock" error.
2. If true → allow. Inventory deducted normally; `Product.inventory` may go negative.
3. On `Order.complete` (payment confirmed), for each OrderItem where `productAtSale.inventory <= 0` was true:
   - Create `BackorderLine(orderItemId, productId, variantId?, qty, qtyFulfilled=0)`.
   - Set `OrderItem.costPriceDeferred = true`.
   - `OrderItem.costPrice` already snapshotted to current `Product.costPrice` (estimate); journal posts revenue immediately but skips the COGS line for this OrderItem.

### 4.3 Fulfilment via PO receipt

Algorithm in Part 2.3. Highlights:

- Oldest BackorderLines FIFO-cleared first.
- Each cleared line posts the deferred COGS at the actual unit cost from the receiving PO (or weighted-average across multiple receipts if the PO partially fulfilled).
- If estimate vs actual unit cost differ → `COGS variance` correction entry.
- Triggers existing `order/fulfilled` Inngest event so the customer gets shipment notification + the WBS session can pick up the `backorder.fulfilled` event for WhatsApp blast.

### 4.4 Merchant-facing

- `/stores/:id/stock/backorders` admin page lists open BackorderLines (customer name from Order, product, qty, days waiting). Sorted oldest-first.
- Bulk actions: "Convert oldest 10 backorders to a draft PO" (one click pre-fills PO with those quantities to the preferred supplier).
- Cancel backorder → BackorderLine.cancelledAt set + automatic refund via `OrderService.applyRefundEffects` (reuses existing 7-edge refund pipeline + new journal-reversal edge).

### 4.5 Edge cases

- **Variant-parent products**: backorder flag carried on the variant, not the parent. Parent.allowBackorder gives a "default for new variants" hint only.
- **Mixed cart (some lines backorder, some in-stock)**: order ships partially — existing `Shipment` model already supports partial shipments. The in-stock lines ship first; backorder lines ship when fulfilled. Customer gets two shipment notifications.
- **Refund of a backorder line before fulfilment**: cancellation flow above. No COGS ever posts.
- **Estimated ship date for customer**: v1 = "ships when restocked" (no concrete date). Future: derive from PO.expectedDate + supplier lead — wire when frontend session asks for it.

---

## Part 5 — Kuwait COA template

Seeded for every existing Store on first migration + for every new Store on creation. Account codes follow the Kuwait small-retail convention (4-digit codes by type, room for custom children).

| Code | Name (EN)           | Name (AR)              | Type      | isSystem | Notes                               |
| ---- | ------------------- | ---------------------- | --------- | -------- | ----------------------------------- |
| 1000 | Cash KNET           | كاش كي نت              | asset     | yes      | Settles from MyFatoorah KNET        |
| 1010 | Cash Card           | كاش بطاقات             | asset     | yes      | Visa/Mastercard                     |
| 1020 | Cash COD            | كاش الدفع عند الاستلام | asset     | yes      | Cash on delivery cleared by courier |
| 1030 | Bank Main           | بنك رئيسي              | asset     | yes      | Bank settlement account             |
| 1100 | Accounts Receivable | الذمم المدينة          | asset     | yes      | B2B credit terms (low usage v1)     |
| 1200 | Inventory           | المخزون                | asset     | yes      | Single inventory account for v1     |
| 2000 | Accounts Payable    | الذمم الدائنة          | liability | yes      | PO receipts post here               |
| 2100 | Tax Payable         | الضريبة المستحقة       | liability | yes      | VAT-ready, 0 today                  |
| 3000 | Owner's Equity      | حقوق الملكية           | equity    | yes      |                                     |
| 3100 | Owner's Draws       | سحوبات المالك          | equity    | yes      |                                     |
| 4000 | Sales Revenue       | إيرادات المبيعات       | revenue   | yes      | Net of discount                     |
| 4010 | Shipping Income     | إيرادات الشحن          | revenue   | yes      |                                     |
| 4090 | Sales Returns       | مرتجعات المبيعات       | revenue   | yes      | Contra-revenue (refunds debit here) |
| 5000 | Cost of Goods Sold  | تكلفة البضاعة المباعة  | expense   | yes      |                                     |
| 5010 | COGS Variance       | فرق تكلفة البضاعة      | expense   | yes      | Backorder cost variance             |
| 5100 | Packaging           | التغليف                | expense   | yes      |                                     |
| 5200 | Marketing           | تسويق                  | expense   | yes      |                                     |
| 5300 | Salaries            | رواتب                  | expense   | yes      |                                     |
| 5400 | Rent                | إيجار                  | expense   | yes      |                                     |
| 5500 | Utilities           | كهرباء وماء واتصالات   | expense   | yes      |                                     |
| 5600 | Software            | اشتراكات برمجية        | expense   | yes      | Including FWB subscription itself   |
| 5700 | Courier             | شحن وتوصيل             | expense   | yes      |                                     |
| 5800 | Bank Fees           | رسوم بنكية             | expense   | yes      | MyFatoorah / Tap commissions        |
| 5900 | Damage / Loss       | تلف وفقد               | expense   | yes      | StockAdjustment.damage posts here   |
| 5910 | Theft               | سرقة                   | expense   | yes      | StockAdjustment.theft               |
| 5920 | Write-off           | شطب                    | expense   | yes      | StockAdjustment.write_off           |
| 5990 | Other               | متفرقات                | expense   | yes      | Catch-all                           |

Merchant can add custom expense children (e.g. 5210 "Meta Ads", 5220 "TikTok Ads") under 5200 Marketing. System accounts are locked (no rename, no delete, no disable).

---

## Part 6 — Admin UI

Two new sidebar groups: **Finance** and **Stock**, plus a new **Insights** group in Batch 4. All routes are platform-level and gated by the existing `authenticate → authorize('store_admin','super_admin') → requireStoreAccess` chain.

### Finance group

| Route                           | Purpose                                                                                                                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/stores/:id/finance/dashboard` | Merchant landing: this month revenue / COGS / gross profit / expenses / net + sparkline + cash by account + stock value + top anomalies. Default landing for the group. |
| `/stores/:id/finance/journal`   | Filterable journal entry list, drill into lines, CSV/XLSX export.                                                                                                       |
| `/stores/:id/finance/accounts`  | Chart of accounts: tree view by type, add/edit/disable custom accounts, system accounts locked.                                                                         |
| `/stores/:id/finance/reports`   | Trial Balance, P&L, Balance Sheet, Cashflow. Date-range picker. PDF + XLSX export.                                                                                      |
| `/stores/:id/finance/expenses`  | List + new expense (with receipt upload → OCR) + approve/reject flow.                                                                                                   |
| `/stores/:id/finance/tax`       | Tax settings (defaultTaxRateBps + per-product overrides v2) + Tax-period report.                                                                                        |

### Stock group

| Route                               | Purpose                                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `/stores/:id/stock/dashboard`       | On-hand / low-stock count / dead-stock count / open backorders / stock value / reorder suggestions count.  |
| `/stores/:id/stock/inventory`       | Per-product/variant stock + adjustments shortcut. (Existing inventory views fold in here, not duplicated.) |
| `/stores/:id/stock/adjustments`     | List + new adjustment with reason + evidence upload + post.                                                |
| `/stores/:id/stock/suppliers`       | Supplier CRUD.                                                                                             |
| `/stores/:id/stock/purchase-orders` | PO list + new PO + receive PO.                                                                             |
| `/stores/:id/stock/reorder`         | AI reorder dashboard — suggestion cards, one-click draft PO.                                               |
| `/stores/:id/stock/backorders`      | Open BackorderLines, bulk-PO-from-backorder, cancel + auto-refund.                                         |
| `/stores/:id/stock/deadstock`       | AI dead-stock dashboard — clearance copy + draft coupon.                                                   |

### Insights group (Batch 4)

| Route                            | Purpose                                                                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `/stores/:id/insights/dashboard` | KPI tiles: AOV trend / rolling-30d revenue / repeat purchase rate / top segments / top 5 SKUs by velocity.                    |
| `/stores/:id/insights/cohorts`   | Month-by-month retention matrix + LTV curve. AI commentary on notable cohort shifts.                                          |
| `/stores/:id/insights/funnel`    | Checkout funnel chart with per-step drop-off rate (daily aggregate, 7d/30d/90d windows). AI commentary on drop-off anomalies. |
| `/stores/:id/insights/segments`  | RFM segment cards; for each segment, customer list + recommended action (re-engage / VIP perks / churn alert).                |
| `/stores/:id/insights/products`  | SKU velocity ranking, ASP trend, FBT affinity pairs (leverages existing FrequentlyBoughtTogether), dead-stock cross-link.     |

### Per CLAUDE.md UI rules

- Admin pages mirror storefront/operational flow (sales → costs → reports), not alphabetical (rule 5).
- Controls within each page mirror the storefront top-to-bottom flow where relevant (rule 5).
- All copy in `apps/admin/messages/{en,ar}.json` for i18n (rule 3 platform-level).
- ThemeTab clutter ceiling (rule 4) doesn't apply — these are new sidebar groups.

---

## Part 7 — Integration hooks (boundary contracts with other sessions)

### 7.1 Frontend session

We expose schema fields the frontend session consumes; they wire storefront UI. **No coordination needed beyond contract review.**

- Product API response gains: `inStock: boolean`, `acceptsBackorder: boolean`, `lowStock: boolean`, `availableQty: number | null`. `availableQty` is the exact qty when `lowStock=true` OR `acceptsBackorder=true` (so storefront can show "Only 3 left" / "0 in stock — pre-order"); `null` when `inStock=true AND !lowStock` (avoids leaking stock counts for normal in-stock products to competitors).
- Frontend session can layer "Pre-order" / "Ships when restocked" CTA, OOS ribbon enhancements, low-stock urgency text.

### 7.2 WBS (WhatsApp Bulk Sender) integration session

We emit Inngest events; they dispatch. **Event contract owned by us, dispatcher owned by them.**

| Event                      | Payload                                                                              | When fired                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `stock/low`                | `{ storeId, productId, variantId?, currentQty, threshold }`                          | When inventory crosses `lowStockThreshold` downward (already a signal in InventoryHistory — we promote it to an event) |
| `stock/depleted`           | `{ storeId, productId, variantId?, allowBackorder }`                                 | When inventory hits 0                                                                                                  |
| `backorder/fulfilled`      | `{ storeId, orderItemId, customerId, productId, qty }`                               | Each time a BackorderLine.fulfilledAt is set                                                                           |
| `accounting/anomaly`       | `{ storeId, severity: 'p0'\|'warning', metric, currentValue, baseline, productId? }` | Profit anomaly threshold crossed                                                                                       |
| `insights/segment-changed` | `{ storeId, customerId, previousSegment, newSegment }`                               | Daily rollup detects a customer moved between RFM segments                                                             |

WBS session subscribes via `inngest.createFunction({ event: 'stock/low' }, ...)` and translates to WhatsApp dispatch using their existing templates.

### 7.3 Existing FWB systems we hook into (no schema change to them)

- **Payment webhook (`/webhooks/payment/:provider`)** — existing handler posts `order/created` Inngest event. We add a sync journal post step to the `OrderService.markPaid` flow.
- **`OrderService.applyRefundEffects`** — 7th edge added (journal reversal). Existing 6 edges (inventory, coupon, commission, loyalty, customer profile, notifications) untouched. Per `feedback-fwb-refund-side-effect-pipeline` standing pattern.
- **AbandonedCart, LoyaltyTransaction, Coupon, AffiliateReferral** — read-only references for analytics. No schema mutation.
- **Existing `InventoryHistory`** — we keep populating it for backwards compat. New stock adjustments also write an InventoryHistory row (`type=adjustment`, `reference=stockAdjustmentId`) alongside the new StockAdjustment row.

---

## Part 8 — Kuwait + MOF specifics

- **All money fields in fils (Int).** Display layer divides by 1000 for KWD presentation. Already the FWB convention.
- **Currency = KWD** by default on every new table. Store.currency overrides.
- **`Store.defaultTaxRateBps = 0`** today (Kuwait has no VAT). Tax Payable account exists; per-product tax rate override planned for v2. When Kuwait activates VAT, switching is a config change + per-product rate setting + journal split already separates Tax Payable line.
- **Retention.** JournalEntry / JournalLine / posted Expense / posted StockAdjustment carry no `deletedAt`. Soft-delete is forbidden — MOF requires immutable financial records. Reversals via `reversedById` keep the audit trail.
- **GDPR / Kuwait Law 13/2023 erasure.** `AuthService.eraseAccount(userId)` (existing) extends to anonymize customer-side fields on Order (shippingAddress.name / phone / email scrubbed) but preserves Order, OrderItem, Payment, JournalEntry, JournalLine intact — required for MOF audit. The anonymization replaces customer PII with `ERASED-<userId-hash>` markers. Pattern matches existing `feedback-fwb-gdpr-erase-reuse-pattern`.
- **Bilingual.** Every Account, Expense, JournalEntry memo, AI-generated reasoning / clearance copy / commentary has `*Ar` sibling. Admin UI locale-switches.

---

## Part 9 — Phasing (4 commit batches)

Each batch is a coherent ship-able unit. Run the standing recipe (13-rule code-quality gate, rollback recipe, Iceberg Audit dispatch, memory update) after each.

### Batch 1 — Accounting foundations (~5-7 commits)

- Prisma schema: `Account`, `JournalEntry`, `JournalLine` + `Store` extensions (`accountingEnabled`, `defaultTaxRateBps`, `fiscalYearStartMonth`).
- Hand-written migration for CHECK constraints + deferred DR=CR trigger + RLS policies + per-store sequence table.
- `@ebda/database` exports for new enums.
- `apps/api/src/services/accounting/`:
  - `account.service.ts` — COA CRUD + seed-on-store-create hook.
  - `journal.service.ts` — `post(entry, lines)`, `reverse(entryId)`, idempotency check by `(source, sourceId)`.
  - `posting/order-posting.ts` — hooks into `OrderService.markPaid`.
  - `posting/refund-posting.ts` — extends `applyRefundEffects` with the journal-reversal edge.
- `apps/api/src/routes/finance.routes.ts` — accounts + journal endpoints.
- COA seed for all existing Stores (one-off script `scripts/seed-coa-for-existing-stores.mjs`).
- `apps/admin/src/app/stores/[id]/finance/journal/page.tsx` + `accounts/page.tsx` — read-only journal viewer + COA tree editor.
- Inngest job: `accounting/daily-close` + `accounting/period-reconciliation`.
- E2E test: place a paid order → assert journal entry exists with correct DR/CR; refund → assert reversal posted. (PO-receipt posting tested in Batch 2 when POs ship.)

### Batch 2 — Stock + backorders + Finance dashboard (~6-8 commits)

- Schema: `Supplier`, `PurchaseOrder` + `PurchaseOrderItem`, `StockAdjustment` + `StockAdjustmentItem`, `ReorderRule`, `BackorderLine`, `Expense`. Extensions: `Product/Variant.allowBackorder`, `Product.lastCostUpdateAt`, `OrderItem.costPriceDeferred`, `Store.expenseTwoStepApproval`.
- Services: `supplier.service.ts`, `purchase-order.service.ts` (with WAC + backorder FIFO logic), `stock-adjustment.service.ts`, `backorder.service.ts` (cancel + auto-refund), `expense.service.ts`.
- API extensions on product list / detail endpoints to surface `inStock`, `acceptsBackorder`, `lowStock`, `availableQty`.
- `CartService.addToCart` + `OrderService.createOrder` updates to allow zero-stock-buy when `allowBackorder=true`.
- Admin pages under `/stores/:id/stock/*` (8 pages per Part 6).
- Admin pages under `/stores/:id/finance/` for `dashboard`, `expenses`, `reports`.
- Reports service generating Trial Balance / P&L / Balance Sheet from JournalLine sums.
- E2E tests: PO lifecycle + backorder fulfilment + variance posting + stock adjustment posting + expense single-step + two-step approval.

### Batch 3 — Smart layer (~4-6 commits)

- `ReorderSuggestion` lightweight table (purged nightly past 30 days).
- Inngest functions:
  - `stock/reorder-scan` daily 06:00
  - `stock/deadstock-scan` weekly Sun 06:00
  - `accounting/profit-anomaly` daily 06:00
  - `accounting/expense-ocr-process` on-demand
- Receipt upload endpoint at `/expenses/upload-receipt` → R2 + Inngest fire.
- Gemini Flash Lite (vision) prompt + JSON parser for receipt OCR.
- Admin dashboards under `/stock/reorder`, `/stock/deadstock`, alerts surfaced on `/finance/dashboard`.
- Bilingual prompt templates for clearance copy + reasoning.
- E2E tests: synthetic order history → reorder suggestion fires; old + valuable product → dead-stock detected; receipt fixture → expense draft created with correct category.

### Batch 4 — Insights / BI tier (~5-7 commits)

- Schema: `CustomerCohortSnapshot`, `FunnelSnapshot`, `CustomerRfmSnapshot`.
- Inngest function `analytics/daily-rollup` daily 02:00 KW running cohort + funnel + RFM in sequence (concurrency-keyed per store).
- Admin pages under `/stores/:id/insights/*` (5 pages per Part 6).
- Reusable chart primitives (cohort heatmap, funnel bar, RFM scatter) in `@ebda/ui` if not already present.
- AI commentary endpoints (rate-limited, lazy-fired on dashboard load with caching).
- E2E test: seed N customers across cohorts → rollup → assert retention matrix matches expected.

### Cross-batch policies

- Every batch follows `feedback-rollback-recipe` (Neon snapshot per commit, rollback script verified).
- Every batch passes 0/0/0/0 `npm audit` at every severity.
- Every batch updates `graphify-out/` (`graphify update .` after each commit batch).
- Every batch's PR description includes the dependency-check 5-point output (per `feedback-ai-deps-discipline`).
- Iceberg Audit runs after Batch 2 (mid-feature) and Batch 4 (final) per the standing schedule.

---

## Part 10 — Acceptance criteria

A merchant on FWB at end of Batch 4 should be able to:

1. **Place a sale → see the journal entry post automatically.** Open Journal page → see DR Cash + CR Sales + CR Tax + DR COGS + CR Inventory, all balancing.
2. **Refund an order → see reversal entry.** Original entry status flips to `reversed`, new reversal entry visible.
3. **Receive a PO → see inventory increase + WAC update + AP credit.** Product.costPrice reflects weighted-average correctly.
4. **Enable backorder on a product, sell through zero → order completes, backorder line created.** Receive PO → backorder fulfilled, deferred COGS posts, customer gets `backorder.fulfilled` notification (via WBS dispatcher).
5. **Upload a receipt photo → draft expense created with vendor/amount/category populated.** Edit + approve → journal posts.
6. **Get a daily reorder suggestion based on velocity + lead time + open backorders.** Click suggestion → draft PO opens pre-filled.
7. **See P&L / Balance Sheet / Trial Balance exportable to PDF and XLSX.**
8. **See cohort retention matrix month-by-month + checkout funnel drop-off.**
9. **See RFM segments with bilingual AI-summarized actions.**
10. **Profit-margin drop > 40% → P0 Telegram alert fires.**
11. **All admin pages bilingual EN/AR.** Switching locale flips every Account name, Expense memo, AI commentary correctly.
12. **No journal entry ever silently disappears.** All corrections via reversal.

---

## Part 11 — Open questions / decisions deferred

- **Per-product tax rate override** (Part 8) — schema-ready but admin UI deferred to v2 unless Kuwait activates VAT first.
- **B2B credit terms / AR aging** beyond a generic "Accounts Receivable" account — deferred unless a merchant explicitly asks.
- **Bank reconciliation** against KNET / MyFatoorah settlement files — deferred to v2 (needs ETL of settlement reports, separate spec).
- **Multi-warehouse / multi-location** — schema designed single-warehouse; multi-warehouse retrofit requires splitting `Product.inventory` into a per-location join table. Spec'd as future work; not blocked by current schema.
- **Per-session funnel attribution** — deferred until frontend session wires an `analytics.track()` SDK on the storefront. Current funnel is daily aggregate from existing timestamps.
- **Marketing-source attribution (UTM)** — deferred to a future "Marketing Insights" extension; not in scope of this spec.

---

## Part 12 — Risks + mitigations

| Risk                                                                      | Mitigation                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Journal posting failures break checkout                                   | Synchronous posting in same `$transaction`; if journal fails, sale fails (loud error, customer retries — preferable to silent GL drift).                                                                                                        |
| Deferred-COGS-on-backorder drift                                          | `accounting/period-reconciliation` Inngest job daily flags any OrderItem with `costPriceDeferred=true` older than 30 days as suspect; admin sees a red badge.                                                                                   |
| WAC recompute bug corrupting all future COGS                              | Hand-written unit tests covering edge cases (negative on-hand, zero on-hand, multi-variant). Code path goes through one helper `recomputeWac(productId, receivedQty, unitCost)`; mutating Product.costPrice elsewhere is forbidden (lint rule). |
| AI prompt drift on Expense OCR (Gemini model change)                      | Pin `GEMINI_MODEL` env var; OCR job records the model version used in `ocrJson`; failing JSON parse → drafts an empty Expense with raw OCR text shown to the merchant for manual entry. Always degrades gracefully.                             |
| Frontend session ships backorder badge before our flags are live          | Schema-only contract published in Batch 1 (the API fields are part of Batch 2 deliverables). Frontend session waits for Batch 2 merge. Communicated explicitly in the kickoff.                                                                  |
| WBS session subscribes to events before they fire                         | Inngest event registry deployed in Batch 2; WBS subscribers can register against unfired events safely.                                                                                                                                         |
| Daily rollup job blows past Gemini quota when fanning out across N stores | Already shares `AI_DAILY_REQUEST_CAP` / `AI_MONTHLY_REQUEST_CAP` guard. AI commentary in Insights is lazy-fired on admin dashboard load, not in the rollup itself.                                                                              |

---

## Sign-off

Approved by Ahmad 2026-05-19 via brainstorming flow:

- Hybrid GL + merchant view ✓
- Single warehouse + suppliers + reorder AI ✓
- Admin + backend only ✓
- Weighted average costing ✓
- All 4 AI features (reorder, dead-stock, profit anomaly, expense OCR) ✓
- Opt-in backorders ✓
- Insights / BI cohort + funnel + RFM tier ✓
- Posting model = hybrid (sync core, async secondary) — locked

Open follow-up: writing the implementation plan via `superpowers:writing-plans`.
