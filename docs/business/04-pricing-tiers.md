# Force Store — Proposal Pricing Framework

**Internal document. Last updated: 2026-05-22. Owner: Ahmad Sharaf / Force AI.**

> **There is no public tier list.** Force Store is sold as a **managed e-commerce platform** by Force AI / Force Media. Every client gets a **custom proposal** based on the features they need. Pricing is per-client, not per-tier. This doc holds the inputs you need to write good proposals — cost floors, feature value bands, competitor benchmarks.

---

## 1. How Force Store actually sells

Per Ahmad's standing 2026-05-22 description:

1. **Client comes to Force AI** (usually through Force Media agency relationships, referrals, or inbound contact)
2. **Sees the contract** — full list of features Force Store offers
3. **You write a proposal** — pick the features the client needs, set a price, send the contract
4. **Client pays** — typically upfront or 50/50 split (deposit + on-completion)
5. **Onboarding begins** — you ask for:
   - Brand assets (logo, colors, fonts, hero images)
   - Excel file with categories, product names + AR translations, descriptions + AR translations, prices, images
   - Domain (or you provision via Vercel)
   - Payment provider setup (Tap/MyFatoorah/Hesabe/UPayments account creation if needed)
6. **You enable features via super_admin** — flip the per-store flags in `StoreFeature` for whatever the client signed and paid for
7. **Store goes live**

There's no self-serve signup. There's no monthly tier list on a public pricing page. Every deal is a custom contract.

**Why this model fits Force AI today:**

- **No CBK licensing risk** — you're not aggregating payments, each merchant has their own provider account
- **No race-to-the-bottom pricing** — Salla/Shopify can publish a $39/mo Basic, you don't compete on that axis
- **Custom feature bundles** — clients pay for what they need, not for a marketing-driven tier
- **Premium positioning** — agency-led delivery commands agency-level fees
- **Less product engineering** — no signup flow, no billing dashboard, no Tap Subscriptions integration needed

---

## 2. Inputs for writing a proposal

### 2a. Cost-floor math (from the 2026-05-22 audit)

What it costs YOU per merchant per month on infrastructure:

| Scale                      | Infra cost/mo | Per-merchant cost | Cost floor (3× loaded) | Cost floor (5× loaded) |
| -------------------------- | ------------- | ----------------- | ---------------------- | ---------------------- |
| Today (~2 merchants)       | ~$26          | ~$13              | $39                    | $65                    |
| 10k MAU / 100 merchants    | ~$171         | **$1.71**         | $5.13                  | $8.55                  |
| 100k MAU / 1,000 merchants | ~$1,100       | **$1.10**         | $3.30                  | $5.50                  |

**Use this to:** never quote a monthly maintenance fee below the loaded cost floor. Today, anything under ~$40/mo is unprofitable. At 100 merchants, $9/mo is the floor.

**One-off vs recurring split in proposals:**

- **Setup fee** (one-off) — your time onboarding the client (data import, branding setup, theme configuration, training). Recommended: 200-1000 KWD depending on complexity.
- **Monthly platform fee** — covers infra + ongoing support + AI quotas + new features as they ship. Recommended: above the loaded cost floor + your margin.

### 2b. Competitor benchmarks (what client says they're comparing against)

| Competitor              | Equivalent monthly fee                                     | Notes                       |
| ----------------------- | ---------------------------------------------------------- | --------------------------- |
| Shopify Basic Kuwait    | $39 USD + 2% GMV + ~$20 translation app + ~$10 KNET plugin | Real all-in ~$80/mo USD     |
| Shopify Advanced Kuwait | $299 USD + 0.5% GMV + apps                                 | Real all-in $350-450/mo USD |
| Salla Starter           | ~$22 USD (SAR 79)                                          | Saudi-first, no KNET native |
| Salla Pro               | ~$130 USD (SAR 479)                                        | Same, no built-in AI        |
| Wix eCommerce           | $27-59 USD                                                 | Limited Arabic support      |
| WooCommerce + agency    | $5-15k upfront + $200-500/mo maintenance                   | Self-managed risk           |

**Use this to:** anchor against the competitor the client cites. Most Kuwait merchants compare against Shopify or are evaluating "do I just hire a developer for WooCommerce?" — the agency-managed Force Store sells against both.

### 2c. Feature value bands (what to charge for each feature group in a proposal)

The 22-feature `FEATURE_REGISTRY` in `packages/shared/src/features.ts` falls into 4 value bands when building a custom proposal:

#### Band 1 — Always included (always on, no upcharge)

- `coupons`, `returns`, `reviews`, `inventory`, `tax`, `pwa`, `seo`, `search_autocomplete`, `marketing_pixels`, `shipping_carriers`, `bulk_operations`, `abandoned_cart`

These are platform-default. Every Force Store client gets them. Don't bother itemizing in a proposal — they're table stakes.

#### Band 2 — Premium add-ons (charge separately)

| Feature              | Value framing                                                                                                        | Recommended proposal price band                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `loyalty`            | "Customer loyalty program — points, tiers, rewards"                                                                  | Setup: 100-300 KWD + Monthly: 5-15 KWD                  |
| `affiliate`          | "Run an affiliate program — let influencers earn % per sale"                                                         | Setup: 100-200 KWD + Monthly: 5-10 KWD                  |
| `whatsapp`           | "WhatsApp integration: order notifications (4 templates) + customer DM ordering bot + bot analytics + payment links" | Setup: 150-300 KWD + Monthly: 10-25 KWD                 |
| `sms`                | "Order updates via SMS (Kuwait carriers)"                                                                            | Setup: 50-150 KWD + Monthly: 3-10 KWD + SMS-per-message |
| `push_notifications` | "Web push to opt-in customers"                                                                                       | Setup: 50-100 KWD + Monthly: 2-8 KWD                    |
| `upsell_crosssell`   | "AI-driven product recommendations + bundles"                                                                        | Setup: 50-100 KWD + Monthly: 3-10 KWD                   |
| `floating_widget`    | "Sticky WhatsApp/Instagram/music button"                                                                             | Setup: 50-100 KWD + Monthly: 2-8 KWD                    |

> **Bot intelligence is included in the `whatsapp` feature at no extra charge.** The natural-language AI (intent classification, voice transcription, product photo matching, returning-customer personalization) runs on the Google Gemini free tier — there is no per-conversation or per-LLM-call cost passed to merchants. Same holds for all other AI features (translation, SEO, category suggestion): the platform absorbs the Gemini free-tier cost.

These are the **upgrade levers** during a proposal conversation. A merchant wanting WhatsApp + Loyalty + Affiliate adds ~250-500 KWD setup + ~13-35 KWD/month to the base.

#### Band 3 — White-glove services (your time, billed at agency rates)

| Service                                                          | Recommended price band             |
| ---------------------------------------------------------------- | ---------------------------------- |
| Catalog import (per 100 products)                                | 50-100 KWD                         |
| Bilingual translation review (per 100 products with AI-pre-fill) | 30-60 KWD                          |
| Custom theme tweaks                                              | 200-500 KWD per round              |
| Brand identity work (if Force Media does it)                     | 500-2000 KWD                       |
| Photoshoot / product photography                                 | varies, refer to Force Media rates |
| Marketing campaign setup (Meta/Google ads)                       | varies, refer to Force Media rates |

#### Band 4 — Custom dev (escalation, rarely)

| Custom request                                               | Pricing posture                                        |
| ------------------------------------------------------------ | ------------------------------------------------------ |
| Custom payment provider integration (beyond the 4 supported) | Custom quote — 1500+ KWD setup                         |
| Custom storefront design (outside the 5 themes)              | Custom quote — usually decline or refer to Force Media |
| API access for client's external systems                     | Custom quote — 500+ KWD setup + monthly access fee     |
| Multi-store under one account                                | Custom quote — pre-codebase support, 2000+ KWD setup   |

Custom dev requests are where Force AI margin is highest BUT also where scope creep risk is highest. Have a fixed-scope contract before starting.

### 2d. Payment processing economics (no GMV cut from you)

Per Ahmad's standing 2026-05-22 instruction — **payments are handled by Ahmad/Force Media** as part of the onboarding service:

- You help the client get a Tap, MyFatoorah, Hesabe, or UPayments account if they don't have one
- The merchant's payment provider credentials are configured in their Force Store admin
- Money flows direct from customer → merchant's payment provider account → merchant's bank
- Force Store doesn't touch the funds
- No CBK licensing required

What Force Store charges the merchant:

- One-off setup fee (your time onboarding)
- Monthly platform fee (recurring)
- Optional add-ons (paid per feature unlocked)

The merchant pays payment provider fees (2-3.5% per transaction) directly to Tap/MyFatoorah/etc. You don't take a cut of those.

This is the **managed-setup payment model** documented earlier — it stays clean from a regulatory standpoint and the merchant keeps 100% of every sale (minus what their gateway charges them).

### 2e. Kuwait market context for proposal-writing

- **Kuwait merchants negotiate.** Expect 10-30% pushback on first quote. Build that into your initial number.
- **Round numbers anchor better** (50, 100, 250, 500, 1000 KWD) than precise ones (47, 113, 287)
- **Annual prepay discount is expected** — typical 10-20% off if they prepay 12 months
- **Q4 / Ramadan** (peak shopping seasons) — merchants are more price-sensitive at quote time but less likely to churn after launch
- **Bilingual proposals** — if the client speaks Arabic, send the proposal in both languages. Force Media has a template you can adapt.

---

## 3. Sample proposal structures (illustrative — your actual numbers may vary)

### Basic merchant (single store, 50-200 products, no addons)

```
Setup fee: 500 KWD (one-off)
  - Brand setup (logo, colors, hero images)
  - Catalog import (up to 200 products, bilingual)
  - Theme configuration
  - Payment provider setup
  - Custom domain provisioning
  - 1-hour live training session

Monthly platform fee: 50 KWD/mo
  - Hosting, bandwidth, SSL
  - All Band 1 (core) features
  - Bilingual AI translation (within quota)
  - Email order confirmations
  - Standard support (email, 24hr response)
  - Updates + new features as we ship them
  - 3 staff accounts

Annual prepay discount: 2 months free (effectively 17% off)
Annual total: 1100 KWD (500 setup + 600 / 12 mo @ 50)
```

### Mid-market merchant (single store, 500+ products, addons)

```
Setup fee: 1000 KWD (one-off)
  - Everything in Basic
  - + Loyalty program configuration
  - + WhatsApp integration (4 order templates + customer DM ordering bot + payment links) — incl. WBS bridge setup
  - + Affiliate program setup
  - + 2-hour live training session

Monthly platform fee: 100 KWD/mo
  - Everything in Basic
  - + WhatsApp order notifications
  - + Loyalty program
  - + Affiliate tracking
  - + Push notifications
  - + Upsell/cross-sell recommendations
  - Priority support (email + WhatsApp, 4hr response)
  - 10 staff accounts

Annual prepay discount: 2 months free
Annual total: 2200 KWD (1000 setup + 1200 / 12 mo @ 100)
```

### Enterprise / high-volume (custom)

Each enterprise prospect gets a fully custom contract. Typical contract value:

- Setup: 2000-5000+ KWD (white-label, custom integrations, dedicated infrastructure setup)
- Monthly: 250-500+ KWD (multi-store, dedicated support, SLA, white-label)

**Do not publish enterprise pricing.** Negotiate based on the client's specific needs + alternatives.

---

## 4. Common objections + responses

| Objection                                              | Response                                                                                                                                                                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Shopify is only $39/mo"                               | "Shopify is $39 + a $20 translation app + a 3rd-party KNET plugin + you still need someone to set it up. The all-in cost is $80-150/mo for what you'd get from us in one bill, fully managed."                                        |
| "Salla is cheaper at SAR 99"                           | "Salla is built for Saudi Arabia. KNET works but is not the primary integration. AR is the only storefront language. If you sell to Kuwait specifically and want English-speaking customers too, Force Store is built for that case." |
| "Can I do month-to-month?"                             | "Yes, but we offer 2 months free on annual prepay — most clients pick that. Month-to-month is fine for the first 3 months while you decide."                                                                                          |
| "What if I want to leave?"                             | "Your data is yours. We export everything as CSV/Excel. Your custom domain transfers back to your registrar. We give you 30 days of read-only access after cancellation to download anything you need."                               |
| "What about my customer reviews / orders / customers?" | "All exportable. We use standard formats — you can import them into Shopify, Wix, or anywhere else."                                                                                                                                  |
| "Why do I need an annual contract?"                    | "You don't — we offer monthly too. The annual contract saves you 2 months of fees and locks in your current pricing if our rates change."                                                                                             |

---

## 5. Proposal-writing checklist

Before sending a proposal:

- [ ] Confirm the merchant's product count (drives catalog import cost)
- [ ] Confirm bilingual needs (EN-only, AR-only, or both)
- [ ] Confirm payment provider (Tap / MyFatoorah / Hesabe / UPayments) — set up account if they don't have one
- [ ] Confirm custom domain availability (or provision a Force Store subdomain)
- [ ] Identify which Band 2 add-ons they want (Loyalty / Affiliate / WhatsApp / etc.)
- [ ] Identify any Band 3 white-glove services they need (catalog import, photoshoot, branding)
- [ ] Identify any Band 4 custom dev — if yes, fixed-scope contract addendum
- [ ] Setup fee = ABOVE your time cost + reasonable margin
- [ ] Monthly fee = ABOVE the loaded cost floor (currently ~$40 USD / 12 KWD at small scale)
- [ ] Annual prepay discount included (2 months free)
- [ ] Contract terms: deposit %, completion %, cancellation policy, data export commitment
- [ ] Bilingual proposal if client speaks Arabic

---

## 6. Operational discipline (what you do after the client pays)

1. **Generate the store** — use the super_admin store-creation flow
2. **Enable features** — flip `StoreFeature` rows for everything the client paid for
3. **Set tier internally** — set `Store.plan` enum to whichever value tracks this client best (you control the meaning of `free` / `starter` / `professional` / `enterprise` internally; clients never see this)
4. **Configure payment provider** — set up Tap/MyFatoorah/Hesabe/UPayments credentials per the client's account
5. **Onboard the client** — branding, catalog import (Excel → Force Store), theme config, training session
6. **Verify it works** — place a test order, verify webhooks fire, verify order confirmation email arrives
7. **Hand over** — give the client admin credentials, schedule the training session, schedule a 2-week check-in

---

## 7. What this doc is NOT

- **Not a public pricing page.** No version of this is published. Clients get a custom proposal, not a tier list.
- **Not a feature paywall enforcement reference.** That logic is in `StoreFeature` table + per-route `feature-gate.ts` middleware.
- **Not a contract template.** Use Force Media's existing legal templates for the actual contract; this doc informs the dollar amounts in the contract.
- **Not exposed to the codebase.** Future engineers don't need to read this — pricing decisions live in your head + the proposals you send, not in code.

---

## 8. Companion documents

- [`02-feature-catalog.md`](02-feature-catalog.md) — feature inventory (informs what's available in a proposal)
- [`03-competitive-positioning.md`](03-competitive-positioning.md) — competitor comparison (informs objection-handling)
- [`05-pitch-deck-outline.md`](05-pitch-deck-outline.md) — sales pitch (for first conversations, before proposal)
- [`docs/audits/_slices/06-cost-forecast.md`](../audits/_slices/06-cost-forecast.md) — full infra cost forecast (sets your cost floor)
- [`packages/shared/src/features.ts`](../../packages/shared/src/features.ts) — FEATURE_REGISTRY source of truth
