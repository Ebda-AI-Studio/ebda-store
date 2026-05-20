# FWB Accounting Batch 4 — Insights / BI Tier Design

**Date:** 2026-05-20
**Status:** Draft (parent spec at `docs/superpowers/specs/2026-05-19-fwb-accounting-stock-design.md` Part 9 Batch 4).
**Ships in:** one batch — 3 snapshot tables + 1 nightly rollup Inngest function + 5 admin pages under new "Insights" sidebar group. Self-contained — depends on Batch 1 (GL) + Batch 2 (Order/AbandonedCart timestamps) for source data.

---

## Goals

1. **Cohort retention matrix** — month-by-month retention of customer cohorts (grouped by first-order month). Surfaces churn patterns + LTV curve.
2. **Checkout funnel** — daily aggregate funnel rates from existing timestamps (product views → cart → checkout-started → order-completed). Drop-off rate per step. NO new event-tracking SDK required for v1 (per-session attribution deferred — would need storefront wiring from frontend session).
3. **RFM customer segmentation** — Recency / Frequency / Monetary scoring per customer; assigns segment (VIP / Loyal / Potential / New / At-risk / Hibernating / Lost) with recommended actions per segment.
4. **SKU velocity ranking** — top sellers + ASP trend + dead-stock cross-link. Drill into product → see velocity over time + FBT affinity pairs (from existing `FrequentlyBoughtTogether` table).
5. **AI-narrated insights** — Gemini summarizes notable cohort/funnel/segment shifts so merchants understand WHAT and WHY without parsing tables.

## Non-goals (Batch 4)

- Per-session checkout-funnel attribution (requires `analytics.track('product_view')` SDK on storefront — frontend session would need to wire it; deferred to v5 or later).
- Marketing-source attribution (UTM-aware funnel) — deferred.
- Multi-touch attribution.
- Looker / Metabase / Power BI replacement — Insights tier is merchant-facing, not analyst-facing.
- Real-time dashboards (data refreshes nightly; intra-day staleness is acceptable for cohort/RFM analysis).
- Predictive churn modeling (could be added in v6 but needs more data than most merchants have).

## Strategic alignment (per FWB CLAUDE.md)

- **Customization granularity** — none per-merchant (segments + cohort math are universally defined). Merchants pick how often the rollup runs (daily default; weekly opt-in for small stores).
- **AI-as-default** — Gemini-narrated insights default ON; can be toggled off via `Store.aiNarrationEnabled` (new boolean).
- **Arabic-first** — every AI narration bilingual; segment names bilingual via i18n.
- **Kuwait-stack** — KWD only; KW timezone for rollup window boundaries.

---

## Part 1 — Data model

### 1.1 New tables (3 snapshot tables — materialized nightly)

```prisma
// ==========================================
// Cohort retention — customer cohorts × month offsets
// ==========================================

model CustomerCohortSnapshot {
  id               String   @id @default(uuid())
  storeId          String   @map("store_id")
  cohortMonth      String   @map("cohort_month")    // 'YYYY-MM' of customer's first paid order
  periodOffset     Int      @map("period_offset")   // 0 = cohort month itself, 1 = +1 month, ...
  customersTotal   Int      @map("customers_total") // cohort size
  customersActive  Int      @map("customers_active")// active (≥1 paid order) in this offset
  ordersInPeriod   Int      @map("orders_in_period")
  revenueInPeriod  Int      @map("revenue_in_period") // fils
  computedAt       DateTime @default(now()) @map("computed_at")

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@unique([storeId, cohortMonth, periodOffset])
  @@index([storeId, cohortMonth])
  @@map("customer_cohort_snapshots")
}

// ==========================================
// Checkout funnel — daily aggregate
// ==========================================

model FunnelSnapshot {
  id                 String   @id @default(uuid())
  storeId            String   @map("store_id")
  periodDate         DateTime @map("period_date") // day boundary, KW timezone
  productViews       Int      @map("product_views")        // delta of Product.viewCount sum
  cartsCreated       Int      @map("carts_created")        // distinct Cart rows created that day
  cartItemsAdded     Int      @map("cart_items_added")
  checkoutsStarted   Int      @map("checkouts_started")    // distinct AbandonedCart created (existing signal)
  ordersCompleted    Int      @map("orders_completed")     // paymentStatus=paid
  ordersAbandoned    Int      @map("orders_abandoned")     // AbandonedCart never converted (cutoff: 7 days)
  revenueFils        Int      @map("revenue_fils")
  computedAt         DateTime @default(now()) @map("computed_at")

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@unique([storeId, periodDate])
  @@index([storeId, periodDate(sort: Desc)])
  @@map("funnel_snapshots")
}

// ==========================================
// RFM customer segmentation — current snapshot per customer
// ==========================================

model CustomerRfmSnapshot {
  id              String     @id @default(uuid())
  storeId         String     @map("store_id")
  customerId      String     @map("customer_id")  // User.id (registered) OR hashed guest key (sha256 of email+phone)
  isGuest         Boolean    @default(false) @map("is_guest")
  recencyDays     Int        @map("recency_days")
  frequencyOrders Int        @map("frequency_orders")
  monetaryFils    Int        @map("monetary_fils")
  rfmScore        Int        @map("rfm_score")        // R*100 + F*10 + M (e.g. 555 = top VIP)
  segment         RfmSegment
  previousSegment RfmSegment? @map("previous_segment") // for "moved from X to Y" detection
  computedAt      DateTime   @default(now()) @map("computed_at")

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@unique([storeId, customerId])
  @@index([storeId, segment])
  @@index([storeId, rfmScore(sort: Desc)])
  @@map("customer_rfm_snapshots")
}

enum RfmSegment {
  vip          // recent + frequent + big spender
  loyal        // frequent + decent spender, may not be recent
  potential    // recent + decent spender, low frequency
  new          // first order recent, no repeat yet
  at_risk      // were frequent, gone quiet
  hibernating  // low everything
  lost         // > 365d since last order
}
```

### 1.2 Extensions

```prisma
// Store
aiNarrationEnabled Boolean @default(true) @map("ai_narration_enabled")
insightsRollupCron String  @default("daily") @map("insights_rollup_cron") // 'daily' | 'weekly'
```

---

## Part 2 — Rollup job model

### 2.1 Nightly rollup — `analytics/daily-rollup`

**Cadence:** daily 02:00 KW (`cron: '0 23 * * *'` UTC, after Batch 1 daily-close at 01:00 + period-reconcile at 01:30).
**Concurrency:** limit 1 (cross-tenant; ~20-60s per store).
**Retries:** 2.

For each store with `accountingEnabled=true`:

**Step 1 — Cohort snapshot**

```
For each cohortMonth from store launch to current month:
  cohort = distinct customers with first paid order in cohortMonth
  For each periodOffset (0 to currentMonth - cohortMonth):
    activeCustomers = count of cohort members with ≥1 paid order in (cohortMonth + offset months)
    orders          = count of paid orders by cohort in that period
    revenue         = sum of paid order totals by cohort in that period
    UPSERT CustomerCohortSnapshot
```

**Step 2 — Funnel snapshot** (for yesterday, KW timezone)

```
For each day from last computed date to yesterday:
  productViews     = sum(Product.viewCount delta in day)  // requires tracking deltas via daily snapshot
  cartsCreated     = COUNT(Cart where createdAt in day)
  cartItemsAdded   = COUNT(CartItem where createdAt in day)
  checkoutsStarted = COUNT(AbandonedCart where createdAt in day) // existing signal
  ordersCompleted  = COUNT(Order where paymentStatus=paid AND createdAt in day)
  ordersAbandoned  = COUNT(AbandonedCart where convertedAt IS NULL AND createdAt < day - 7d)
  revenue          = SUM(Order.total for completed)
  UPSERT FunnelSnapshot
```

**Note on Product.viewCount delta:** existing `Product.viewCount` is a cumulative counter incremented per request. For daily deltas, the rollup keeps a `Store.lastViewCountSnapshotAt` field — diffs current vs snapshot. First run = total views (lifetime). Subsequent runs = daily delta. Acceptable approximation; perfect accuracy needs the analytics SDK (deferred).

**Step 3 — RFM segmentation**

```
For each customer who has placed ≥1 paid order ever for this store:
  recencyDays     = days since last paid order
  frequencyOrders = count of paid orders lifetime
  monetaryFils    = sum of paid order totals lifetime

  Bucket each metric into quintiles (1..5) relative to the store's customer base:
    R: 5 = most-recent quintile, 1 = oldest
    F: 5 = most-frequent, 1 = least
    M: 5 = top spender, 1 = lowest

  rfmScore = R*100 + F*10 + M

  segment = (per table below)

  loadPreviousSegment from CustomerRfmSnapshot if exists
  UPSERT CustomerRfmSnapshot with previousSegment = old segment (for "moved" detection)
```

**Segment assignment table:**
| Segment | Rule |
|---|---|
| `vip` | R ≥ 4 AND F ≥ 4 AND M ≥ 4 |
| `loyal` | F ≥ 4 AND M ≥ 3 AND not VIP |
| `potential` | R ≥ 4 AND F ≤ 2 |
| `new` | R ≥ 4 AND F = 1 |
| `at_risk` | F ≥ 3 AND R ≤ 2 |
| `hibernating` | R ≤ 2 AND F ≤ 2 AND M ≤ 2 |
| `lost` | recencyDays > 365 |
| (else) | `potential` (catch-all for new-ish customers without enough data) |

**Step 4 — AI narration** (optional per `Store.aiNarrationEnabled`):

Top 3 cohort shifts ranked by month-3 retention delta vs prior cohort → Gemini summarizes ("July cohort retained 65% at month-3 vs June's 40% — driven by July's free-shipping launch").

Funnel drop-off change >X% vs trailing 7-day avg → Gemini explains likely cause referencing recent events (price change, coupon launch, supply issue).

Segment shifts where N customers moved from VIP → At-risk → flag with explanation.

All AI outputs cached in a new lightweight `InsightNarration` table (1 row per (store, scope, scannedDate)) to avoid re-asking Gemini.

### 2.2 No journal posting

Batch 4 is computational only. NO GL impact. All work is in snapshot tables + UI.

---

## Part 3 — Admin UI (new "Insights" sidebar group)

Adds a new hub to the 8-hub sidebar from the 2026-05-20 restructure. Becomes the 9th hub (slotted between Analytics and Marketing) OR replaces Analytics (more comprehensive). **Recommend:** keep Analytics for the existing operational metrics + add Insights as the 9th hub for cohort/funnel/RFM specifically. Order:

```
Dashboard → Catalog → Sales → Stock → Finance → Analytics → Insights → Marketing → Settings
```

### 3.1 `/insights/dashboard` — landing

KPI tiles:

- AOV trend (this month vs last)
- Rolling 30-day revenue
- Repeat purchase rate (this month)
- Top RFM segment by count + revenue contribution
- Top 5 SKUs by velocity (last 7 days)
- Funnel summary (yesterday's checkout conversion %)

### 3.2 `/insights/cohorts`

Month-by-month retention matrix (rows = cohort month, cols = period offset 0..N). Cell shading: green = high retention, red = low. Click cell → drill into that cohort's customers + orders.

LTV curve chart below the matrix.

AI commentary section: top 3 cohort observations from the latest rollup.

### 3.3 `/insights/funnel`

Funnel bar chart: views → carts → checkouts → completed. Drop-off percentages annotated.

Window picker: 7d / 30d / 90d.

AI commentary on drop-off anomalies.

### 3.4 `/insights/segments`

RFM segment cards (one per segment): customer count, total revenue contribution, average order value, recommended action.

Recommended action examples:

- VIP → "Send personalized thank-you + exclusive early-access offer"
- At-risk → "Win-back email with 15% off + free shipping"
- Hibernating → "Re-engagement campaign with what's-new since their last order"

Click segment → list of customers in that segment with recency/frequency/monetary stats.

### 3.5 `/insights/products`

SKU velocity ranking (top + bottom). Filter by category. ASP trend per product. FBT affinity pairs (existing `FrequentlyBoughtTogether` table) listed. Dead-stock cross-link (from Batch 3 `DeadStockFlag`).

---

## Part 4 — Cross-page data linking

Insights snapshots are the SOURCE OF TRUTH for cross-cutting metrics. Other admin pages link/embed:

- **Dashboard hub** — shows top RFM segment + repeat purchase rate from latest snapshot
- **Finance Dashboard** — adds "Top customers by revenue contribution" (from RFM monetary score)
- **Customers page** (Sales hub) — adds RFM segment badge per customer row
- **Analytics page** — links to Insights for deeper drill-in on each KPI
- **WBS / Marketing** — uses RFM segments as audience filters for WhatsApp campaigns

All reads from snapshot tables (eventually consistent — refreshed nightly). Real-time admin needs the Socket.io refresh events from Batch 3's Group D.

---

## Part 5 — Integration hooks

- **Frontend session:** none. Insights are admin-only.
- **WBS session:** new event `insights/segment-changed` → WBS can subscribe to fire campaigns when customers move between segments (e.g. send win-back when "loyal → at_risk"). Optional integration.
- **Existing FWB systems:** no schema changes outside the 3 new tables. All reads from existing Order/Cart/AbandonedCart/Product/User tables.

---

## Part 6 — Phasing (single batch)

### Group A — Schema + snapshot tables

1. Prisma schema (3 new tables + 1 enum + 2 Store extensions)
2. Hand-written migration (CHECKs + RLS, no Prisma diff)

### Group B — Rollup job

3. `analytics-rollup.service.ts` — implements all 3 sub-rollups (cohort/funnel/RFM) as separate methods with shared transaction
4. Inngest function `analytics-daily-rollup` (cron 02:00 KW)
5. `InsightNarration` table + AI narration step (gated by `Store.aiNarrationEnabled`)

### Group C — Admin Insights hub

6. New sidebar group + 5 admin pages (dashboard / cohorts / funnel / segments / products)
7. HubTabs entries (extend `hubs.ts` with `insights` hub)
8. Cohort heatmap component, funnel chart, RFM segment cards (reusable in `_components/`)

### Group D — Cross-page integration

9. Embed RFM badge in Customers list (Sales hub)
10. Add "Top segments" + "Repeat purchase rate" to Dashboard hub
11. Link Analytics → Insights for deeper drill-in
12. Integration tests (cohort math + funnel math + RFM bucket boundaries)
13. Validation pass + memory update

---

## Part 7 — Acceptance criteria

A merchant on FWB at end of Batch 4 should be able to:

1. **Open `/insights/cohorts`** → see the retention matrix populated for every month since store launch.
2. **Click an old cohort cell** → drill into the list of customers + their orders in that period.
3. **Open `/insights/funnel`** → see yesterday's product views, carts created, checkouts started, orders completed, plus the 7-day trailing average for each step.
4. **Open `/insights/segments`** → see RFM segment cards with counts + revenue contribution + recommended actions per segment.
5. **Click "VIP" segment** → see the list of VIP customers + their last order + lifetime value.
6. **See an AI narration** at top of each Insights page summarizing notable trends ("Your VIP segment grew 18% this month — driven by repeat purchases from the July cohort").
7. **All AI narrations bilingual** EN+AR.
8. **Customers list (Sales hub)** shows per-customer RFM segment badge.
9. **Dashboard hub** shows the top-segment KPI tile.
10. **Insights snapshot tables stay coherent** across rollup runs (re-running doesn't double-count; upserts work correctly).

---

## Part 8 — Open questions

1. **Storefront analytics SDK** — Per-session funnel attribution requires storefront wiring (`analytics.track('product_view')` etc.). v1 ships aggregate-only. When should we coordinate with the frontend session to wire this?
2. **AI narration cost** — At ~100 stores × 4-5 narrations/day × 2 languages = 800-1000 Gemini calls/day for narration alone. Within the free tier today. As FWB scales, may need to throttle or move narration to weekly.
3. **RFM quintile boundaries per-store vs cross-store** — Currently per-store. Small stores with <20 customers may have unstable quintiles. Consider falling back to absolute thresholds (e.g. recencyDays<7 = R5) for stores below a customer-count threshold.
4. **Cohort granularity (monthly vs weekly)** — Monthly is standard. Weekly cohorts are richer but harder to read. v1 monthly only.
5. **Lost customer definition** — Currently 365 days. Configurable per store later if merchants ask.

---

## Part 9 — Risks + mitigations

| Risk                                                                      | Mitigation                                                                                                             |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Rollup job timeout on stores with 100k+ customers                         | Stream the customer loop in batches of 1000 with `step.run('rfm-batch-N', ...)` so Inngest checkpoints between batches |
| Gemini narration hallucinates trends                                      | Always render the raw numbers alongside the AI summary; merchant can verify                                            |
| RFM segments jump erratically week-to-week for new stores                 | Hide segment shifts when store has <50 customers (not enough signal); show absolute counts only                        |
| Snapshot tables grow unbounded                                            | Keep only latest 24 months of cohort snapshots; archive older to S3 if merchant requests historical depth              |
| Product.viewCount delta inaccurate (uses cumulative counter, not per-day) | Document as known approximation in admin; offer the real-event-tracking SDK as v5 upgrade path                         |
| Insights pages slow on first load                                         | All reads from materialized snapshots — fast; first load ≤200ms expected                                               |

---

## Part 10 — Sign-off

Awaiting Ahmad's review. Open items: storefront analytics SDK (Q1) — coordinate with frontend session before kicking off Batch 4 execution.

Open follow-up: implementation plan via `superpowers:writing-plans`.
