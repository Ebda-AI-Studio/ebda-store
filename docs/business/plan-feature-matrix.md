# Force AI Store — Plan ⇄ Feature Matrix

> **INTERNAL — Force AI / Force Media team. Generated from `packages/shared/src/plan-baselines.ts`
> (the code that actually gates features at runtime). If this table and the code disagree, the code
> wins — regenerate this doc.**
>
> **Last synced: 2026-07-21.** 🤖 marks an AI capability — all AI is available on every paid plan (AI-first policy).
>
> **Prior sync 2026-07-02.** Multi-currency, bank reconciliation, barcode scanning, and
> multi-warehouse are shipped Enterprise features (not roadmap). Tax reports (XLSX export),
> profit anomaly watch, loyalty redemption, low-stock alerts, backorders, and server-side CAPI
> pixels are also real and confirmed against code. The 2026-06 shipping/orders/payment-lifecycle
> work (delivery-area rates + bulk import/export, Orders-PWA CRUD, payment-received
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

| Feature (key)                                                | Free | Starter | Professional | Enterprise |
| ------------------------------------------------------------ | :--: | :-----: | :----------: | :--------: |
| Coupons (`coupons`)                                          |  ✅  |   ✅    |      ✅      |     ✅     |
| Reviews (`reviews`)                                          |  ✅  |   ✅    |      ✅      |     ✅     |
| Inventory — basic (`inventory.basic`)                        |  ✅  |   ✅    |      ✅      |     ✅     |
| Returns (`returns`)                                          |  —   |   ✅    |      ✅      |     ✅     |
| Tax (`tax`)                                                  |  —   |   ✅    |      ✅      |     ✅     |
| PWA (`pwa`)                                                  |  —   |   ✅    |      ✅      |     ✅     |
| SEO (`seo`)                                                  |  —   |   ✅    |      ✅      |     ✅     |
| Search autocomplete (`search_autocomplete`)                  |  —   |   ✅    |      ✅      |     ✅     |
| Marketing pixels (`marketing_pixels`)                        |  —   |   ✅    |      ✅      |     ✅     |
| Shipping carriers (`shipping_carriers`)                      |  —   |   ✅    |      ✅      |     ✅     |
| Bulk operations (`bulk_operations`)                          |  —   |   ✅    |      ✅      |     ✅     |
| Abandoned cart (`abandoned_cart`)                            |  —   |   ✅    |      ✅      |     ✅     |
| Staff accounts (`staff_accounts`)                            |  —   |   ✅    |      ✅      |     ✅     |
| AI Product Feed (`agent_feed`) 🤖                            |  —   |   ✅    |      ✅      |     ✅     |
| Upsell / cross-sell (`upsell_crosssell`) 🤖                  |  —   |   ✅    |      ✅      |     ✅     |
| Accounting — profit anomaly (`accounting.profit_anomaly`) 🤖 |  —   |   ✅    |      ✅      |     ✅     |
| Answer-Engine Insights (`answer_engine_insights`) 🤖         |  —   |   ✅    |      ✅      |     ✅     |
| Inventory — stock alerts (`inventory.stock_alerts`)          |  —   |    —    |      ✅      |     ✅     |
| Inventory — backorder (`inventory.backorder`)                |  —   |    —    |      ✅      |     ✅     |
| Accounting — basic / CoA + journals (`accounting.basic`)     |  —   |    —    |      ✅      |     ✅     |
| Accounting — expenses (`accounting.expenses`)                |  —   |    —    |      ✅      |     ✅     |
| Accounting — invoicing (`accounting.invoicing`)              |  —   |    —    |      ✅      |     ✅     |
| Loyalty (`loyalty`)                                          |  —   |    —    |      ✅      |     ✅     |
| Push notifications (`push_notifications`)                    |  —   |    —    |      ✅      |     ✅     |
| Inventory — multi-warehouse (`inventory.multi_warehouse`)    |  —   |    —    |      —       |     ✅     |
| Inventory — barcode (`inventory.barcode`)                    |  —   |    —    |      —       |     ✅     |
| Inventory — purchase orders (`inventory.purchase_orders`)    |  —   |    —    |      —       |     ✅     |
| Inventory — bulk adjustments (`inventory.bulk_adjustments`)  |  —   |    —    |      —       |     ✅     |
| Accounting — tax reports (`accounting.tax_reports`)          |  —   |    —    |      —       |     ✅     |
| Accounting — multi-currency (`accounting.multi_currency`)    |  —   |    —    |      —       |     ✅     |
| Accounting — bank reconcile (`accounting.bank_reconcile`)    |  —   |    —    |      —       |     ✅     |
| Affiliate program (`affiliate`)                              |  —   |    —    |      —       |     ✅     |
| SMS (`sms`)                                                  |  —   |    —    |      —       |     ✅     |
| Floating widget (`floating_widget`)                          |  —   |    —    |      —       |     ✅     |
| Payment-gateway abandonment capture (`payment_abandonment`)  |  —   |    —    |      —       |     ✅     |

## Not plan-gated by baseline (add-on or always-on)

- **Product discount engine** (per-product percentage/fixed discount with live preview) — part of the core product editor; available from Starter up.
- **WhatsApp Business Platform integration** (`whatsapp`) — **universal by default (managed-agency).** As of 2026-06-09 (#94) `whatsapp` is in `STARTER_CORE` and the `free` grace baseline, so the `/whatsapp` admin pages are accessible to **every** store out of the box (Ahmad onboards each client and WhatsApp is a core offering). It is still feature-gated, but the gate **defaults open** — access is restricted only by exception, when a super-admin sets a `StoreFeature` `whatsapp` override with `enabled=false` (e.g. a limited deal). This is the managed-agency default-everything/restrict-by-exception model, not a sold per-plan tier.
- **AI Tools** — the admin AI-bulk-sweep hub (`/stores/:id/ai-tools`) is feature-gated as of 2026-06-09. There is no standalone `ai_tools` `FeatureKey`; the page gates on **`bulk_operations`** (`useRequireFeature('bulk_operations')`, Starter+ — same row already in the matrix). This prevents unbounded Gemini API usage from stores below Starter.
- **Email campaigns** (`email_campaigns`), **customer wallet** (`customer_wallet`) — present in the registry; enable per-store via override when sold. Not in baselines as of this sync. (**`staff_accounts`** moved from this list into `STARTER_CORE` on 2026-07-02 — it's now a real matrix row above, universal by default like `whatsapp`. The `/staff` admin page now renders the `FeatureUpgradeGate` for a store without it; API-side `staff.routes` enforcement is tracked separately.)
- **AI Product Feed** (`agent_feed`) — **in every paid plan baseline** (Starter/Professional/Enterprise) since 2026-07-21 under the AI-first policy. `free` (lapsed-payment / demo grace) still excludes it. Still fail-closed at the API: a store without the feature gets a **404** (not 403) on `GET /api/v1/public/feed/products.json` and the storefront's `/feeds/products.json`, so a disabled store never reveals the endpoint's existence. Disable for a specific client via a `StoreFeature` override from the FeatureMatrix admin grid.
- **Answer-Engine Insights** (`answer_engine_insights`) — added to `STARTER_CORE` on 2026-07-22 (Plan 8A, same AI-first policy as `agent_feed`), so it's on every paid plan and off on `free`. Merchant surface: `/stores/:id/answer-engine` (Marketing hub) shows per-engine (Gemini/Perplexity/OpenAI) cited counts, a week-over-week trend, and the latest per-prompt win/lose list with a "run AI citation fix" deep-link to the `bulk-ai-citation-copy` GEO sweep for every prompt the store lost. Read API (`GET /stores/:id/answer-engine/summary`) fails closed like every other feature-gated route in this codebase — `403 FEATURE_DISABLED`, not a 404. Underlying `AnswerEngineCheck` rows come from a weekly citation-scan cron (Gemini always runs on the platform key; Perplexity/OpenAI are opt-in, platform-wide-toggled, DB-config-keyed add-on engines — see `docs/ENVIRONMENT.md`). **Google Search Console ingestion (Plan 8B, added 2026-07-23) is part of this SAME feature — no separate feature key.** The same page's GSC section (`GET /stores/:id/answer-engine/gsc`, same `403 FEATURE_DISABLED` gate) surfaces a daily impressions/clicks/CTR/position trend and top queries from `GscDailyMetric` rows written by a force-managed daily ingestion cron. Dormant (zero rows, UI shows "Google Search Console not connected") until `GSC_SERVICE_ACCOUNT_JSON` is provisioned — see `docs/ENVIRONMENT.md` and `docs/runbooks/google-search-console-indexing.md`.

### 2026-07-21 — AI-first baseline

Every AI capability is now available on every paid plan. `agent_feed`, `upsell_crosssell` and `accounting.profit_anomaly` moved into `STARTER_CORE`; the AI reorder-suggestion scan was re-gated from `inventory.purchase_orders` to `inventory.basic` so an AI feature is no longer gated behind an ERP module (purchase orders themselves stay Enterprise).

Rationale: FWB is an AI-first product and AI is its only uncontested differentiator against OSOSS. Tiering it made the positioning untrue — and left the flagship AI Product Feed disabled on **every** store, with a live storefront returning 404 for `/feeds/products.json`. Revenue comes from the platform, not from gating the differentiator.

`accounting.profit_anomaly` moves independently of `accounting.basic`: `profit-anomaly.service.ts` reads only coupon, inventory-history, payment and store data — never journal entries — so it functions on Starter without the accounting suite.

- The legacy parent `inventory` flag is **intentionally not in any baseline** — code reads the granular `inventory.*` sub-keys.
- **Delivery areas & fees** (governorate → area cascade, per-area fee, bulk xlsx/csv import + xlsx export, hide-unpriced) — **core shipping, ungated.** Part of the checkout + Settings → Shipping for every plan; not a `FeatureKey`. The legacy `ShippingZone` API stays as a fallback when a store has no area rates.
- **Orders + Orders PWA CRUD** (status, mark-paid, payment link, refund, refresh payment/refund, bulk mark-paid, activity timeline, staff order permissions) — **core, ungated.** There is no `orders` feature key; order management is universal. Staff visibility is governed by the staff/role system, not a plan baseline. Exception: the **invoice viewer** (`/orders/:orderId/invoice`) admin page gates on **`accounting.invoicing`** (Professional+, same row already in the matrix) via `FeatureUpgradeGate` — the underlying API route itself has no plan check yet.
- **Order payment-lifecycle alerts** ("Payment received", auto-cancel-unpaid via `AUTO_CANCEL_UNPAID_DAYS`, no-false-refund-on-unpaid-cancel) — **platform-level, ungated.** Background Inngest jobs that run for every store; tuned by env, not by plan. Note: the unpaid-online-order "Checkout abandoned" merchant push is NOT ungated — it belongs to the Enterprise `payment_abandonment` feature (`PAYMENT_ABANDON_MINUTES`), the sole such alert since the always-on "Payment pending — follow up" nudge was removed 2026-07-18.
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
