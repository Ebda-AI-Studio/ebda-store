# Force Store — Pricing Tier Structure

**Internal document. Last updated: 2026-05-22. Owner: Ahmad Sharaf / Force AI.**

Use this to wire the billing flow, configure `StorePlan` enforcement in the API, and run sales conversations. All prices are final — do not hedge with "around" in any customer-facing copy.

---

## 1. Pricing Philosophy

Kuwait SMB merchants are acutely price-sensitive. The typical decision-maker compares Force Store against Salla (~$80–320/mo) or Shopify ($39–399/mo + 2% transaction fee) and defaults to the cheaper option unless the value differential is obvious within the first demo. The freemium tier exists not as a revenue driver but as a trust and onboarding instrument: let the merchant log in, see the AI-assisted catalogue fill, and feel the Arabic-first admin before they're asked to pay anything. The conversion event is the moment a merchant connects a payment provider or attaches a custom domain — both are Starter gates. Free is for exploring; Starter is for selling.

Charge structure follows a single axis: subscription per merchant per month. FWB does not take a cut of GMV. Payment processing fees (2–3.5% for KNET/cards) are borne by the merchant directly with their chosen provider (Tap, MyFatoorah, Hesabe, UPayments). This is not a concession — it is the correct model at launch. Taking a GMV cut requires financial licensing in Kuwait (CBK regulations), increases merchant friction at checkout, and competes with payment processors who can bundle their own SaaS tools. Subscription-only keeps Force AI in a clean software company category. If a transaction fee is introduced later, it must go through legal review first and only applies to the Enterprise tier as a custom negotiation.

Add-ons exist for capabilities that some merchants need and others don't, where bundling would inflate the headline price for the majority. The rule: if fewer than 40% of active merchants would use a feature, it belongs as an add-on rather than tier-included. Tier limits (product counts, staff seats, API calls) are set conservatively — the goal is to create natural upsell pressure as merchants grow, not to artificially block functionality on day one.

---

## 2. The Four Tiers

### Free — 0 KWD / $0/mo

**Target:** First-time merchants, hobbyists, pre-launch testing. Not a revenue source — a conversion funnel entry point.

**Rationale:** Free tier costs Force AI approximately $1.71/merchant/month in infrastructure at 100-merchant scale (cost audit: §6, $171/mo ÷ 100). At zero revenue per free merchant, the platform absorbs that cost. This is acceptable only if free-to-paid conversion is measurable and the tier has hard limits that push growing merchants to Starter quickly.

| Limit             | Value                                                  |
| ----------------- | ------------------------------------------------------ |
| Products          | 20                                                     |
| Monthly orders    | 50                                                     |
| Staff accounts    | 1 (owner only)                                         |
| Custom domain     | No (forcestores.com subdomain)                         |
| Payment providers | No (browsing/demo only — cannot process live payments) |
| Storage (R2)      | 200 MB                                                 |
| AI requests/day   | 10 (global cap slice)                                  |

**Anti-abuse:** Free stores with zero orders for 60 days are marked dormant and suspended after a 7-day warning email. Dormant stores are not deleted — merchant can reactivate by upgrading to Starter. This prevents Free from becoming a permanent parked-store tier that inflates infrastructure cost with no conversion.

---

### Starter — 15 KWD / $49/mo

**Target:** Merchants doing real sales. Home businesses, small boutiques, single-category stores. The majority tier by count at launch.

**Why $49 not $29:** The cost audit shows $1.71/merchant at 10k MAU. A 3× loaded cost target sets the floor at $5.13. The $29 price point (Shopify Basic equivalent) works at margin only if 100% of merchants are Starter — the moment Professional and Enterprise merchants consume disproportionate infra (bulk AI sweeps, high-volume Inngest steps, large R2 buckets), Starter must cross-subsidize. Setting $49 keeps a 28× gross margin at current scale, creates room for infra growth, and is still below Shopify's $79/mo (Basic with transaction fees factored in).

**Why KWD 15 not KWD 13:** Kuwait psychological anchoring. KWD 15 is a round, memorable monthly expense. KWD 13 suggests discount framing that undercuts brand positioning. The USD equivalent ($49) works globally.

| Limit             | Value                                   |
| ----------------- | --------------------------------------- |
| Products          | 500                                     |
| Monthly orders    | Unlimited                               |
| Staff accounts    | 1 (owner only)                          |
| Custom domain     | 1 included                              |
| Payment providers | All 4 (Tap/MyFatoorah/Hesabe/UPayments) |
| Storage (R2)      | 2 GB                                    |
| AI requests/day   | 100                                     |
| Theme             | All 5 themes                            |

---

### Professional — 35 KWD / $115/mo

**Target:** Established merchants with real order volume, multi-category catalogues, team operations, and active marketing. The revenue-maximizing tier.

**Why $115:** The cost audit at 10k MAU supports a $15–30 price point at 3–4× loaded cost. Professional merchants are heavier infrastructure users — more AI sweeps, more Inngest steps, larger R2 footprints, more push notification subscribers. A $115/mo price point is $49 above Starter, justified by the addon features unlocked (WhatsApp, loyalty, affiliate, push notifications) and the staff account expansion. Competitors: Shopify Advanced ($299/mo) is 2.6× more; Salla Pro (~$130/mo) is comparable. FWB undercuts Salla Pro while offering native KNET and built-in AI that Salla doesn't have. This is the lead argument in every sales conversation.

| Limit             | Value                                   |
| ----------------- | --------------------------------------- |
| Products          | 5,000                                   |
| Monthly orders    | Unlimited                               |
| Staff accounts    | 5 (when `staff_accounts` feature ships) |
| Custom domain     | 1 included + 1 additional for KWD 3/mo  |
| Payment providers | All 4                                   |
| Storage (R2)      | 20 GB                                   |
| AI requests/day   | 500                                     |
| Theme             | All 5 themes                            |

---

### Enterprise — 99 KWD / $325/mo (or custom)

**Target:** High-volume merchants, B2B, agencies running multiple storefronts under one account, merchants requiring SLA, white-label, or custom integrations.

**Why $325:** The cost audit at 100k MAU shows $1.10/merchant at 1,000 merchants. Enterprise merchants are outliers — a single Enterprise tenant could be running 10,000 orders/month and 5,000 products, consuming infra equivalent to 20 Starter merchants. $325/mo provides ~295× gross margin on infra cost at scale, funds dedicated support overhead, and is still 54% cheaper than Shopify Plus ($2,300/mo base). Shopify Plus is the benchmark any Enterprise prospect will cite — $325/mo is a category-breaking price for what's included.

The KWD 99 price is the ceiling for self-serve. Merchants who need custom GMV processing volume, dedicated Railway instances, white-label reseller rights, or SLA >99.5% should be moved to a negotiated contract (custom pricing, handled by Force Media agency relationship).

| Limit             | Value                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| Products          | Unlimited                                                                                                        |
| Monthly orders    | Unlimited                                                                                                        |
| Staff accounts    | Unlimited (when `staff_accounts` feature ships)                                                                  |
| Custom domain     | 3 included                                                                                                       |
| Payment providers | All 4 + custom provider integration on request                                                                   |
| Storage (R2)      | 100 GB                                                                                                           |
| AI requests/day   | 2,000 (platform-capped at 1,000 currently — increase requires `AI_DAILY_REQUEST_CAP` bump per Enterprise tenant) |
| Theme             | All 5 + priority access to new themes                                                                            |
| SLA               | 99.5% uptime (requires Railway Pro + multi-replica — verify infra headroom before selling this)                  |

---

## 3. Per-Tier Feature Matrix

All 22 `FEATURE_REGISTRY` entries mapped to unlock tier. "Starter+" means the feature is available from Starter and above.

| Feature Key           | Name                    | Registry Tier | Billing Tier Unlock        | Rationale                                                                                                                                                                                                                                                                                      |
| --------------------- | ----------------------- | ------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `coupons`             | Coupons                 | core          | **Starter+**               | Core conversion tool. Every selling merchant needs discount codes. Withholding from Free is the right lever — you can't sell without connecting a payment provider anyway.                                                                                                                     |
| `returns`             | Returns & Refunds       | core          | **Starter+**               | Operational necessity for any merchant processing real orders. Not meaningful on Free (no live orders).                                                                                                                                                                                        |
| `reviews`             | Product Reviews         | core          | **Starter+**               | Social proof is a selling feature. Free merchants can enable it but can't accept payments, so reviews without transactions are low-value — still allow it at Starter as trust-building.                                                                                                        |
| `inventory`           | Inventory Management    | core          | **Starter+**               | Needed by any merchant with physical goods. Low infra cost — single platform feature. No reason to restrict higher.                                                                                                                                                                            |
| `tax`                 | Tax Management          | core          | **Starter+**               | Compliance feature. 5% VAT is a GCC merchant concern even at small volumes. Do not gate compliance features above Starter.                                                                                                                                                                     |
| `bulk_operations`     | Bulk Operations         | core          | **Professional+**          | Not a day-1 need for small catalogs. Meaningful once a merchant has 100+ products. Also: bulk ops are Inngest-heavy (50K steps consumed quickly). Gate at Professional to protect free-tier Inngest quota.                                                                                     |
| `abandoned_cart`      | Abandoned Cart Recovery | core          | **Starter+**               | High-ROI feature for any merchant. Technically Inngest-backed but at low step count (one event per cart). Genuine starter-tier value prop — differentiate from Salla on day one.                                                                                                               |
| `marketing_pixels`    | Marketing Pixels        | core          | **Starter+**               | Meta/Google/TikTok pixels are standard for any merchant running ads. Gating higher would frustrate merchants who are actively spending on advertising. Consent-gate is enforced platform-wide regardless.                                                                                      |
| `shipping_carriers`   | Shipping Carriers       | core          | **Starter+**               | Operational necessity for physical goods merchants. Low platform cost — API call per carrier rate lookup.                                                                                                                                                                                      |
| `pwa`                 | Progressive Web App     | core          | **Starter+**               | Differentiator vs Shopify. PWA is a one-click toggle — minimal infra cost. Bundling it from Starter strengthens the value narrative.                                                                                                                                                           |
| `seo`                 | SEO Tools               | core          | **Free+** (platform-level) | Platform-level — every store emits SEO metadata regardless. Hidden in feature registry (`hidden: true`). Do not gate — it's not a per-store toggle.                                                                                                                                            |
| `search_autocomplete` | Search Autocomplete     | core          | **Free+** (platform-level) | Same as SEO — platform-wide, hidden, no billing gate.                                                                                                                                                                                                                                          |
| `upsell_crosssell`    | Upsell & Cross-sell     | addon         | **Professional+**          | AOV-boosting feature. Merchants who need this have enough catalogue depth and order volume to justify Professional. At Starter, most merchants have 20–100 SKUs where upsell logic is trivial.                                                                                                 |
| `loyalty`             | Loyalty Program         | addon         | **Professional+**          | Loyalty programs are operationally complex (points accrual, redemption, expiry logic). Merchants with loyalty programs are repeat-purchase businesses — those tend to be Professional-tier volumes.                                                                                            |
| `whatsapp`            | WhatsApp Notifications  | addon         | **Professional+**          | Requires merchant to own a WABA (Meta approval) + WBS bridge connection. Complexity and value are Professional-tier. The WBS bridge itself is a separate Force AI product — the integration is a premium differentiator.                                                                       |
| `push_notifications`  | Push Notifications      | addon         | **Professional+**          | OneSignal growth plan required at scale. Platform cost is non-trivial at >10K subscribers. Gate at Professional to ensure only merchants with real subscriber bases use it.                                                                                                                    |
| `sms`                 | SMS Notifications       | addon         | **Professional+**          | SMS provider costs are per-message (not free tier). Without a bundled SMS quota, this gate is enforced to ensure merchants understand they're paying for sends. Add-on pricing for SMS volume applies separately.                                                                              |
| `affiliate`           | Affiliate Program       | addon         | **Professional+**          | Affiliate infrastructure (referral tracking, commission payouts) is meaningful only for merchants with existing marketing relationships and volume. Starter merchants rarely have affiliate networks.                                                                                          |
| `floating_widget`     | Floating Widget         | addon         | **Starter+**               | Lower bar than other addons. The widget is a lightweight storefront feature (CSS + JS), near-zero infra cost, and provides high perceived value (WhatsApp button, contact channels). Differentiates Force Store at the Starter level — this is a visual feature Shopify doesn't have built-in. |
| `customer_wallet`     | Customer Wallet         | experimental  | **Not yet available**      | No backing model/service/UI. Ship when ready; wire to Professional+ tier at that time.                                                                                                                                                                                                         |
| `email_campaigns`     | Email Campaigns         | experimental  | **Not yet available**      | No campaign builder. When shipped, wire to Professional+ (Resend volume implications).                                                                                                                                                                                                         |
| `staff_accounts`      | Staff Accounts          | experimental  | **Not yet available**      | No team membership model. When shipped: Starter gets 1 (owner only), Professional gets 5, Enterprise gets unlimited.                                                                                                                                                                           |

---

## 4. Add-On Pricing

Features that don't fit cleanly into a tier, or where per-merchant usage variance is high enough that bundling is unfair:

| Add-On                                               | Price                     | Notes                                                                                                                                                                                                                                                       |
| ---------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extra custom domain                                  | KWD 3 / $10 per domain/mo | First domain included in Starter+. Professional includes 1 extra. Enterprise includes 3 total. Beyond included count, each additional domain billed monthly.                                                                                                |
| AI quota boost (+500 req/day)                        | KWD 5 / $16/mo            | Adds 500 AI requests/day on top of tier allocation. Stackable. Primarily for merchants running frequent bulk catalogue sweeps. Maximum 2 boosts per Starter, unlimited per Professional+.                                                                   |
| WhatsApp Notifications (if on Starter)               | KWD 8 / $26/mo add-on     | Allows Starter merchants to unlock `whatsapp` feature without upgrading to Professional. Priced to make Professional the more economical choice at scale (Professional = Starter $49 + $26 add-on = $75 vs Professional $115 which includes 5 more addons). |
| SMS volume pack (1,000 messages)                     | KWD 4 / $13/mo            | Covers ~1,000 SMS sends. Usage-based above pack. Charged when `sms` feature is enabled. Exact per-SMS rate depends on provider (typically $0.005–0.015/message in GCC).                                                                                     |
| Dedicated support (business hours, 4hr response)     | KWD 15 / $49/mo           | SLA-backed support ticket priority. Enterprise includes it. Professional and Starter can add it. Manual onboarding session (2hr) included on first month.                                                                                                   |
| White-label storefront (remove Force AI attribution) | KWD 20 / $65/mo           | Removes "Powered by Force Store" footer mark. Available to Professional+ only. Enterprise includes it by default.                                                                                                                                           |
| Extra R2 storage (per 10 GB)                         | KWD 2 / $6.50/mo          | Only relevant for media-heavy merchants (food, fashion with many variants). R2 cost to platform at this volume is ~$0.15/GB — 43× margin.                                                                                                                   |

---

## 5. Per-Transaction Fees

**Recommendation: zero platform transaction fees at launch and for the foreseeable future.**

Payment processing fees are borne entirely by the merchant through their own gateway credentials (Tap, MyFatoorah, Hesabe, UPayments). FWB passes through the payment flow — it does not sit in the money path, does not process funds, and does not hold merchant balances. This is the existing per-store credential architecture and it is the correct long-term shape.

Reasons to maintain this position:

1. **CBK licensing risk.** Taking a cut of payment flows in Kuwait requires Central Bank of Kuwait payment institution licensing (Law No. 20 of 2014 on Electronic Transactions, Payment Services Regulations 2019). Without it, a GMV fee is legally a payment service — regulatory exposure that $0.50/order cannot justify at current scale.
2. **Merchant friction.** Any platform fee reduces merchant margin on every sale. In a price-sensitive Kuwait market where the competing argument against Shopify is "no transaction fees," introducing one undercuts the primary sales pitch.
3. **Already handled.** The payment provider takes 2–3.5% directly. Merchants know this cost going in. FWB's job is to be the SaaS layer on top, not a payments layer underneath.

If GMV-based revenue is pursued in the future (post-scale, post-licensing): the right vehicle is an Enterprise add-on negotiated contract at <0.5% of GMV, with the merchant's processing fees reduced in exchange (requires a gateway volume deal). Do not retrofit GMV fees onto Starter/Professional — it will drive churn to Shopify.

---

## 6. Comparison to Local Competitors

KWD / USD conversion used: 1 KWD ≈ $3.25 USD (May 2026 rate).

| Tier                    | Force Store       | Shopify equivalent                             | Salla equivalent                        | Zid equivalent                |
| ----------------------- | ----------------- | ---------------------------------------------- | --------------------------------------- | ----------------------------- |
| Entry/launch            | KWD 0 / $0        | $0 (trial 3 days only, then $39)               | Free plan (Saudi, KNET absent)          | Free (Saudi, no Kuwait stack) |
| Starter / Basic         | **KWD 15 / $49**  | $39/mo + 2% transaction fee = ~$58+ at $1k GMV | ~$27/mo (SAR 99) — Saudi-first, no KNET | ~$22/mo (SAR 79)              |
| Professional / Advanced | **KWD 35 / $115** | $299/mo Advanced (no KNET, English-first)      | ~$130/mo (SAR 479 Pro) — no built-in AI | ~$82/mo (SAR 299)             |
| Enterprise              | **KWD 99 / $325** | Shopify Plus $2,300/mo                         | N/A                                     | N/A                           |

**Key differentiators that justify equal or higher price vs Salla/Zid:**

- KNET integration is native (Salla and Zid are Saudi-first; KNET requires contractual Kuwaiti bank relationships they haven't done).
- AI translation/SEO/AEO built-in at every tier vs not available on either competitor.
- Full Chart-of-Accounts Finance hub (neither competitor has this).
- Per-section typography and theme flag customization granularity not available on either.

**Against Shopify:** Force Store at Professional ($115) is 62% cheaper than Shopify Advanced ($299) for a Kuwait merchant who also pays Shopify $20/mo for Arabic translation (Translate & Adapt app) and $0 for KNET (not available via Shopify at all). Effective Shopify cost for an equivalent-feature Kuwait store: $319/mo + transaction fees. Force Store Professional: $115/mo, no transaction fees, KNET native. This is the anchor comparison to use in all sales presentations.

---

## 7. Annual Billing Discount

**Recommend 17% discount (2 months free) for annual prepay.**

- Monthly Starter: $49/mo → $588/yr. Annual: $490/yr ($40.83/mo effective).
- Monthly Professional: $115/mo → $1,380/yr. Annual: $1,150/yr ($95.83/mo effective).
- Monthly Enterprise: $325/mo → $3,900/yr. Annual: $3,250/yr ($270.83/mo effective).

**Why 17% and not 20%:** 20% (2.4 months free) is the Shopify rate — matching or beating it is unnecessary. 17% is psychologically equivalent to "2 months free" which is the way to present it in copy. The cash flow benefit of 12-month prepay is significant: a 1,000-merchant platform at 30% annual-billing adoption collects ~$345K upfront vs ~$41K/mo drip. That upfront cash covers the Railway Pro upgrade, Inngest Pro, and Resend Pro in a single stroke.

**Anti-churn logic:** Annual billing reduces monthly churn from ~3–5% (typical SMB SaaS) to ~1–2% (annual-committed). For a 100-merchant base, that's the difference between replacing 3–5 merchants/month (high CAC drain) vs 1–2. The 17% discount pays for itself in reduced acquisition cost within 2 months of retained merchant.

**KWD annual prices:**

- Starter: KWD 150/yr (vs KWD 180 monthly total — KWD 30 savings)
- Professional: KWD 350/yr (vs KWD 420 monthly total — KWD 70 savings)
- Enterprise: KWD 990/yr (vs KWD 1,188 monthly total — KWD 198 savings)

---

## 8. Free Trial and Money-Back Guarantee

**Free trial: 14 days of Professional, no credit card required.**

When a merchant signs up (once self-serve signup ships), they get 14 days at Professional tier — all addon features unlocked, full catalogue limits, WhatsApp + loyalty + push_notifications enabled. After 14 days, the store downgrades to Free unless a paid plan is selected.

**Why Professional trial not Starter:** The conversion argument is the addon features. A merchant who uses WhatsApp order notifications for 14 days and sees it drive repeat purchases will pay $115/mo to keep it. A merchant who only sees Starter features for 14 days is evaluating a $49 product. Trial the most compelling version.

**Money-back guarantee: 7 days from first paid charge.**

Not 30 days — Kuwait SMB merchants decide quickly. A 7-day window is enough to resolve genuine "this doesn't work for me" cases. 30 days creates a refund abuse vector (use the full month, cancel day 29). The guarantee applies to the first monthly payment only, once per account.

**Anti-abuse logic:**

- Free trial limited to 1 per verified phone number (OTP verification required at signup).
- Money-back guarantee requires at least 1 test order to have been placed (verifies the merchant actually tried the platform).
- Stores with >50 products created during trial and then refunded are flagged for manual review (content extraction abuse).
- Free tier stores inactive for 60 days are suspended after 7-day warning. Data retained for 90 days after suspension; merchant can reactivate by upgrading.

---

## 9. Migration Discount

**30% off the first 3 months for merchants migrating from Shopify, Wix, or Salla.**

Offer: on any Starter or Professional plan, first 3 months at 30% off. No annual commitment required. After month 3, billing reverts to standard pricing.

- Starter migration price: $34.30/mo for 3 months (vs $49 standard).
- Professional migration price: $80.50/mo for 3 months (vs $115 standard).

**Eligibility verification:** merchant provides a screenshot or URL of their active Shopify/Wix/Salla store at signup. Manual verification by Force Media — takes <24hr. No automated URL scraping needed at current scale.

**Why this discount is worth it:**

- Customer Acquisition Cost (CAC) for inbound self-serve SaaS is typically 3–6× ARPU. At $49/mo ARPU, that's $147–294 acceptable CAC per merchant.
- 3 months × 30% off = $14.70 in forgone revenue per Starter merchant. Trivially below CAC threshold.
- The switch friction cost (data migration, domain transfer, re-learning admin) is the real barrier. Reducing the financial barrier by 30% for 90 days makes the decision feel lower-risk. The XLSX bulk import (with Arabic header normalization) is the technical migration story; this discount is the financial migration story.

**Complementary offer:** Free 1-hour onboarding session for migration merchants (Force Media team). Not scalable at 1,000+ merchants but appropriate for the agency-led phase.

---

## 10. Revenue Projections

Infrastructure cost baseline from audit: $171/mo at 10k MAU (100 merchants), $1,100/mo at 100k MAU (1,000 merchants).

Assumptions:

- Tier mix: 60% Starter, 30% Professional, 10% Enterprise (conservative; professional mix increases as platform matures)
- Annual billing adoption: 25% of merchants
- Average plan price accounting for tier mix and annual discount:
  - Weighted monthly price (monthly billing): 0.6 × $49 + 0.3 × $115 + 0.1 × $325 = $29.40 + $34.50 + $32.50 = **$96.40 blended ARPU**
  - With 25% annual (17% off) factored in: ~$92/mo blended ARPU

### At 100 merchants (near-term target)

| Metric                                 | Value                                                         |
| -------------------------------------- | ------------------------------------------------------------- |
| Monthly Recurring Revenue (MRR)        | 100 × $92 = **$9,200/mo**                                     |
| Annual Recurring Revenue (ARR)         | **$110,400/yr**                                               |
| Infrastructure cost                    | ~$200/mo (transitional — Vercel Pro, Railway Pro, Resend Pro) |
| Gross margin                           | ($9,200 - $200) / $9,200 = **97.8%**                          |
| Net margin (post Force Media overhead) | ~60–70% depending on support headcount                        |

### At 1,000 merchants (12-month target)

| Metric              | Value                                                                                                     |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| MRR                 | 1,000 × $92 = **$92,000/mo**                                                                              |
| ARR                 | **$1,104,000/yr**                                                                                         |
| Infrastructure cost | ~$1,100/mo (100k MAU cost floor from audit)                                                               |
| Gross margin        | ($92,000 - $1,100) / $92,000 = **98.8%**                                                                  |
| Scale note          | At 1,000 merchants, Resend explodes to $515/mo. Add-back: ~$1,700/mo infra = 98.2% GM. Still exceptional. |

### At 10,000 merchants (3-year target)

| Metric                            | Value                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| MRR                               | 10,000 × $92 = **$920,000/mo**                                                                                                       |
| ARR                               | **$11,040,000/yr**                                                                                                                   |
| Infrastructure cost               | Estimated ~$11,000/mo at this scale (Resend requires volume deal or per-merchant SMTP handoff)                                       |
| Gross margin                      | **98.8%** (assuming Resend cost is shifted to merchants at this scale)                                                               |
| Critical action before this scale | Per-merchant SMTP architecture (merchants pay Resend/Mailgun directly, not FWB). Eliminates the $515 → $5,150 Resend cost explosion. |

### Infrastructure vs Revenue Health Check

The audit's per-merchant cost benchmarks ($1.71 at 100 merchants, $1.10 at 1,000 merchants) validate the $49 Starter floor even under the worst case (all merchants on Starter, no Professional/Enterprise):

- All-Starter scenario: 100 merchants × $49 = $4,900 MRR vs $200 infra = 95.9% GM.
- Blended scenario above: 97.8%+ GM at every scale.

The only GM risk is Resend at scale (email cost grows linearly with order volume, not merchant count). Solve it before 500 active merchants with per-merchant sender architecture.

---

## Implementation Notes (for billing flow wiring)

1. `StorePlan` enum in `packages/database/prisma/schema.prisma` (line 454) already has the four values: `free`, `starter`, `professional`, `enterprise`. Default is `starter` on the `Store` model — change this to `free` when self-serve signup ships.
2. Feature gating should check both `store.plan` and `StoreFeature` rows: plan gates whether a feature _can_ be enabled; `StoreFeature` row gates whether the merchant has toggled it on. The `addon` features in the feature registry should only be enablable by super-admin (or self-serve billing flow once wired) when the store is on the correct plan.
3. Limits (product count, order count, staff seats) need a `plan-limits.ts` module in `@force/shared` that exports a map of `StorePlan → limits`. API middleware should enforce these limits on create operations before they hit the DB.
4. Add-on billing (extra domain, AI quota boost, SMS pack) requires a `StoreAddon` table — not yet in schema. When billing ships, add: `storeId`, `addonKey`, `quantity`, `billingPeriodStart`, `billingPeriodEnd`.
5. Annual billing: add `billingCycle: 'monthly' | 'annual'` and `planRenewsAt: DateTime` to `Store` model.
6. Migration discount tracking: add `migrationDiscountApplied: Boolean` + `migrationDiscountExpiresAt: DateTime` to `Store` model.
