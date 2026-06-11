# Pitch Deck Outline

> 12-slide outline for sales / investor / acquirer conversations about Force AI Store. Adapt slides 11–12 per audience.

---

## Slide 1 — Title

**Force AI Store** — Kuwait's e-commerce platform, built for Arabic merchants.

Subtitle: _Sell online in 4 hours. Bilingual from minute one. KNET-native. AI-assisted._

Visual: hero shot of [wadyaljuz.com](https://wadyaljuz.com) on a phone, bilingual.

---

## Slide 2 — The Kuwait Problem

**Today, a Kuwait merchant who wants to sell online faces 3 bad options:**

1. **Shopify** — $30–80/mo + $20/mo Arabic translation app + 3rd-party KNET plugin + no AI = $80+/month for a half-localized store
2. **Salla** — Saudi-first, Mada/STC Pay native, KNET as an afterthought, Arabic-only storefronts, no AI
3. **WooCommerce + agency** — flexible but needs a developer who quits in 3 months, $5–15K upfront, ongoing maintenance burden

**The gap:** an opinionated, Kuwait-native, AI-included platform priced for SMBs at $30–60/month.

Visual: 3-column comparison showing the gaps in each existing option.

---

## Slide 3 — Our Solution

**Force AI Store is what Shopify would look like if Shopify was built in Kuwait.**

- Arabic + English equal — every field, every page, every email
- KNET works on day one through 4 native gateways (Tap, MyFatoorah, Hesabe, UPayments)
- AI fills product translations, SEO, FAQs, categories — included free
- Custom domain auto-provisioned per merchant
- Full inventory + accounting inside the same admin (no QuickBooks)

Visual: split-screen — same product page in English + Arabic, with the merchant's brand color and KNET logo visible.

---

## Slide 4 — Why now

**Three converging waves in 2026:**

1. **Kuwait e-commerce TAM growing** — ~$3.5B GMV in 2026, +18% YoY, but platform tooling is still 5 years behind
2. **AI commodity unlocks** — Gemini Flash Lite free tier (1,000 req/day per platform) lets us ship $20/mo Shopify-app-equivalent features at $0 cost
3. **Kuwait Law 13/2023** — new data residency + erasure requirements that Shopify (US-hosted) handles poorly. Local platform = compliance moat.

Visual: 3 timeline arrows converging into a single "now" point.

---

## Slide 5 — The 4 Pillars (our moat)

| Pillar                        | What it means                                                      | Durability                                             |
| ----------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------ |
| **AI-as-default**             | Translation, SEO, FAQ, category, review tools all free-tier-Gemini | 12–18 months (until competitors integrate Gemini)      |
| **Arabic-first data model**   | Bilingual fields on every entity; RTL admin native                 | 60+ months (hard to retrofit on existing platforms)    |
| **Kuwait payment stack**      | 4 KNET providers, per-store encrypted credentials                  | 60+ months (contractual + compliance overhead to copy) |
| **Customization granularity** | Per-section typography, palette, layout, theme flags               | 12–24 months (requires ongoing investment)             |

Visual: 4 stacked pillars, each labeled with durability years.

---

## Slide 6 — Product Snapshot

**One screenshot per key surface:**

1. Storefront PDP — bilingual, mobile, KNET checkout button visible; product discount "Was / Now" strikethrough shown
2. Admin Dashboard — 8-hub navigation, recent orders panel
3. AI Bulk Sweep — "Translating 235 products to Arabic" progress UI
4. Finance Hub — full Chart-of-Accounts with journal entries and P&L report
5. Page Builder — drag-and-drop section ordering with live preview; Navigation + Footer consolidated here
6. Product Discount — per-product discount dropdown (Percentage / Fixed KWD) with live discounted-price preview

Visual: 5-6 phone/laptop mockups in a tight grid.

---

## Slide 7 — Traction

**As of 2026-05-22 — update before pitching:**

- **2 live merchants** in production
  - **Wady Aljuz** (food/grocery): 235 products, 8 categories, KWD ~5,000 GMV/mo
  - **Palora** (lifestyle): bilingual, mobile-first
- **Codebase:** 1,158 files, 79 database models, 30 async background jobs, 5 themes
- **Infrastructure:** Vercel Pro + Neon Launch (paid), 99.9% uptime since launch
- **Zero security vulnerabilities** at every npm audit severity (verified 2026-05-22)
- **Comprehensive audit completed** (security, performance, infrastructure, business) — see internal `docs/audits/`

For investor/acquirer slides, replace this with revenue + MAU + CAC/LTV when those exist.

Visual: 2 merchant logos + 4 KPI bubbles.

---

## Slide 8 — Business model

**Managed e-commerce platform delivered as an agency service.** Custom proposal per client — no public tier list.

How it works:

1. Client comes to Force AI / Force Media
2. Sees the feature catalog, picks what they need
3. Force AI sends a custom proposal (setup fee + monthly platform fee + addon features)
4. Client signs + pays
5. Force AI does the onboarding personally — brand setup, catalog import, theme config, training session
6. Client's store goes live, fully configured

**Why this model fits Kuwait:**

- Premium positioning matches Force Media's existing agency relationships
- Custom contracts = no race-to-the-bottom against Salla/Shopify
- High-touch onboarding builds merchant loyalty + reduces churn
- Each merchant uses their own payment provider account (no CBK licensing concerns)

**Unit economics (per the 2026-05-22 audit):**

- Per-merchant infra cost: ~$13/mo today, dropping to ~$1.71/mo at 10k MAU
- Gross margin >90% on any reasonable per-client contract
- Setup fees recoup onboarding labor + buffer for first-year margin

**Pricing details:** see [04-pricing-tiers.md](04-pricing-tiers.md) — proposal pricing framework with feature value bands, cost floors, sample proposal structures (basic / mid-market / enterprise).

Visual: a single-frame "how it works" diagram showing the 6-step client journey from inquiry to launch.

---

## Slide 9 — Market

**Kuwait e-commerce:**

- TAM: ~$3.5B GMV/yr in 2026
- ~5,000 active online merchants in Kuwait
- Growing 18% YoY
- SMB segment underserved by global SaaS (Shopify) + regional players (Salla, Zid focus Saudi)

**Realistic SOM (Force AI Store at maturity):**

- Year 1: 25-50 hand-onboarded Kuwait merchants × custom proposal ARPU
- Year 3: 200-500 merchants × custom proposal ARPU + 1-2 additional onboarding staff
- Year 5 (GCC expansion): scale via partner agencies in Saudi / UAE / Bahrain referring clients

Agency model trades raw merchant count for higher per-client revenue + lower churn. Per-merchant infra cost ceiling: $1.10/mo at 100k MAU — gross margin stays >90% on every contract.

GCC expansion path: add Mada (Saudi) + Benefit (Bahrain) + UAE payment rails → 10× TAM.

Visual: Kuwait market funnel → SMB segment → Force AI Store's wedge.

---

## Slide 10 — Competitive moat

**Why a Kuwait merchant chooses Force AI Store over Shopify in 2027:**

| Switching cost                       | Shopify → FWB                   | FWB → Shopify                                           |
| ------------------------------------ | ------------------------------- | ------------------------------------------------------- |
| Bilingual content already translated | 0 (we keep it)                  | High (Shopify needs $20/mo app + manual re-translation) |
| KNET integration                     | 0 (we configure for them)       | Medium (3rd-party plugin)                               |
| Custom domain                        | 0 (we provision via Vercel API) | 0                                                       |
| Product data export                  | 0 (CSV / Excel export)          | 0                                                       |
| Storefront design                    | Low (5 themes ≠ Shopify's 100+) | 0                                                       |

**The asymmetry:** moving TO Force AI Store costs nothing and unlocks features. Moving FROM Force AI Store costs translation + KNET + AI features.

Visual: 2-column table emphasizing FROM vs TO asymmetry.

---

## Slide 11 — Team

**Force AI / Force AI Store** is built by Ahmad Sharaf:

- Kuwait-based engineer + product lead
- Sister company to Force Media Kuwait (the agency arm) — direct merchant feedback loop from day one
- Codebase reflects an experienced full-stack engineer who has shipped through multiple production incidents (per the audit's "guardrails everywhere" assessment)
- Currently a 1-person shop. Hiring plan: 1 Kuwait-based designer + 1 customer success rep at Year 1 ARR > $100K

**Bus factor risk acknowledged.** Mitigation: comprehensive `CLAUDE.md` + `docs/audits/` codebase documentation; full 2-week handoff plan available for any acquirer.

Visual: Ahmad's photo + bio + Force Media logo connection.

(Adjust this slide heavily for investor vs acquirer audiences — for acquirers, lead with the bus-factor mitigation plan.)

---

## Slide 12 — The Ask

**Adapt this slide per audience:**

### For investors

> Raising $250K seed (Year 1 runway + design hire + Kuwait merchant acquisition).
>
> Valuation: $2M pre-money (8% dilution).
>
> Use of funds: 60% Kuwait merchant acquisition + content marketing, 25% engineering (designer + senior dev), 15% ops (legal + payment provider partnerships).

### For acquirers

> Open to strategic acquisition by:
>
> - Regional e-commerce platforms (Salla, Zid) entering Kuwait
> - GCC fintech / payment processors (Tap, MyFatoorah parent) forward-integrating into merchant tooling
> - Saudi/UAE PE funds with GCC e-commerce thesis
>
> Estimated range: $300K–$800K (codebase replacement + strategic optionality + bundled with Force AI's WBS WhatsApp product).
>
> Full acquirer-grade due diligence package available — see internal `docs/audits/2026-05-22-comprehensive-saas-audit.md`.

### For Kuwait merchants

> **Request a tailored proposal.** Force AI Store is a managed e-commerce service — every client gets a custom contract built around the features they need. Talk to us at [forcemediakw.com/contact](https://forcemediakw.com/contact). Live demo of a working Kuwait store at [wadyaljuz.com](https://wadyaljuz.com).

Visual: clean ask line with contact email + Force AI Store logo.

---

## Slide-by-slide design notes

- **Color palette:** Force AI brand orange (#FF7700) + Force Media maroon (#2D1418) + neutral (#ECECEC)
- **Font:** for the deck, a clean Arabic-capable typeface like IBM Plex Sans Arabic (free) — matches the bilingual product positioning
- **Logo placement:** Force AI Store wordmark top-right corner every slide except #1 and #12
- **Per-slide footer:** small `forcemediakw.com` + slide number, e.g. `1/12`
- **Bilingual deck variant:** consider an Arabic mirror version for Kuwait-domestic merchant pitches. Slides 1-6 + 8 + 12 translate directly; 7 + 9 + 11 may need re-localizing.

---

## Source material

Every claim in this outline is backed by:

- `docs/audits/2026-05-22-comprehensive-saas-audit.md` — full audit report
- `docs/audits/_slices/05-business-features.md` — feature inventory
- `docs/audits/_slices/06-cost-forecast.md` — per-merchant cost math + scaling
- `packages/shared/src/features.ts` — FEATURE_REGISTRY (22 parent features + 14 inventory/accounting sub-features)
- `packages/shared/src/plan-baselines.ts` — plan tier feature baselines (starter/professional/enterprise)
- `CLAUDE.md` lines 1–29 — strategic positioning + 4 pillars
- Production tenants: [wadyaljuz.com](https://wadyaljuz.com) and Palora
