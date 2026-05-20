# FWB Accounting Batch 4 — Insights / BI Tier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Ship cohort retention + checkout funnel + RFM segmentation as nightly rollups → new "Insights" hub (9th sidebar entry) with 5 admin pages + AI-narrated commentary.

**Architecture:** 3 snapshot tables materialized by ONE nightly Inngest rollup (cron 02:00 KW). Reads from existing Order / AbandonedCart / Product / User / journal_lines. NO new operational events. NO journal posting. AI narration via existing `gemini-ai.service.ts` (B3-T2). Insights hub injected into HubTabs (sidebar restructure from 2026-05-20).

**Tech Stack:** Same as B3 (Prisma + Postgres, Express + Next.js 16 admin, Inngest, Gemini Flash Lite).

**Spec reference:** `docs/superpowers/specs/2026-05-20-fwb-accounting-batch-4-insights.md`.

**Out of scope:** per-session funnel attribution (needs storefront SDK — frontend session), marketing-source UTM attribution, predictive churn, real-time dashboards (nightly is fine).

---

## File structure

**Created (9 files):**

- `packages/database/prisma/migrations/<TS>_accounting_batch_4/migration.sql`
- `apps/api/src/services/accounting/analytics-rollup.service.ts`
- `apps/api/src/services/accounting/insights-narration.service.ts`
- `apps/api/src/lib/inngest/functions/analytics-daily-rollup.ts`
- `apps/api/src/routes/insights.routes.ts`
- `apps/admin/src/app/stores/[id]/insights/page.tsx` (hub landing — auto-redirect to dashboard)
- `apps/admin/src/app/stores/[id]/insights/dashboard/page.tsx`
- `apps/admin/src/app/stores/[id]/insights/cohorts/page.tsx`
- `apps/admin/src/app/stores/[id]/insights/funnel/page.tsx`
- `apps/admin/src/app/stores/[id]/insights/segments/page.tsx`
- `apps/admin/src/app/stores/[id]/insights/products/page.tsx`
- `tests/integration/accounting/analytics-rollup.test.ts`

**Modified:**

- `packages/database/prisma/schema.prisma` (3 new tables + 1 enum + Store extensions)
- `packages/database/src/index.ts` (re-export RfmSegment)
- `apps/api/src/lib/inngest/functions/index.ts` (register rollup)
- `apps/api/src/routes/index.ts` (mount insights routes)
- `apps/admin/src/components/admin-layout/buildStoreAdminNav.ts` (insert Insights hub between Analytics + Marketing)
- `apps/admin/src/components/admin-layout/hubs.ts` (Insights hub + 5 tabs)
- `apps/admin/src/components/admin-layout/AdminLayout.tsx` (add `insights` to NavLabels)
- `apps/admin/src/app/stores/[id]/customers/page.tsx` (embed RFM segment badge per row)
- `apps/admin/src/app/stores/[id]/page.tsx` (DashboardAccountingSummary already exists — add RFM top-segment tile)
- `apps/admin/src/i18n/messages/{en,ar}.json` (insights.\* block + RFM segment labels)

---

## Pre-flight

- [ ] **P1:** `git config user.email = ahmed0montaser@gmail.com`
- [ ] **P2:** `bash scripts/backup-db.sh`

---

## Task 1: Schema + migration

### Step 1 — Schema additions to `packages/database/prisma/schema.prisma`

```prisma
enum RfmSegment {
  vip
  loyal
  potential
  new_customer        // 'new' is reserved keyword in some contexts; use new_customer
  at_risk
  hibernating
  lost
}

model CustomerCohortSnapshot {
  id               String   @id @default(uuid())
  storeId          String   @map("store_id")
  cohortMonth      String   @map("cohort_month")    // 'YYYY-MM'
  periodOffset     Int      @map("period_offset")
  customersTotal   Int      @map("customers_total")
  customersActive  Int      @map("customers_active")
  ordersInPeriod   Int      @map("orders_in_period")
  revenueInPeriod  Int      @map("revenue_in_period")
  computedAt       DateTime @default(now()) @map("computed_at")

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@unique([storeId, cohortMonth, periodOffset])
  @@index([storeId, cohortMonth])
  @@map("customer_cohort_snapshots")
}

model FunnelSnapshot {
  id                 String   @id @default(uuid())
  storeId            String   @map("store_id")
  periodDate         DateTime @map("period_date")
  productViews       Int      @map("product_views")
  cartsCreated       Int      @map("carts_created")
  cartItemsAdded     Int      @map("cart_items_added")
  checkoutsStarted   Int      @map("checkouts_started")
  ordersCompleted    Int      @map("orders_completed")
  ordersAbandoned    Int      @map("orders_abandoned")
  revenueFils        Int      @map("revenue_fils")
  computedAt         DateTime @default(now()) @map("computed_at")

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@unique([storeId, periodDate])
  @@index([storeId, periodDate(sort: Desc)])
  @@map("funnel_snapshots")
}

model CustomerRfmSnapshot {
  id              String     @id @default(uuid())
  storeId         String     @map("store_id")
  customerId      String     @map("customer_id")
  isGuest         Boolean    @default(false) @map("is_guest")
  recencyDays     Int        @map("recency_days")
  frequencyOrders Int        @map("frequency_orders")
  monetaryFils    Int        @map("monetary_fils")
  rfmScore        Int        @map("rfm_score")
  segment         RfmSegment
  previousSegment RfmSegment? @map("previous_segment")
  computedAt      DateTime   @default(now()) @map("computed_at")

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@unique([storeId, customerId])
  @@index([storeId, segment])
  @@index([storeId, rfmScore(sort: Desc)])
  @@map("customer_rfm_snapshots")
}
```

### Step 2 — Store extensions

```prisma
aiNarrationEnabled Boolean @default(true) @map("ai_narration_enabled")
insightsRollupCron String  @default("daily") @map("insights_rollup_cron")
```

Plus reverse relations on Store:

```prisma
customerCohortSnapshots CustomerCohortSnapshot[]
funnelSnapshots         FunnelSnapshot[]
customerRfmSnapshots    CustomerRfmSnapshot[]
```

### Step 3 — Hand-written migration

`packages/database/prisma/migrations/20260520020000_accounting_batch_4/migration.sql` — 1 enum + 3 tables + 3 column ALTERs + RLS policies (same pattern as B3-T1). Apply via `prisma migrate deploy` from `packages/database/`.

### Step 4 — Re-export `RfmSegment` in `packages/database/src/index.ts`

### Step 5 — Commit

```bash
git add packages/database/prisma/schema.prisma packages/database/prisma/migrations/20260520020000_accounting_batch_4/ packages/database/src/index.ts
git commit -m "feat(db): batch 4 schema — cohort + funnel + rfm snapshot tables"
```

---

## Task 2: Analytics rollup service

`apps/api/src/services/accounting/analytics-rollup.service.ts` — exports:

- `runDailyRollup(storeId): Promise<{ cohortRows, funnelDays, rfmCustomers }>`
- `runCohortRollup(storeId, tx?): Promise<number>` (returns rows upserted)
- `runFunnelRollup(storeId, tx?): Promise<number>` (days computed)
- `runRfmRollup(storeId, tx?): Promise<number>` (customers segmented)

**Cohort:**

```ts
// For each cohortMonth from store launch to current:
//   cohortCustomers = SELECT DISTINCT customerId FROM orders WHERE storeId AND paymentStatus='paid'
//                      GROUP BY customerId HAVING MIN(createdAt) IN cohortMonth
//   For each periodOffset (0..currentMonth-cohortMonth):
//     active = COUNT DISTINCT customerId in cohort WHERE paid order in (cohortMonth + offset months)
//     orders = COUNT, revenue = SUM
//     UPSERT
```

**Funnel** — daily aggregate from yesterday backwards to last computed:

```ts
// For each day not yet in FunnelSnapshot, OR last 3 days (in case of recomputes):
//   cartsCreated = COUNT(Cart WHERE createdAt in day)
//   checkoutsStarted = COUNT(AbandonedCart WHERE createdAt in day)
//   ordersCompleted = COUNT(Order WHERE paymentStatus='paid' AND createdAt in day)
//   ordersAbandoned = COUNT(AbandonedCart WHERE convertedAt IS NULL AND createdAt < day - 7d)
//   revenueFils = SUM
//   productViews — approximate: store snapshot of SUM(Product.viewCount) on Store.lastViewCountSnapshotAt; today's delta = current - snapshot. Skip if no snapshot column (acknowledged limitation per spec).
//   UPSERT
```

**RFM** — for each customer with ≥1 paid order:

```ts
// recencyDays = (NOW - max(paid order createdAt))
// frequencyOrders = COUNT paid orders
// monetaryFils = SUM paid order totals
// Quintile bucket each (1..5) relative to store population:
//   R5 = top 20% most-recent, R1 = bottom 20%
//   Same for F, M
// rfmScore = R*100 + F*10 + M
// segment = (per table in spec)
// previousSegment = load from existing CustomerRfmSnapshot if any
// UPSERT
```

For guest customers (Order.customerId IS NULL): use `sha256(shippingAddress.email + ':' + shippingAddress.phone)` as `customerId` + `isGuest=true`. If no email/phone, skip.

Commit:

```bash
git add apps/api/src/services/accounting/analytics-rollup.service.ts
git commit -m "feat(insights): analytics rollup service (cohort + funnel + rfm)"
```

---

## Task 3: AI narration service + Inngest function

### Service `apps/api/src/services/accounting/insights-narration.service.ts`

`generateInsightNarration(storeId, scope: 'cohort'|'funnel'|'segment'): Promise<{ en: string; ar: string } | null>`

Reads latest snapshots, calls Gemini with context (top 3 cohorts by retention delta / yesterday's funnel vs trailing avg / segments where N customers moved). Returns bilingual narration or null if `Store.aiNarrationEnabled=false`.

Cache result in a new lightweight `InsightNarration` row (storeId, scope, scannedDate, en, ar) — schema: skip for v1 simplicity, compute on-demand in dashboard fetch (Gemini call per page load with 5min HTTP cache). Acceptable since the rollup runs once a day.

### Inngest function `apps/api/src/lib/inngest/functions/analytics-daily-rollup.ts`

```ts
export const analyticsDailyRollup: InngestFunction.Any = inngest.createFunction(
  {
    id: 'analytics-daily-rollup',
    name: 'Insights — nightly cohort/funnel/rfm rollup',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: '0 23 * * *' }],
  }, // 02:00 KW
  async ({ step }) => {
    const stores = await step.run('list-stores', () =>
      prisma.store.findMany({
        where: { accountingEnabled: true, deletedAt: null },
        select: { id: true },
      })
    );
    for (const store of stores) {
      await step.run(`rollup-${store.id}`, () => runDailyRollup(store.id));
    }
    return { stores: stores.length };
  }
);
```

Register in `functions/index.ts`. No new event types needed (cron-only).

Commit:

```bash
git add apps/api/src/services/accounting/insights-narration.service.ts apps/api/src/lib/inngest/functions/analytics-daily-rollup.ts apps/api/src/lib/inngest/functions/index.ts
git commit -m "feat(insights): nightly rollup inngest cron + ai narration"
```

---

## Task 4: API routes

`apps/api/src/routes/insights.routes.ts`:

- `GET /:storeId/insights/dashboard` — top-level KPIs: AOV trend, MRR-equiv, repeat purchase rate, top RFM segment, top 5 SKUs by velocity, yesterday's funnel conversion
- `GET /:storeId/insights/cohorts` — full matrix from CustomerCohortSnapshot
- `GET /:storeId/insights/funnel?window=7|30|90` — daily snapshots + drop-off rates per step
- `GET /:storeId/insights/segments` — RFM segment counts + revenue contribution per segment
- `GET /:storeId/insights/products?perPage=50` — SKU velocity ranking (from OrderItem aggregation + product join)
- `GET /:storeId/insights/customers/:customerId/rfm` — single customer's RFM snapshot
- `POST /:storeId/insights/rollup/run-now` — super_admin only — fires the cron function on-demand

Auth chain + runInTenantContext as in Batch 2/3.

Mount in `routes/index.ts`. Commit:

```bash
git add apps/api/src/routes/insights.routes.ts apps/api/src/routes/index.ts
git commit -m "feat(insights): api routes — cohorts + funnel + segments + products"
```

---

## Task 5: Admin Insights hub + 5 pages

`apps/admin/src/app/stores/[id]/insights/` — 6 files:

- `page.tsx` — auto-redirect to `/insights/dashboard` via `redirect()` from `next/navigation`
- `dashboard/page.tsx` — KPI tiles
- `cohorts/page.tsx` — retention heatmap (color-shaded matrix, drill into cell)
- `funnel/page.tsx` — bar chart with drop-off annotations
- `segments/page.tsx` — RFM segment cards with recommended actions
- `products/page.tsx` — top/bottom velocity tables + dead-stock cross-link

i18n keys under `insights.*` block — full bilingual.

Commit:

```bash
git add apps/admin/src/app/stores/\[id\]/insights/ apps/admin/src/i18n/messages/en.json apps/admin/src/i18n/messages/ar.json
git commit -m "feat(admin): insights hub — dashboard + cohorts + funnel + segments + products"
```

---

## Task 6: Sidebar Insights hub + cross-page RFM badge

### Sidebar update (`buildStoreAdminNav.ts` + `hubs.ts` + `AdminLayout.tsx`)

Add `insights` hub to NavLabels + HUBS array (urlPrefixes: `['/insights']`, buildTabs returns 5 entries). Insert in sidebar nav array between `analytics` and `marketing`. Use bar-chart icon.

### Customers list RFM badge

In `apps/admin/src/app/stores/[id]/customers/page.tsx`, fetch `/insights/customers/{id}/rfm` per row (or batch — fetch all RFM snapshots for store in one call, then per-row lookup like B3-T10's reorder/deadstock badge pattern). Render small segment badge next to customer name.

### Dashboard RFM top-segment tile

Extend `DashboardAccountingSummary` to fetch top RFM segment (from `/insights/segments` → pick segment with highest count) and add as a 5th tile.

Commit:

```bash
git add apps/admin/src/components/admin-layout/ apps/admin/src/app/stores/\[id\]/customers/ apps/admin/src/app/stores/\[id\]/_components/DashboardAccountingSummary.tsx apps/admin/src/i18n/messages/en.json apps/admin/src/i18n/messages/ar.json
git commit -m "feat(admin): insights sidebar hub + rfm badge on customers + dashboard tile"
```

---

## Task 7: Integration test

`tests/integration/accounting/analytics-rollup.test.ts` — seed store + 10 customers across 3 cohort months + paid orders → run rollup → assert:

- CustomerCohortSnapshot has N rows for each cohort × periodOffset
- FunnelSnapshot has entries for the orders' days
- CustomerRfmSnapshot has 10 rows with segments assigned

Commit:

```bash
git add tests/integration/accounting/analytics-rollup.test.ts
git commit -m "test(insights): integration — analytics rollup (cohort + funnel + rfm)"
```

---

## Task 8: Validation + memory

```bash
npm run build -w apps/api && npm run build -w apps/admin && npm run build -w apps/web
npm audit  # must be 0/0/0/0
graphify update .
git add graphify-out/graph.json graphify-out/GRAPH_REPORT.md
git commit -m "chore(graphify): refresh after accounting batch 4"
git push origin main
```

Memory file at `feature-accounting-batch-4.md`. Update MEMORY.md index. Fire pipeline.

---

## Self-review

Spec coverage: all 3 snapshot tables + rollup + 5 pages + sidebar + integration test = ✓
Placeholders: none.
Type consistency: RfmSegment used in service + route + UI consistently.

## Execution

Subagent-driven (Sonnet per task). 7 logical tasks. ~5-7 commits.
