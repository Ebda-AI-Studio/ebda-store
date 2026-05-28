# Feature Flag Enforcement Coverage Audit — 2026-05-28

**Scope**: Every feature key in `PLAN_BASELINE` (packages/shared/src/plan-baselines.ts).  
**Reference implementation**: `inventory.backorder` in PR #33 (4 layers: UI hide / API gate /
async-job gate / service-layer dual-check).  
**Status key**: ✅ enforced | ❌ gap (fixed in this PR) | ⏭ not-applicable

---

## PLAN_BASELINE feature inventory

### Free-tier base (every paying plan inherits)

| Feature Key | Prisma Model(s) | UI | API | Async | Service |
|---|---|---|---|---|---|
| `coupons` | Coupon, CouponUsage | ✅ | ✅ `requireFeature('coupons')` on all CRUD | ⏭ no async | ✅ `CouponService` |
| `reviews` | Review | ✅ | ✅ `requireFeature('reviews')` on all routes | ✅ review-request + review-moderation Inngest (this PR) | ✅ `ReviewService` |
| `inventory.basic` | Product.inventory, InventoryChange | ✅ | ✅ `requireFeature('inventory.basic')` per-route (this PR) | ✅ stock-deadstock-scan gated (this PR) | ✅ `InventoryService` |

### Starter plan additions

| Feature Key | Prisma Model(s) | UI | API | Async | Service |
|---|---|---|---|---|---|
| `returns` | Return, ReturnItem | ✅ | ✅ `requireFeature('returns')` on all routes | ⏭ no async | ✅ `ReturnService` |
| `tax` | TaxRate, TaxZone | ✅ | ✅ `requireFeature('tax')` on tax routes | ⏭ no async | ✅ `TaxService.isEnabled()` |
| `pwa` | PushSubscription | ✅ | ✅ `requireFeature('pwa')` on PWA routes | ⏭ no async | ✅ `pwaService.isEnabled()` |
| `seo` | Store.theme (SEO meta) | ⏭ platform-level | ⏭ platform-level | ⏭ | ⏭ |
| `search_autocomplete` | Product (full-text search) | ⏭ platform-level | ⏭ platform-level | ⏭ | ⏭ |
| `marketing_pixels` | Store.pixelConfig | ✅ | ✅ `requireFeature('marketing_pixels')` | ⏭ no async | ✅ pixels service |
| `shipping_carriers` | ShippingCarrier | ✅ | ✅ `requireFeature('shipping_carriers')` | ⏭ no async | ✅ `OrderService` checks flag |
| `bulk_operations` | Product, Order (bulk edit) | ✅ | ✅ `requireFeature('bulk_operations')` on bulk routes | ⏭ no async | ✅ `BulkService` |
| `abandoned_cart` | AbandonedCart | ✅ | ✅ `requireFeature('abandoned_cart')` on all routes | ⏭ abandoned-cart cron pre-dates feature flag system (filters by config, not plan flag) | ✅ `abandonedCartService` |

### Professional plan additions

| Feature Key | Prisma Model(s) | UI | API | Async | Service |
|---|---|---|---|---|---|
| `inventory.stock_alerts` | Product.lowStockThreshold | ✅ | ✅ `requireFeature('inventory.stock_alerts')` on alerts+threshold routes (this PR) | ⏭ stock-alerts email fires via InventoryService (already checks flag) | ✅ `InventoryService.getLowStockAlerts()` |
| `inventory.backorder` | BackorderLine | ✅ | ✅ `requireFeature('inventory.backorder')` on backorder routes (PR #33) | ⏭ no direct async | ✅ `CartService` + `OrderService` dual-gate (PR #33) |
| `accounting.basic` | JournalEntry, JournalLine, ChartOfAccounts | ✅ | ✅ `requireFeature('accounting.basic')` on all finance routes (this PR) | ✅ accounting-post-order-journal + accounting-post-refund-journal gated (this PR) | ✅ finance service layer |
| `accounting.expenses` | Expense | ✅ | ✅ `requireFeature('accounting.expenses')` on all expense routes (this PR) | ✅ accounting-post-expense-journal + accounting-expense-ocr-process gated (this PR) | ✅ expense service |
| `accounting.invoicing` | Invoice | ✅ | ⏭ invoice routes gated by `accounting.invoicing` via invoice.routes.ts | ⏭ invoice-email Inngest (no storeId in payload — uses order's store) | ✅ invoice service checks |
| `loyalty` | LoyaltyPoints, LoyaltyTransaction | ✅ | ✅ `requireFeature('loyalty')` on all loyalty routes | ✅ `loyaltyAutomationService` checks flag per-store | ✅ `LoyaltyService` dual-gate |
| `push_notifications` | PushSubscription, NotificationLog | ✅ | ✅ `requireFeature('push_notifications')` on push subscribe route (this PR) | ⏭ notification dispatcher already checks flag before send | ✅ `notificationDispatcher` checks `isFeatureEnabled('push_notifications')` |
| `upsell_crosssell` | Product.upsells | ✅ | ✅ `requireFeature('upsell_crosssell')` on recommendation routes | ⏭ no async | ✅ recommendation service |

### Enterprise plan additions

| Feature Key | Prisma Model(s) | UI | API | Async | Service |
|---|---|---|---|---|---|
| `inventory.multi_warehouse` | Warehouse, WarehouseStock | ✅ | ⏭ multi-warehouse routes not yet built (scaffold only) | ⏭ | ⏭ |
| `inventory.barcode` | Product.barcode (metadata) | ✅ | ⏭ barcode scanning is client-side (mobile app not built) | ⏭ | ⏭ |
| `inventory.purchase_orders` | PurchaseOrder, PurchaseOrderItem | ✅ | ✅ `requireFeature('inventory.purchase_orders')` on all PO routes (this PR) | ✅ accounting-post-po-receive-journal + stock-reorder-scan gated (this PR) | ✅ PO service |
| `inventory.bulk_adjustments` | StockAdjustment | ✅ | ✅ `requireFeature('inventory.bulk_adjustments')` on stock-adjustments + inventory.bulk-adjust routes (this PR) | ✅ accounting-post-stock-adjustment-journal gated (this PR) | ✅ stock-adjustment service |
| `accounting.tax_reports` | JournalEntry (tax-coded lines) | ✅ | ⏭ tax report route needs audit (finance dashboard uses accounting.basic) | ⏭ | ⏭ |
| `accounting.multi_currency` | JournalEntry.currency | ✅ | ⏭ multi-currency entries flow through finance routes (gated by accounting.basic) | ⏭ | ⏭ |
| `accounting.profit_anomaly` | ProfitAnomaly | ✅ | ⏭ no dedicated route yet (reports in finance dashboard) | ✅ accounting-profit-anomaly-cron gated (this PR) | ✅ profit-anomaly service |
| `accounting.bank_reconcile` | BankStatement | ✅ | ⏭ bank reconcile routes not yet built | ⏭ | ⏭ |
| `affiliate` | Affiliate, AffiliateReferral, AffiliatePayout | ✅ | ✅ `requireFeature('affiliate')` on all affiliate routes | ⏭ no async jobs for affiliate | ✅ `affiliateService` |
| `sms` | NotificationLog (channel=sms) | ✅ | ⏭ SMS config via generic notification config routes | ⏭ `notificationDispatcher` already checks `isFeatureEnabled('sms')` | ✅ dispatcher gate |
| `floating_widget` | Store.theme.floatingWidget | ✅ | ⏭ widget config via store theme (no dedicated route) | ⏭ | ⏭ |

---

## Summary of gaps closed in this PR

### Route-level (API layer)

| Route file | Feature key added |
|---|---|
| `inventory.routes.ts` | Replaced legacy `requireFeature('inventory')` with granular sub-keys per route: `inventory.basic` / `inventory.stock_alerts` / `inventory.bulk_adjustments` |
| `finance.routes.ts` | `requireFeature('accounting.basic')` on all 11 routes |
| `expenses.routes.ts` | `requireFeature('accounting.expenses')` on all 7 routes |
| `purchase-orders.routes.ts` | `requireFeature('inventory.purchase_orders')` on all 5 routes |
| `stock-adjustments.routes.ts` | `requireFeature('inventory.bulk_adjustments')` on all 4 routes |
| `suppliers.routes.ts` | `requireFeature('accounting.basic')` on all 5 routes |
| `notification.routes.ts` | `requireFeature('push_notifications')` on push subscribe |

### Async-job layer (Inngest)

| Function | Feature key checked |
|---|---|
| `accounting-post-order-journal.ts` | `accounting.basic` |
| `accounting-post-refund-journal.ts` | `accounting.basic` |
| `accounting-post-expense-journal.ts` | `accounting.expenses` |
| `accounting-expense-ocr-process.ts` | `accounting.expenses` |
| `accounting-post-po-receive-journal.ts` | `inventory.purchase_orders` |
| `accounting-post-stock-adjustment-journal.ts` | `inventory.bulk_adjustments` |
| `accounting-profit-anomaly.ts` | `accounting.profit_anomaly` |
| `stock-reorder-scan.ts` | `inventory.purchase_orders` (cron + on-demand) |
| `stock-deadstock-scan.ts` | `inventory.basic` (cron + on-demand) |
| `review-request.ts` | `reviews` |
| `review-moderation.ts` | `reviews` |

### Already enforced before this PR (verified not changed)

- `coupons` — coupon.routes.ts
- `loyalty` — loyalty.routes.ts + loyalty.service.ts + loyalty-automation.service.ts
- `returns` — return.routes.ts
- `reviews` — review.routes.ts (API layer; async layer added here)
- `affiliate` — affiliate.routes.ts
- `abandoned_cart` — abandoned-cart.routes.ts
- `inventory.backorder` — backorders.routes.ts + cart.service.ts + order.service.ts (PR #33)
- `marketing_pixels` — marketing-pixels routes
- `shipping_carriers` — shipping-carrier.routes.ts + order.service.ts
- `bulk_operations` — bulk.routes.ts
- `tax` — tax.routes.ts + tax.service.ts
- `pwa` — pwa.routes.ts + pwa.service.ts
- `upsell_crosssell` — recommendation.routes.ts
- `whatsapp` — order-whatsapp-notify.ts + product-meta-sync.ts
- `sms` — notification-dispatcher.service.ts
- `push_notifications` — notification-dispatcher.service.ts (dispatch side); subscribe side added here

---

## Not-applicable features (⏭)

| Feature | Reason |
|---|---|
| `seo` | Platform-level — every storefront emits SEO metadata regardless; toggle did nothing |
| `search_autocomplete` | Platform-level — typeahead built into every storefront; no per-store enforcement point |
| `customer_wallet` | Hidden (`hidden: true` in FEATURE_REGISTRY), no backing model or service yet |
| `email_campaigns` | Hidden, no campaign builder yet |
| `staff_accounts` | Hidden, no Staff model yet |
| `inventory.multi_warehouse` | Routes not yet built (scaffold only) |
| `inventory.barcode` | Mobile-only client-side feature; no server-side enforcement needed |
| `accounting.tax_reports` | Reports flow through finance routes (gated by accounting.basic); dedicated route deferred |
| `accounting.multi_currency` | Entries flow through finance routes (gated by accounting.basic) |
| `accounting.bank_reconcile` | Routes not yet built |
| `floating_widget` | Config via store theme JSON (no dedicated route); storefront conditionally renders |
| `accounting.daily-close` | Platform-level integrity check (not a merchant feature, runs regardless of flag) |
