# Force AI Store — Plan ⇄ Feature Matrix

> **INTERNAL — Force AI / Force Media team. Generated from `packages/shared/src/plan-baselines.ts`
> (the code that actually gates features at runtime). If this table and the code disagree, the code
> wins — regenerate this doc.**
>
> **Last synced: 2026-07-02.** Multi-currency, bank reconciliation, barcode scanning, and
> multi-warehouse are shipped Enterprise features (not roadmap). Tax reports (XLSX export),
> profit anomaly watch, loyalty redemption, low-stock alerts, backorders, and server-side CAPI
> pixels are also real and confirmed against code. The 2026-06 shipping/orders/payment-lifecycle
> work (delivery-area rates + bulk import/export, Orders-PWA CRUD, payment-received / stuck-payment
> alerts, auto-cancel-unpaid, variant stock totals, Stock → Scan) is **not** a new plan tier — see
> the "Not plan-gated" section below for where each piece sits. The barcode **Scan** UI is gated by
> the existing `inventory.barcode` Enterprise key (row already in the matrix); everything else is
> core/platform and ungated.

Plans are **layered (strict superset)**: Professional includes everything in Starter, Enterprise
includes everything in Professional. `free` is a stripped grace/demo state, **not a sold tier**
(Force AI Store is sold managed-agency with a custom proposal + yearly contract — there is no
self-serve signup and no free trial). Super-admin can override any feature per store via the
`StoreFeature` table without changing the plan.

## Matrix

| Feature (key)                                               | Free | Starter | Professional | Enterprise |
| ----------------------------------------------------------- | :--: | :-----: | :----------: | :--------: |
| Coupons (`coupons`)                                         |  ✅  |   ✅    |      ✅      |     ✅     |
| Reviews (`reviews`)                                         |  ✅  |   ✅    |      ✅      |     ✅     |
| Inventory — basic (`inventory.basic`)                       |  ✅  |   ✅    |      ✅      |     ✅     |
| Returns (`returns`)                                         |  —   |   ✅    |      ✅      |     ✅     |
| Tax (`tax`)                                                 |  —   |   ✅    |      ✅      |     ✅     |
| PWA (`pwa`)                                                 |  —   |   ✅    |      ✅      |     ✅     |
| SEO (`seo`)                                                 |  —   |   ✅    |      ✅      |     ✅     |
| Search autocomplete (`search_autocomplete`)                 |  —   |   ✅    |      ✅      |     ✅     |
| Marketing pixels (`marketing_pixels`)                       |  —   |   ✅    |      ✅      |     ✅     |
| Shipping carriers (`shipping_carriers`)                     |  —   |   ✅    |      ✅      |     ✅     |
| Bulk operations (`bulk_operations`)                         |  —   |   ✅    |      ✅      |     ✅     |
| Abandoned cart (`abandoned_cart`)                           |  —   |   ✅    |      ✅      |     ✅     |
| Staff accounts (`staff_accounts`)                           |  —   |   ✅    |      ✅      |     ✅     |
| Inventory — stock alerts (`inventory.stock_alerts`)         |  —   |    —    |      ✅      |     ✅     |
| Inventory — backorder (`inventory.backorder`)               |  —   |    —    |      ✅      |     ✅     |
| Accounting — basic / CoA + journals (`accounting.basic`)    |  —   |    —    |      ✅      |     ✅     |
| Accounting — expenses (`accounting.expenses`)               |  —   |    —    |      ✅      |     ✅     |
| Accounting — invoicing (`accounting.invoicing`)             |  —   |    —    |      ✅      |     ✅     |
| Loyalty (`loyalty`)                                         |  —   |    —    |      ✅      |     ✅     |
| Push notifications (`push_notifications`)                   |  —   |    —    |      ✅      |     ✅     |
| Upsell / cross-sell (`upsell_crosssell`)                    |  —   |    —    |      ✅      |     ✅     |
| Inventory — multi-warehouse (`inventory.multi_warehouse`)   |  —   |    —    |      —       |     ✅     |
| Inventory — barcode (`inventory.barcode`)                   |  —   |    —    |      —       |     ✅     |
| Inventory — purchase orders (`inventory.purchase_orders`)   |  —   |    —    |      —       |     ✅     |
| Inventory — bulk adjustments (`inventory.bulk_adjustments`) |  —   |    —    |      —       |     ✅     |
| Accounting — tax reports (`accounting.tax_reports`)         |  —   |    —    |      —       |     ✅     |
| Accounting — multi-currency (`accounting.multi_currency`)   |  —   |    —    |      —       |     ✅     |
| Accounting — profit anomaly (`accounting.profit_anomaly`)   |  —   |    —    |      —       |     ✅     |
| Accounting — bank reconcile (`accounting.bank_reconcile`)   |  —   |    —    |      —       |     ✅     |
| Affiliate program (`affiliate`)                             |  —   |    —    |      —       |     ✅     |
| SMS (`sms`)                                                 |  —   |    —    |      —       |     ✅     |
| Floating widget (`floating_widget`)                         |  —   |    —    |      —       |     ✅     |
| Payment-gateway abandonment capture (`payment_abandonment`) |  —   |    —    |      —       |     ✅     |

## Not plan-gated by baseline (add-on or always-on)

- **Product discount engine** (per-product percentage/fixed discount with live preview) — part of the core product editor; available from Starter up.
- **WhatsApp Business Platform integration** (`whatsapp`) — **universal by default (managed-agency).** As of 2026-06-09 (#94) `whatsapp` is in `STARTER_CORE` and the `free` grace baseline, so the `/whatsapp` admin pages are accessible to **every** store out of the box (Ahmad onboards each client and WhatsApp is a core offering). It is still feature-gated, but the gate **defaults open** — access is restricted only by exception, when a super-admin sets a `StoreFeature` `whatsapp` override with `enabled=false` (e.g. a limited deal). This is the managed-agency default-everything/restrict-by-exception model, not a sold per-plan tier.
- **AI Tools** — the admin AI-bulk-sweep hub (`/stores/:id/ai-tools`) is feature-gated as of 2026-06-09. There is no standalone `ai_tools` `FeatureKey`; the page gates on **`bulk_operations`** (`useRequireFeature('bulk_operations')`, Starter+ — same row already in the matrix). This prevents unbounded Gemini API usage from stores below Starter.
- **Email campaigns** (`email_campaigns`), **customer wallet** (`customer_wallet`) — present in the registry; enable per-store via override when sold. Not in baselines as of this sync. (**`staff_accounts`** moved from this list into `STARTER_CORE` on 2026-07-02 — it's now a real matrix row above, universal by default like `whatsapp`. The `/staff` admin page now renders the `FeatureUpgradeGate` for a store without it; API-side `staff.routes` enforcement is tracked separately.)
- The legacy parent `inventory` flag is **intentionally not in any baseline** — code reads the granular `inventory.*` sub-keys.
- **Delivery areas & fees** (governorate → area cascade, per-area fee, bulk xlsx/csv import + xlsx export, hide-unpriced) — **core shipping, ungated.** Part of the checkout + Settings → Shipping for every plan; not a `FeatureKey`. The legacy `ShippingZone` API stays as a fallback when a store has no area rates.
- **Orders + Orders PWA CRUD** (status, mark-paid, payment link, refund, refresh payment/refund, bulk mark-paid, activity timeline, staff order permissions) — **core, ungated.** There is no `orders` feature key; order management is universal. Staff visibility is governed by the staff/role system, not a plan baseline. Exception: the **invoice viewer** (`/orders/:orderId/invoice`) admin page gates on **`accounting.invoicing`** (Professional+, same row already in the matrix) via `FeatureUpgradeGate` — the underlying API route itself has no plan check yet.
- **Order payment-lifecycle alerts** ("Payment received", "Payment pending — follow up" via `STUCK_PAYMENT_MINUTES`, auto-cancel-unpaid via `AUTO_CANCEL_UNPAID_DAYS`, no-false-refund-on-unpaid-cancel) — **platform-level, ungated.** Background Inngest jobs that run for every store; tuned by env, not by plan.
- **Inventory variant stock totals + paginated inventory page + per-type adjustment explanations** — **part of `inventory.basic` (Starter+)**, the same row already in the matrix. The barcode **Scan** modes (Receive / Pick / Count) are gated by `inventory.barcode` (**Enterprise**, already in the matrix).
- **Storefront Locations page** (Google Maps embed, Page-Builder-editable, nav + mobile "Menu" drawer link) — **core storefront, ungated.**

## Upgrade UX

When a store-admin opens a feature their plan doesn't include, they see an on-brand
**"Available on the &lt;Plan&gt; plan"** upsell page (the `FeatureUpgradeGate` component) with the
feature's value proposition + a contact CTA — not a silent redirect. The "lowest plan that
unlocks feature X" shown there is computed by `lowestPlanForFeature()` in `plan-baselines.ts`.

## How to regenerate

This table is derived from `STARTER_CORE`, `PROFESSIONAL_ADDITIONS`, `ENTERPRISE_ADDITIONS`, and
the `PLAN_BASELINE` map in `packages/shared/src/plan-baselines.ts`, with names from
`FEATURE_REGISTRY` in `packages/shared/src/features.ts`. When a feature's tier changes in code,
update this doc in the same PR (see the doc-parity rule in the global build playbook).
