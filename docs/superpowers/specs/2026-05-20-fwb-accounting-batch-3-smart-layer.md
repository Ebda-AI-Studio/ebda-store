# FWB Accounting Batch 3 — Smart Layer Design

**Date:** 2026-05-20
**Status:** Draft (parent spec at `docs/superpowers/specs/2026-05-19-fwb-accounting-stock-design.md` Part 9 Batch 3).
**Ships in:** one batch of 4 AI Inngest jobs + admin dashboards. Self-contained — depends on Batch 1 (GL) + Batch 2 (stock + backorders + suppliers).
**Token budget per AI call:** Gemini Flash Lite, free tier (~30 RPM, ~1500 RPD per key). All bulk-AI throttled per existing FWB convention.

---

## Goals

1. **Reorder suggestions** — every morning, scan each store's active products + 7d/28d sales velocity + supplier lead time + open backorder demand → emit "reorder N units" cards. One click drafts a PO pre-filled with quantities + best supplier + cost.
2. **Dead-stock detection** — weekly scan, flag products with 0 sales in 90 days AND stock value > KWD 50. Generate bilingual clearance copy + suggested discount %. One click creates a coupon scoped to those products.
3. **Profit anomaly detection** — daily scan, compare 7d gross margin per product/category against 28d trailing baseline. >20% drop → admin badge; >40% → P0 Telegram alert. AI explains likely cause (supplier price hike via Product.costPrice move, refund spike, coupon abuse).
4. **Expense receipt OCR** — merchant uploads receipt → Gemini Vision extracts vendor/date/amount/items/category → drafts an Expense with `categoryAiConfidence` set. Merchant reviews + approves → posts.
5. **Cross-page data linking** — each AI job's output surfaces in the right admin pages: reorder suggestions on Stock/Reorder + Stock/Dashboard + low-stock list; dead-stock on Stock/Deadstock + Stock/Inventory badge; profit anomalies on Finance/Dashboard + Analytics; expense OCR drafts on Finance/Expenses + Dashboard pending-count.

## Non-goals (Batch 3)

- Cohort / funnel / RFM rollups (Batch 4).
- Auto-approve AI suggestions (merchant always confirms).
- Per-product AI reorder cadence customization (uses store-wide defaults; merchant overrides via existing ReorderRule from Batch 2).
- Receipt-OCR for non-PDF/non-image formats (jpeg/png/webp only v1).
- Multi-currency receipt parsing (KWD only v1; non-KWD receipts get a warning + manual currency entry).
- AI-generated owner replies to customer reviews (already shipped in Batch 1 via the `feedback-fwb-myfatoorah-integration` review infra — different feature).

## Strategic alignment (per FWB CLAUDE.md)

- **Customization granularity** — every suggestion is overridable: merchant rejects, edits qty, or pins a different supplier. ReorderRule + StockAdjustment from Batch 2 are the merchant's escape hatches.
- **AI-as-default** — all 4 jobs default-on per store. `Store.aiFeaturesEnabled` boolean (existing or new) gates the whole layer for merchants who opt out.
- **Arabic-first** — every AI output (reasoning, clearance copy, anomaly explanation) bilingual via Gemini's `responseSchema` returning `{en, ar}` pairs.
- **Kuwait-stack** — KWD only; cash-basis margin computation; OCR primed with Kuwait vendor patterns (Wady, Carrefour, Sultan Center, etc.).

---

## Part 1 — Data model

### 1.1 New tables (3)

```prisma
// ==========================================
// Reorder suggestions — ephemeral (purged 30d after surfacing)
// ==========================================

model ReorderSuggestion {
  id            String   @id @default(uuid())
  storeId       String   @map("store_id")
  productId     String   @map("product_id")
  variantId     String?  @map("variant_id")
  suggestedQty  Int      @map("suggested_qty")
  velocity7d    Float    @map("velocity_7d")    // units/day
  velocity28d   Float    @map("velocity_28d")
  onHand        Int      @map("on_hand")
  onOrder       Int      @map("on_order")
  openBacklog   Int      @map("open_backlog")
  urgencyDays   Int      @map("urgency_days")   // days until stockout at current velocity
  supplierId    String?  @map("supplier_id")    // ReorderRule.preferredSupplierId or last-PO supplier
  reasoningEn   String   @map("reasoning_en")   // AI-generated bilingual rationale
  reasoningAr   String?  @map("reasoning_ar")
  status        ReorderSuggestionStatus @default(open) @map("status")
  dismissedBy   String?  @map("dismissed_by")
  dismissedAt   DateTime? @map("dismissed_at")
  poId          String?  @map("po_id")          // populated when merchant accepts via one-click PO
  scannedAt     DateTime @default(now()) @map("scanned_at")

  store    Store           @relation(fields: [storeId], references: [id], onDelete: Cascade)
  product  Product         @relation(fields: [productId], references: [id], onDelete: Cascade)
  variant  ProductVariant? @relation(fields: [variantId], references: [id], onDelete: Cascade)
  supplier Supplier?       @relation(fields: [supplierId], references: [id], onDelete: SetNull)

  @@unique([storeId, productId, variantId, scannedAt])
  @@index([storeId, status, scannedAt(sort: Desc)])
  @@map("reorder_suggestions")
}

enum ReorderSuggestionStatus {
  open
  accepted
  dismissed
  expired
}

// ==========================================
// Dead-stock flags — refreshed weekly
// ==========================================

model DeadStockFlag {
  id              String   @id @default(uuid())
  storeId         String   @map("store_id")
  productId       String   @map("product_id")
  variantId       String?  @map("variant_id")
  daysSinceSale   Int      @map("days_since_sale")
  stockOnHand     Int      @map("stock_on_hand")
  stockValueFils  Int      @map("stock_value_fils") // inventory * costPrice
  suggestedDiscountBps Int @map("suggested_discount_bps") // basis points (e.g. 3000 = 30%)
  clearanceCopyEn String   @map("clearance_copy_en")
  clearanceCopyAr String?  @map("clearance_copy_ar")
  status          DeadStockFlagStatus @default(open) @map("status")
  couponCode      String?  @map("coupon_code") // when merchant accepted via one-click clearance
  dismissedBy     String?  @map("dismissed_by")
  dismissedAt     DateTime? @map("dismissed_at")
  scannedAt       DateTime @default(now()) @map("scanned_at")

  store    Store           @relation(fields: [storeId], references: [id], onDelete: Cascade)
  product  Product         @relation(fields: [productId], references: [id], onDelete: Cascade)
  variant  ProductVariant? @relation(fields: [variantId], references: [id], onDelete: Cascade)

  @@unique([storeId, productId, variantId, scannedAt])
  @@index([storeId, status])
  @@map("deadstock_flags")
}

enum DeadStockFlagStatus {
  open
  accepted_clearance
  dismissed
  expired
}

// ==========================================
// Profit anomalies — daily snapshot
// ==========================================

model ProfitAnomaly {
  id                String   @id @default(uuid())
  storeId           String   @map("store_id")
  scope             AnomalyScope                 // 'store' | 'category' | 'product'
  scopeId           String?  @map("scope_id")    // categoryId or productId (null for store-wide)
  metric            AnomalyMetric                // margin_drop | cost_spike | revenue_drop | refund_spike
  current7d         Float    @map("current_7d")
  baseline28d       Float    @map("baseline_28d")
  deltaPercent      Float    @map("delta_percent")
  severity          AnomalySeverity              // warning | p0
  explanationEn     String   @map("explanation_en")
  explanationAr     String?  @map("explanation_ar")
  acknowledged      Boolean  @default(false)
  acknowledgedBy    String?  @map("acknowledged_by")
  acknowledgedAt    DateTime? @map("acknowledged_at")
  detectedAt        DateTime @default(now()) @map("detected_at")

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@index([storeId, severity, detectedAt(sort: Desc)])
  @@index([storeId, acknowledged])
  @@map("profit_anomalies")
}

enum AnomalyScope { store; category; product }
enum AnomalyMetric { margin_drop; cost_spike; revenue_drop; refund_spike }
enum AnomalySeverity { warning; p0 }
```

### 1.2 Extensions to existing tables

```prisma
// Expense — extends Batch 2's table
ocrJson                Json?    @map("ocr_json")               // full Gemini Vision response
categoryAiConfidence   Float?   @map("category_ai_confidence")
ocrModelVersion        String?  @map("ocr_model_version")      // gemini-flash-lite-X
ocrProcessedAt         DateTime? @map("ocr_processed_at")

// Store — gate for the smart layer
aiFeaturesEnabled      Boolean  @default(true) @map("ai_features_enabled")
aiBulkThrottleMs       Int      @default(2500) @map("ai_bulk_throttle_ms")
```

### 1.3 No new sequence kinds. ReorderSuggestion/DeadStockFlag/ProfitAnomaly use uuid IDs only — no merchant-facing numbering needed (these are advisory, not transactional).

---

## Part 2 — Posting model (no GL impact)

Batch 3 jobs are advisory + computational. They DO NOT post journal entries. The PO created from a reorder suggestion goes through Batch 2's existing `purchase-order.service.ts` → `stock/po-received` event → already-tested journal posting.

Same for the clearance coupon: created via existing Coupon model, which doesn't post a journal (coupons reduce revenue at sale time inside the order journal entry — already in Batch 1 via the `discount` field on Order).

---

## Part 3 — Smart layer (4 Inngest jobs)

### 3.1 Reorder scan — `stock/reorder-scan`

**Cadence:** daily 06:00 KW (`cron: '0 3 * * *'` UTC).
**Concurrency:** limit 1 (serialize across all stores; ~10s per store).
**Retries:** 2.

**Algorithm per product (status='active', trackInventory=true):**

```
sales7d  = sum(OrderItem.quantity where paid order in last 7 days, productId=X)
sales28d = sum(OrderItem.quantity where paid order in last 28 days, productId=X)
velocity = max(sales7d/7, sales28d/28)  // conservative — pick higher
rule = ReorderRule for this product (else defaults from Product.lowStockThreshold)
  minQty          = rule?.minQty          ?? product.lowStockThreshold
  reorderQty      = rule?.reorderQty      ?? max(velocity * 14, minQty * 2)
  leadTimeDays    = rule?.leadTimeDays    ?? 7
  safetyStockDays = rule?.safetyStockDays ?? 7

onHand   = product.inventory
onOrder  = sum(PurchaseOrderItem.qty - qtyReceived where productId=X, po.status in (sent, partial))
backlog  = sum(BackorderLine.qty - qtyFulfilled where productId=X, fulfilledAt IS NULL, cancelledAt IS NULL)

demandDuringLead = velocity * (leadTimeDays + safetyStockDays)
projectedStock   = onHand + onOrder - backlog - demandDuringLead

if projectedStock < minQty:
  suggestedQty = max(reorderQty, backlog + reorderQty - onHand - onOrder)
  urgencyDays  = onHand / max(velocity, 0.01)
  supplierId   = rule?.preferredSupplierId ?? last-PO supplier for this productId
  reasoning    = Gemini-generated bilingual rationale
  upsert ReorderSuggestion(storeId, productId, variantId, scannedAt=today, ...)
```

**Gemini prompt template (single-call batch per store, max 20 products):**

```
You are an inventory ops assistant for a Kuwait retailer. For each product below,
in <=2 sentences each, explain WHY this reorder suggestion makes sense given the
velocity + on-hand + lead time + open backlog. Return STRICT JSON matching:
{
  "items": [
    { "productId": "...", "reasoningEn": "...", "reasoningAr": "..." },
    ...
  ]
}

Input (product list with metrics): {...}
```

**Cleanup:** entries older than 30 days transition to `status='expired'` (separate cron daily). Accepted entries link to PO via `poId` and stay forever (audit trail).

### 3.2 Dead-stock scan — `stock/deadstock-scan`

**Cadence:** weekly Sunday 06:00 KW (`cron: '0 3 * * 0'` UTC).
**Concurrency:** limit 1.

**Algorithm per product:** flag if (`sales in last 90d = 0`) AND (`Product.inventory * Product.costPrice >= 50000 fils`) AND (`Product.status = active`).

For flagged products, ask Gemini:

- Suggested discount % (10-50% sliding scale based on age + stock value)
- Bilingual clearance copy (≤80 chars EN + AR — used for coupon name + storefront badge)

```
You are a retail clearance copywriter for a Kuwait e-commerce store. For each
dead-stock product below, suggest a clearance discount (10-50%) and write a
short campaign copy in both English and Arabic.

Products: [{ name, nameAr, daysSinceSale, stockOnHand, stockValueFils, costPrice }]

Return STRICT JSON:
{
  "items": [
    { "productId": "...", "discountPercent": 25, "copyEn": "...", "copyAr": "..." }
  ]
}
```

**One-click clearance:** merchant clicks → service creates `Coupon` (existing model) scoped to those products + flagged status='accepted_clearance' + couponCode.

### 3.3 Profit anomaly — `accounting/profit-anomaly`

**Cadence:** daily 06:30 KW (after Batch 1's period-reconciliation at 01:30 — uses fresh GL state).
**Concurrency:** limit 1.

**Algorithm:** for each store, for each metric:

```
margin = (revenue - cogs) / revenue       // from GL: journal_lines aggregated
cost   = sum(Product.costPrice) avg       // from Product table directly
refundRate = refunds / orders             // from Order table

7d  = window over last 7 days
28d = window over last 28 days (excluding the 7d window — pure baseline)

delta = (current - baseline) / baseline
severity = abs(delta) > 0.40 ? 'p0' : abs(delta) > 0.20 ? 'warning' : null
```

For each anomaly:

- Gemini explains likely cause based on contextual data (recent costPrice changes in Product, recent refund spike in Order, recent coupon usage)
- ProfitAnomaly row created
- If severity='p0': fire Telegram alert via existing `alerts.service.ts` (Batch 1 pattern)

Gemini prompt includes:

- Affected product/category
- 7d metrics + 28d baseline
- Last 5 InventoryHistory rows (cost changes)
- Last 5 refunds (Order.applyRefundEffects calls)
- Top 5 coupon usages
  → returns `{ explanationEn, explanationAr, likelyCause: 'cost' | 'refund' | 'coupon' | 'demand' }`

### 3.4 Expense receipt OCR — `accounting/expense-ocr-process`

**Trigger:** on-demand. Endpoint: `POST /api/v1/stores/:id/expenses/upload-receipt` (multipart/form-data). Returns 202 + jobId.

**Flow:**

1. Upload image to R2 (~few KB-MB), get URL.
2. Fire Inngest event `accounting/expense-ocr-process` with `{ storeId, receiptUrl, uploadedBy }`.
3. Function downloads image, calls Gemini Vision (model: `gemini-flash-lite-latest`, vision-enabled):

```
You are a receipt parser for a Kuwait retailer. Extract:
- vendor (English + Arabic if visible)
- invoice date (ISO 8601)
- currency (3-letter code; default KWD if unclear)
- subtotal, taxAmount, total (numbers in the displayed currency)
- line items: [{ description, quantity, unitPrice, lineTotal }]
- suggested expense category from:
  [packaging, marketing, salaries, rent, utilities, software, courier,
   bank_fees, office_supplies, professional_services, other]
- confidence: 0..1 for category suggestion

Return STRICT JSON matching schema. If unclear, set fields to null.
```

4. Resolve `expenseAccountId` from suggested category → map to system COA code (5100/5200/5300 etc.) via `getSystemAccountIdByCode`.
5. Create `Expense` with `status='draft'`, `receiptImageUrl`, `ocrJson` populated, `categoryAiConfidence` set.
6. Notify merchant via existing `NotificationLog`: "1 new expense draft ready for review".

**Currency handling:** if extracted currency ≠ KWD, mark expense status='draft' + add `notes: "Auto-detected currency ${X}; please verify in KWD"`. Merchant edits manually.

**Failure handling:** if Gemini Vision fails or returns malformed JSON, create the Expense as draft with `receiptImageUrl` set + `notes: "OCR failed — please enter manually"` so the upload isn't lost.

---

## Part 4 — Admin UI surface (extends Batch 2 pages)

### 4.1 `/stock/reorder` — replaces Batch 2 placeholder

Lists open `ReorderSuggestion`s sorted by `urgencyDays ASC`. Per-card:

- Product name + SKU + image thumb
- "Reorder N units" big text
- Bilingual reasoning paragraph
- Urgency badge (red <3 days, amber <7, gray >7)
- Suggested supplier (with link to supplier page)
- Cost preview (qty × last costPrice)
- Two buttons: **"Draft PO"** (one-click — opens pre-filled new-PO form) + **"Dismiss"**

Top-bar: scan progress indicator ("Last scanned 4 hours ago"), manual "Re-scan now" button (admin-only, fires Inngest event directly).

### 4.2 `/stock/deadstock` — replaces Batch 2 placeholder

Lists open `DeadStockFlag`s sorted by `stockValueFils DESC`. Per-card:

- Product + image + stock value KWD
- "Last sold X days ago" badge
- AI clearance copy (bilingual preview)
- Suggested discount %
- Two buttons: **"Run Clearance"** (creates Coupon scoped to product, navigates to new coupon) + **"Dismiss"**

### 4.3 Finance Dashboard extension (`/finance/dashboard`)

Add new section: **"Recent anomalies"**

- Top 3 unacknowledged `ProfitAnomaly` rows
- Each shows: scope (store/category/product), metric, current vs baseline, AI explanation
- "Acknowledge" button + "View details" link to a new `/finance/anomalies` page (list view)

Add new section: **"Pending expense drafts"**

- Count of Expenses with `status='draft' AND ocrJson IS NOT NULL` (OCR-generated drafts)
- Link to `/finance/expenses?status=draft&hasOcr=true`

### 4.4 `/finance/anomalies` — new page

Full list of ProfitAnomaly rows with filtering (all/p0/warning, all/acknowledged/open, scope filter). Per-row drill-in shows the AI explanation + the metric chart (7d vs 28d) + links to affected products/orders.

### 4.5 Expense form OCR upload

`/finance/expenses/new` gets a file-upload section above the form. After upload:

- Spinner: "Reading receipt with AI..."
- On completion: form auto-fills with extracted vendor/date/amount/category. Merchant edits as needed.
- `categoryAiConfidence` displayed as a badge ("AI is 87% confident this is Marketing")

### 4.6 Stock Dashboard extension (`/stock/dashboard`)

Add Reorder Suggestions count card (replaces Batch 2's "Coming in Batch 3" placeholder). Link to `/stock/reorder`.
Add Dead Stock count card. Link to `/stock/deadstock`.

### 4.7 Inventory list badge (`/stock/inventory`)

Per-product row badges:

- 🔴 "Reorder suggested" if open ReorderSuggestion exists
- 🟡 "Dead stock" if open DeadStockFlag exists

---

## Part 5 — Cross-page data linking

The smart layer's outputs propagate via two mechanisms:

### 5.1 Direct DB reads (eventually-consistent)

When admin loads a page, it queries the relevant table. Reorder suggestions on `/stock/reorder` come from `ReorderSuggestion` (filtered `status='open'`). Profit anomalies on `/finance/dashboard` come from `ProfitAnomaly` (filtered `acknowledged=false`).

### 5.2 Real-time via existing Socket.io (extends Batch 1's NotificationContext)

When an Inngest function completes, fire a Socket.io event to the admin's WebSocket connection (keyed by storeId). NotificationContext (per `apps/admin/src/contexts/NotificationContext.tsx`, mentioned in CLAUDE.md "Known Issues") subscribes and triggers a SWR-style refetch on the relevant dashboards.

**Concrete events:**

- `stock/reorder-scanned` → fires after `stock/reorder-scan` completes → all open admin tabs for that store refresh their "Reorder count" badges
- `stock/deadstock-scanned` → same shape
- `accounting/anomaly-detected` → toast notification + dashboard badge bump
- `accounting/expense-draft-ready` → "1 receipt processed" toast + Expenses page refetch

### 5.3 Cross-batch reusability

Same pattern Batch 2 used for `stock/po-received` → `accounting-post-po-receive-journal`. Each Inngest function fires a follow-on "UI refresh" event after the main work is done. Frontend pages subscribe based on which storeId tab is open.

---

## Part 6 — Integration hooks

- **Frontend session:** none. All Batch 3 work is admin-only.
- **WBS session:** new event `stock/dead-stock-flagged` → WBS dispatches WhatsApp broadcast to subscribed customers about clearance items (opt-in via existing notification preferences). Same `inngest.send` pattern as Batch 2.
- **Existing FWB systems:**
  - Reorder accepts → creates PO via `purchase-order.service.ts:createPurchaseOrder` → existing Batch 2 flow
  - Dead-stock clearance accepts → creates Coupon via existing `coupon.service.ts`
  - Anomaly P0 → existing `alerts.service.ts:sendAlert` → existing Telegram integration
  - Expense OCR draft → existing `expense.service.ts:createExpense` → existing Batch 2 flow

**No new external dependencies.** Gemini Flash Lite already wired (`GOOGLE_GENERATIVE_AI_KEY` env var). R2 already wired for image uploads. Telegram alerts already wired.

---

## Part 7 — Kuwait/MOF specifics

- All money in fils (Int) — same as Batches 1+2.
- Bilingual AI outputs everywhere — Gemini prompts return `{en, ar}` pairs in structured JSON.
- OCR vendor recognition primed with Kuwait patterns (Wady Aljuz, Carrefour, Sultan Center, X-cite, etc.) via prompt examples.
- MOF retention: ReorderSuggestion / DeadStockFlag / ProfitAnomaly are advisory — `deletedAt` allowed (these are NOT financial records). Expired entries auto-deleted after 30 days to keep the tables lean.

---

## Part 8 — Phasing (single batch, 4 commit groups)

### Group A — Schema + sequence

1. Prisma schema additions (3 new tables, 2 enum additions, Expense + Store extensions)
2. Hand-written migration (CHECKs + RLS, NO Prisma diff)
3. Re-export new enums from `@ebda/database`

### Group B — Reorder + Dead-stock jobs

4. `reorder-scan.service.ts` + Inngest function + `/stock/reorder` admin page
5. `deadstock-scan.service.ts` + Inngest function + `/stock/deadstock` admin page
6. "Draft PO from suggestion" + "Run Clearance from flag" service methods
7. Stock Dashboard badge updates

### Group C — Profit anomaly + alerts

8. `profit-anomaly.service.ts` + Inngest function
9. `/finance/anomalies` admin page + Finance Dashboard "Recent anomalies" section
10. Telegram P0 wiring + acknowledge endpoint

### Group D — Expense OCR + real-time

11. Receipt upload endpoint (R2 multipart) + Inngest function + Gemini Vision client
12. Expense form OCR section with auto-fill
13. Socket.io UI refresh events + NotificationContext subscriptions
14. Integration tests (reorder scan + dead-stock scan + anomaly threshold + OCR end-to-end with fixture image)
15. Validation pass + memory update

Each commit group ships independently after the schema + scan jobs are in. UI refresh + Socket.io is the last layer (Group D) so the system works without real-time even if Socket.io has issues.

---

## Part 9 — Acceptance criteria

A merchant on FWB at end of Batch 3 should be able to:

1. **Open `/stock/reorder` in the morning** → see 5-15 reorder suggestions ordered by urgency, each with AI bilingual reasoning.
2. **Click "Draft PO"** → land on `/stock/purchase-orders/new` pre-filled with the product + qty + best supplier + last unit cost.
3. **Open `/stock/deadstock`** → see slow-moving SKUs with AI-suggested discount % + bilingual clearance copy.
4. **Click "Run Clearance"** → land on a new coupon page pre-configured for those products + suggested discount applied.
5. **Receive a Telegram alert** when gross margin drops >40% in a week ("Wady Aljuz: gross margin -42% vs 28d baseline. Likely cause: cost spike on SKU XYZ from 2.000 KWD to 2.800 KWD on 2026-06-XX").
6. **Acknowledge the anomaly** in `/finance/anomalies` → it disappears from Dashboard "Recent anomalies" section.
7. **Upload a receipt photo** at `/finance/expenses/new` → form auto-fills within 5-10s → review + approve → journal posts.
8. **All AI outputs bilingual** EN+AR.
9. **Reorder/Dead-stock counts on Stock Dashboard match Reorder/Deadstock pages** (data linked).
10. **AI quota guards prevent runaway** — verified via `AI_DAILY_REQUEST_CAP` honored; bulk scans throttle at 2.5s/call.

---

## Part 10 — Open questions

1. **Multi-image receipts** (front + back of receipt) — v1 ships one image only. Stitching multiple images into one OCR call could be v2.
2. **OCR confidence threshold for auto-approval** — currently always drafts (merchant approves). If confidence >0.95, auto-approve? Discuss with merchant before shipping (risk: small fraud window).
3. **Reorder suggestion learning from rejections** — currently no feedback loop. If merchant dismisses the same product 3 weeks in a row, should the algorithm down-weight it? v2 work.
4. **Multi-tenant Gemini quota fairness** — currently all stores share `AI_DAILY_REQUEST_CAP`. Heavy store could starve others. v2: per-store quota.
5. **Anomaly explanations using LLM may hallucinate** — must include "AI-generated; verify cause before acting" disclaimer per FWB anti-pattern feedback. Always show raw 7d/28d numbers alongside.

---

## Part 11 — Risks + mitigations

| Risk                                   | Mitigation                                                                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Gemini quota exhausted by reorder scan | Daily + monthly cap from `lib/ai-quota.ts`; reorder scan throttles 2.5s between calls; skip products not changed since last scan                                         |
| Reorder suggests wrong supplier        | Uses ReorderRule.preferredSupplierId if set; falls back to last-PO supplier; merchant overrides via dropdown                                                             |
| OCR mistakes mislead merchant          | `categoryAiConfidence` always shown; manual edit allowed before approve; receipt image always attached for verification                                                  |
| Anomaly false positives spam P0 alerts | Severity threshold conservative (>40%); per-store rate-limit (max 3 P0 alerts/day); acknowledge dismisses the badge but doesn't suppress future scans of the same metric |
| Real-time refresh storms admin         | Socket.io events debounced; SWR cache invalidation rather than full refetch; only the active tab refreshes                                                               |
| Cross-tenant data leak via Gemini      | Each call scoped to one store; no cross-store data in prompts; Gemini Flash Lite is stateless (no cross-call leakage)                                                    |

---

## Part 12 — Sign-off

Awaiting Ahmad's review. Open items: AI quota fairness (Q4) and OCR auto-approve threshold (Q2) before final lock.

Open follow-up: implementation plan via `superpowers:writing-plans`.
