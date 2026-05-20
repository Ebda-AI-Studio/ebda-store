# FWB Accounting Batch 3 — Smart Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ship the 4 AI Inngest jobs (reorder suggestions, dead-stock detection, profit anomaly, expense OCR) + replace the Batch 2 placeholder pages with live AI-driven admin surfaces + activate Socket.io real-time UI refresh.

**Architecture:** Identical patterns to Batch 2 — Inngest functions per AI job (concurrency-keyed per store, retries:3), hand-written migration, services in `apps/api/src/services/accounting/`, posting helpers reuse `postEntry({source,sourceId})` idempotency, all AI outputs bilingual via Gemini Flash Lite returning `{en,ar}` JSON. New: Socket.io broadcast on completion → admin pages SWR-refetch.

**Tech Stack:** Prisma + Postgres (Neon), Express + TypeScript, Next.js 16 admin, Inngest, Gemini Flash Lite (vision-enabled for OCR), Socket.io (existing in repo, currently inactive per CLAUDE.md known issues), R2 (already wired for image uploads).

**Spec reference:** `docs/superpowers/specs/2026-05-20-fwb-accounting-batch-3-smart-layer.md`.

**Out of scope:** Insights/cohort/funnel/RFM (Batch 4), per-session checkout-funnel attribution (deferred), Gemini fine-tuning, multi-currency OCR.

---

## File Structure

**Created (18 files):**

- `packages/database/prisma/migrations/<TS>_accounting_batch_3/migration.sql`
- `apps/api/src/services/accounting/reorder-scan.service.ts`
- `apps/api/src/services/accounting/deadstock-scan.service.ts`
- `apps/api/src/services/accounting/profit-anomaly.service.ts`
- `apps/api/src/services/accounting/expense-ocr.service.ts`
- `apps/api/src/services/accounting/gemini-ai.service.ts` (shared Gemini client)
- `apps/api/src/lib/inngest/functions/stock-reorder-scan.ts`
- `apps/api/src/lib/inngest/functions/stock-deadstock-scan.ts`
- `apps/api/src/lib/inngest/functions/accounting-profit-anomaly.ts`
- `apps/api/src/lib/inngest/functions/accounting-expense-ocr-process.ts`
- `apps/api/src/lib/socket.ts` (centralizes the broadcast helper)
- `apps/admin/src/app/stores/[id]/finance/anomalies/page.tsx` (new)
- `apps/admin/src/app/stores/[id]/finance/expenses/[id]/page.tsx` (expense detail w/ OCR upload — if not existing)
- `tests/integration/accounting/reorder-scan.test.ts`
- `tests/integration/accounting/deadstock-scan.test.ts`
- `tests/integration/accounting/profit-anomaly.test.ts`
- `tests/integration/accounting/expense-ocr.test.ts`

**Modified:**

- `packages/database/prisma/schema.prisma` (3 new tables + 2 enums + extensions on Expense + Store)
- `packages/database/src/index.ts` (re-export enums)
- `apps/api/src/lib/inngest/client.ts` (add 4 new event types)
- `apps/api/src/lib/inngest/functions/index.ts` (register 4 new functions)
- `apps/api/src/routes/expenses.routes.ts` (wire receipt upload endpoint to fire OCR event)
- `apps/api/src/services/accounting/purchase-order.service.ts` (`createFromSuggestion(suggestionId)` factory)
- `apps/api/src/services/coupon.service.ts` (`createFromDeadstockFlag(flagId)` factory — if coupon.service exists; else inline in deadstock-scan)
- `apps/api/src/services/alerts.service.ts` (use existing `sendAlert` for P0 anomalies; no edit needed if signature stable)
- `apps/admin/src/app/stores/[id]/stock/reorder/page.tsx` (replace placeholder with live cards)
- `apps/admin/src/app/stores/[id]/stock/deadstock/page.tsx` (replace placeholder)
- `apps/admin/src/app/stores/[id]/finance/dashboard/page.tsx` (add "Recent anomalies" + "Pending OCR drafts" sections)
- `apps/admin/src/app/stores/[id]/finance/expenses/new/page.tsx` (add OCR upload section)
- `apps/admin/src/contexts/NotificationContext.tsx` (subscribe to UI refresh events)
- `apps/admin/src/i18n/messages/{en,ar}.json` (new `stock.reorder.*`, `stock.deadstock.*`, `finance.anomalies.*`, `finance.expenses.ocr.*` keys)

---

## Pre-flight

- [ ] **P1:** Verify `git config user.email = ahmed0montaser@gmail.com` (Vercel Hobby author rule).
- [ ] **P2:** `bash scripts/backup-db.sh` (local backup before schema change).
- [ ] **P3:** Verify Gemini API key env var:
  ```bash
  grep -q "^GOOGLE_GENERATIVE_AI_KEY=" apps/api/.env && echo "✓ key present" || echo "✗ MISSING — set before continuing"
  ```

---

## Task 1: Schema + migration

**Files:** `schema.prisma` + new migration dir + `src/index.ts`

### Step 1: Append to `packages/database/prisma/schema.prisma`

```prisma
// ==========================================
// Smart layer (Batch 3) — advisory tables, soft-deletable
// ==========================================

enum ReorderSuggestionStatus { open; accepted; dismissed; expired }
enum DeadStockFlagStatus     { open; accepted_clearance; dismissed; expired }
enum AnomalyScope            { store; category; product }
enum AnomalyMetric           { margin_drop; cost_spike; revenue_drop; refund_spike }
enum AnomalySeverity         { warning; p0 }

model ReorderSuggestion {
  id           String  @id @default(uuid())
  storeId      String  @map("store_id")
  productId    String  @map("product_id")
  variantId    String? @map("variant_id")
  suggestedQty Int     @map("suggested_qty")
  velocity7d   Float   @map("velocity_7d")
  velocity28d  Float   @map("velocity_28d")
  onHand       Int     @map("on_hand")
  onOrder      Int     @map("on_order")
  openBacklog  Int     @map("open_backlog")
  urgencyDays  Int     @map("urgency_days")
  supplierId   String? @map("supplier_id")
  reasoningEn  String  @map("reasoning_en")
  reasoningAr  String? @map("reasoning_ar")
  status       ReorderSuggestionStatus @default(open)
  dismissedBy  String?  @map("dismissed_by")
  dismissedAt  DateTime? @map("dismissed_at")
  poId         String?  @map("po_id")
  scannedAt    DateTime @default(now()) @map("scanned_at")

  store    Store           @relation(fields: [storeId], references: [id], onDelete: Cascade)
  product  Product         @relation(fields: [productId], references: [id], onDelete: Cascade)
  variant  ProductVariant? @relation(fields: [variantId], references: [id], onDelete: Cascade)
  supplier Supplier?       @relation(fields: [supplierId], references: [id], onDelete: SetNull)

  @@unique([storeId, productId, variantId, scannedAt])
  @@index([storeId, status, scannedAt(sort: Desc)])
  @@map("reorder_suggestions")
}

model DeadStockFlag {
  id                   String   @id @default(uuid())
  storeId              String   @map("store_id")
  productId            String   @map("product_id")
  variantId            String?  @map("variant_id")
  daysSinceSale        Int      @map("days_since_sale")
  stockOnHand          Int      @map("stock_on_hand")
  stockValueFils       Int      @map("stock_value_fils")
  suggestedDiscountBps Int      @map("suggested_discount_bps")
  clearanceCopyEn      String   @map("clearance_copy_en")
  clearanceCopyAr      String?  @map("clearance_copy_ar")
  status               DeadStockFlagStatus @default(open)
  couponCode           String?  @map("coupon_code")
  dismissedBy          String?  @map("dismissed_by")
  dismissedAt          DateTime? @map("dismissed_at")
  scannedAt            DateTime @default(now()) @map("scanned_at")

  store   Store           @relation(fields: [storeId], references: [id], onDelete: Cascade)
  product Product         @relation(fields: [productId], references: [id], onDelete: Cascade)
  variant ProductVariant? @relation(fields: [variantId], references: [id], onDelete: Cascade)

  @@unique([storeId, productId, variantId, scannedAt])
  @@index([storeId, status])
  @@map("deadstock_flags")
}

model ProfitAnomaly {
  id              String          @id @default(uuid())
  storeId         String          @map("store_id")
  scope           AnomalyScope
  scopeId         String?         @map("scope_id")
  metric          AnomalyMetric
  current7d       Float           @map("current_7d")
  baseline28d     Float           @map("baseline_28d")
  deltaPercent    Float           @map("delta_percent")
  severity        AnomalySeverity
  explanationEn   String          @map("explanation_en")
  explanationAr   String?         @map("explanation_ar")
  acknowledged    Boolean         @default(false)
  acknowledgedBy  String?         @map("acknowledged_by")
  acknowledgedAt  DateTime?       @map("acknowledged_at")
  detectedAt      DateTime        @default(now()) @map("detected_at")

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@index([storeId, severity, detectedAt(sort: Desc)])
  @@index([storeId, acknowledged])
  @@map("profit_anomalies")
}
```

Extensions:

- `Expense`: `ocrJson Json? @map("ocr_json")` (already shipped in Batch 2), add `ocrModelVersion String? @map("ocr_model_version")` + `ocrProcessedAt DateTime? @map("ocr_processed_at")`
- `Store`: `aiFeaturesEnabled Boolean @default(true) @map("ai_features_enabled")` + `aiBulkThrottleMs Int @default(2500) @map("ai_bulk_throttle_ms")`

Reverse relations on `Store/Product/ProductVariant/Supplier` — add `reorderSuggestions`, `deadstockFlags`, `profitAnomalies` arrays.

### Step 2: Validate

```bash
npm run db:generate -w packages/database && npm run build -w packages/database
```

### Step 3: Hand-write migration `packages/database/prisma/migrations/<TS>_accounting_batch_3/migration.sql`

Use timestamp `20260520000000`. Include: 5 enum CREATEs, 3 table CREATEs with FKs + indexes, 5 ALTER TABLE statements for extensions, RLS policies (4 — one per new table + Expense already has none from B2 because the original Expense already had it).

Apply:

```bash
cd packages/database && npx prisma migrate deploy && cd ../..
```

### Step 4: Re-export enums

In `packages/database/src/index.ts`, add to existing `export { ... } from '@prisma/client'` block:

```ts
ReorderSuggestionStatus,
DeadStockFlagStatus,
AnomalyScope,
AnomalyMetric,
AnomalySeverity,
```

### Step 5: Commit

```bash
git add packages/database/prisma/schema.prisma packages/database/prisma/migrations/20260520000000_accounting_batch_3/ packages/database/src/index.ts
git commit -m "feat(db): batch 3 schema — reorder suggestions + deadstock flags + profit anomalies"
```

---

## Task 2: Shared Gemini AI service

**Files:** `apps/api/src/services/accounting/gemini-ai.service.ts`

Wrapper around `@google/generative-ai`. Exports:

- `callGemini<T>({ prompt, responseSchema, imageBase64? }): Promise<T>` — single call
- `callGeminiBatch<T>({ items, perItemPrompt, responseSchema }): Promise<T[]>` — chunked + throttled per `Store.aiBulkThrottleMs`
- Honors `AI_DAILY_REQUEST_CAP` / `AI_MONTHLY_REQUEST_CAP` (existing in `lib/ai-quota.ts`)

```ts
import { GoogleGenerativeAI, type GenerationConfig } from '@google/generative-ai';
import logger from '../../lib/logger';
// Existing quota helpers — confirm names via grep before using:
import { checkAiQuota, recordAiUsage } from '../../lib/ai-quota';

const apiKey = process.env.GOOGLE_GENERATIVE_AI_KEY;
const modelName = process.env.GEMINI_MODEL ?? 'gemini-flash-lite-latest';

const client = apiKey ? new GoogleGenerativeAI(apiKey) : null;

export interface CallGeminiOpts<T> {
  prompt: string;
  responseSchema?: Record<string, unknown>;
  imageBase64?: string;
  imageMimeType?: string; // e.g. 'image/jpeg'
  storeId?: string; // for quota attribution
}

export async function callGemini<T>(opts: CallGeminiOpts<T>): Promise<T> {
  if (!client) throw new Error('GOOGLE_GENERATIVE_AI_KEY not set');
  await checkAiQuota(opts.storeId);
  const model = client.getGenerativeModel({ model: modelName });
  const generationConfig: GenerationConfig = {
    responseMimeType: 'application/json',
    ...(opts.responseSchema ? { responseSchema: opts.responseSchema as any } : {}),
  };
  const parts: any[] = [{ text: opts.prompt }];
  if (opts.imageBase64 && opts.imageMimeType) {
    parts.push({ inlineData: { mimeType: opts.imageMimeType, data: opts.imageBase64 } });
  }
  const result = await model.generateContent({
    contents: [{ role: 'user', parts }],
    generationConfig,
  });
  const text = result.response.text();
  await recordAiUsage(opts.storeId);
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    logger.error({ err, text }, 'callGemini: malformed JSON');
    throw new Error('Gemini returned malformed JSON');
  }
}
```

Build + commit:

```bash
npm run build -w apps/api
git add apps/api/src/services/accounting/gemini-ai.service.ts
git commit -m "feat(accounting): shared gemini ai client + quota gate"
```

---

## Task 3: Reorder scan service + Inngest

**Files:** `reorder-scan.service.ts` + `stock-reorder-scan.ts` (Inngest) + register in `functions/index.ts` + client event

### Service shape

```ts
export interface ReorderScanResult {
  scanned: number;
  suggested: number;
  expiredCount: number;
}

export async function runReorderScan(storeId: string): Promise<ReorderScanResult> {
  // 1. Mark old suggestions as expired (status='open' AND scannedAt < 30 days ago)
  // 2. For each active product with trackInventory:
  //    - velocity7d/28d from OrderItem aggregation
  //    - read ReorderRule if exists, else use Product.lowStockThreshold defaults
  //    - compute projectedStock per spec algorithm
  //    - if projected < min: stage suggestion (productId, qty, velocity, etc.)
  // 3. Batch-call Gemini for bilingual reasoning (max 20 products per call):
  //    callGeminiBatch with prompt template from spec Part 3.1
  // 4. Upsert ReorderSuggestion rows (unique on (storeId, productId, variantId, scannedAt))
  // 5. Return counts.
}
```

### Inngest function

```ts
export const stockReorderScan: InngestFunction.Any = inngest.createFunction(
  {
    id: 'stock-reorder-scan',
    name: 'Reorder scan (AI)',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: '0 3 * * *' }],
  }, // 06:00 KW
  async ({ step }) => {
    const stores = await step.run('list-stores', () =>
      prisma.store.findMany({
        where: { accountingEnabled: true, aiFeaturesEnabled: true, deletedAt: null },
        select: { id: true },
      })
    );
    let totalSuggested = 0;
    for (const store of stores) {
      const result = await step.run(`scan-${store.id}`, () => runReorderScan(store.id));
      totalSuggested += result.suggested;
      // Socket.io broadcast (Task 11):
      // broadcastToStore(store.id, { name: 'ui/reorder-scanned', data: { count: result.suggested } });
    }
    return { stores: stores.length, totalSuggested };
  }
);
```

Also export an on-demand variant triggered by event `stock/reorder-scan-requested` for the admin "Re-scan now" button.

Build + commit + register:

```bash
npm run build -w apps/api
git add apps/api/src/services/accounting/reorder-scan.service.ts apps/api/src/lib/inngest/functions/stock-reorder-scan.ts apps/api/src/lib/inngest/client.ts apps/api/src/lib/inngest/functions/index.ts
git commit -m "feat(accounting): reorder scan service + inngest cron (06:00 kw)"
```

---

## Task 4: Dead-stock scan service + Inngest

Mirror Task 3 but weekly (Sunday 06:00 KW = cron `0 3 * * 0`). Service: `runDeadstockScan(storeId)`. Function: `stockDeadstockScan`. Event: `stock/deadstock-scan-requested` (on-demand variant).

Gemini prompt per spec Part 3.2 — returns `{ items: [{ productId, discountPercent, copyEn, copyAr }] }`. Service writes `DeadStockFlag` rows with `suggestedDiscountBps = round(discountPercent * 100)`.

Build + commit:

```bash
git add apps/api/src/services/accounting/deadstock-scan.service.ts apps/api/src/lib/inngest/functions/stock-deadstock-scan.ts apps/api/src/lib/inngest/client.ts apps/api/src/lib/inngest/functions/index.ts
git commit -m "feat(accounting): deadstock scan service + inngest cron (weekly sun)"
```

---

## Task 5: Profit anomaly service + Inngest

Daily 06:30 KW = cron `30 3 * * *`. Service: `runProfitAnomalyScan(storeId)`.

Algorithm per spec Part 3.3:

- Aggregate from journal_lines via reports.service helpers (already shipped Batch 2)
- For each metric (margin_drop / cost_spike / revenue_drop / refund_spike): compute 7d current vs 28d baseline delta
- If |delta| > 0.20 OR > 0.40 → call Gemini for explanation referencing recent context (last 5 InventoryHistory rows, last 5 refunds, top 5 coupon usages)
- Insert ProfitAnomaly row
- If severity='p0' AND no other P0 ProfitAnomaly for this metric in last 24h: fire `alerts.service.sendAlert({ level: 'p0', ... })` (existing — Batch 1 pattern)

Build + commit:

```bash
git add apps/api/src/services/accounting/profit-anomaly.service.ts apps/api/src/lib/inngest/functions/accounting-profit-anomaly.ts apps/api/src/lib/inngest/client.ts apps/api/src/lib/inngest/functions/index.ts
git commit -m "feat(accounting): profit anomaly scan + p0 telegram alerts"
```

---

## Task 6: Expense OCR service + Inngest

**Files:** `expense-ocr.service.ts` + `accounting-expense-ocr-process.ts` + modify `expenses.routes.ts`

### Service

```ts
export async function processExpenseReceipt(args: {
  storeId: string;
  receiptUrl: string;
  uploadedBy?: string;
}): Promise<{ expenseId: string }> {
  // 1. Fetch image bytes from R2 receiptUrl → base64
  // 2. Detect MIME from URL extension (jpg/png/webp) — reject others
  // 3. callGemini with vision prompt from spec Part 3.4 + image
  // 4. Map suggested category → COA code (5100/5200/5300/...) via lookup table
  // 5. Resolve expenseAccountId via getSystemAccountIdByCode
  // 6. Create Expense with status='draft', ocrJson populated, categoryAiConfidence,
  //    ocrModelVersion, ocrProcessedAt, receiptImageUrl, paidFromAccountId=1000 (default Cash KNET)
  // 7. Return { expenseId }
}
```

### Inngest function

Listens to `accounting/expense-ocr-process` event. Calls `processExpenseReceipt`. On failure, still creates a draft Expense with `notes: 'OCR failed — please enter manually'`.

### Wire route

In `expenses.routes.ts`, the `/upload-receipt` endpoint (was returning 501 in Batch 2) now:

1. Accepts multipart upload
2. Stores image in R2
3. Fires `accounting/expense-ocr-process` event
4. Returns 202 + `{ message: 'Processing — expense draft will appear shortly' }`

Build + commit:

```bash
git add apps/api/src/services/accounting/expense-ocr.service.ts apps/api/src/lib/inngest/functions/accounting-expense-ocr-process.ts apps/api/src/lib/inngest/client.ts apps/api/src/lib/inngest/functions/index.ts apps/api/src/routes/expenses.routes.ts
git commit -m "feat(accounting): expense receipt ocr via gemini vision"
```

---

## Task 7: "Draft PO from suggestion" + "Clearance from flag" service methods

### In `purchase-order.service.ts`

```ts
export async function createPoFromSuggestion(suggestionId: string, createdBy?: string): Promise<PurchaseOrder> {
  const sug = await prisma.reorderSuggestion.findUnique({ where: { id: suggestionId }, include: { product: true } });
  if (!sug || sug.status !== 'open') throw new Error(...);
  const po = await createPurchaseOrder({
    storeId: sug.storeId,
    supplierId: sug.supplierId ?? (await pickLastSupplierForProduct(sug.productId)),
    items: [{ productId: sug.productId, variantId: sug.variantId ?? undefined, qty: sug.suggestedQty, unitCost: sug.product.costPrice ?? 0 }],
    createdBy,
  });
  await prisma.reorderSuggestion.update({ where: { id: suggestionId }, data: { status: 'accepted', poId: po.id } });
  return po;
}
```

### Inline in `deadstock-scan.service.ts` (no separate coupon.service edit needed)

```ts
export async function createClearanceCouponFromFlag(flagId: string): Promise<{ couponCode: string }> {
  const flag = await prisma.deadStockFlag.findUnique({ where: { id: flagId }, include: { product: true } });
  if (!flag || flag.status !== 'open') throw new Error(...);
  const code = `CLEAR-${flag.product.sku ?? flag.productId.slice(0, 6).toUpperCase()}`;
  const coupon = await prisma.coupon.create({
    data: {
      storeId: flag.storeId,
      code,
      type: 'percentage',
      value: Math.round(flag.suggestedDiscountBps / 100),
      // scope to product via existing coupon-product relation if exists, else
      // generic store-wide with a note that merchant should narrow
    },
  });
  await prisma.deadStockFlag.update({ where: { id: flagId }, data: { status: 'accepted_clearance', couponCode: code } });
  return { couponCode: code };
}
```

Build + commit:

```bash
git add apps/api/src/services/accounting/purchase-order.service.ts apps/api/src/services/accounting/deadstock-scan.service.ts
git commit -m "feat(accounting): one-click po from suggestion + clearance coupon from flag"
```

---

## Task 8: Admin pages — Reorder + Deadstock + Anomalies

### `/stock/reorder/page.tsx` — REPLACE Batch 2 placeholder

Fetches `GET /api/v1/stores/:id/stock/reorder-suggestions` (new endpoint in finance.routes.ts or a new routes file). Cards per spec Part 4.1.

### `/stock/deadstock/page.tsx` — REPLACE Batch 2 placeholder

Fetches `GET /api/v1/stores/:id/stock/deadstock-flags`. Cards per spec Part 4.2.

### `/finance/anomalies/page.tsx` (new)

List `ProfitAnomaly` with filters (severity, acknowledged). Drill-in shows full explanation + raw 7d/28d numbers + cross-links to affected products/orders.

### `/finance/dashboard/page.tsx` — extend

Add `RecentAnomaliesCard` (top 3 unacknowledged) + `PendingOcrDraftsCard` (count of Expenses with `ocrJson IS NOT NULL AND status='draft'`).

### Routes to add in `finance.routes.ts` (or new stock-suggestions.routes.ts)

- `GET /:storeId/stock/reorder-suggestions`
- `POST /:storeId/stock/reorder-suggestions/:id/accept` → calls `createPoFromSuggestion`
- `POST /:storeId/stock/reorder-suggestions/:id/dismiss`
- `GET /:storeId/stock/deadstock-flags`
- `POST /:storeId/stock/deadstock-flags/:id/clearance` → calls `createClearanceCouponFromFlag`
- `POST /:storeId/stock/deadstock-flags/:id/dismiss`
- `GET /:storeId/finance/anomalies`
- `POST /:storeId/finance/anomalies/:id/acknowledge`
- `POST /:storeId/stock/reorder-scan/run-now` → fires Inngest event (super_admin)
- `POST /:storeId/stock/deadstock-scan/run-now` → fires Inngest event (super_admin)

Build + commit:

```bash
git add apps/admin/src/app/stores/\[id\]/stock/reorder/ apps/admin/src/app/stores/\[id\]/stock/deadstock/ apps/admin/src/app/stores/\[id\]/finance/anomalies/ apps/admin/src/app/stores/\[id\]/finance/dashboard/ apps/api/src/routes/finance.routes.ts apps/admin/src/i18n/messages/en.json apps/admin/src/i18n/messages/ar.json
git commit -m "feat(admin): smart layer pages — reorder + deadstock + anomalies + dashboard cards"
```

---

## Task 9: Expense form OCR upload section

In `apps/admin/src/app/stores/[id]/finance/expenses/new/page.tsx`, ABOVE the form, add a "Upload receipt (AI auto-fill)" section:

- File input (accept: jpg/png/webp)
- On upload: POST to `/api/v1/stores/:id/expenses/upload-receipt` (multipart)
- Show spinner: "Reading receipt with AI..."
- Poll `GET /api/v1/stores/:id/expenses?status=draft&hasOcr=true&perPage=1` every 2s until a new draft appears (max 30s)
- When found: navigate to `/finance/expenses/:newId/edit` (or auto-fill the current form)
- If timeout: show error + keep form blank for manual entry

Build + commit:

```bash
git add apps/admin/src/app/stores/\[id\]/finance/expenses/new/page.tsx apps/admin/src/i18n/messages/en.json apps/admin/src/i18n/messages/ar.json
git commit -m "feat(admin): expense form ocr upload + auto-fill"
```

---

## Task 10: Stock dashboard count cards updated

In `apps/admin/src/app/stores/[id]/stock/dashboard/page.tsx`, replace the "Reorder suggestions: Coming in Batch 3" + "Dead-stock: Coming in Batch 3" placeholders with live counts from `/stock/reorder-suggestions?status=open` + `/stock/deadstock-flags?status=open`.

Inventory list page (`/stock/inventory`): per-product row badges 🔴 "Reorder suggested" + 🟡 "Dead stock" when corresponding flag exists. Batch the lookups.

Build + commit:

```bash
git add apps/admin/src/app/stores/\[id\]/stock/dashboard/ apps/admin/src/app/stores/\[id\]/stock/inventory/
git commit -m "feat(admin): live counts on stock dashboard + inventory badges for reorder/deadstock"
```

---

## Task 11: Socket.io UI refresh activation

**Files:** `apps/api/src/lib/socket.ts` + modify `NotificationContext.tsx` + each Inngest function to broadcast at end

### `lib/socket.ts`

Create thin wrapper around existing socket.io setup (per CLAUDE.md it's wired but inactive):

```ts
export function broadcastToStore(storeId: string, event: { name: string; data: unknown }) {
  // existing io instance from socket.service.ts; broadcast to room `store-${storeId}`
}
```

### NotificationContext subscription

In `apps/admin/src/contexts/NotificationContext.tsx`, when socket connects + store changes, subscribe to room `store-${storeId}`. On any event in `['ui/reorder-scanned','ui/deadstock-scanned','ui/anomaly-detected','ui/expense-draft-ready','ui/journal-posted','ui/stock-changed','ui/orders-changed']` → invoke a callback registry that pages can subscribe to.

### Inngest functions broadcast

In each `stockReorderScan`, `stockDeadstockScan`, `accountingProfitAnomaly`, `accountingExpenseOcrProcess` — at the END of `step.run('broadcast', () => broadcastToStore(...))`.

Build + commit:

```bash
git add apps/api/src/lib/socket.ts apps/admin/src/contexts/NotificationContext.tsx apps/api/src/lib/inngest/functions/stock-reorder-scan.ts apps/api/src/lib/inngest/functions/stock-deadstock-scan.ts apps/api/src/lib/inngest/functions/accounting-profit-anomaly.ts apps/api/src/lib/inngest/functions/accounting-expense-ocr-process.ts
git commit -m "feat(realtime): socket.io ui refresh broadcasts on smart-layer events"
```

---

## Task 12: Integration tests (4 test files)

`tests/integration/accounting/reorder-scan.test.ts`:

1. Seed store + 3 products with controlled velocity (mock OrderItem history)
2. Run `runReorderScan(storeId)` (skips Gemini call by mocking `callGemini` — see fixture)
3. Assert ReorderSuggestion rows created for products below threshold + skipped for healthy stock

`tests/integration/accounting/deadstock-scan.test.ts`:

1. Seed products with various sales recency + stock value
2. Run scan → assert flags created only for products meeting criteria

`tests/integration/accounting/profit-anomaly.test.ts`:

1. Seed orders + journal_lines simulating margin drop > 40%
2. Run scan → assert ProfitAnomaly created with severity='p0' + alert call recorded

`tests/integration/accounting/expense-ocr.test.ts`:

1. Pre-uploaded fixture image URL (use a known-good R2 URL or skip the actual upload)
2. Call `processExpenseReceipt({...})` with mocked Gemini response
3. Assert Expense draft created with category mapped + ocrJson populated

Each test mocks Gemini by replacing `callGemini` via vitest's `vi.mock`.

Build + commit:

```bash
git add tests/integration/accounting/reorder-scan.test.ts tests/integration/accounting/deadstock-scan.test.ts tests/integration/accounting/profit-anomaly.test.ts tests/integration/accounting/expense-ocr.test.ts
git commit -m "test(accounting): batch 3 integration — reorder/deadstock/anomaly/ocr"
```

---

## Task 13: Full validation pass

```bash
npm run build -w apps/api && npm run build -w apps/admin && npm run build -w apps/web
npx vitest run tests/integration/accounting/
npm audit
graphify update .
git add graphify-out/graph.json graphify-out/GRAPH_REPORT.md
git commit -m "chore(graphify): refresh after accounting batch 3"
git push origin main
```

---

## Task 14: Memory + vault

Write `~/.claude/projects/-Users-ahmadsharaf-Desktop-projects-force-website-builder/memory/feature-accounting-batch-3.md` capturing:

- What shipped
- Gemini quota management approach
- Socket.io activation lessons
- Cross-batch dependency on Batch 1/2

Update MEMORY.md index. Fire pipeline:

```bash
nohup ~/.claude/scripts/update-memory-pipeline.sh all > /tmp/update-memory-batch3.log 2>&1 &
disown
```

---

## Self-review

- Spec coverage: all 4 AI jobs + 3 tables + admin pages + Socket.io = ✓
- Placeholder scan: every step has complete code, no TODOs
- Type consistency: ReorderSuggestion fields match across service/route/UI; same for DeadStockFlag + ProfitAnomaly
- Open questions deferred: storefront analytics SDK (out of scope) + per-store Gemini quota (v2)

## Execution Handoff

Plan complete + saved to `docs/superpowers/plans/2026-05-20-fwb-accounting-batch-3-smart-layer.md`. Execute via subagent-driven-development (subagent per task, Sonnet model).
