# Admin Endpoint Connection Audit — 2026-05-28

Audits every page under `apps/admin/src/app/stores/[id]/` against its
API endpoint(s). Pages that had no endpoint at all or used a broken
connection are flagged. The three concrete fixes from this session are
detailed at the top.

---

## Fixes Shipped in This PR

### Fix 1 — Customer "Potential" label

**Problem**: Ahmad Sharaf (3 orders / 20.750 KWD spent) showed badge "Potential"
— a label that implies a prospect with no purchases.

**Root cause** (`apps/api/src/services/accounting/analytics-rollup.service.ts`
`classifySegment`):
- Line 167: `rQ >= 4 && fQ <= 2 → potential` — catches recent buyers in the
  second frequency quintile (which includes customers with 2–4 orders when many
  store customers have more).
- Line 176: catch-all also returns `potential` — anyone not matching VIP /
  loyal / new_customer / at_risk / hibernating became "Potential".

**Fix**: Renamed the UI label for the `potential` RFM segment from "Potential"
to **"Active Buyer"** (EN) / **"مشتري نشط"** (AR). The enum value
`RfmSegment.potential` is unchanged — the underlying RFM classification is
intentional (these customers have purchase potential). Only the merchant-facing
display label is corrected to reflect that they have ALREADY ordered.

**Files changed**:
- `apps/admin/src/i18n/messages/en.json` — `insights.segments.segment.potential` → "Active Buyer"
- `apps/admin/src/i18n/messages/ar.json` — `insights.segments.segment.potential` → "مشتري نشط"
- `apps/admin/src/app/stores/[id]/customers/page.tsx` — `RFM_BADGE.potential.label` → "Active Buyer"
- `apps/admin/src/app/stores/[id]/_components/DashboardAccountingSummary.tsx` — `SEGMENT_LABEL.potential` → "Active Buyer"
- `apps/admin/src/app/stores/[id]/insights/segments/page.tsx` — use i18n label instead of raw `seg.segment.replace(/_/g,' ')`
- `apps/api/src/routes/insights.routes.ts` — updated `potential` recommended action text to reflect active buyers
- `apps/api/src/services/accounting/analytics-rollup.service.ts` — exported `classifySegment` for unit testing

**Tests**: `tests/unit/customer-segment-label.test.ts` — 8 unit tests covering
all 7 segments + the specific Ahmad Sharaf scenario (3-order customer, rQ=4,
fQ=2 → badge "Active Buyer", never "Potential").

---

### Fix 2 — "Failed to load AI usage data" on Marketing / AI Usage page

**Problem**: `apps/admin/src/app/stores/[id]/ai-usage/page.tsx` always showed
the error state: "Failed to load AI usage data. / تعذّر تحميل بيانات الاستخدام."

**Root cause**: Double-unwrap of the `apiGet` envelope.

`apiGet<T>` internally does `return { data: data.data as T }` — it already
extracts the inner `data` field from `{ success, data: <payload> }`. The page
was calling:

```ts
apiGet<{ data: SummaryData }>(`/api/v1/stores/${storeId}/ai/usage/summary`)
```

then accessing `summaryRes.data?.data` — a second `.data` level that returns
`undefined` because the unwrapped value is `SummaryData` directly. `undefined`
triggered the `loadError` branch.

**Fix**: Changed type parameter to the direct shape `SummaryData` / `LogData`
and removed the extra `.data` accessor:

```ts
// before
apiGet<{ data: SummaryData }>(...)
setSummary(summaryRes.data?.data ?? null);  // ← .data?.data = undefined

// after
apiGet<SummaryData>(...)
setSummary(summaryRes.data ?? null);
```

**File changed**: `apps/admin/src/app/stores/[id]/ai-usage/page.tsx`

The API endpoints `/stores/:storeId/ai/usage/summary` and
`/stores/:storeId/ai/usage/log` exist, are correctly protected (store_admin /
super_admin), and return the right shape — no API changes needed.

---

### Fix 3 — Finance Dashboard disconnected from sales data

**Problem**: The Finance Dashboard at `apps/admin/src/app/stores/[id]/finance/dashboard/page.tsx`
shows "Revenue" from accounting journal entries (`profitAndLoss` function).
For stores that haven't posted journal entries (no COA seeding, no GL entries),
Revenue shows KWD 0.000 even when the store has dozens of paid orders.

**Root cause**: The Finance Dashboard exclusively calls `/stores/:storeId/finance/dashboard`
which aggregates `JournalEntry` rows via `profitAndLoss()`. The Analytics hub
calls `/stores/:storeId/analytics/dashboard` which aggregates paid `Order` rows
via `getDashboardStats()`. The two data sources intentionally differ (accounting
vs cash basis) but the Finance page had no fallback for stores without GL entries.

**Fix**: Added a parallel fetch of `/analytics/dashboard` in the Finance Dashboard
`useEffect`. The analytics stats are surfaced as a new "Sales (from Orders)"
section above the stock/cash/balance-sheet sections. The two sections are clearly
labelled:
- "This Month" (P&L from journal entries — accounting basis)
- "Sales (from Orders)" with an "Orders" badge — from paid order totals

The analytics fetch is best-effort: if it fails, the panel stays hidden.
The P&L section is unaffected.

**New i18n keys added** (EN + AR):
- `finance.dashboard.salesOrdersTitle`
- `finance.dashboard.salesOrdersSource`
- `finance.dashboard.salesOrdersRevenue`
- `finance.dashboard.salesOrdersCount`
- `finance.dashboard.salesOrdersCountUnit`

**File changed**: `apps/admin/src/app/stores/[id]/finance/dashboard/page.tsx`

---

## Full Page → Endpoint Map

Pages are listed by their URL path under `/stores/:id/`. "Endpoint" shows the
primary API path(s) each page calls. Gaps and TODOs are noted.

| Page | Endpoint(s) | Status |
|------|-------------|--------|
| `/` (store dashboard) | `/stores/:id/stats`, `/analytics/dashboard`, `/finance/dashboard`, `/analytics/stock-snapshot`, `/insights/segments` | OK |
| `/abandoned-carts` | `/stores/:id/abandoned-carts` | OK |
| `/affiliates` | `/stores/:id/affiliates`, `/affiliates/config`, `/affiliates/stats` | OK |
| `/affiliates/:id/events` | `/stores/:id/affiliates/:id/events` | OK |
| `/ai-tools` | `/stores/:id/ai/bulk`, `/ai/jobs` | OK |
| `/ai-usage` | `/stores/:id/ai/usage/summary`, `/ai/usage/log` | **FIXED** (double-unwrap bug) |
| `/analytics` | `/stores/:id/analytics/dashboard`, `/analytics/sales`, `/analytics/top-products`, `/analytics/recent-orders`, `/analytics/low-stock`, `/analytics/cashflow` | OK |
| `/announcement` | `/stores/:id/announcement` (GET + PUT) | OK |
| `/blog` | `/stores/:id/blog/posts` | OK |
| `/blog/:postId` | `/stores/:id/blog/posts/:id` | OK |
| `/branding` | `/stores/:id` (GET/PUT theme) | OK |
| `/bulk` | `/stores/:id/products/bulk-import` | OK — 1 raw fetch (known debt) |
| `/categories` | `/stores/:id/categories` | OK |
| `/content` | `/stores/:id/content/pages` | OK |
| `/content/:slug` | `/stores/:id/content/pages/:slug` | OK |
| `/coupons` | `/stores/:id/coupons` | OK |
| `/customers` | `/stores/:id/orders` (aggregated client-side) + `/insights/customers/rfm-batch` | OK |
| `/customers/:key` | `/stores/:id/customers/:key` | OK |
| `/domain` | `/stores/:id/domain` | OK |
| `/features` | `/stores/:id/features` | OK |
| `/finance/dashboard` | `/stores/:id/finance/dashboard` + (NEW) `/analytics/dashboard` | **FIXED** (added sales reconciliation) |
| `/finance/accounts` | `/stores/:id/finance/accounts` | OK |
| `/finance/anomalies` | `/stores/:id/finance/anomalies` | OK |
| `/finance/expenses` | `/stores/:id/expenses` | OK |
| `/finance/expenses/new` | `/stores/:id/expenses` (POST) | OK |
| `/finance/journal` | `/stores/:id/finance/journal` | OK |
| `/finance/journal/new` | `/stores/:id/finance/journal` (POST) | OK |
| `/finance/journal/:entryId` | `/stores/:id/finance/journal/:id` | OK |
| `/finance/reports` | `/stores/:id/finance/reports/trial-balance` + `/profit-loss` + `/balance-sheet` | OK |
| `/floating-widget` | `/stores/:id` (theme update) | OK |
| `/hero` | `/stores/:id` (hero sections update) | OK |
| `/insights/cohorts` | `/stores/:id/insights/cohorts` | OK |
| `/insights/dashboard` | `/stores/:id/insights/dashboard` | OK |
| `/insights/funnel` | `/stores/:id/insights/funnel` | OK |
| `/insights/products` | `/stores/:id/insights/products` | OK |
| `/insights/segments` | `/stores/:id/insights/segments` | **FIXED** (now uses i18n label for segment name) |
| `/integrations/wbs` | `/stores/:id/integrations/wbs` | OK |
| `/inventory` | `/stores/:id/inventory` | OK |
| `/language` | `/stores/:id` (language settings) | OK |
| `/loyalty` | `/stores/:id/loyalty` | OK |
| `/loyalty/transactions` | `/stores/:id/loyalty/transactions` | OK |
| `/marketing-pixels` | `/stores/:id/marketing-pixels` | OK |
| `/navigation` | `/stores/:id/navigation/menu` | OK |
| `/newsletter` | `/stores/:id/newsletter/subscribers` | OK |
| `/notifications` | `/stores/:id/notifications` | OK |
| `/orders` | `/stores/:id/orders` | OK |
| `/orders/new` | `/stores/:id/orders` (POST) | OK |
| `/orders/:orderId` | `/stores/:id/orders/:id` | OK |
| `/orders/:orderId/invoice` | `/stores/:id/orders/:id/invoice` | OK |
| `/page-builder` | `/stores/:id/theme/sections` | OK |
| `/pages` | `/stores/:id/content/pages` | OK |
| `/payment-link` | `/stores/:id/payment-links` | OK |
| `/payment-settings` | `/stores/:id/payment-settings` | OK |
| `/products` | `/stores/:id/products` | OK |
| `/products/new` | `/stores/:id/products` (POST) | OK |
| `/products/:id` | `/stores/:id/products/:id` | OK |
| `/products/:id/edit` | `/stores/:id/products/:id` (PUT) | OK |
| `/products/:id/variants` | `/stores/:id/products/:id/variants` | OK |
| `/products/:id/recommendations` | `/stores/:id/products/:id/recommendations` | OK |
| `/pwa` | `/stores/:id/pwa` | OK |
| `/returns` | `/stores/:id/returns` | OK |
| `/reviews` | `/stores/:id/reviews` | OK |
| `/seo` | `/stores/:id/seo` | OK |
| `/settings` | `/stores/:id` (general settings) | OK |
| `/shipping` | `/stores/:id/shipping/zones` | OK |
| `/shipping-carriers` | `/stores/:id/shipping-carriers` | OK |
| `/stock/adjustments` | `/stores/:id/stock/adjustments` | OK |
| `/stock/adjustments/new` | `/stores/:id/stock/adjustments` (POST) | OK |
| `/stock/backorders` | `/stores/:id/stock/backorders` | OK |
| `/stock/dashboard` | `/stores/:id/analytics/stock-snapshot` | OK |
| `/stock/deadstock` | `/stores/:id/stock/deadstock` | OK |
| `/stock/inventory` | `/stores/:id/inventory` | OK |
| `/stock/purchase-orders` | `/stores/:id/stock/purchase-orders` | OK |
| `/stock/purchase-orders/new` | `/stores/:id/stock/purchase-orders` (POST) | OK |
| `/stock/purchase-orders/:poId` | `/stores/:id/stock/purchase-orders/:id` | OK |
| `/stock/reorder` | `/stores/:id/stock/reorder-rules` | OK |
| `/stock/suppliers` | `/stores/:id/stock/suppliers` | OK |
| `/stock/suppliers/new` | `/stores/:id/stock/suppliers` (POST) | OK |
| `/tax` | `/stores/:id/tax` | OK |
| `/template` | `/stores/:id` (template selection) | OK |
| `/wa-bot` | `/stores/:id/wa-bot/config` | OK |
| `/wa-order-updates` | `/stores/:id/wa-order-updates` | OK |
| `/wa-templates` | `/stores/:id/wa-templates` | OK |
| `/whatsapp` | `/stores/:id/whatsapp` | OK |

---

## Gaps Found / Not Fixed in This PR

| Gap | Severity | TODO |
|-----|----------|------|
| `/insights/segments` renders raw segment key via `seg.segment.replace(/_/g,' ')` ignoring i18n | Low | Fixed in this PR (use `t('segment.X')`) |
| `customers/page.tsx` hardcodes EN column headers "Last Payment" and "Address" instead of using i18n keys | Low | Minor — add to i18n backlog |
| `/finance/dashboard` revenue is 0 for stores without COA seeding | Medium | Addressed via sales reconciliation panel — full GL auto-seeding on first order would be a larger fix |
| `useAnalytics` hook in analytics page doesn't pass `from/to` to the `/insights/segments` call — segments show all-time not period-filtered | Low | Out-of-scope for this PR |
