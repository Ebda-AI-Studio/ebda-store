# OSOSS vs FWB — Feature Gap Analysis

_Drafted 2026-07-21. Rev 2 — after a targeted deep crawl of contested pages (rev 1 was nav-level only and got several calls wrong; corrections marked **[REV2]**)._

**Method.** OSOSS side = observed live in `my.ososs.com` (PecannBee merchant account, in expired-grace). Rev 1 walked the navigation tree only. Rev 2 additionally opened the create/edit forms and record detail pages for the ~15 places where _depth_, not _existence_, decides the call. FWB side = code inventory of `force-website-builder` (admin route tree, Prisma schema, `packages/shared/src/features.ts`, `docs/business/plan-feature-matrix.md`).

**Two evidence caveats, both learned the hard way in rev 1:**

1. **An empty list is not an absent feature.** Nearly every list on this account reads "No Data Available" — the merchant simply has little data. Worse, the dashboard tile said _0 Products_ while `/dashboard/products` holds a full catalogue: the tile is date-range scoped. Read forms and record details, never list emptiness.
2. **The nav is not the full surface.** `Production` and `Table Management` appear in the Inventories sidebar but in no top-level menu; I only found them from a product detail page. There are likely more.

Items still unread are listed in §8 rather than guessed at.

> **Addendum — 2026-09-07.** This is a snapshot of FWB's code as of 2026-07-21 (superseded by
> `ososs-vs-fwb-full-comparison-2026-07-21.md`, but still referenced directly — corrected here
> too). Since then, FWB has shipped product bundles: fixed kits of specific products at set
> quantities, sold as one line at one price, with availability derived from the components' own
> stock and atomic (whole-box, not itemized) returns. Feature key `bundles` — an add-on in no plan
> baseline, off by default, enabled per store only via a `StoreFeature` override once sold. The §3
> P1 "Bundles / Services / Addons" row's "Absent" call and the §6 "Bundles + Addons + BOM" roadmap
> item are **out of date** on the bundles half (Services and Addons as separate sellable types are
> still genuinely absent). Left in place below as-is; this addendum carries the correction.

---

## 1. The one-line read

**OSOSS is an ERP with a storefront attached. FWB is a storefront with AI attached.**

OSOSS's centre of gravity is Purchases → Inventory → Production → Accounting → POS, sold as a base account plus a **paid app marketplace** (~60 installable apps, KWD10–600, mostly yearly). FWB's centre of gravity is storefront design, merchandising and AI/AEO, bundled and sold managed-agency.

**[REV2]** Rev 1 framed this as "OSOSS has more modules, FWB has more intelligence." That was too kind to FWB. The deep crawl showed OSOSS's _commerce_ primitives — promotions, coupons, pricing, costing — are also considerably deeper than FWB's, not just its ERP ones. The honest framing: **FWB leads on design surface and AI; OSOSS leads on nearly everything transactional.**

---

## 2. OSOSS modules (observed)

| Top nav         | Sub-modules                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dashboard**   | Configurable widgets, branch filter, date range, sales comparison                                                                                                                                                                                                                                                                                                                                          |
| **Sales**       | Dashboard · Orders · Invoices · **POS** · **Website** (each channel gets Dashboard/Orders/Pending/Canceled/Consolidated Invoices/Refunded) · Customers · Customer Groups · Reports · Settings (A4 Invoice, Sales Invoice Types, Invoicing settings)                                                                                                                                                        |
| **Marketing**   | WhatsApp (Campaigns/Templates/Segments) · Coupons · Cart Rules · Loyalty Rules · VTO Sessions · Abandoned Carts · Order Rules · Apps Notifications · SEO                                                                                                                                                                                                                                                   |
| **Purchases**   | Dashboard · Purchase Orders · Purchase Invoices · Refunded Purchase Invoices · Purchase Cost Adjustments · Recurring Purchase Invoices · Suppliers · Reports · Settings                                                                                                                                                                                                                                    |
| **Inventories** | Dashboard · Catalog (Products, Bundles, Services, Categories, Addons, **BOM**, Selling pricings, Price lists, Brands, Attributes, Units, Taxes) · Operations (Stock Transactions, Transfers, Counting, Shortages, Redistribution, Receive, Settings) · Price Label · Inventories (+ Backorder items, Backorder ingredients) · Branches · **Production** _[REV2]_ · **Table Management** _[REV2]_ · Reports |
| **Accounting**  | Dashboard · Incomes · Expenses · Online PG Transactions · Vouchers · Recurring Vouchers · Journal Entries · Chart of Accounts · Reports · Settings                                                                                                                                                                                                                                                         |
| **Settings**    | Users · Roles & Permissions · Notification Center · Sender ID Management · Templates · Profile · WABA Balance · Business Profile · Billing & Subscription · Marketplace · **Data Fields** · Mobile files · Pickup · Delivery · Payment Methods · Locations · Domains · Media Management · Excel Operations                                                                                                 |

Sales channels are first-class and separately reported: **Store** (`pecannbee.com.kw`) and **POS** (`pos2.ososs.com`).

---

## 3. Gap A — OSOSS has it, FWB does not

### P0 — deal-losing

| #   | Capability                                           | OSOSS (verified)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | FWB today                                                                                                                                                                                                       |
| --- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **POS terminal**                                     | Full sales channel, own subdomain, own order/invoice/refund streams, consolidated invoices                                                                                                                                                                                                                                                                                                                                                                                                                  | **Absent.** `stock/scan` is a receive/pick/count tool, not a till. Disqualifies every merchant with a shop floor                                                                                                |
| 2   | **Promotions engine (Cart Rules)** _[REV2 — was P2]_ | Real IF/THEN engine: enable toggle, start/end datetime, numeric **priority** for precedence, ALL/ANY logic. Conditions: Payment method · Invoice Status · Minimum Order Amount · Products count in order · **Products count in purchase history** · **Order count in purchase history** · Order Status · Categories · Products · **Customer Groups**. Actions: Free Payment Method · Free Order Count · **Buy X Get Cheapest Free (BOGO)** · Discounted Order · Products · Categories · **Tiered Discount** | Flat coupons + per-product discounts. **No conditional logic, no BOGO, no tiered discounts, no purchase-history targeting.** Rev 1 rated this P2 from the menu label alone — that was wrong; it's a large build |
| 3   | **Coupon depth** _[REV2 — was scored parity]_        | Bilingual AR/EN title+description, type, code, date window, discount type, **price type (apply to original vs post-discount price)**, amount, minimum subtotal, **uses per coupon**, **uses per customer**, and targeting by **Currencies · Price zones · Countries · Customers · Customer Groups · Payment methods · Sales Channels**, include-shipping toggle, auto-apply-in-store, active. Manual **and** auto-generated                                                                                 | Materially simpler. Rev 1 called coupons parity because both products have "coupons" — they are not comparable                                                                                                  |
| 4   | **Payment gateway breadth**                          | ~19 incl. **Knet direct, Tabby, Tamara, Deema, PayPal, Cybersource, MPGS, Sadad, Payzah, PayLe, Bookeey, Oneglobal, Taly**                                                                                                                                                                                                                                                                                                                                                                                  | 5: Tap, MyFatoorah, Hesabe, UPayments, COD. **No BNPL at all** — table stakes in GCC fashion/beauty                                                                                                             |
| 5   | **Shipping carrier breadth**                         | ~14 incl. DHL, FedEx, Shipa, Armada, Mashkoor, Go Wagon, V-Deliver, Smooth, Beyond, Allowmena, Muvx                                                                                                                                                                                                                                                                                                                                                                                                         | 2: Aramex, iCarry                                                                                                                                                                                               |
| 6   | **Branches**                                         | First-class org dimension; filters dashboards, stock, reports; per-branch stock rows; per-branch JIT production toggle                                                                                                                                                                                                                                                                                                                                                                                      | Warehouses + StoreLocation exist, but no branch dimension in reporting                                                                                                                                          |
| 7   | **Multi-currency / multi-region pricing**            | Coupons target **Currencies**, **Price zones**, **Countries**; multicurrency add-on KWD50.40/yr                                                                                                                                                                                                                                                                                                                                                                                                             | **Absent** — customer-facing money is KWD only. FWB multi-currency is bookkeeping-only (FX on expenses)                                                                                                         |

### P1 — blocks whole verticals

| #   | Capability                                                                                       | Why it matters                                                                                                                                                                                                           | FWB                                                                                       |
| --- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| 8   | **Production / Manufacturing Orders + JIT** _[REV2 — new]_                                       | Manual **and** just-in-time production orders, per-branch JIT toggle, BOM cost rolled onto the product. Make-to-order bakery/F&B/perfume is exactly the FWB F&B vertical on the roadmap                                  | Absent entirely                                                                           |
| 9   | **Table Management** _[REV2 — new]_                                                              | Restaurant floor/table service                                                                                                                                                                                           | Absent                                                                                    |
| 10  | **BOM + Backorder ingredients**                                                                  | Ingredient-level stock depletion                                                                                                                                                                                         | Absent                                                                                    |
| 11  | **Bundles / Services / Addons** as first-class sellable types                                    | F&B modifiers, service businesses, kits                                                                                                                                                                                  | Absent (only manual cross-sell relations)                                                 |
| 12  | **Price lists + Selling pricings + Customer Groups**                                             | B2B/wholesale tiered pricing. Price lists are **date-boxed** (From/To)                                                                                                                                                   | Absent — FWB has RFM _segments_ (analytical), no manual groups, no group-priced catalogue |
| 13  | **Costing depth** _[REV2 — new]_                                                                 | Per product: unit cost, **lifetime average cost**, **BOM cost**, on-hold qty, **on-the-way qty**, return rate, total profit/growth, **expiry-date tracking**, per-branch stock, configurable alert thresholds            | FWB tracks stock and basic cost; no average/landed costing, no expiry dates               |
| 14  | **Data Fields — custom field engine** _[REV2 — new]_                                             | Custom fields per section (Invoice, Invoice Item, Address, Note) with type, visibility, required, system-vs-custom flags. The Kuwait address model (Block/Street/Avenue/House/Floor/Flat) is _configuration_, not schema | FWB hardcodes address shape. This is an architecture difference, not a feature gap        |
| 15  | **Purchase Invoices, Refunded Purchase Invoices, Cost Adjustments, Recurring Purchase Invoices** | Real landed-cost accounting; FWB stops at the PO                                                                                                                                                                         | PO + Supplier only (Enterprise)                                                           |
| 16  | **Stock Transfers / Redistribution / Shortages**                                                 | Multi-branch daily ops                                                                                                                                                                                                   | Adjustments + counting only                                                               |
| 17  | **Vouchers + Recurring Vouchers**                                                                | Standard accounting entry surface                                                                                                                                                                                        | Journal entries only                                                                      |
| 18  | **Brands / Attributes / Units** as catalogue entities                                            | Storefront filtering + reporting; Units needed for anything sold by weight                                                                                                                                               | Tags only                                                                                 |
| 19  | **Loyalty as a rules engine** _[REV2]_                                                           | Same IF/THEN engine with Earning Trigger + Points amount, priority, date window                                                                                                                                          | FWB loyalty is points + tiers, not conditional                                            |

### P2 — commercially significant

App marketplace (~60 apps, per-app pricing, self-serve install) · Order Rules · Excel Operations (bulk import/export across all entities; FWB bulk CSV is products+stock only) · merchant-facing outbound webhooks · Vendors/consignment (Sales by vendors, Vendor Payment Balance) · Price Label printing + Scalar barcode reader · Consolidated invoices / Sales Invoice Types / A4 templates / Invoice Serialization · centralised Notification Center + Sender ID Management + Templates · custom Roles & Permissions · Live sales monitoring · ERP bridges (Ocean, Midocean, Robosize) · vertical add-ons (Appointments, Consultations, Repair orders, Gold/Silver pricing, Size chart, Gift receipt, Exchange orders, VTO, Perfume composition at POS, SKU generator).

**Of these, don't skip Dynamic Ads Catalog Sync** (Google Merchant / Meta catalog RSS, KWD200.40/yr) — it's how merchants run performance ads, and FWB already has the feed pipeline built for `agent_feed`.

---

## 4. Gap B — FWB has it, OSOSS does not

**[REV2] Rev 1 overstated this list by three items.** The product detail page carries tabs for **Reviews**, **Related products**, **Upsell products** and **Cross sell products** — so reviews and cross-sell/upsell are **parity, not FWB advantages**, and have been removed. What survives:

| #   | Capability                                                                                                                | Position                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Self-serve storefront design** — Page Builder, 5 themes, Smart Palette, typography zones, hero/nav/announcement editors | No theme or page editor anywhere in OSOSS's nav; it sells "User Interface Design" as a **KWD500 one-off service**. Still FWB's sharpest differentiator _(see §8 — worth one more check)_ |
| 2   | **AI insights suite** — RFM, cohorts, funnel, product-level                                                               | No equivalent surface                                                                                                                                                                    |
| 3   | **AI inventory intelligence** — reorder suggestions, dead-stock, profit-anomaly watch                                     | OSOSS has richer _raw_ costing data but no AI layer over it                                                                                                                              |
| 4   | **AI content ops** — bulk translate, SEO/AEO copy, auto-categorisation, FAQ/How-to generation                             | OSOSS sells SEO/sitemap/GA as paid apps; no generation                                                                                                                                   |
| 5   | **Agentic commerce — AI Product Feed** for ChatGPT/Perplexity                                                             | No equivalent. The forward-looking moat                                                                                                                                                  |
| 6   | **Affiliate program** — referrals, payouts, audit trail                                                                   | Not found                                                                                                                                                                                |
| 7   | **Payment-gateway abandonment capture** (distinct from cart abandonment)                                                  | Not found                                                                                                                                                                                |
| 8   | **Bank reconciliation** (CSV/OFX + auto-match)                                                                            | Not found                                                                                                                                                                                |
| 9   | **Wishlist (+ shareable) and product comparison**                                                                         | Not found in admin; **see §8** — may exist storefront-side                                                                                                                               |
| 10  | **PWA storefront + dedicated Orders staff PWA**                                                                           | Not found                                                                                                                                                                                |
| 11  | **MFA, device management, audit logs, RLS tenant isolation**                                                              | No visible equivalent                                                                                                                                                                    |
| 12  | **Bundled-by-default** — blog, sitemap/SEO, webhooks, multi-currency bookkeeping, unlimited products                      | OSOSS charges per item: blog KWD200/yr, sitemap KWD100/yr, webhook KWD200/yr, multicurrency KWD50/yr, **unlimited products KWD120/yr**                                                   |

---

## 5. Parity

Loyalty (mechanism differs — see A19) · Abandoned carts · WhatsApp campaigns/templates/segments · Push & app notifications · Customers · Taxes · Chart of accounts + journal entries · Expenses/incomes · Suppliers · Purchase orders · Stock counting · Backorders · Multi-warehouse · Barcode · Domains · Users + roles · Media management · Pickup/delivery config · Product variants & categories · **Reviews** _[REV2]_ · **Related/upsell/cross-sell products** _[REV2]_ · Auto-generated coupons.

---

## 6. What I'd actually do

**Close, in this order:**

1. **BNPL (Tabby + Tamara) + Knet direct.** Smallest effort, largest deal impact; `PaymentProvider` is already the right seam.
2. **Promotions engine.** _[REV2 — promoted from P2]_ Conditional rules with BOGO and tiered discounts. This is now the biggest _commerce_ gap after POS, and merchants ask for BOGO by name.
3. **Coupon depth.** Uses-per-customer, customer-group / payment-method / channel targeting. Cheap next to #2 and shares the targeting model.
4. **Price lists + Customer Groups.** Unlocks B2B/wholesale, where GCC margin lives.
5. **Bundles + Addons + BOM (+ Production/JIT).** _[REV2]_ Directly unblocks the F&B vertical; note the real target is production, not just BOM.
6. **Carrier breadth** — Shipa/Armada/Mashkoor/Go Wagon behind the existing `ShippingCarrierConfig` seam.
7. **Dynamic ads catalog feed** — same pipeline as `agent_feed`, different consumer.

**Decide, don't drift:**

- **POS** is the largest single gap and the largest single build. Strategy call, not a backlog item: commit to omnichannel or explicitly position online-only and concede physical retail.
- **Purchasing/accounting depth.** Compete with an ERP or integrate with one. Building half an ERP is the worst outcome.
- **Custom fields (Data Fields).** _[REV2]_ If FWB is going multi-vertical, hardcoded address/invoice shapes become the bottleneck. Worth deciding early — it's cheap now, expensive after ten verticals ship.

**Don't chase:** the app-marketplace model. It exists because OSOSS sells self-serve and needs scope control plus upsell surface. FWB sells managed-agency with everything included — that bundling is a weapon against a merchant staring at KWD120/yr for "unlimited products". Keep it.

---

## 7. Where FWB's advantage is thinner than it looks

Worth saying plainly for proposal honesty: strip out design and AI, and FWB is behind OSOSS on most transactional surfaces — promotions, coupons, pricing, costing, production, multi-branch, multi-currency, gateway and carrier breadth. The FWB pitch should lead with **storefront quality + AI/AEO + bundled pricing**, not with breadth. Against an ERP-shaped incumbent, a breadth argument loses.

---

## 8. Still unverified — settle before this goes in a proposal

- **Does OSOSS have a storefront theme/page editor behind a higher plan?** §4.1 is the whole differentiator. Highest-value open item.
- **Order Rules** create form — wouldn't open (2 attempts). Contents unknown.
- **Table Management** — confirmed to exist, contents unread.
- **Excel Operations**, **Delivery**, **Payment Methods**, **Locations**, **Pickup** pages — not opened.
- **POS internals** — never entered `pos2.ososs.com`.
- The 12th Cart Rule condition type (list truncated below "Customer Groups").
- Whether **wishlist / comparison** exist storefront-side without an admin surface.
- Whether OSOSS ships a **native mobile app** (`Settings → Mobile files` exists, was empty, purpose unconfirmed).
- **OSOSS base-plan pricing**, to sit ~60 paid add-ons against an FWB proposal.
- Modules hidden by this account's plan/permissions would read as absent throughout. Given `Production` and `Table Management` were invisible in the top nav, assume more exist.
