# Ebda pricing and packaging research

Researched: 2026-10-03

**Verification caveat (read first):** every first-party pricing page (shopify.com, wuilt.com, zid.sa, youcan.shop, expandcart.com, easyorders) was blocked by the research sandbox's egress proxy (WebFetch returned EGRESS_BLOCKED). All figures below come from WebSearch result summaries and third-party aggregators, so each is tagged with the page it was reported from and should be re-checked on the vendor page before any number reaches a deck. Anything marked **unverified** conflicts between sources or has no source at all.

## Answer

The Egyptian/MENA field splits into three models: (1) flat SaaS tiers gated by team seats, order volume and sales caps (Shopify, YouCan, ExpandCart, Zid), (2) a generous free tier that monetises via higher tiers and payments (Wuilt, Zid Starter, ExpandCart Free), and (3) per-order micro-commission (EasyOrders at about $0.04/order). Mid-tier entry sits around $29-39/month (about EGP 1,500-2,000 at 52.24 EGP/USD) for the cheapest paid plan at Shopify, YouCan, ExpandCart. For a COD-heavy Egyptian market, Ebda's best lever set is: free tier with a branded subdomain and capped orders/products, paid tiers gated by staff seats, custom domain, order volume, automation (WhatsApp, abandoned cart) and a falling transaction fee, plus a no-fee path for COD. Prices are deliberately not recommended here; Ahmad sets them. Amelia Aurum (merchant #1) is on a free, unlimited plan, so the engine needs an admin-granted override plan that bypasses all limits.

## FX rate used

- 1 USD = 52.24 EGP (mid-market, reported 2026-10-03 04:31 UTC; Wise showed 52.31, Revolut 51.94, Egyptian bank range 51.94-52.10; 7-day range 51.76-52.32). Source: [Wise USD/EGP](https://wise.com/gb/currency-converter/usd-to-egp-rate), [XE](https://www.xe.com/en-us/currencyconverter/convert/?Amount=1&From=USD&To=EGP) (as reported via search summary, 2026-10-03).
- SAR to EGP derived via the SAR peg of 3.75 per USD (peg is general knowledge, not fetched): 1 SAR is about 13.93 EGP. Treat as approximate.
- All conversions are rounded to nearest 5 EGP and exclude 14% Egyptian VAT unless stated.

## Decision table

| Decision              | Recommendation                                                            | Why                                                                                  |
| --------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Free tier?            | Yes, capped (subdomain, limited products/orders)                          | Wuilt, Zid Starter, ExpandCart Free, EasyOrders Standard all have one                |
| Primary gating levers | Staff seats, orders/month, custom domain, automation, transaction fee bps | Matches YouCan (users+orders+sales caps) and Shopify (staff+fees)                    |
| Transaction fee model | Platform fee in bps that falls by tier; 0 on COD                          | Shopify charges 2% to 0.2% on third-party gateways; Zid says no extra platform fee   |
| Billing               | Monthly plus annual discount                                              | Shopify gives ~25% off annual; YouCan about 2 months free                            |
| Currency              | EGP-native pricing                                                        | USD-priced competitors (ExpandCart, YouCan, EasyOrders) expose merchants to FX moves |
| Per-order alt         | Consider as optional "pay as you go" plan                                 | EasyOrders $0.04/order is a direct threat for tiny COD sellers                       |
| Merchant #1           | `plan = founding_free`, all limits null/unlimited, set by admin           | Required by Ahmad                                                                    |

## Competitor detail

### Shopify

- Plans (USD, monthly / annual-billed-monthly-equivalent): Basic $39 / $29, Grow $105 / $79, Advanced $399 / $299. Source: [Nudgify](https://www.nudgify.com/how-much-does-shopify-cost/), [CostBench](https://costbench.com/software/ecommerce/shopify/) (search summary, 2026-10-03).
- EGP at 52.24: Basic 2,035 / 1,515; Grow 5,485 / 4,125; Advanced 20,845 / 15,620.
- Regional EGP pricing: **unverified.** Searches found no evidence of Shopify publishing EGP subscription prices; shopify.com/eg/pricing was blocked. Assume USD billing. Source of the absence: [EasyAppsEcom Egypt guide](https://easyappsecom.com/guides/selling-on-shopify-egypt) (not confirmed).
- Fees: card rate on Shopify Payments 2.9%+30c (Basic), 2.7%+30c (Grow), 2.5%+30c (Advanced); third-party gateway surcharge 2% / 1% / 0.6% (Plus 0.2%). Source: [Nudgify](https://www.nudgify.com/how-much-does-shopify-cost/). Shopify Payments availability in Egypt: **unverified** (Egyptian merchants typically use Paymob/Fawry-type gateways, which would trigger the third-party surcharge).
- Limits/bundles (staff accounts, locations, POS Lite, apps ecosystem): **unverified** from this research; standard known tiers scale staff 5/15/15+ but not sourced here.
- Trial: **unverified** (commonly a short trial then promotional $1/month; not confirmed this session).

### Wuilt (Egypt)

- Reported plans (EGP): Forever/free, 3GB storage, 2GB bandwidth; Premium EGP 1,250; Business/next tier EGP 7,500; Ultimate EGP 17,500 (one source) vs "US$ 350 annually" (another). Source: [Wuilt pricing via search](https://wuilt.com/en/pricing), [SpotSaaS](https://www.spotsaas.com/product/wuilt/pricing), [Valley4Techs](https://www.valley4techs.com/2025/04/wuilt-free-store-egypt-launch.html) (2026-10-03).
- **Unverified / conflicting:** sources disagree on billing period (monthly vs annual), the EGP-to-USD labelling (EGP 1,250 is about $24, not "$50"), and whether these are website-builder or store plans. One source says Wuilt gives its top annual package (valued around EGP 40,000) free to every Egyptian merchant. Do not quote any Wuilt price without opening wuilt.com/en/pricing in a browser.
- Free tier: yes ("100% free" store, per Valley4Techs); trial: 7 days free on a Wuilt subdomain (per search summary).
- Included: custom domain and SSL from the Premium tier up (per search summary). Limits on products/staff/orders: **unverified**.
- Payment gateway pass-through: Paymob's public rate is 2.75% + EGP 3 per transaction, no monthly fee. Source: [Paymob](https://paymob.com/en/pricing) (2026-10-03, search summary).

### Zid (Saudi, operates in Egypt)

- SAR/month: Starter free (unlimited products; bank transfer and COD only), Launch/Rise 99, Growth 299 (5 team members, invoices, tax settings, custom CSS), Professional custom (up to 20 team members). Source: [Zid pricing](https://zid.sa/en/pricing/), [Salla vs Zid](https://www.redrock.com.sa/blog/salla-vs-zid-vs-shopify-saudi-arabia/) (search summary, 2026-10-03). Plan names differ between sources (Launch vs Rise).
- EGP approx (at about 13.93): 99 SAR about EGP 1,380; 299 SAR about EGP 4,165. Egypt-specific EGP pricing: **unverified.**
- Fees: Zid states no extra platform transaction fee beyond gateway rates; Zid Pay rates vary by network/plan (Growth shown 1%+1 SAR to 3.3%+1 SAR). Source: [Zid payments](https://zid.sa/en/solutions/payments/). Free plan restricts payments to COD/bank transfer, a relevant precedent for Ebda.
- Trial: **unverified.**

### YouCan (Morocco-based, MENA)

- USD/month (annual): Solopreneur $29 ($290), Starter $49 ($490), Entrepreneur $89 ($890), Premium $187 ($1,870). Source: [YouCan pricing](https://youcan.shop/en/pricing) (search summary, 2026-10-03).
- EGP monthly: 1,515 / 2,560 / 4,650 / 9,770.
- Limits: monthly sales cap $50K / $100K / $300K / unlimited; orders 3,500 / 7,000 / 21,000 / unlimited; users 1 / 3 / 6 / 19. Same source.
- Offers a commission-on-sales alternative to subscription (rate **unverified**). Trial and bundles (domain, apps, WhatsApp, POS): **unverified**.

### ExpandCart (Egypt-founded)

- USD/month: Professional $29, Ultimate $89, Enterprise $299; plus a limited Free plan. Source: [SaaSworthy](https://www.saasworthy.com/product/expandcart/pricing), [ExpandCart pricing](https://expandcart.com/en/pricing-2/) (search summary, 2026-10-03).
- EGP: 1,515 / 4,650 / 15,620. Native EGP price list: **unverified** (results show USD only).
- Limits, fees, bundles, trial: **unverified.**

### EasyOrders (Egypt, COD-focused)

- Standard: free to start, about $0.04 per order, unlimited products/orders/visits. Professional: $100/month, zero commission, unlimited everything, 24/7 support. Source: [EasyOrder pricing](https://www.easyorderapp.com/en/pricing), [Easyorders.ai](https://www.easyorders.ai/en/) (search summary, 2026-10-03).
- EGP: $100 about EGP 5,225/month; $0.04 about EGP 2.1 per order.
- Several unrelated domains use the EasyOrders name (easyorders.eg, easyorderapp.com, easy-orders.net); confirm which is the Egyptian builder before benchmarking. **Unverified.**
- Other notable: sellX ([sell1x.com](https://sell1x.com/en)) markets "0% commission" in Egypt; pricing **unverified**.

## Comparison matrix (what is known)

| Platform   | Free tier             | Cheapest paid (USD or local)  | Approx EGP    | Seat limits    | Fee model                         |
| ---------- | --------------------- | ----------------------------- | ------------- | -------------- | --------------------------------- |
| Shopify    | No (trial unverified) | $39 monthly / $29 annual      | 2,035 / 1,515 | unverified     | 2% third-party surcharge on Basic |
| Wuilt      | Yes                   | EGP 1,250 (period unverified) | 1,250         | unverified     | gateway only (Paymob 2.75%+3)     |
| Zid        | Yes (COD/bank only)   | 99 SAR                        | ~1,380        | 5 on Growth    | no platform fee, gateway rates    |
| YouCan     | No (unverified)       | $29                           | 1,515         | 1 / 3 / 6 / 19 | subscription or commission        |
| ExpandCart | Yes (limited)         | $29                           | 1,515         | unverified     | unverified                        |
| EasyOrders | Yes                   | $0.04/order or $100/mo        | 2.1/order     | unverified     | per-order                         |

## Recommended Ebda plan structure (levers only, no prices)

Engine fields on a `Plan` record, with suggested ranges. Ranges are starting hypotheses drawn from the competitor limits above (YouCan order caps 3.5K-21K, seats 1-19; Zid 5-20 seats; Shopify fee 2%-0.2%), not market-validated.

| Field                             | Type                    | Free                  | Mid tier(s)     | Top tier         | Notes                                                     |
| --------------------------------- | ----------------------- | --------------------- | --------------- | ---------------- | --------------------------------------------------------- |
| `key` / `nameAr` / `nameEn`       | string                  |                       |                 |                  |                                                           |
| `maxProducts`                     | int or null             | 25-100                | 500-5,000       | null (unlimited) | Zid/EasyOrders free = unlimited; consider not gating hard |
| `maxOrdersPerMonth`               | int or null             | 50-200                | 1,000-7,000     | 20,000+ or null  | YouCan model; soft limit with upgrade nudge               |
| `staffSeats`                      | int                     | 1                     | 2-6             | 10-20            | Zid/YouCan benchmarks                                     |
| `maxStores`                       | int                     | 1                     | 1-2             | 3-5              |                                                           |
| `customDomain`                    | bool                    | false                 | true            | true             | Wuilt/Zid gate domain above free                          |
| `removeEbdaBranding`              | bool                    | false                 | true            | true             |                                                           |
| `transactionFeeBps`               | int                     | 100-200 (online only) | 50-100          | 0-50             | 0 on COD recommended; Shopify 200 to 20 bps shape         |
| `codEnabled`                      | bool                    | true                  | true            | true             | Zid free allows COD; core to Egypt                        |
| `paymentGateways`                 | enum[]                  | COD + 1 wallet        | all             | all              | Paymob/Fawry etc.                                         |
| `shippingIntegrations`            | int or enum[]           | 1                     | all             | all              | Bosta/Aramex etc. (carrier set unverified)                |
| `whatsappTier`                    | enum: link, api_metered | link (wa.me)          | link or add-on  | api_metered      | see WhatsApp brief                                        |
| `whatsappMonthlyMessageAllowance` | int                     | 0                     | add-on          | add-on           | cost pass-through                                         |
| `abandonedCartRecovery`           | bool                    | false                 | true            | true             |                                                           |
| `posEnabled`                      | bool                    | false                 | optional        | true             |                                                           |
| `themesAccess`                    | enum: basic/all         | basic                 | all             | all+custom code  |                                                           |
| `appsInstallLimit`                | int                     | 0-3                   | 10              | null             |                                                           |
| `apiAccess` / `webhooks`          | bool                    | false                 | false/true      | true             |                                                           |
| `analyticsLevel`                  | enum                    | basic                 | standard        | advanced         |                                                           |
| `supportLevel`                    | enum                    | community             | email/chat      | priority         |                                                           |
| `trialDays`                       | int                     | n/a                   | 7-14            | 7-14             | Wuilt: 7 days                                             |
| `billingPeriods`                  | enum[]                  | n/a                   | monthly, annual | monthly, annual  | annual discount range 15-25% (Shopify about 25%)          |
| `isAdminGranted`                  | bool                    | false                 | false           | false            | true only for `founding_free`                             |
| `overrides` (jsonb)               | per-merchant            |                       |                 |                  | allows limit exceptions without new plans                 |

Suggested tiers: Free (Starter), 1-2 paid mid tiers (Growth, Pro), one high-volume tier (Scale) with custom quote option; plus the hidden `founding_free` plan (all limits null, `transactionFeeBps = 0`, `isAdminGranted = true`) for Amelia Aurum. Enforcement should be a central `getEntitlements(merchant)` that resolves plan then per-merchant overrides, so merchant #1 never hits a limit and can later be migrated.

Design cautions:

- Gate on things merchants feel as growth (orders, seats, domain, automation), not on products alone; competitors with unlimited free products attract the same COD-heavy sellers.
- Soft-limit on orders (warn, grace, then block checkout only as last resort) because blocking COD orders directly costs the merchant revenue.
- Keep WhatsApp metered separately from plan fee because Meta cost is per message (see the WhatsApp brief).
- Show EGP prices inclusive/exclusive of 14% VAT explicitly (Wuilt notes VAT on cash payments).

## Open questions for Ahmad

1. Should Free allow online payments (with a fee) or be COD-only like Zid's Starter?
2. Per-order micro-fee option (EasyOrders-style) in addition to subscription, or subscription only?
3. Is the order cap soft (nudge) or hard (block)?
4. Annual discount: size and whether to launch with annual billing at all?
5. Do we bill in EGP only, and who handles 14% VAT invoicing (e-invoice requirement is **unverified**)?
6. Which payment gateways and carriers ship at launch (gates `paymentGateways` and `shippingIntegrations`)?
7. Does Amelia Aurum's free plan carry an expiry/review date, and does it include the future WhatsApp tier (cost to us)?
8. Someone with browser access should re-open the six competitor pricing pages to replace every figure marked from "search summary" and resolve all **unverified** items.

## Sources (all accessed 2026-10-03 via search summaries; first-party pages blocked)

- [Shopify cost 2026, Nudgify](https://www.nudgify.com/how-much-does-shopify-cost/)
- [Shopify pricing, CostBench](https://costbench.com/software/ecommerce/shopify/)
- [Selling on Shopify in Egypt](https://easyappsecom.com/guides/selling-on-shopify-egypt)
- [Wuilt pricing](https://wuilt.com/en/pricing)
- [Wuilt pricing, SpotSaaS](https://www.spotsaas.com/product/wuilt/pricing)
- [Wuilt free store launch](https://www.valley4techs.com/2025/04/wuilt-free-store-egypt-launch.html)
- [Paymob pricing](https://paymob.com/en/pricing)
- [Zid pricing](https://zid.sa/en/pricing/)
- [Zid payments](https://zid.sa/en/solutions/payments/)
- [Salla vs Zid vs Shopify](https://www.redrock.com.sa/blog/salla-vs-zid-vs-shopify-saudi-arabia/)
- [YouCan pricing](https://youcan.shop/en/pricing)
- [ExpandCart pricing](https://expandcart.com/en/pricing-2/)
- [ExpandCart, SaaSworthy](https://www.saasworthy.com/product/expandcart/pricing)
- [EasyOrder pricing](https://www.easyorderapp.com/en/pricing)
- [EasyOrders.ai](https://www.easyorders.ai/en/)
- [sellX](https://sell1x.com/en)
- [Wise USD/EGP](https://wise.com/gb/currency-converter/usd-to-egp-rate)
- [XE USD/EGP](https://www.xe.com/en-us/currencyconverter/convert/?Amount=1&From=USD&To=EGP)

## Owner decision, 2026-10-05

The draft tiers above are superseded by `docs/plans/done/2026-10-05-pricing-decisions.md`: Basic/Growth/Business, no public free plan, zero platform fees. Amelia stays last.
