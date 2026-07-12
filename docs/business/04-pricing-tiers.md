> **INTERNAL — Force AI / Force Media team only. Contains cost floors, margins, and market benchmark figures. NEVER share with clients.**

# Force AI Store — Proposal Pricing Framework

**Internal document. Last updated: 2026-06-15. Owner: Ahmad Sharaf / Force AI.**

> **There is no public tier list.** Force AI Store is sold as a **managed e-commerce platform** by
> Force AI / Force Media. Every client gets a **custom proposal** based on the features they need.
> Pricing is per-client, not per-tier. This doc holds the inputs you need to write good proposals —
> cost floors, feature value bands, competitor benchmarks.

---

## 1. How Force AI Store actually sells

Per Ahmad's standing 2026-05-22 description:

1. **Client comes to Force AI** (usually through Force Media agency relationships, referrals, or
   inbound contact)
2. **Sees the contract** — full list of features Force AI Store offers
3. **You write a proposal** — pick the features the client needs, set a price, send the contract
4. **Client pays** — typically upfront or 50/50 split (deposit + on-completion)
5. **Onboarding begins** — you ask for:
   - Brand assets (logo, colors, fonts, hero images)
   - Excel file with categories, product names + AR translations, descriptions + AR translations,
     prices, images
   - Domain (or you provision via Cloudflare-for-SaaS)
   - Payment provider setup (Tap/MyFatoorah/Hesabe/UPayments account creation if needed)
6. **You enable features via super_admin** — flip the per-store flags in `StoreFeature` for
   whatever the client signed and paid for
7. **Store goes live**

There's no self-serve signup. There's no monthly tier list on a public pricing page. Every deal is
a custom contract.

**Why this model fits Force AI today:**

- **No CBK licensing risk** — you're not aggregating payments, each merchant has their own provider
  account
- **No race-to-the-bottom pricing** — other platforms publish a $39/mo Basic; we don't compete on
  that axis
- **Custom feature bundles** — clients pay for what they need, not for a marketing-driven tier
- **Premium positioning** — agency-led delivery commands agency-level fees
- **Less product engineering** — no signup flow, no billing dashboard, no subscription billing
  integration needed

---

## 2. Inputs for writing a proposal

### 2a. Cost-floor math (from the 2026-05-22 audit)

What it costs YOU per merchant per month on infrastructure:

| Scale                      | Infra cost/mo | Per-merchant cost | Cost floor (3× loaded) | Cost floor (5× loaded) |
| -------------------------- | ------------- | ----------------- | ---------------------- | ---------------------- |
| Today (~2 merchants)       | ~$26          | ~$13              | $39                    | $65                    |
| 10k MAU / 100 merchants    | ~$171         | **$1.71**         | $5.13                  | $8.55                  |
| 100k MAU / 1,000 merchants | ~$1,100       | **$1.10**         | $3.30                  | $5.50                  |

**Use this to:** never quote a monthly maintenance fee below the loaded cost floor. Today, anything
under ~$40/mo is unprofitable. At 100 merchants, $9/mo is the floor.

**One-off vs recurring split in proposals:**

- **Setup fee** (one-off) — your time onboarding the client (data import, branding setup, theme
  configuration, training). Recommended: 200-1000 KWD depending on complexity.
- **Annual platform fee** (one-time yearly charge, quoted at a monthly-equivalent rate) — covers
  infra + ongoing support + AI quotas + new features as they ship. Recommended: above the loaded
  cost floor + your margin.

### 2b. INTERNAL — Market reference benchmarks (NEVER shown to clients)

> These figures are for your pricing intelligence only. They inform what the client compares
> against — not what you quote. Do not include this table in any proposal or client communication.

| Competitor              | Equivalent monthly fee                                     | Notes                       |
| ----------------------- | ---------------------------------------------------------- | --------------------------- |
| Shopify Basic Kuwait    | $39 USD + 2% GMV + ~$20 translation app + ~$10 KNET plugin | Real all-in ~$80/mo USD     |
| Shopify Advanced Kuwait | $299 USD + 0.5% GMV + apps                                 | Real all-in $350-450/mo USD |
| Salla Starter           | ~$22 USD (SAR 79)                                          | Saudi-first, no KNET native |
| Salla Pro               | ~$130 USD (SAR 479)                                        | Same, no built-in AI        |
| Wix eCommerce           | $27-59 USD                                                 | Limited Arabic support      |
| WooCommerce + agency    | $5-15k upfront + $200-500/mo maintenance                   | Self-managed risk, no AI    |

**Use this to:** anchor against whatever the client says they're comparing. Most Kuwait merchants
compare against Shopify or are evaluating "do I just hire a developer for WooCommerce?" — the
agency-managed Force AI Store sells against both. Frame your response around what the merchant
gets, not the competitor's shortcomings.

### 2c. Plan tiers and feature value bands (what to charge for each feature group in a proposal)

The Force AI Store plan system defines four tiers — `free` (grace/lapsed state only, not sold),
`starter`, `professional`, `enterprise`. The source of truth is
`packages/shared/src/plan-baselines.ts`. When building a proposal, use the tier as the starting
point, then layer add-ons and white-glove services on top.

#### Starter plan — baseline features (always included for any paying client)

`coupons`, `returns`, `reviews`, `tax`, `pwa`, `marketing_pixels`, `shipping_carriers`,
`bulk_operations`, `abandoned_cart`, `inventory.basic`

These are table stakes. Every Force AI Store client gets them. Don't itemize in a proposal —
bundle into the platform fee.

Also included in every tier at no extra charge:

- **Product discount engine** — per-product discount dropdown (None / Percentage % / Fixed KWD)
  with live price preview; replaces manual compare-at-price entry
- **AI features** — translation, SEO, AEO, category suggestion, FAQ/How-To, review tools,
  reorder/dead-stock AI (platform absorbs cost)
- **Page Builder** — drag-and-drop sections; Navigation, Footer, and Category config all
  consolidated here

#### Professional plan — Starter + the following

| Feature group                                                       | What to say in the proposal                                                  | Incremental price band vs Starter               |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------- |
| `loyalty`                                                           | "Customer loyalty program — points, tiers, rewards"                          | Setup: 100-300 KWD + Annual: 5-15 KWD/mo equiv. |
| `push_notifications`                                                | "Web push to opt-in customers"                                               | Setup: 50-100 KWD + Annual: 2-8 KWD/mo equiv.   |
| `upsell_crosssell`                                                  | "AI-driven product recommendations + bundles"                                | Setup: 50-100 KWD + Annual: 3-10 KWD/mo equiv.  |
| `inventory.stock_alerts`                                            | "Auto-email when stock drops below your threshold"                           | Included in Professional                        |
| `inventory.backorder`                                               | "Accept orders for out-of-stock products, queue for fulfillment"             | Included in Professional                        |
| `accounting.basic` + `accounting.expenses` + `accounting.invoicing` | "Full Chart of Accounts, journal, P&L, expenses, Kuwait-compliant invoicing" | Included in Professional                        |

#### Enterprise plan — Professional + the following

| Feature group                                                                                                   | What to say in the proposal                                                                                                         | Incremental price band vs Professional                           |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `affiliate`                                                                                                     | "Affiliate program — let influencers earn % per sale, track commissions"                                                            | Setup: 100-200 KWD + Annual: 5-10 KWD/mo equiv.                  |
| `sms`                                                                                                           | "Order updates via SMS (Kuwait carriers)"                                                                                           | Setup: 50-150 KWD + Annual: 3-10 KWD/mo equiv. + SMS-per-message |
| `floating_widget`                                                                                               | "Sticky WhatsApp/Instagram/music button on every storefront page"                                                                   | Setup: 50-100 KWD + Annual: 2-8 KWD/mo equiv.                    |
| `inventory.multi_warehouse`, `inventory.barcode`, `inventory.purchase_orders`, `inventory.bulk_adjustments`     | "Full warehouse management — barcode scanning (receive/pick/cycle-count), multi-location stock, PO workflow"                        | Included in Enterprise                                           |
| `accounting.tax_reports`, `accounting.multi_currency`, `accounting.profit_anomaly`, `accounting.bank_reconcile` | "Advanced accounting: VAT/tax reports (XLSX), multi-currency FX + KWD conversion, profit anomaly AI, bank reconciliation (CSV/OFX)" | Included in Enterprise                                           |

> **`whatsapp` admin access is baseline-included on every plan (Starter, Professional, Enterprise —
> even the `free` grace state).** Per `packages/shared/src/plan-baselines.ts`, `whatsapp` is in
> `STARTER_CORE`, so the `/whatsapp` admin section is available to every client by default
> (managed-agency default: Ahmad onboards every client and WhatsApp is a core offering). A
> super-admin can restrict a specific client by exception (a `StoreFeature` `whatsapp` override
> with `enabled=false`), but it is never sold as a plan upgrade.

> **What you still charge for is the activation SERVICE, not the feature gate.** Turning on live
> WhatsApp ordering requires an active Force AI WhatsApp Business Platform account + a
> Meta-approved WABA connected to the store — real setup work (Meta review, catalog provisioning,
> phone-number linking) worth quoting: Setup 150-300 KWD + Annual 10-25 KWD/mo equiv. Bot intelligence
> (NLU, voice, photo matching, returning-customer personalization) is included in that activation
> at no extra charge — the platform absorbs the AI cost.

These are the **upgrade levers** during a proposal conversation (WhatsApp activation is a service
add-on available at any tier; Affiliate requires Enterprise). A merchant on Professional wanting
WhatsApp activation + Affiliate (Enterprise) adds ~250-500 KWD setup + ~15-35 KWD/month to the
base.

> **AI Product Feed (`agent_feed`) — plan-independent add-on, available at any tier.** Not part of
> any plan baseline (Starter, Professional, and Enterprise all default to disabled); a super-admin
> enables it per store via a `StoreFeature` override once sold. Publishes a machine-readable
> product feed at `/feeds/products.json` so AI shopping assistants (ChatGPT, Perplexity, agent
> crawlers) can read and recommend the store's catalog. Priced individually per quote — not a
> fixed price band yet.

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
| API access for client's external systems                     | Custom quote — 500+ KWD setup + annual access fee      |
| Multi-store under one account                                | Custom quote — pre-codebase support, 2000+ KWD setup   |

Custom dev requests are where Force AI margin is highest BUT also where scope creep risk is
highest. Have a fixed-scope contract before starting.

### 2d. Payment processing economics (no GMV cut from you)

Per Ahmad's standing 2026-05-22 instruction — **payments are handled by Ahmad/Force Media** as
part of the onboarding service:

- You help the client get a Tap, MyFatoorah, Hesabe, or UPayments account if they don't have one
- The merchant's payment provider credentials are configured in their Force AI Store admin
- Money flows direct from customer → merchant's payment provider account → merchant's bank
- Force AI Store doesn't touch the funds
- No CBK licensing required

What Force AI Store charges the merchant:

- One-off setup fee (your time onboarding)
- Annual platform fee (one-time yearly charge)
- Optional add-ons (paid per feature unlocked)

The merchant pays payment provider fees (2-3.5% per transaction) directly to
Tap/MyFatoorah/etc. You don't take a cut of those.

This is the **managed-setup payment model** documented earlier — it stays clean from a regulatory
standpoint and the merchant keeps 100% of every sale (minus what their gateway charges them).

### 2e. Kuwait market context for proposal-writing

- **Kuwait merchants negotiate.** Expect 10-30% pushback on first quote. Build that into your
  initial number.
- **Round numbers anchor better** (50, 100, 250, 500, 1000 KWD) than precise ones (47, 113, 287)
- **A discount off the initial annual quote is expected** — typical 10-20% off the first number
  you give (there's no separate "monthly vs. annual" negotiation — the fee is annual by default)
- **Q4 / Ramadan** (peak shopping seasons) — merchants are more price-sensitive at quote time but
  less likely to churn after launch
- **Bilingual proposals** — if the client speaks Arabic, send the proposal in both languages. Force
  Media has a template you can adapt.

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

Annual platform fee: 50 KWD/mo equivalent (billed as one yearly payment)
  - Hosting, bandwidth, SSL
  - All Band 1 (core) features
  - Bilingual AI translation (within quota)
  - Email order confirmations
  - Standard support (email, 24hr response)
  - Updates + new features as we ship them
  - 3 staff accounts

Built into the annual rate: 2 months free vs. the monthly-equivalent rate (effectively 17% off)
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

Annual platform fee: 100 KWD/mo equivalent (billed as one yearly payment)
  - Everything in Basic
  - + WhatsApp order notifications
  - + Loyalty program
  - + Affiliate tracking
  - + Push notifications
  - + Upsell/cross-sell recommendations
  - Priority support (email + WhatsApp, 4hr response)
  - 10 staff accounts

Built into the annual rate: 2 months free vs. the monthly-equivalent rate
Annual total: 2200 KWD (1000 setup + 1200 / 12 mo @ 100)
```

### Enterprise / high-volume (custom)

Each enterprise prospect gets a fully custom contract. Typical contract value:

- Setup: 2000-5000+ KWD (white-label, custom integrations, dedicated infrastructure setup)
- Annual: 250-500+ KWD/mo equiv. (multi-store, dedicated support, SLA, white-label)

**Do not publish enterprise pricing.** Negotiate based on the client's specific needs + alternatives.

---

## 4. Common objections + responses

| Objection                                              | Response                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Platform X is only $39/mo"                            | "That's the subscription line item. Add a translation app, a KNET plugin, WhatsApp notifications, and someone to set it up — you're at $80-150/mo, fully unmanaged. We deliver all of that in one bill, fully configured."                                                                                                                                                                                                                                        |
| "Another platform is cheaper"                          | "A lower monthly line item often means more add-ons and more of your time managing them. We include AI translation, KNET, WhatsApp, accounting, and full inventory in the platform — compare the full basket, not the subscription fee."                                                                                                                                                                                                                          |
| "Can I do month-to-month?"                             | "No — Force AI Store is sold as a one-time yearly fee, not a monthly subscription. That's part of what keeps this a managed-agency engagement instead of a self-serve SaaS tier."                                                                                                                                                                                                                                                                                 |
| "What if I want to leave?"                             | "Your data is yours. We export everything as CSV/Excel. Your custom domain transfers back to your registrar. We give you 30 days of read-only access after cancellation to download anything you need."                                                                                                                                                                                                                                                           |
| "What about my customer reviews / orders / customers?" | "All exportable. We use standard formats — you can import them into any other platform."                                                                                                                                                                                                                                                                                                                                                                          |
| "Why do I need an annual contract?"                    | "It's the model, not an upsell — Force AI Store is sold as a one-time yearly fee per client, so the contract term is annual and locks in your pricing for the year."                                                                                                                                                                                                                                                                                              |
| "How do I know you can hold the 99.5% uptime SLA?"     | Walk them through §6.5 below: CI-gated pushes (pre-push hook + GitHub Actions CI must pass before code reaches production); daily local pg_dump backups (30-day retention) so any deploy can be rolled back with a pg_restore in <30min; Inngest functions self-register on boot so post-deploy job queues never stall; Telegram + watchdog alert pipeline pages on any main-branch CI failure within 17min. Offer to share `docs/ROLLBACK.md` for them to audit. |
| "What happens if there's an outage?"                   | "We get paged automatically — the Telegram alert hits within minutes of any main-branch CI failure or service health degradation. For a critical-severity incident we have a 4h response SLA and a tested rollback procedure that reverts the bad deploy + restores the previous database backup in <5min. The SLA carries a credit (1 day of service term extension per excess downtime hour, capped at 30/year)."                                               |

---

## 5. Proposal-writing checklist

Before sending a proposal:

- [ ] Confirm the merchant's product count (drives catalog import cost)
- [ ] Confirm bilingual needs (EN-only, AR-only, or both)
- [ ] Confirm payment provider (Tap / MyFatoorah / Hesabe / UPayments) — set up account if they
      don't have one
- [ ] Confirm custom domain availability (or provision a Force AI Store subdomain)
- [ ] Identify which Band 2 add-ons they want (Loyalty / Affiliate / etc.) and whether they need
      WhatsApp activation (baseline-included admin access at any tier — the activation service,
      not the feature, is what's billable)
- [ ] Identify any Band 3 white-glove services they need (catalog import, photoshoot, branding)
- [ ] Identify any Band 4 custom dev — if yes, fixed-scope contract addendum
- [ ] Setup fee = ABOVE your time cost + reasonable margin
- [ ] Annual fee's monthly-equivalent rate = ABOVE the loaded cost floor (currently ~$40 USD / 12 KWD at small scale)
- [ ] Annual-rate discount reflected in the quote (2 months free vs. monthly-equivalent rate)
- [ ] Contract terms: deposit %, completion %, cancellation policy, data export commitment
- [ ] Bilingual proposal if client speaks Arabic

---

## 6. Operational discipline (what you do after the client pays)

1. **Generate the store** — use the super_admin store-creation flow
2. **Pick a plan tier** — set `Store.plan` to `starter` / `professional` / `enterprise` (use
   `free` only for the grace/lapsed state — it is not a sold tier). The plan-baseline resolver
   (see `packages/shared/src/plan-baselines.ts`) automatically enables every feature included in
   that tier — no manual `StoreFeature` row creation needed for baseline features. The
   upgrade-marketing gate will show an on-brand upsell page to merchants who try to access a
   feature above their plan.
3. **Layer overrides only for hybrid deals** — only flip `StoreFeature` rows for features OUTSIDE
   the chosen plan's baseline (e.g. a starter client who paid for the `loyalty` add-on). `whatsapp`
   is already baseline on every plan — only flip its override to restrict a specific client by
   exception, never to "add" it. Plan changes never touch override rows, so upgrading or
   downgrading the store doesn't lose merchant-paid extras.
4. **Configure payment provider** — set up Tap/MyFatoorah/Hesabe/UPayments credentials per the
   client's account
5. **Provision Meta Commerce catalog** — if the client paid for the WhatsApp Native Catalog Bot,
   click **Provision automatically** in Admin → WhatsApp Bot → MetaCatalogCard. No Meta Business
   Manager steps required from the client.
6. **Onboard the client** — branding, catalog import (Excel → Force AI Store), theme config,
   training session
7. **Verify it works** — place a test order, verify webhooks fire, verify order confirmation email
   arrives, check the `payment_events` audit log shows the full lifecycle
8. **Hand over** — give the client admin credentials, schedule the training session, schedule a
   2-week check-in

---

## 6.5. Operational maturity (defending the SLA when a merchant audits)

The 99.5% uptime + 24h-normal / 4h-critical support response in the contract are not aspirational.
As of 2026-05-27, each SLA component is backed by concrete infrastructure a merchant's CTO can
audit:

| SLA clause                              | Backing infrastructure                                                                                                                                                                                                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 99.5% monthly uptime                    | CI-gated pushes (pre-push hook + GitHub Actions must pass before code reaches production) · Railway + Cloudflare Workers deploys gated by CI green · Inngest functions self-register on boot so post-deploy job queues don't stall (`apps/api/src/index.ts` self-PUT to `/api/v1/inngest` 3s after listen)                     |
| 24h support response                    | Telegram alert pipeline fires on every main-branch CI failure with branch / sha / commit title / author / failed jobs in one message · cross-repo watchdog re-pages every 2h until acknowledged · Uptime monitor + alert bridge on critical endpoints                                                                          |
| 4h critical response                    | Auto-fix watchdog detects red main within 17min · Telegram + email dual channel · `scripts/rollback.sh` reverts the bad deploy + redeploys Cloudflare Workers + Railway in <5min                                                                                                                                               |
| Daily backups + 30-day retention        | Daily local `pg_dump` via launchd `com.forceai.neon-backup` (3:30am, 30-day rotation at `~/Desktop/projects/_backups/force-website-builder/`) · `scripts/backup-db.sh` for on-demand dumps · `docs/ROLLBACK.md` §C documents the pg_restore procedure                                                                          |
| Kuwait Law 13/2023 Data Processor split | `/auth/me/erase` + `/auth/me/export` endpoints actually implemented · 72h breach notification path via alert bridge · per-store tenant isolation via RLS (`apps/api/src/middleware/tenant-context.ts`)                                                                                                                         |
| Payment auditability (dispute-proof)    | Append-only `payment_events` table records every payment-status transition + raw provider webhook payload (`apps/api/src/services/payment-event.service.ts`) · `GET /api/v1/payments/:id/events` returns the full lifecycle · 6-month-later dispute can be reconstructed with proof from Tap / MyFatoorah / Hesabe / UPayments |

**When to bring this table up:**

- The merchant asks "how do I know you can hold the SLA"
- The merchant is enterprise-scale + sends a security questionnaire
- The merchant has a CTO/CIO on the call who'll dig into operations

**When NOT to:**

- 1500–5000 KWD SME deals — the merchant doesn't care + listing this depth reads as
  overcompensation. Trust the contract numbers.

---

## 7. What this doc is NOT

- **Not a public pricing page.** No version of this is published. Clients get a custom proposal,
  not a tier list.
- **Not a feature paywall enforcement reference.** That logic is in `StoreFeature` table +
  per-route `feature-gate.ts` middleware.
- **Not a contract template.** Use Force Media's existing legal templates for the actual contract;
  this doc informs the dollar amounts in the contract.
- **Not exposed to the codebase.** Future engineers don't need to read this — pricing decisions
  live in your head + the proposals you send, not in code.

---

## 8. Companion documents

- [`02-feature-catalog.md`](02-feature-catalog.md) — feature inventory (informs what's available
  in a proposal)
- [`03-competitive-positioning.md`](03-competitive-positioning.md) — market positioning context
  (informs objection-handling)
- [`05-pitch-deck-outline.md`](05-pitch-deck-outline.md) — sales pitch (for first conversations,
  before proposal)
- [`docs/audits/_slices/06-cost-forecast.md`](../audits/_slices/06-cost-forecast.md) — full infra
  cost forecast (sets your cost floor)
- [`packages/shared/src/features.ts`](../../packages/shared/src/features.ts) — FEATURE_REGISTRY
  source of truth
