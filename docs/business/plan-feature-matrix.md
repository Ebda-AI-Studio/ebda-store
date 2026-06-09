# Force Store — Plan ⇄ Feature Matrix

> **Single source of truth for which features each plan tier includes.** Generated from
> `packages/shared/src/plan-baselines.ts` (the code that actually gates features at runtime).
> If this table and the code disagree, the code wins — regenerate this doc.
> Last synced: **2026-06-09**.

Plans are **layered (strict superset)**: Professional includes everything in Starter, Enterprise
includes everything in Professional. `free` is a stripped grace/demo state, **not a sold tier**
(Force Store is sold managed-agency with a custom proposal + yearly contract — there is no
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

## Not plan-gated by baseline (add-on or always-on)

- **Product discount engine** (per-product percentage/fixed discount with live preview) — part of the core product editor; available from Starter up.
- **WhatsApp Business Platform integration** (`whatsapp`) — **universal by default (managed-agency).** As of 2026-06-09 (#94) `whatsapp` is in `STARTER_CORE` and the `free` grace baseline, so the `/whatsapp` admin pages are accessible to **every** store out of the box (Ahmad onboards each client and WhatsApp is a core offering). It is still feature-gated, but the gate **defaults open** — access is restricted only by exception, when a super-admin sets a `StoreFeature` `whatsapp` override with `enabled=false` (e.g. a limited deal). This is the managed-agency default-everything/restrict-by-exception model, not a sold per-plan tier.
- **AI Tools** (`ai_tools`) — admin AI-bulk-sweep pages are feature-gated as of 2026-06-09; only stores with `ai_tools` feature enabled see the AI Tools hub. This prevents unbounded Gemini API usage from stores that haven't been provisioned for it.
- **Email campaigns** (`email_campaigns`), **customer wallet** (`customer_wallet`), **staff accounts** (`staff_accounts`) — present in the registry; enable per-store via override when sold. Not in baselines as of this sync.
- The legacy parent `inventory` flag is **intentionally not in any baseline** — code reads the granular `inventory.*` sub-keys.

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
