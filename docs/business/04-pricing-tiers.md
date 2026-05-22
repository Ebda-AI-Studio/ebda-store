# Force Store — Pricing Decision Framework

**Internal document. Last updated: 2026-05-22. Owner: Ahmad Sharaf / Force AI.**

> Pricing tiers + onboarding flow are Ahmad's call to design. This doc holds the **inputs** — cost floors, competitor benchmarks, FEATURE_REGISTRY tier annotations, payment-provider economics, market context — so the synthesis step is grounded in data, not hunch.

---

## 1. Inputs for pricing decisions

### 1a. Cost-floor math (from the 2026-05-22 audit)

From `docs/audits/_slices/06-cost-forecast.md`:

| Scale                      | Infra cost/mo | Per-merchant cost | Cost floor (3× loaded) | Cost floor (5× loaded) |
| -------------------------- | ------------- | ----------------- | ---------------------- | ---------------------- |
| Today (~2 merchants)       | ~$26          | ~$13              | $39                    | $65                    |
| 10k MAU / 100 merchants    | ~$171         | **$1.71**         | $5.13                  | $8.55                  |
| 100k MAU / 1,000 merchants | ~$1,100       | **$1.10**         | $3.30                  | $5.50                  |

**What this means:** the loaded floor (3-5× infra cost) gives you the minimum sustainable per-merchant pricing at scale. Anything above this is gross margin. Below this and merchant churn cross-subsidies become structural debt.

**Most expensive cost line at scale:** Resend email overage (~$515/mo at 100k MAU if every merchant sends 600 emails/day). Architectural fix before 500 active merchants: per-merchant SMTP provider (each store routes its own transactional email through their own Resend/Mailgun account).

### 1b. Competitor benchmarks (Kuwait/GCC market, 2026)

| Competitor                          | Equivalent tier | Monthly price         | KNET?                     | Bilingual?                                         | AI?                                  |
| ----------------------------------- | --------------- | --------------------- | ------------------------- | -------------------------------------------------- | ------------------------------------ |
| **Shopify Basic** (Kuwait)          | Entry           | $39 USD + 2% GMV      | Via 3rd-party plugin only | Translate & Adapt app (now free, 100k char/yr cap) | Shopify Magic, EN-only on paid plans |
| **Shopify Advanced** (Kuwait)       | Mid             | $299 USD + 0.5% GMV   | Same plugin route         | Same                                               | Same                                 |
| **Shopify Plus**                    | Top             | $2,300 USD/mo base    | Same                      | Same                                               | Same                                 |
| **Salla Starter** (Saudi-first)     | Entry           | ~$22 USD (SAR 79)     | Mada native, KNET weak    | Arabic-first                                       | None                                 |
| **Salla Pro**                       | Mid             | ~$130 USD (SAR 479)   | Same                      | Same                                               | None                                 |
| **Wix eCommerce Standard**          | Entry           | $27 USD               | Via 3rd-party             | EN-first, AR via plugin                            | None                                 |
| **Wix eCommerce Premium**           | Mid             | $59 USD               | Same                      | Same                                               | None                                 |
| **WooCommerce + hosting + plugins** | Self-managed    | $30-100 USD effective | Plugin (WooCommerce KNET) | Plugin (WPML $99/yr)                               | None                                 |

**Source URLs:** Shopify pricing page, Salla pricing page, Wix Kuwait pricing, WooCommerce hosting estimates — all captured 2026-05-22 by the competitive-positioning subagent. Confirm before any pricing announcement.

**Pricing white space (where Force Store can land profitably):**

- **Below $30/mo** — possible but compresses margin to ~3× at 10k MAU. Worth it only as a deliberate land-grab strategy with Series A funding behind it. Not recommended at current scale.
- **$30-100/mo** — the sweet spot. Comparable to Shopify Basic + translation app + KNET plugin total cost, undercut Salla Pro, beat WooCommerce TCO when factoring developer maintenance.
- **$100-300/mo** — Professional tier zone. Anchor against Shopify Advanced ($299 + 0.5% GMV) which is what your Kuwait merchant prospects compare you to most.
- **Above $300/mo** — Enterprise / custom contracts. White-label, multi-store, dedicated support territory.

### 1c. FEATURE_REGISTRY tier annotations

From `packages/shared/src/features.ts` (22 features as of 2026-05-21):

| Feature key           | Tier         | Category   | Status                | Notes                                            |
| --------------------- | ------------ | ---------- | --------------------- | ------------------------------------------------ |
| `coupons`             | core         | commerce   | Live                  | Should be in every paid tier                     |
| `loyalty`             | **addon**    | commerce   | Live                  | Natural upsell — Professional+                   |
| `returns`             | core         | commerce   | Live                  | Every paid tier                                  |
| `reviews`             | core         | commerce   | Live                  | Every paid tier (Free OK too)                    |
| `inventory`           | core         | commerce   | Live                  | Every paid tier                                  |
| `tax`                 | core         | commerce   | Live                  | Every paid tier                                  |
| `bulk_operations`     | core         | operations | Live                  | Starter+                                         |
| `customer_wallet`     | experimental | commerce   | Hidden                | Don't price yet                                  |
| `upsell_crosssell`    | **addon**    | commerce   | Live                  | Natural upsell — Professional+                   |
| `whatsapp`            | **addon**    | marketing  | Live (via WBS)        | Premium — Professional+                          |
| `sms`                 | **addon**    | marketing  | Live                  | Premium — Professional+                          |
| `push_notifications`  | **addon**    | marketing  | Live                  | Mid — Starter+ or Pro+ depending on positioning  |
| `email_campaigns`     | experimental | marketing  | Hidden                | Don't price yet                                  |
| `abandoned_cart`      | core         | marketing  | Live                  | Starter+                                         |
| `affiliate`           | **addon**    | marketing  | Live                  | Premium — Professional+                          |
| `marketing_pixels`    | core         | marketing  | Live                  | Starter+                                         |
| `shipping_carriers`   | core         | operations | Live                  | Starter+                                         |
| `staff_accounts`      | experimental | operations | Hidden                | Don't price yet                                  |
| `pwa`                 | core         | storefront | Live                  | Free+                                            |
| `seo`                 | core         | storefront | Live (platform-level) | Always on                                        |
| `search_autocomplete` | core         | storefront | Live (platform-level) | Always on                                        |
| `floating_widget`     | **addon**    | engagement | Live (2026-05-21)     | Differentiator — could lead with this in Starter |

**6 addon-tier features** are your tier-gate decision points: `loyalty`, `upsell_crosssell`, `whatsapp`, `sms`, `affiliate`, `floating_widget`. Each one merits a tier-mapping decision.

### 1d. Payment processing economics

**Payment processing model is Ahmad's call** (per 2026-05-22 standing instruction). Two viable models:

- **Managed-setup model** — Force Media negotiates payment provider accounts (Tap, MyFatoorah, Hesabe, UPayments) on each merchant's behalf. Credentials configured in the merchant's Force Store admin. Money flows direct: customer → merchant's own provider account → merchant's bank. Force Store collects subscription only; no GMV cut. No CBK licensing required.
- **Aggregator model** — Force AI uses one master payment provider account. Customer pays Force AI → Force AI holds funds → periodic payout to merchant minus subscription + GMV cut. Requires CBK financial services licensing, AML/KYC compliance, reserve obligations against chargebacks. Codebase changes: refactor per-store credentials to platform-level + add payout/balance/reserve modules.

Decision affects:

- Pricing model (subscription-only vs subscription + GMV cut)
- Regulatory exposure (none vs CBK-licensed financial services entity)
- Codebase changes (none vs significant refactor)
- Sales pitch ("you keep 100% of every sale" vs "we handle everything")

Standard 2026 KNET/card rates (provider direct, applies to both models):

| Provider   | KNET  | Visa/MC domestic | International |
| ---------- | ----- | ---------------- | ------------- |
| MyFatoorah | 2.0%  | 3.5%             | 3.5%+         |
| Tap        | 2.75% | 2.75%            | 3.25% + FX    |
| Hesabe     | ~2.5% | ~3.5%            | —             |
| UPayments  | ~2.5% | ~3.0%            | —             |

### 1e. Kuwait market context

- Kuwait psychological pricing: round KWD numbers (5, 10, 15, 20, 50, 100) read as "thought through"; numbers like KWD 13 or KWD 47 suggest discount framing.
- USD pricing matters for the international/expat merchant segment + future GCC expansion.
- Annual prepay discount is standard in Kuwait B2B SaaS — typically 2 months free (effectively ~17% off).
- Switching-discount offers ("migrate from Shopify, get 50% off 3 months") are a documented Kuwait merchant acquisition tool.

### 1f. Onboarding-driven tier-design notes

Ahmad will design onboarding himself. For pricing-tier design context only:

- **Free tier conversion event** — the moment a merchant connects a payment provider OR attaches a custom domain. Both are "I'm taking real money" signals. Free tier must NOT include these unless conversion strategy demands it.
- **Free tier anti-abuse** — dormant stores (no orders 60+ days) flagged as inactive after 7-day warning email. Prevents parked-domain inflation of infra costs.
- **14-day Pro trial vs 14-day Starter trial** — Pro trial is a more compelling conversion tool because it lets merchants experience the addon features (loyalty, affiliate, WhatsApp) they'd be paying extra for. Starter trial converts at a lower rate but is more honest about what most merchants need long-term.

---

## 2. The tier-structure decision (Ahmad's call)

### Recommended structure (Ahmad to fill in pricing + final feature mapping)

| Tier             | Price (KWD/USD) | Target merchant                       | Key feature unlock                                    | Hard limits    |
| ---------------- | --------------- | ------------------------------------- | ----------------------------------------------------- | -------------- |
| **Free**         | 0               | Hobbyist, pre-launch                  | All core features, no live payments                   | [TBD by Ahmad] |
| **Starter**      | [TBD]           | Real selling, single store            | Custom domain + KNET + all themes                     | [TBD by Ahmad] |
| **Professional** | [TBD]           | Established + team + marketing        | + WhatsApp / Loyalty / Affiliate / Upsell-Crosssell   | [TBD by Ahmad] |
| **Enterprise**   | [TBD]           | High-volume, multi-store, white-label | + Multi-store, dedicated support, custom integrations | Unlimited      |

### Decision inputs Ahmad should consult

1. **Cost floor** — keep all tiers above the 5× loaded cost line from §1a (Starter ≥ $8.55/mo at 10k MAU, Pro/Enterprise above proportionally).
2. **Competitor anchor** — Professional tier is the **most important price** because that's where Kuwait merchants compare you against Shopify Advanced ($299/mo). Beat that price by a clear margin and the value differential (KNET + AI + Arabic) closes the sale.
3. **Addon tier feature mapping** — 6 addon features in FEATURE_REGISTRY. Decide whether each unlocks at Starter, Pro, or Enterprise. The decision drives upgrade pressure.
4. **Annual prepay discount** — standard is 2 months free. Worth offering at launch as a cash-flow + churn-reduction mechanism.
5. **Migration discount** — Shopify/Wix/Salla switchers are a real Kuwait acquisition channel. 50% off 3 months is a documented industry move.

---

## 3. Add-on pricing (separate from tier subscription)

Features merchants might want individually without upgrading tier:

| Add-on                                           | Recommended price band | Rationale                                                                         |
| ------------------------------------------------ | ---------------------- | --------------------------------------------------------------------------------- |
| Extra custom domain                              | KWD 2-5/mo per domain  | Vercel auto-provision cost = ~$0; price for value                                 |
| AI quota bump (10× daily cap)                    | KWD 5-15/mo            | Gemini paid is $0.10/1M input + $0.40/1M output — even heavy use is $5-15/mo cost |
| Dedicated support (4hr response SLA)             | KWD 10-30/mo           | Manual support time cost                                                          |
| White-label storefront (no Force Store branding) | KWD 20-50/mo           | Brand equity loss premium                                                         |
| API access (for custom integrations)             | KWD 10-30/mo           | API stability commitment + support burden                                         |

Final add-on prices: Ahmad's call.

---

## 4. Annual billing + discount structure

**Standard recommendation:**

- Monthly billing: tier price × 12
- Annual prepay: tier price × 10 (i.e. 2 months free, ~17% discount)
- Quarterly billing: tier price × 12 (no discount — billed in advance)

**Why annual matters:**

- Cash flow buffer for Force AI in pre-Series A stage
- Lower churn (merchant has prepaid; not re-evaluating monthly)
- Standard Kuwait B2B SaaS expectation

---

## 5. Free trial + money-back

**Recommended (Ahmad's call):**

- 14-day trial of Professional tier (NOT Starter) — sells the addon features that are the upgrade pressure
- No credit card required to start trial
- At end of trial: merchant chooses Starter/Pro/Enterprise OR drops to Free (data preserved 30 days)
- Money-back: 30-day full refund on any tier if merchant cancels in first 30 days (rare in B2B SaaS but reduces switching friction from Shopify)

**Anti-abuse:**

- One trial per merchant identity (verify via email + phone + payment provider check on activation)
- Trial cannot include extra add-ons
- Trial does not include white-label or API access (Enterprise-only add-ons)

---

## 6. Migration / switcher discounts

**Recommended:**

- 50% off Professional tier for first 3 months, for verified switchers from Shopify, Wix, Salla, Zid, or WooCommerce
- Proof: screenshot of prior platform billing within last 90 days
- Funnel: drives Kuwait merchants in the Force Media network who already use Shopify → Force Store

**Why migration discount is worth it:**

- Acquisition cost in Kuwait via paid social is ~$50-200 per active merchant
- A 50%-off-3-months discount on a $50-100 Pro tier is $75-150 forgone — comparable acquisition cost with much higher intent (merchant is actively switching, not browsing)

---

## 7. Revenue projection (illustrative — final numbers depend on Ahmad's pricing)

Assuming a moderate pricing curve at the 3-4× loaded cost floor:

| Stage  | Merchants    | Avg ARPU | MRR   | ARR   | Infra cost | Gross margin |
| ------ | ------------ | -------- | ----- | ----- | ---------- | ------------ |
| Today  | 2            | [n/a]    | [n/a] | [n/a] | $26/mo     | n/a          |
| Year 1 | 100          | [TBD]    | [TBD] | [TBD] | $170/mo    | [TBD]        |
| Year 3 | 1,000        | [TBD]    | [TBD] | [TBD] | $1,100/mo  | [TBD]        |
| Year 5 | 10,000 (GCC) | [TBD]    | [TBD] | [TBD] | $11,000/mo | [TBD]        |

Use this template to model revenue at Ahmad's chosen price points. At any pricing above the 3× loaded cost floor, gross margin stays >70% at scale.

---

## 8. Pricing announcement checklist (when Ahmad commits)

When you finalize prices, update these files in the same commit:

- [ ] `04-pricing-tiers.md` (this doc) — replace every `[TBD]` with the final number + rationale paragraph
- [ ] `05-pitch-deck-outline.md` slide 8 + slide 9 — replace `[TBD]` placeholders
- [ ] `06-faq.md` — replace `[TBD]` in the "How much does it cost?" answer
- [ ] `01-overview.md` — verify no specific dollar amount needs updating (currently links to this doc for pricing)
- [ ] Public-facing landing page (when it exists) — copy the announced prices
- [ ] Billing flow + admin signup wizard — wire `StorePlan` enum to billing provider (Tap Subscriptions or MyFatoorah recurring)
- [ ] Sales scripts / call playbooks — update talking points

The bundle stays consistent only if all 7 surfaces get the new numbers in one push.

---

## 9. Companion documents

- [`02-feature-catalog.md`](02-feature-catalog.md) — full feature inventory (informs which features land in which tier)
- [`03-competitive-positioning.md`](03-competitive-positioning.md) — TCO comparison vs Shopify/Salla/Wix (drives competitor anchoring)
- [`05-pitch-deck-outline.md`](05-pitch-deck-outline.md) — sales pitch (must match pricing decisions)
- [`docs/audits/_slices/06-cost-forecast.md`](../audits/_slices/06-cost-forecast.md) — full per-service cost forecast at scale
- [`packages/shared/src/features.ts`](../../packages/shared/src/features.ts) — FEATURE_REGISTRY source of truth
