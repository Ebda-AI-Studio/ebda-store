# OSOSS vs Force Website Builder — Full Comparison

**Version:** 1.0 · **Date:** 2026-07-21 · **Owner:** Ahmad Sharaf
**Supersedes:** `ososs-vs-fwb-gap-analysis-2026-07-21.md` (rev 1–2). That file was a gap list; this is the complete comparison and is now the canonical document.

---

## 0. Method and evidence quality

**OSOSS** — observed live in `my.ososs.com` on the **PecannBee** merchant account (Kuwait, confectionery/gifts), which is in expired-grace. Coverage: the full navigation tree, plus create/edit forms and record details for the surfaces where depth decides the call.

**FWB** — code inventory of `force-website-builder`: admin route tree (111 admin pages), `apps/web` + `apps/orders`, `packages/database/prisma/schema.prisma`, `packages/shared/src/features.ts` (33 feature keys), `docs/business/plan-feature-matrix.md`.

### Four evidence rules this document follows

1. **An empty list is not an absent feature.** Nearly every OSOSS list on this account shows "No Data Available" — the merchant has little data, not a hollow product.
2. **A dashboard tile is not a source of truth.** The dashboard read _0 Products_ while `/dashboard/products` holds a full catalogue; the tile is date-range scoped.
3. **The nav is not the full surface.** `Production` and `Table Management` exist in the Inventories sidebar but in **no** top-level menu — found only via a product detail page.
4. **Gated modules read as absent.** `/dashboard/stores` returns _"You need to activate Stores — visit Marketplace."_ Anything this merchant never purchased is invisible to me. **This is the single biggest limit on the document** — see §10.

Confidence is marked per row: **[V]** verified by opening the surface · **[N]** nav-level only · **[?]** unresolved.

---

## 1. Executive summary

**OSOSS is an ERP with a storefront attached. FWB is a storefront with AI attached.**

OSOSS's centre of gravity runs Purchases → Inventory → Production → Accounting → POS, monetised as a base account plus a **paid app marketplace** (~60 installable apps, KWD10–600, mostly annual). FWB's centre of gravity is storefront design, merchandising and AI/AEO, bundled and sold managed-agency.

**The uncomfortable finding:** FWB's advantage is narrower than the module count suggests. OSOSS is deeper not only on ERP surfaces but on **core commerce primitives** — promotions, coupons, pricing, costing, delivery scheduling, geography, payment routing. FWB leads decisively on **storefront design, AI/AEO, and bundled pricing** and very little else.

|                  | OSOSS                                               | FWB                                            |
| ---------------- | --------------------------------------------------- | ---------------------------------------------- |
| Product shape    | ERP + commerce + POS                                | Commerce + AI                                  |
| Sales channels   | Store, POS, API (+ gated Stores module)             | Storefront (web/PWA)                           |
| Monetisation     | Base account + ~60 paid apps                        | Managed-agency, all-inclusive                  |
| Depth strength   | Transactional / operational                         | Design + intelligence                          |
| Verticals served | Retail, F&B, manufacturing, services, B2B           | Online retail                                  |
| Design surface   | **None self-serve** — KWD500 design service **[?]** | Page Builder, 5 themes, palette, typography    |
| AI               | None found                                          | Insights, inventory AI, content AI, agent feed |

---

## 2. Complete side-by-side matrix

Legend: ✅ present · ⚠️ partial/shallower · ❌ absent

### 2.1 Catalog

| Capability                           | OSOSS      | FWB | Notes                                               |
| ------------------------------------ | ---------- | --- | --------------------------------------------------- |
| Products                             | ✅ **[V]** | ✅  |                                                     |
| Variants / options                   | ✅ **[N]** | ✅  | FWB: `ProductVariant`, `ProductOption`              |
| Categories                           | ✅ **[V]** | ✅  |                                                     |
| **Product bundles / kits**           | ✅ **[V]** | ❌  |                                                     |
| **Services** as sellable type        | ✅ **[V]** | ❌  |                                                     |
| **Addons / modifiers**               | ✅ **[V]** | ❌  | F&B and configurable products                       |
| **Bill of Materials (BOM)**          | ✅ **[V]** | ❌  | BOM cost rolls onto product                         |
| **Brands**                           | ✅ **[V]** | ❌  | FWB has tags only                                   |
| **Attributes**                       | ✅ **[V]** | ⚠️  | FWB: variant options, not a global attribute system |
| **Units**                            | ✅ **[V]** | ❌  | Needed for sell-by-weight                           |
| **Selling pricings**                 | ✅ **[V]** | ❌  |                                                     |
| **Price lists (date-boxed From/To)** | ✅ **[V]** | ❌  |                                                     |
| Taxes                                | ✅ **[V]** | ✅  |                                                     |
| Tags                                 | ⚠️         | ✅  |                                                     |
| Digital / downloadable products      | ❌         | ❌  | Neither                                             |
| Reviews & ratings                    | ✅ **[V]** | ✅  | Product-detail tab                                  |
| Related / upsell / cross-sell        | ✅ **[V]** | ✅  | FWB adds AI-generated recommendations               |
| Product FAQ / How-to (AEO)           | ❌         | ✅  | AI-generated                                        |
| Wishlist (+ shareable)               | ❓ **[?]** | ✅  | Storefront-side, unconfirmed for OSOSS              |
| Product comparison                   | ❓ **[?]** | ✅  | Same                                                |
| Bulk import/export                   | ✅ **[V]** | ⚠️  | See §2.12                                           |

### 2.2 Inventory & operations

| Capability                                              | OSOSS                         | FWB                   |
| ------------------------------------------------------- | ----------------------------- | --------------------- |
| Stock tracking                                          | ✅ **[V]**                    | ✅                    |
| Multi-warehouse / multi-branch stock                    | ✅ **[V]**                    | ✅                    |
| **Branches as an org dimension** (filters every screen) | ✅ **[V]**                    | ❌                    |
| Stock transactions ledger                               | ✅ **[N]**                    | ✅ `InventoryHistory` |
| **Stock transfers**                                     | ✅ **[N]**                    | ❌                    |
| **Stock redistribution**                                | ✅ **[N]**                    | ❌                    |
| **Stock shortages**                                     | ✅ **[N]**                    | ❌                    |
| Stock receive                                           | ✅ **[N]**                    | ✅                    |
| Stock counting                                          | ✅ **[N]**                    | ✅ `CountSession`     |
| Backorder items                                         | ✅ **[V]**                    | ✅ `BackorderLine`    |
| **Backorder ingredients**                               | ✅ **[N]**                    | ❌                    |
| Barcode                                                 | ✅ **[V]**                    | ✅ (Enterprise)       |
| **Price label printing**                                | ✅ **[N]**                    | ❌                    |
| **Expiry-date tracking**                                | ✅ **[V]**                    | ❌                    |
| Low-stock alert thresholds                              | ✅ **[V]** per product/branch | ✅ (Pro+)             |
| **Unit cost / lifetime average cost / BOM cost**        | ✅ **[V]**                    | ❌                    |
| **On-hold qty / on-the-way qty**                        | ✅ **[V]**                    | ❌                    |
| **Return rate per product**                             | ✅ **[V]**                    | ❌                    |
| AI reorder suggestions                                  | ❌                            | ✅                    |
| AI dead-stock detection                                 | ❌                            | ✅                    |

### 2.3 Production / manufacturing

| Capability                              | OSOSS      | FWB |
| --------------------------------------- | ---------- | --- |
| **Manufacturing orders (manual)**       | ✅ **[V]** | ❌  |
| **JIT / make-to-order production**      | ✅ **[V]** | ❌  |
| **Per-branch JIT toggle**               | ✅ **[V]** | ❌  |
| **Table Management (restaurant floor)** | ✅ **[N]** | ❌  |

Entire capability class absent from FWB. Directly relevant to the F&B vertical on the FWB roadmap.

### 2.4 Orders, fulfilment, delivery

| Capability                                            | OSOSS                  | FWB                                                                                                                                                                               |
| ----------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Order management                                      | ✅ **[V]**             | ✅                                                                                                                                                                                |
| Per-channel order streams (Store / POS separately)    | ✅ **[V]**             | ❌                                                                                                                                                                                |
| Pending / cancelled / refunded views                  | ✅ **[V]**             | ⚠️ status filters                                                                                                                                                                 |
| **Consolidated invoices**                             | ✅ **[N]**             | ❌                                                                                                                                                                                |
| Manual order creation                                 | ✅ **[N]**             | ✅                                                                                                                                                                                |
| Returns & refunds                                     | ✅ **[V]**             | ✅ (Starter+)                                                                                                                                                                     |
| **Exchange orders**                                   | ✅ paid app            | ❌                                                                                                                                                                                |
| Invoices + A4 templates + invoice types               | ✅ **[V]**             | ⚠️ single invoice format                                                                                                                                                          |
| Document serialisation                                | ✅ paid app (invoices) | ⚠️ **[V]** `Sequence` — atomic per-store counters for journal / PO / adjustment / expense numbers, but **not** customer invoices                                                  |
| Delivery-area rates                                   | ✅ **[V]**             | ✅ governorate→area                                                                                                                                                               |
| Delivery time-window rules ("6–9PM for orders 1–7PM") | ✅ **[V]**             | ✅ **[V]** — `CheckoutDeliveryWindow`: bilingual label, store-local `start`/`end`, plus an explicit `orderBy` cutoff. **Parity, arguably richer** (documented fallback semantics) |
| Delivery rules per product / per currency             | ✅ **[V]**             | ❌                                                                                                                                                                                |
| Delivery rules import/export + audit trail            | ✅ **[V]**             | ❌                                                                                                                                                                                |
| Pickup                                                | ✅ **[N]**             | ✅ `StoreLocation`                                                                                                                                                                |
| Carrier integrations                                  | ✅ ~14 **[V]**         | ⚠️ 2 (Aramex, iCarry)                                                                                                                                                             |
| Shipments tracking                                    | ✅ **[N]**             | ✅ `Shipment`                                                                                                                                                                     |
| Orders staff PWA                                      | ❌                     | ✅                                                                                                                                                                                |

### 2.5 Payments & checkout

| Capability                                                                  | OSOSS          | FWB             |
| --------------------------------------------------------------------------- | -------------- | --------------- |
| Online gateways                                                             | ✅ **~19 [V]** | ⚠️ 4 + COD      |
| — Knet direct                                                               | ✅             | ❌              |
| — **BNPL: Tabby, Tamara, Deema**                                            | ✅             | ❌              |
| — PayPal, Cybersource, MPGS, Sadad, Payzah, PayLe, Bookeey, Oneglobal, Taly | ✅             | ❌              |
| — Tap, MyFatoorah, Hesabe, UPayments                                        | ✅             | ✅              |
| **Offline methods: Cash, Bank transfer, Cheque, Wallet**                    | ✅ **[V]**     | ⚠️ COD only     |
| **Per-channel gateway accounts (Store / POS / API)**                        | ✅ **[V]**     | ❌              |
| Payment webhook inbox + replay                                              | ❓             | ✅              |
| Payment-gateway abandonment capture                                         | ❌             | ✅ (Enterprise) |
| Payment links                                                               | ❓             | ✅              |

### 2.6 Promotions & pricing

| Capability                                                                                                                                                                                                                  | OSOSS      | FWB |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --- |
| **Cart Rules engine** — IF/THEN, priority, ALL/ANY, date window                                                                                                                                                             | ✅ **[V]** | ❌  |
| — Conditions: payment method, invoice status, min order amount, product count in order, **product count in purchase history**, **order count in purchase history**, order status, categories, products, **customer groups** | ✅ **[V]** | ❌  |
| — Actions: free payment method, free order count, **Buy X Get Cheapest Free (BOGO)**, discounted order, products, categories, **tiered discount**                                                                           | ✅ **[V]** | ❌  |
| **Order Rules engine**                                                                                                                                                                                                      | ✅ **[N]** | ❌  |
| Coupons — basic code/amount/date                                                                                                                                                                                            | ✅         | ✅  |
| — bilingual AR/EN content                                                                                                                                                                                                   | ✅ **[V]** | ⚠️  |
| — **uses per coupon / uses per customer**                                                                                                                                                                                   | ✅ **[V]** | ❌  |
| — **apply to original vs post-discount price**                                                                                                                                                                              | ✅ **[V]** | ❌  |
| — minimum subtotal                                                                                                                                                                                                          | ✅ **[V]** | ⚠️  |
| — **target by currency / price zone / country**                                                                                                                                                                             | ✅ **[V]** | ❌  |
| — **target by customer / customer group**                                                                                                                                                                                   | ✅ **[V]** | ❌  |
| — **target by payment method / sales channel**                                                                                                                                                                              | ✅ **[V]** | ❌  |
| — include-shipping toggle                                                                                                                                                                                                   | ✅ **[V]** | ❌  |
| — auto-apply in store                                                                                                                                                                                                       | ✅ **[V]** | ⚠️  |
| Auto-generated coupons                                                                                                                                                                                                      | ✅ **[V]** | ✅  |
| Per-product discounts                                                                                                                                                                                                       | ✅         | ✅  |
| **Price lists / customer-group pricing (B2B)**                                                                                                                                                                              | ✅ **[V]** | ❌  |

### 2.7 Customers & CRM

| Capability                                                    | OSOSS                          | FWB                |
| ------------------------------------------------------------- | ------------------------------ | ------------------ |
| Customer directory                                            | ✅ **[V]**                     | ✅                 |
| Addresses                                                     | ✅ **[V]** configurable fields | ✅ hardcoded shape |
| **Customer Groups** (active/default, drives pricing + promos) | ✅ **[V]**                     | ❌                 |
| RFM segmentation                                              | ❌                             | ✅                 |
| Cohort analysis                                               | ❌                             | ✅                 |
| Customer accounts (storefront self-service)                   | ❓                             | ✅                 |
| Store credit / wallet                                         | ✅ payment method **[V]**      | ❌ (flag hidden)   |

### 2.8 Marketing

| Capability                                                | OSOSS                         | FWB                                                                                                                                                               |
| --------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WhatsApp campaigns / templates / segments                 | ✅ **[V]**                    | ✅                                                                                                                                                                |
| WhatsApp Business API                                     | ✅ paid app                   | ✅                                                                                                                                                                |
| WhatsApp bot / native catalog ordering                    | ❓                            | ✅ (WBS bridge)                                                                                                                                                   |
| **WABA balance management**                               | ✅ **[V]**                    | ❌                                                                                                                                                                |
| **Sender ID management**                                  | ✅ **[V]**                    | ❌                                                                                                                                                                |
| Centralised notification centre                           | ✅ **[V]**                    | ✅ **[V]** — `NotificationConfig` + `NotificationEventConfig` (per-event WhatsApp/SMS/push toggles) + `NotificationLog` + `/notifications` admin page. **Parity** |
| **Sender ID management + template library**               | ✅ **[V]**                    | ⚠️ WhatsApp templates only (`WhatsAppTemplate`)                                                                                                                   |
| Abandoned carts                                           | ✅ **[V]**                    | ✅ (Starter+)                                                                                                                                                     |
| Loyalty                                                   | ✅ **rules engine [V]**       | ⚠️ points + tiers, not conditional                                                                                                                                |
| Push / app notifications                                  | ✅ **[V]**                    | ✅                                                                                                                                                                |
| SMS                                                       | ✅ **[N]**                    | ✅ (Enterprise)                                                                                                                                                   |
| Newsletter                                                | ❓                            | ✅                                                                                                                                                                |
| Email campaigns                                           | ❓                            | ❌ (flag hidden)                                                                                                                                                  |
| Affiliate program                                         | ❌                            | ✅ (Enterprise)                                                                                                                                                   |
| Marketing pixels (Meta/Google/TikTok + CAPI)              | ⚠️ GA app                     | ✅                                                                                                                                                                |
| **Dynamic ads catalog sync (Google Merchant / Meta RSS)** | ✅ paid app                   | ❌                                                                                                                                                                |
| **Virtual Try-On (VTO) + sessions**                       | ✅ **[V]**                    | ❌                                                                                                                                                                |
| Announcement bar / floating widget                        | ❓                            | ✅                                                                                                                                                                |
| Blog                                                      | ✅ paid app                   | ✅ bundled                                                                                                                                                        |
| SEO                                                       | ✅ **[V]** + paid sitemap app | ✅ bundled                                                                                                                                                        |
| **AEO — AI FAQ/How-to generation**                        | ❌                            | ✅                                                                                                                                                                |
| **AI Product Feed (ChatGPT/Perplexity)**                  | ❌                            | ✅                                                                                                                                                                |

### 2.9 POS

| Capability                                        | OSOSS       | FWB |
| ------------------------------------------------- | ----------- | --- |
| POS terminal (`pos2.ososs.com`)                   | ✅ **[V]**  | ❌  |
| POS dashboard: invoices, paid/unpaid/due, freight | ✅ **[V]**  | ❌  |
| POS sales by category with **cost + profit**      | ✅ **[V]**  | ❌  |
| POS return rate / revenue trend                   | ✅ **[V]**  | ❌  |
| POS-specific payment account                      | ✅ **[V]**  | ❌  |
| Perfume composition at POS                        | ✅ paid app | ❌  |
| Scalar barcode reader                             | ✅ paid app | ❌  |
| Gift receipt                                      | ✅ paid app | ❌  |

Entire module absent from FWB.

### 2.10 Purchasing

| Capability                                                  | OSOSS      | FWB             |
| ----------------------------------------------------------- | ---------- | --------------- |
| Purchase orders                                             | ✅ **[N]** | ✅ (Enterprise) |
| Suppliers                                                   | ✅ **[N]** | ✅              |
| **Purchase invoices**                                       | ✅ **[N]** | ❌              |
| **Refunded purchase invoices**                              | ✅ **[N]** | ❌              |
| **Purchase cost adjustments**                               | ✅ **[N]** | ❌              |
| **Recurring purchase invoices**                             | ✅ **[N]** | ❌              |
| Purchase reports                                            | ✅ **[N]** | ⚠️              |
| **Vendors / consignment (sales by vendor, vendor balance)** | ✅ **[N]** | ❌              |

### 2.11 Accounting & finance

| Capability                                   | OSOSS        | FWB             |
| -------------------------------------------- | ------------ | --------------- |
| Chart of accounts                            | ✅ **[N]**   | ✅ (Pro+)       |
| Journal entries                              | ✅ **[N]**   | ✅              |
| Incomes / expenses                           | ✅ **[N]**   | ✅              |
| **Vouchers + recurring vouchers**            | ✅ **[N]**   | ❌              |
| **Online PG transactions reconciliation**    | ✅ **[N]**   | ⚠️              |
| Tax rates + reports                          | ✅ **[V]**   | ✅              |
| **Bank reconciliation (CSV/OFX auto-match)** | ❌           | ✅ (Enterprise) |
| Expense OCR                                  | ❌           | ✅              |
| Multi-currency bookkeeping / FX              | ✅ paid app  | ✅ (Enterprise) |
| **AI profit-anomaly watch**                  | ❌           | ✅              |
| P&L / finance dashboard                      | ✅ **[N]**   | ✅              |
| **ERP bridges (Ocean, Midocean, Robosize)**  | ✅ paid apps | ❌              |

### 2.12 Platform, data & administration

| Capability                                                                                                                  | OSOSS                      | FWB                                                |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------- |
| **Data Fields — custom field engine** (section, type, visibility, required, system/custom)                                  | ✅ **[V]**                 | ❌                                                 |
| **Configurable address model** (Block/Street/Avenue/House/Floor/Flat as data)                                               | ✅ **[V]**                 | ❌ hardcoded                                       |
| **Excel Operations — async import/export jobs** across Customer, Product, Inventory, Income, with user attribution + status | ✅ **[V]**                 | ⚠️ products + stock CSV only                       |
| Media management                                                                                                            | ✅ **[N]**                 | ✅                                                 |
| Users / staff                                                                                                               | ✅ **[V]**                 | ✅                                                 |
| **Custom roles & permissions**                                                                                              | ✅ **[V]**                 | ⚠️ 4 fixed roles; per-endpoint enforcement partial |
| MFA + device management                                                                                                     | ❓                         | ✅                                                 |
| Audit logs                                                                                                                  | ⚠️ per-record "Updated By" | ✅                                                 |
| RLS tenant isolation                                                                                                        | ❓                         | ✅                                                 |
| **Locations hierarchy: Zones · Countries · Cities · Areas**                                                                 | ✅ **[V]**                 | ⚠️ Kuwait governorate→area                         |
| Domains — connect custom domain                                                                                             | ✅ **[V]**                 | ✅                                                 |
| **Domain registration + resale + auto-renewal**                                                                             | ✅ **[V]**                 | ❌                                                 |
| Free subdomain                                                                                                              | ✅ `*.ososs.store`         | ✅                                                 |
| **App marketplace (~60 installable apps)**                                                                                  | ✅ **[V]**                 | ❌                                                 |
| **Merchant-facing outbound webhooks**                                                                                       | ✅ paid app                | ❌                                                 |
| REST API + API payment account                                                                                              | ✅ **[V]**                 | ✅                                                 |
| Billing & subscription self-serve                                                                                           | ✅ **[V]**                 | ❌ by design                                       |
| Multi-store per account                                                                                                     | ✅ gated **[?]**           | ✅                                                 |

### 2.13 Storefront & design

| Capability                               | OSOSS                 | FWB  |
| ---------------------------------------- | --------------------- | ---- |
| **Page builder**                         | ❓ **[?]** none found | ✅   |
| **Themes**                               | ❓ **[?]** none found | ✅ 5 |
| **Smart palette / typography zones**     | ❓ **[?]**            | ✅   |
| Hero / navigation / announcement editors | ❓ **[?]**            | ✅   |
| Custom static pages                      | ❓                    | ✅   |
| PWA storefront                           | ❌                    | ✅   |
| **UI design as a paid service**          | ✅ KWD500             | n/a  |

**This is the pivotal row and it is unresolved** — see §10.

### 2.14 Analytics & reporting

| Capability                                                        | OSOSS      | FWB |
| ----------------------------------------------------------------- | ---------- | --- |
| Configurable dashboard widgets                                    | ✅ **[V]** | ⚠️  |
| Branch + channel + date filters                                   | ✅ **[V]** | ⚠️  |
| Sales by product / detailed / summary / invoice / location / user | ✅ **[V]** | ⚠️  |
| **Live sales monitoring**                                         | ✅ **[V]** | ❌  |
| Product performance, annual comparison                            | ✅ **[V]** | ⚠️  |
| Sales by vendor / addon                                           | ✅ **[V]** | ❌  |
| **Per-product profit & growth**                                   | ✅ **[V]** | ❌  |
| **AI insights (RFM, cohorts, funnel)**                            | ❌         | ✅  |
| AI usage / quota tracking                                         | ❌         | ✅  |

### 2.15 Vertical add-ons (OSOSS marketplace)

Appointment System · Consultation System · Repair Orders · Gold/Silver Pricing · Size Chart · Gift Receipt · Exchange Orders · Perfume Composition at POS · SKU Generator · Foreign-Currency Product Pricing · Robosize (sizing) · Scalar Barcode Reader.

FWB: **none of these**. Individually small; collectively the reason OSOSS wins niche merchants.

---

## 3. OSOSS-only — the consolidated list

**Whole modules:** POS · Production/manufacturing + JIT · Table Management · Purchasing beyond the PO · Vouchers · App marketplace · Domain registration/resale.

**Engines:** Cart Rules · Order Rules · Loyalty Rules · Data Fields (custom fields) · Excel Operations (async jobs) · Locations hierarchy.

**Commerce depth:** coupon targeting (7 dimensions) · price lists · customer groups · selling pricings · BOM/bundles/services/addons · brands/attributes/units · delivery time-windows · offline payment methods · per-channel payment accounts · expiry dates · average/BOM costing · on-hold & in-transit quantities · return rate.

**Breadth:** ~19 payment gateways · ~14 carriers · ~60 marketplace apps.

---

## 4. FWB-only — the consolidated list

**Design (highest value, pending §10):** Page Builder · 5 themes · Smart Palette · typography zones · hero/nav/announcement editors · custom pages · PWA storefront.

**AI/AEO (uncontested):** AI insights suite (RFM, cohorts, funnel) · AI reorder suggestions · AI dead-stock detection · AI profit-anomaly watch · AI bulk translate/SEO/categorisation · AI-generated FAQ & How-to · AI recommendations & frequently-bought-together · **AI Product Feed for ChatGPT/Perplexity (agentic commerce)**.

**Commerce/ops:** Affiliate program · payment-gateway abandonment capture · bank reconciliation · expense OCR · Orders staff PWA · wishlist (+ shareable) & product comparison **[?]**.

**Platform:** MFA + device management · audit logs · RLS tenant isolation · webhook inbox with replay.

**Commercial:** everything bundled — blog, sitemap/SEO, webhooks, multi-currency bookkeeping and unlimited products are all included, where OSOSS charges KWD200/yr, KWD100/yr, KWD200/yr, KWD50/yr and **KWD120/yr** respectively.

---

## 5. Parity

Products/variants/categories · reviews · related/upsell/cross-sell · WhatsApp campaigns, templates, segments · push notifications · SMS · abandoned carts · auto-generated coupons · customers & addresses · taxes · chart of accounts & journal entries · incomes/expenses · suppliers · purchase orders · stock counting/receive · backorders · multi-warehouse · barcode · custom domain connection · staff users · media management · pickup · REST API · multi-store.

---

## 6. Architectural differences (not feature counts)

1. **Configuration vs schema.** OSOSS models custom fields, address shape, geography and pricing as _data_. FWB hardcodes them. OSOSS onboards a new vertical by configuring; FWB does it by migrating. This compounds.
2. **Channel as a first-class entity.** OSOSS separates Store / POS / API down to payment accounts, order streams and reporting. FWB has one channel.
3. **Rules engines vs fixed features.** Promotions, loyalty and order handling are user-authored rules in OSOSS; in FWB they're fixed code paths.
4. **Marketplace vs feature flags.** OSOSS extends via installable, individually-priced apps; FWB via super-admin feature flags. OSOSS's model scales scope and revenue without engineering; FWB's keeps the product coherent and the proposal simple.
5. **Costing model.** OSOSS carries average/BOM/landed cost and in-transit stock. FWB tracks quantity and basic cost. Every profit number downstream inherits this difference.
6. **Intelligence layer.** FWB is alone in having one. OSOSS has richer raw data and does nothing automated with it — which is precisely the opening.

---

## 7. Commercial model

|              | OSOSS                                | FWB                             |
| ------------ | ------------------------------------ | ------------------------------- |
| Sales motion | Self-serve + apps                    | Managed agency, custom proposal |
| Base         | Paid account (price unknown **[?]**) | Yearly contract                 |
| Add-ons      | ~60 apps, KWD10–600, mostly yearly   | None — bundled                  |
| Free trial   | Expired-grace observed               | None by design                  |
| Design       | KWD500 service                       | Included                        |
| Domains      | Resold with auto-renewal             | Connect only                    |
| Lock-in      | Accumulated app subscriptions        | Contract + managed relationship |

**Read:** a merchant on OSOSS running blog + sitemap + webhooks + multicurrency + unlimited products + BNPL + 2 carriers is paying meaningful annual add-on cost on top of base. That stack is FWB's clearest pricing argument — but only against merchants who don't need POS, production or B2B pricing.

---

## 8. Where FWB genuinely wins

1. **Merchants who need a beautiful storefront fast** — if §10 confirms OSOSS has no self-serve designer, this is decisive and hard for them to answer.
2. **Merchants who want AI leverage** — insights, reorder, dead-stock, content generation. Uncontested.
3. **Agentic commerce** — the AI Product Feed is a genuine forward moat; OSOSS has nothing pointed at it.
4. **Merchants who want one bill** — no app-by-app upsell.
5. **Security-sensitive merchants** — MFA, audit logs, RLS.

## 8b. Where FWB loses today

Physical retail (no POS) · F&B (no production/BOM/addons/table management/time-window delivery) · B2B wholesale (no price lists or customer groups) · multi-branch retail (no branch dimension or transfers) · manufacturing (nothing) · BNPL-dependent categories (fashion, beauty) · multi-country merchants (no multi-currency checkout, thin geography) · promotion-led merchants (no BOGO or tiered discounts).

---

## 9. Recommended priorities

**Tier 1 — close now (small effort, large deal impact)**

1. **BNPL: Tabby + Tamara** — table stakes in GCC fashion/beauty. `PaymentProvider` is already the right seam.
2. **Knet direct.**
3. **Offline payment methods** — bank transfer, cheque, wallet. Trivial next to the rest.
4. **Coupon depth** — uses-per-customer, customer-group / payment-method / channel targeting.

**Tier 2 — close next (unlocks whole segments)** 5. **Promotions engine** — conditional rules with BOGO and tiered discounts. Biggest commerce gap after POS; merchants ask for BOGO by name. 6. **Price lists + Customer Groups** — unlocks B2B/wholesale, where GCC margin lives. 7. **Bundles + Addons + BOM + Production/JIT** — unblocks the F&B vertical already on the roadmap. Target production, not just BOM. 8. **Delivery time-windows** — cheap, and F&B merchants ask on day one. 9. **Carrier breadth** — Shipa/Armada/Mashkoor/Go Wagon behind the existing `ShippingCarrierConfig` seam. 10. **Dynamic ads catalog feed** — same pipeline as `agent_feed`, different consumer.

**Tier 3 — strategic decisions, not backlog items** 11. **POS.** Largest gap, largest build. Commit to omnichannel or explicitly position online-only and concede physical retail. Do not drift. 12. **Purchasing/accounting depth.** Compete with an ERP or integrate with one. Half an ERP is the worst outcome. 13. **Custom fields (Data Fields).** If FWB goes multi-vertical, hardcoded shapes become the bottleneck. Cheap now, expensive after ten verticals. 14. **Branch dimension.** Prerequisite for multi-location merchants _and_ for POS.

**Do not chase:** the app-marketplace model. It exists because OSOSS sells self-serve and needs scope control plus upsell surface. FWB's all-inclusive bundling is a weapon against a merchant staring at KWD120/yr for "unlimited products". Keep it.

---

## 10. Coverage, limits, and what to verify

### The one that matters most

**Does OSOSS have a self-serve storefront theme/page editor?** §2.13 is FWB's single sharpest differentiator and I could not settle it. `/dashboard/stores` returns _"You need to activate Stores — visit Marketplace"_ — there is a **gated Stores module this merchant never bought**, and a designer plausibly lives inside it. The KWD500 "User Interface Design" service in the marketplace is suggestive but not proof. **Do not put §2.13 in a proposal until this is checked** on an account with Stores activated.

### Unread surfaces

Order Rules create form (wouldn't open, 2 attempts) · Table Management contents (URL not found) · POS terminal internals (`pos2.ososs.com` never entered) · Pickup · Locations sub-pages · Media Management · Purchases module pages (nav-level only) · Accounting module pages (nav-level only) · the 12th Cart Rule condition (list truncated below "Customer Groups") · Notification Center · Templates · Business Profile · Billing & Subscription.

### Open questions

- OSOSS base-plan pricing, to quantify the bundling argument.
- Whether wishlist / comparison exist storefront-side without an admin surface.
- Whether OSOSS ships a native mobile app (`Mobile files` exists, empty, purpose unconfirmed).
- Whether OSOSS has MFA, audit logs, tenant isolation (absence here is _unverified_, not established).
- What else the gated Stores module contains.

### Standing caveat

This account is a single Kuwaiti confectionery merchant in expired-grace. **Any module gated behind a plan or an unpurchased app is invisible in this document.** Given that `Production` and `Table Management` never appeared in a top-level menu, and `Stores` is gated entirely, assume OSOSS's real surface is **larger** than what is recorded here — not smaller.

---

## 11. Appendix — verified FWB inventory (audit 2026-07-21)

Enumerated directly from source, not summarised by an agent. Rev 1–2 of this document took the FWB side from a single subagent report; that report missed `CheckoutDeliverySettings`, `NotificationEventConfig` and `Sequence`, each of which produced a false gap. The counts below are the audit baseline — re-run the commands before trusting this section in a later month.

**Data model — 96 Prisma models, 38 enums.**

**Merchant admin — 89 store-scoped pages** under `apps/admin/src/app/stores/[id]/`, plus 11 platform pages (`audit-logs`, `webhook-events`, `users`, `stores`, `ai-usage`, `account/security`, `account/devices`, …).

**Feature registry — 38 keys**, of which 4 are `hidden: true` (not shippable): `customer_wallet` (no backing model), `email_campaigns` (no campaign builder), `seo` and `search_autocomplete` (platform-level, always on).

### Confirmed present (corrects earlier false gaps)

| Capability                  | Evidence                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| Delivery time-windows       | `CheckoutDeliveryWindow` — bilingual label, store-local `start`/`end`, explicit `orderBy` cutoff |
| Notification centre         | `NotificationConfig`, `NotificationEventConfig` (per-event WhatsApp/SMS/push), `NotificationLog` |
| Document numbering          | `Sequence` — atomic per-store counters, journal/PO/adjustment/expense                            |
| Free-shipping coupons       | `CouponType.free_shipping`                                                                       |
| Per-store feature overrides | `StoreFeature` + `/stores/[id]/features` admin page                                              |

### Confirmed absent (no model, no route, no feature key)

POS · product bundles · services-as-sellable · addons/modifiers · BOM · `Brand` · global attribute system (only variant-scoped `ProductOption`) · units · price lists · selling pricings · customer groups · production/manufacturing orders · table management · stock transfers / redistribution / shortages · expiry-date tracking · vouchers · purchase invoices (only `PurchaseOrder`) · branches as an org dimension · promotions rules engine.

### Confirmed enum limits

- `PaymentProvider` = `tap · myfatoorah · hesabe · upayments · cod` — **no BNPL, no Knet direct**.
- `DiscountType` = `percentage · fixed` — **no BOGO, no tiered**.
- `UserRole` = `customer · staff · store_admin · super_admin`; `StoreStaff` carries **no permission fields** — role-based only, no custom roles.
- `StoreTemplate` = `modern · classic · minimal · bold · elegant`.

### Reproduce this audit

```bash
grep -c '^model ' packages/database/prisma/schema.prisma
find "apps/admin/src/app/stores/[id]" -name page.tsx | wc -l
grep -A14 '^enum PaymentProvider {' packages/database/prisma/schema.prisma
```
