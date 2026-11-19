# Ebda Store — Plan ⇄ Feature Matrix

> **INTERNAL — Ebda AI Studio / Ebda AI Studio team. Generated from `packages/shared/src/plan-baselines.ts`
> (the code that actually gates features at runtime). If this table and the code disagree, the code
> wins — regenerate this doc.**
>
> **Last synced: 2026-09-07.** 🤖 marks an AI capability — all AI is available on every paid plan (AI-first policy).
>
> **Prior sync 2026-07-21.** Added `bundles` (fixed-kit product bundles) — in no plan baseline,
> same "sold as an add-on, enable per store via `StoreFeature`" shape as `agent_feed` and
> `agent_checkout` WERE originally; both of those have since moved into every paid plan baseline
> (AI-first policy, 2026-07-21 — see `plan-baselines.ts`), so only `bundles` stays add-on; see the "Not plan-gated" section below.
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
(Ebda Store is sold managed-agency with a custom proposal + yearly contract — there is no
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
| Agentic checkout / MCP (`agent_checkout`) 🤖                 |  —   |   ✅    |      ✅      |     ✅     |
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
- **WhatsApp** (`whatsapp`) — **OFF for every store, in NO plan baseline, `hidden: true` in the registry (Ruling `WHATSAPP-OFF-1`).** The legacy in-Store WhatsApp API bridge (admin `/whatsapp` page, WBS connection, templates, bot config, order-update sends, payment-link send, bot analytics, the `/wa-bridge/*` endpoints) was DELETED (Ruling `WA-LEGACY-1`, 2026-10-25); the separate Ebda Chat product (wa.ebda.app) replaces it through the Store contract and keeps using this key and the plan limit `whatsappAutomation`. Only a super-admin `StoreFeature` `whatsapp` override (`enabled=true`) turns it on, per store. Plain `wa.me` buttons (contact, floating widget, product share, COD confirm, "message customer", setup-guide share) never depend on it. This retires the 2026-06-09 (#94) "universal by default (managed-agency)" model.
- **AI Tools** — the admin AI-bulk-sweep hub (`/stores/:id/ai-tools`) is feature-gated as of 2026-06-09. There is no standalone `ai_tools` `FeatureKey`; the page gates on **`bulk_operations`** (`useRequireFeature('bulk_operations')`, Starter+ — same row already in the matrix). This prevents unbounded Gemini API usage from stores below Starter.
- **Email campaigns** (`email_campaigns`) — **shipped 2026-09-25 (D2); in Growth + Business since 2026-10-21 (not Basic)**: on by plan baseline (`professional`/`enterprise` tiers), a super-admin `StoreFeature` override still wins both ways; Basic sees the upgrade gate ("Available on the Growth plan"). Bilingual campaigns to the store's opted-in newsletter subscribers only, sent through Inngest one email per recipient, with a one-click unsubscribe, an AI draft button and a per-store rolling 24h cap by plan (Growth 1000, Business 5000, other tiers 500; `CAMPAIGN_DAILY_SEND_CAP` overrides every plan). Admin: Marketing → Campaigns (`/stores/:id/campaigns`). Plan + rulings: `docs/plans/done/2026-09-25-email-campaigns.md`, `docs/RULINGS.md` EC-1…EC-10.
- **Abandoned-cart recovery email** (part of `abandoned_cart`, 2026-10-21) — a third recovery channel beside push/SMS. Same plan gating as the rest of cart recovery (Growth + Business); OFF until the merchant enables it in Abandoned carts → Recovery settings (reminder delay 60–1440 min, default 120). One email per cart, sent from the store's own sender, only to active newsletter subscribers, one-click unsubscribe. Reach: logged-in customers who are active newsletter subscribers, plus anyone (guests included) who ticks the unchecked checkout box "Email me about my cart" (a cart-reminders-only consent that never receives campaigns; Ruling CART-CONSENT-1). The button is a signed, expiring cart-restore link (CART-RESTORE-1). Per-store cap `CART_EMAIL_DAILY_CAP` (default 200/day, shared with the campaign budget). Plan: `docs/plans/done/2026-10-21-cart-email-campaigns.md`, rulings CART-EMAIL-1…9, CART-CONSENT-1, CART-DETECT-1.
- **Customer wallet / store credit** (`customer_wallet`, shipped 2026-09-25) and **pay with wallet at checkout** (`customer_wallet_checkout`) — **in Growth + Business since 2026-10-29 (Ruling W-8; not Basic)**, pinned by `plan-baselines.test.ts`; a super-admin override still wins both ways (an explicit OFF row on a store keeps it off). `customer_wallet` gives returns-as-store-credit, the admin Sales → Wallet page, the customer-page wallet card with manual adjust, and the shopper's `/account/wallet`. `customer_wallet_checkout` additionally lets signed-in shoppers spend the balance at checkout, and is refused while the store has accounting enabled (Ruling W-3). Design: `docs/plans/done/2026-09-25-customer-wallet.md`. (**`staff_accounts`** moved from this list into `STARTER_CORE` on 2026-07-02 — it's now a real matrix row above, universal by default. The `/staff` admin page now renders the `FeatureUpgradeGate` for a store without it; API-side `staff.routes` enforcement is tracked separately.)
- **AI Product Feed** (`agent_feed`) — **in every paid plan baseline** (Starter/Professional/Enterprise) since 2026-07-21 under the AI-first policy. `free` (lapsed-payment / demo grace) still excludes it. Still fail-closed at the API: a store without the feature gets a **404** (not 403) on `GET /api/v1/public/feed/products.json` and the storefront's `/feeds/products.json`, so a disabled store never reveals the endpoint's existence. Disable for a specific client via a `StoreFeature` override from the FeatureMatrix admin grid.
- **Agentic checkout / MCP** (`agent_checkout`) — **in every paid plan baseline** (Starter/Professional/Enterprise), same rollout as `agent_feed`. Exposes a store-scoped [Model Context Protocol](https://modelcontextprotocol.io) server at `POST /api/v1/mcp/:storeSlug` (stateless Streamable HTTP) with 7 tools (`search_products`, `get_product`, `get_store_info`, `add_to_cart`, `view_cart`, `place_order`, `get_order_status`) so AI shopping agents can browse and check out directly, no human in the loop. Fail-closed like `agent_feed`: an unknown slug and a disabled-feature slug both 404 with the byte-identical error body (no capability leak). Orders it places are stamped `Order.source = 'agent'` (audit-only, visible in the admin order list/detail as an "Agent" badge) and are otherwise identical to a web checkout (same validation, inventory, payment rails). Discoverable via the store's `/llms.txt` (`## Agentic checkout (MCP)` section, links the endpoint + tool list) when enabled. Disable for a specific client via a `StoreFeature` override.
  - **Read/write split (Ruling M1, 2026-09-09).** The 5 READ tools (`search_products`, `get_product`, `get_store_info`, `view_cart`, `get_order_status`) and the MCP handshake stay ANONYMOUS. The 2 WRITE tools (`add_to_cart`, `place_order`) require the store's own agent credential in the `x-agent-key` header — so "no human in the loop" now means "no human in the loop, once the merchant has issued the agent a key". The merchant mints / rotates / revokes it on the **AI agent key** page — `/stores/:id/agent-key`, reached from the Settings card grid and the ⌘K palette, both gated on `agent_checkout` (API: `POST|DELETE /api/v1/stores/:id/integrations/agent-key`, store_admin + MFA). The plaintext key is shown exactly once, at mint/rotate time; the status endpoint and the page never show it again, so a lost key is rotated rather than recovered. Rotating invalidates the previous key immediately (no overlap window) and revoking is behind an explicit acknowledgement of the consequence. Refused and failed writes are recorded in `audit_logs` (`agent.write.denied` / `agent.write.failed`) with ip + user agent.
  - **Denial alerting (2026-09-09).** A 15-minute Inngest cron (`agent-write-denied-watch`) reads the
    `agent.write.denied` rows and alerts through the existing `sendAlert` Telegram channel. It does NOT
    alert on the raw rate — credential-less callers finding the tools through `llms.txt` are expected
    background, and paging on them would get the alert muted. It classifies by what the caller
    PRESENTED: a lookup failure of ours (p0), a merchant integration sending a stale key from a stable
    source (p1, 3 per 16 min), a credential sweep from many sources (p1 at 10, escalating to a single
    platform p0 when 3+ stores are hit at once), and credential-less volume (info, 50).
  - **Escape hatch:** `agent_checkout_open_writes` — in NO plan baseline, so enforcement is ON everywhere by default. A super-admin `StoreFeature` override turns it on for ONE store to drop the credential requirement there (takes effect in ≤300s, no deploy). It is the rollback lever, never the enable switch.
- **Product Bundles** (`bundles`) — added 2026-09-06, **in no plan baseline** (Starter, Professional,
  and Enterprise all default to disabled) — sold as an individually-priced add-on and enabled per
  store via a `StoreFeature` override, same shape as `agent_feed`/`agent_checkout`. A fixed kit of
  specific products at specific quantities, sold as one line at one price (fixed price / % off the
  component sum / fixed amount off). Availability is derived from component stock
  (`min(floor(componentStock / quantity))`) — no separate bundle stock row, so nothing is
  double-counted. Single-line representation in cart/checkout/order/invoice; returns are atomic
  (whole box, refunds exactly the bundle price — itemized partial-box returns are not built).
  Surfaced in the AI product feed (with a `/bundles/<slug>` link) and the WhatsApp bridge's
  store-catalog read when enabled. **The customer-facing purchase path ships**: `GET
/public/:storeId/bundles/:slug`, `apps/web/src/app/bundles/page.tsx` and
  `apps/web/src/app/bundles/[slug]/page.tsx` (add-to-cart via `addBundle`), an auto-appended
  "Bundles" nav entry in `ShopChrome` (gated on `store.enabledFeatures` — no per-page request),
  sitemap fan-out and JSON-LD. (The WhatsApp DM-ordering path that used to resolve bundles was
  deleted with the legacy bridge, Ruling `WA-LEGACY-1`.) Coupons and cart promotions
  are excluded from bundle lines by design, and the storefront quotes a coupon against the loose
  items only so the quote matches the charge. Rollout is a supervised pilot: one merchant, one real
  order, one real return, then offer to others. Flipping the flag does not bust the 600s AI-feed
  cache.
- **Answer-Engine Insights** (`answer_engine_insights`) — added to `STARTER_CORE` on 2026-07-22 (Plan 8A, same AI-first policy as `agent_feed`), so it's on every paid plan and off on `free`. Merchant surface: `/stores/:id/answer-engine` (Marketing hub) shows per-engine (Gemini/Perplexity/OpenAI) cited counts, a week-over-week trend, and the latest per-prompt win/lose list with a "run AI citation fix" deep-link to the `bulk-ai-citation-copy` GEO sweep for every prompt the store lost. Read API (`GET /stores/:id/answer-engine/summary`) fails closed like every other feature-gated route in this codebase — `403 FEATURE_DISABLED`, not a 404. Underlying `AnswerEngineCheck` rows come from a weekly citation-scan cron (Gemini always runs on the platform key; Perplexity/OpenAI are opt-in, platform-wide-toggled, DB-config-keyed add-on engines — see `docs/ENVIRONMENT.md`). **Google Search Console ingestion (Plan 8B, added 2026-07-23) is part of this SAME feature — no separate feature key.** The same page's GSC section (`GET /stores/:id/answer-engine/gsc`, same `403 FEATURE_DISABLED` gate) surfaces a daily impressions/clicks/CTR/position trend and top queries from `GscDailyMetric` rows written by a force-managed daily ingestion cron. Dormant (zero rows, UI shows "Google Search Console not connected") until `GSC_SERVICE_ACCOUNT_JSON` is provisioned — see `docs/ENVIRONMENT.md` and `docs/runbooks/google-search-console-indexing.md`.

### 2026-07-21 — AI-first baseline

Every AI capability is now available on every paid plan. `agent_feed`, `upsell_crosssell` and `accounting.profit_anomaly` moved into `STARTER_CORE`; the AI reorder-suggestion scan was re-gated from `inventory.purchase_orders` to `inventory.basic` so an AI feature is no longer gated behind an ERP module (purchase orders themselves stay Enterprise).

Rationale: Ebda Store is an AI-first product and AI is its only uncontested differentiator against OSOSS. Tiering it made the positioning untrue — and left the flagship AI Product Feed disabled on **every** store, with a live storefront returning 404 for `/feeds/products.json`. Revenue comes from the platform, not from gating the differentiator.

`accounting.profit_anomaly` moves independently of `accounting.basic`: `profit-anomaly.service.ts` reads only coupon, inventory-history, payment and store data — never journal entries — so it functions on Starter without the accounting suite.

- The legacy parent `inventory` flag is **intentionally not in any baseline** — code reads the granular `inventory.*` sub-keys.
- **Delivery areas & fees** (governorate → area cascade, per-area fee, bulk xlsx/csv import + xlsx export, hide-unpriced) — **core shipping, ungated.** Part of the checkout + Settings → Shipping for every plan; not a `FeatureKey`. The legacy `ShippingZone` API stays as a fallback when a store has no area rates.
- **Orders + Orders PWA CRUD** (status, mark-paid, payment link, refund, refresh payment/refund, bulk mark-paid, activity timeline, staff order permissions) — **core, ungated.** There is no `orders` feature key; order management is universal. Staff visibility is governed by the staff/role system, not a plan baseline. Exception: the **invoice viewer** (`/orders/:orderId/invoice`) admin page gates on **`accounting.invoicing`** (Professional+, same row already in the matrix) via `FeatureUpgradeGate` — the underlying API route itself has no plan check yet.
- **Order payment-lifecycle alerts** ("Payment received", auto-cancel-unpaid via `AUTO_CANCEL_UNPAID_DAYS`, no-false-refund-on-unpaid-cancel) — **platform-level, ungated.** Background Inngest jobs that run for every store; tuned by env, not by plan. Note: the unpaid-online-order "Checkout abandoned" merchant push is NOT ungated — it belongs to the Enterprise `payment_abandonment` feature (`PAYMENT_ABANDON_MINUTES`), the sole such alert since the always-on "Payment pending — follow up" nudge was removed 2026-07-18.
- **Inventory variant stock totals + paginated inventory page + per-type adjustment explanations** — **part of `inventory.basic` (Starter+)**, the same row already in the matrix. The barcode **Scan** modes (Receive / Pick / Count) are gated by `inventory.barcode` (**Enterprise**, already in the matrix).
- **Storefront Locations page** (Google Maps embed, Page-Builder-editable, nav + mobile "Menu" drawer link) — **core storefront, ungated.**
- **Multi-warehouse stock auto-reconcile** (item 5 data-integrity, 2026-07-23) — **behavioral fix under the existing `inventory.multi_warehouse` key (Enterprise), no new `FeatureKey`.** Per-warehouse `WarehouseStock` counts are kept in sync with the authoritative `Product.inventory` / `ProductVariant.inventory` via: (1) the 3 admin stock writers reconciling inline after their own write, (2) the order-refund fanout, (3) a daily completeness sweep (cron, all multi-warehouse stores), and (4) this task's on-demand "Reconcile to aggregate" button on the per-warehouse admin page (`POST /stores/:storeId/warehouses/reconcile-all`, same middleware chain — Enterprise + tenant-scoped). `WarehouseStock` is an admin-view-only shadow (never read by checkout/storefront), so this is purely a display-accuracy fix, not a pricing/availability change.

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
