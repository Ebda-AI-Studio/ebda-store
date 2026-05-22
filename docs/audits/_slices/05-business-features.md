## 5. Business Features & Competitive Positioning

### Executive Summary

- **FWB is a proprietary multi-tenant e-commerce platform built by Force AI (Kuwait)**, targeting Kuwait/GCC SMB merchants who need bilingual Arabic-first storefronts with local payment rails (KNET/Tap/MyFatoorah) and built-in AI — a market gap that Shopify, Salla, and Wix leave open.
- **The moat is a 4-pillar stack**: AI-as-default via Gemini Flash Lite (free tier, 11+ live features), Arabic-first locality (bilingual fields everywhere, Gulf payment stack, RTL admin), customization granularity (per-section typography, palette tools, SmartPaletteModal, 7 theme flags), and compact-ecommerce sizing calibrated for GCC mobile merchants.
- **Feature depth exceeds its market tier**: full Chart-of-Accounts accounting, WBS WhatsApp bridge, AEO/GEO schema.org architecture, dual-stack push (VAPID + OneSignal), and Inngest async queue are typically found in platforms charging 10× more.
- **Biggest commercial risk**: AI moat is 12–18 months durable — Salla and Zid can integrate Gemini too. Durable advantages are Kuwait-specific payment integrations (contractual + compliance overhead), bilingual-first data model (costly to retrofit), and the WBS WhatsApp bridge (proprietary cross-product network effect).
- **Pricing model exists in the schema (4 tiers: free/starter/professional/enterprise) but is not yet publicly surfaced** — the platform currently operates in a direct-sales agency model through Force Media Kuwait.

---

### Product Summary (Elevator Pitch)

Force Store (the merchant-facing product name, developed and operated by Force AI — a standalone Kuwait company) is a multi-tenant e-commerce platform that lets Kuwait and GCC SMB merchants launch a bilingual Arabic/English online store in hours rather than weeks. It differentiates on three compounding advantages unavailable in global SaaS alternatives: (1) every manual content task — translation, SEO, category tagging, FAQ writing — has an AI "auto-fill" button powered by Gemini Flash Lite at zero per-call cost to the merchant; (2) the payment stack is native to Kuwait (Tap, MyFatoorah, Hesabe, UPayments, all KNET-compliant) rather than bolt-on; and (3) the entire admin and storefront treats Arabic as the primary language, not a translation overlay.

The platform is deployed at `app.forcemediakw.com` (admin), with per-merchant custom domains on the storefront. Current production tenants include Wady Aljuz (235 products, 8 categories) and Palora. The API runs on Railway; admin and storefront on Vercel. Source code is proprietary (`license: UNLICENSED`).

---

### Feature Inventory

#### 5.1 Storefront Features

| Feature                          | Detail                                                                                                                                                                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Multi-theme system**           | 5 named themes: modern, elegant, classic, minimal, bold. Wady Aljuz uses elegant; Palora uses minimal.                                                                                                                      |
| **Hero banner**                  | Single image or multi-slide (`sliderMode`). Always landscape. 4:3 mobile (2026-05-22 update), 1920×700 desktop.                                                                                                             |
| **Categories grid**              | Nested categories supported. Parent + child hierarchy. Compact sizing (170–200px mobile, 240–280px desktop).                                                                                                                |
| **Product cards**                | 3 distinct render paths: `PecannbeeProductCard` (PLP/search), 5 theme `ProductCard` grids, `ProductCarousel` (homepage strips). All must receive every UX change simultaneously.                                            |
| **PDP**                          | Variant picker, FBT (SQL co-purchase), manual cross-sell/upsell, reviews (verified-purchase only).                                                                                                                          |
| **Cart + checkout**              | Session cart + logged-in cart sync. Multi-step checkout with address + payment provider selection.                                                                                                                          |
| **Wishlist**                     | Persistent wishlist with logged-in account.                                                                                                                                                                                 |
| **Reviews**                      | Verified-purchase gate, star rating, EN+AR review body, AI spam detection (0–1 score), AI review translation, AI owner-response drafting, AI review summarization. No fake/AI-generated reviews (KW Law 39/2014, FTC 2024). |
| **Bottom tab bar**               | Mobile-only: Home / Wishlist / Cart / Search. Hidden on PDP/checkout/auth.                                                                                                                                                  |
| **Floating widget**              | Sticky expandable button group: WhatsApp, Instagram, phone, email, background music, custom links. Premium add-on tier.                                                                                                     |
| **BrandStoryBlock**              | Homepage section using store `heroImage` + `description`. Defaults ON.                                                                                                                                                      |
| **TrustStrip**                   | 3-up trust points above footer. Horizontal or vertical layout. Defaults ON.                                                                                                                                                 |
| **Blog carousel**                | Homepage blog section (requires `blogEnabled` flag). Admin at `/stores/:id/blog`.                                                                                                                                           |
| **Search**                       | Bilingual ILIKE on name + nameAr + description + descriptionAr. Autocomplete platform-level.                                                                                                                                |
| **Multi-language (EN/AR + RTL)** | Full RTL support. Locale-gated `letter-spacing` (Arabic text breaks with Tailwind `tracking-*`). `LanguageContext.tsx` single translation source.                                                                           |
| **PWA support**                  | Installable as mobile app. Per-store feature flag.                                                                                                                                                                          |
| **Cookie consent**               | Banner with `localStorage` persistence. Tracking pixels gated behind consent (GDPR Art. 6(a), KW Law 13/2023).                                                                                                              |
| **AEO / structured data**        | JSON-LD on every page type. Dynamic `/llms.txt`.                                                                                                                                                                            |
| **Per-store visual config**      | 7 merchant-facing theme flags on `StoreTheme` JSONB + `blogEnabled` Store column.                                                                                                                                           |
| **Announcement bar**             | Before-header promo strip.                                                                                                                                                                                                  |
| **Per-section typography**       | Merchants override font size/weight/family per typography zone. `data-zone` attributes wire DOM to per-store CSS emitter.                                                                                                   |
| **Per-section layout/copy**      | Section kicker + subtitle per section, editable in admin Layout page. AI "Generate" button per section.                                                                                                                     |

#### 5.2 Admin Features (8-Hub Navigation)

| Hub           | Landing Route                   | Core Capabilities                                                                                                 |
| ------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Dashboard** | `/stores/:id`                   | Store overview, revenue summary, recent orders                                                                    |
| **Catalog**   | `/stores/:id/products`          | Products CRUD, categories, page-builder, layout/section controls, blog, floating widget, content, AI Tools        |
| **Sales**     | `/stores/:id/orders`            | Orders list + detail, manual order creation, customers CRM, returns/refunds                                       |
| **Stock**     | `/stores/:id/stock/dashboard`   | Inventory dashboard, stock adjustments, suppliers, purchase orders, backorders, reorder alerts, deadstock reports |
| **Finance**   | `/stores/:id/finance/dashboard` | Full Chart-of-Accounts; journal entries, expenses, P&L, two-step approval                                         |
| **Analytics** | `/stores/:id/analytics`         | Overview stats, cohort analysis, conversion funnel, customer segments, product analytics                          |
| **Marketing** | `/stores/:id/ai-tools`          | AI bulk sweeps, WhatsApp (WBS), push notifications, newsletter, abandoned cart, marketing pixels, affiliates      |
| **Settings**  | `/stores/:id/settings`          | Identity, theme/branding, typography, layout, dividers, custom domain, payment providers, feature toggles         |

Super-admin nav adds: Stores management, Users, Audit Logs.

#### 5.3 AI Feature Catalog

| Feature                                            | Quota Model                                          | Status |
| -------------------------------------------------- | ---------------------------------------------------- | ------ |
| EN↔AR translation (product/category/store/meta)    | Smart-skip; per-store daily token budget; global cap | Live   |
| SEO meta generation (titles + descriptions, EN+AR) | Smart-skip                                           | Live   |
| Category suggestion chips                          | Per-field interactive                                | Live   |
| Section kicker + subtitle copy                     | Per-section button                                   | Live   |
| Bulk translate sweep (Inngest, 25-row batches)     | 2.5s throttle (24 RPM under 30 RPM free cap)         | Live   |
| Bulk SEO sweep (store + categories + products)     | 2.5s throttle                                        | Live   |
| AEO FAQ bulk sweep (8 FAQs, EN+AR)                 | Smart-skip (manuallyEdited flag)                     | Live   |
| AEO HowTo bulk sweep (3 guides, EN+AR)             | Smart-skip                                           | Live   |
| AEO meta rewrite (conversational style)            | Smart-skip                                           | Live   |
| Review auto-translation                            | Auto, per review submit                              | Live   |
| Review spam detection (0–1 score)                  | Auto, per review submit                              | Live   |
| Review summarization                               | Per-product button                                   | Live   |
| Owner response drafting                            | Per-review button                                    | Live   |

**Quota architecture:** `AI_DAILY_REQUEST_CAP=1000` + `AI_MONTHLY_REQUEST_CAP=20000` global gates. Per-store daily token budget. 7-day Redis cache on responses. `AiUsage` table audits every call.

**Deterministic smart software (no LLM):** WCAG auto-contrast, token-aware color resolution, SmartPaletteModal generator, FBT (90-day SQL window), abandoned cart detection, XLSX import with Arabic header normalization, bilingual search.

#### 5.4 AEO / GEO Architecture

7-layer architecture shipped 2026-05-12 across 19 commits. Every tenant inherits all layers automatically.

| Layer                              | What ships                                                                                                              |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1. Schema.org JSON-LD              | Store + BreadcrumbList + ItemList on homepage; Product + AggregateRating + Review on PDP; FAQPage + HowTo on help pages |
| 2. Semantic HTML                   | role attributes, itemScope/itemProp microdata on product cards                                                          |
| 3. Dynamic /llms.txt               | Platform-level + per-tenant `/<slug>/llms.txt` per llmstxt.org spec                                                     |
| 4. AI-driven content fill          | 3 AEO Inngest sweeps (FAQ / HowTo / meta-rewrite)                                                                       |
| 5. Bilingual content               | EN + AR columns on every AEO field                                                                                      |
| 6. Knowledge entity links (sameAs) | wikidata, wikipedia, instagram, tiktok, linkedin, facebook, youtube, twitter                                            |
| 7. Real-review JSON-LD             | Populated only from `status='published', verifiedPurchase=true`. AI never generates review content                      |

#### 5.5 Payment Providers

Kuwait payment stack — Stripe not available locally. Per-store credentials AES-GCM encrypted.

| Provider   | Notes                                         |
| ---------- | --------------------------------------------- |
| Tap        | Primary Kuwait gateway. KNET + cards.         |
| MyFatoorah | KNET + cards + Apple Pay. Widely used in GCC. |
| Hesabe     | Kuwait-specific. KNET + Visa/Mastercard.      |
| UPayments  | Kuwait fintech. KNET + digital wallets.       |

KNET (Kuwait national debit network) accessible via all four — dominant payment for Kuwait e-commerce. Finance hub has full Chart-of-Accounts accounting — unusual depth for SMB-tier.

#### 5.6 Multi-Tenant Capabilities

| Axis                           | What merchant can configure                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Custom domain                  | Auto-provisioned via Vercel API                                                                                     |
| Theme                          | One of 5 themes — all 5 receive every platform fix simultaneously                                                   |
| Branding                       | Logo (EN+AR variants), colors, fonts, card frame, section bg presets                                                |
| Per-section typography         | Any zone overridable per-store                                                                                      |
| Theme flags (StoreTheme JSONB) | 7 flags + blogEnabled column                                                                                        |
| Payment provider               | Per-store credentials for Tap/MyFatoorah/Hesabe/UPayments                                                           |
| Email sender                   | Per-store branded Resend sender                                                                                     |
| Push notifications             | Per-store OneSignal app (admin alerts + storefront broadcast separate apps). VAPID key for standards-based web push |
| WhatsApp notifications         | Per-store WBS bridge: API key + 4 approved Meta templates                                                           |
| Feature flags                  | `StoreFeature` rows per store per feature key                                                                       |
| Storage                        | Cloudflare R2 keyed `stores/{storeId}/...`                                                                          |
| AI quota                       | Per-store daily token budget separate from global                                                                   |

#### 5.7 Integrations Inventory

| Integration                    | Purpose                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------- |
| WBS (WhatsApp Business Sender) | Order event → WhatsApp message. Separate Force AI product. Connect-by-key UX |
| Vercel API                     | Auto-provision custom domains for new tenants                                |
| OneSignal                      | Push notifications — dual apps (admin alerts vs storefront broadcasts)       |
| VAPID / Web Push (RFC 8030)    | Standards-based storefront push subscriptions                                |
| Resend                         | Per-store branded transactional email                                        |
| Inngest                        | Async queue for all >300ms / third-party work                                |
| Sentry                         | Error monitoring + profiling                                                 |
| Google Gemini (Flash Lite)     | All AI features. Free tier by default                                        |
| Cloudflare R2                  | Per-tenant media storage                                                     |
| Neon PostgreSQL                | Primary database. Per-commit snapshot branches                               |
| Redis (Railway)                | 7-day AI response cache, session data, idempotency keys                      |
| Marketing pixels               | Meta/Google/TikTok. Per-store, consent-gated                                 |

#### 5.8 Premium / Paid Features (Gated by StoreFeature)

Source: `packages/shared/src/features.ts` (22 keys as of 2026-05-21).

**Tier definitions:** `core` (broadly available), `addon` (opt-in premium), `experimental` (scaffold only, hidden:true).

| Feature Key         | Name                    | Tier         | Status                  |
| ------------------- | ----------------------- | ------------ | ----------------------- |
| coupons             | Coupons                 | core         | Live                    |
| loyalty             | Loyalty Program         | **addon**    | Live                    |
| returns             | Returns & Refunds       | core         | Live                    |
| reviews             | Product Reviews         | core         | Live                    |
| inventory           | Inventory Management    | core         | Live                    |
| tax                 | Tax Management          | core         | Live                    |
| bulk_operations     | Bulk Operations         | core         | Live                    |
| customer_wallet     | Customer Wallet         | experimental | Hidden (no model yet)   |
| upsell_crosssell    | Upsell & Cross-sell     | **addon**    | Live                    |
| whatsapp            | WhatsApp Notifications  | **addon**    | Live (via WBS bridge)   |
| sms                 | SMS Notifications       | **addon**    | Live (infra present)    |
| push_notifications  | Push Notifications      | **addon**    | Live                    |
| email_campaigns     | Email Campaigns         | experimental | Hidden (builder absent) |
| abandoned_cart      | Abandoned Cart Recovery | core         | Live                    |
| affiliate           | Affiliate Program       | **addon**    | Live                    |
| marketing_pixels    | Marketing Pixels        | core         | Live                    |
| shipping_carriers   | Shipping Carriers       | core         | Live                    |
| staff_accounts      | Staff Accounts          | experimental | Hidden (no team model)  |
| pwa                 | PWA                     | core         | Live                    |
| seo                 | SEO Tools               | core         | Live (platform-level)   |
| search_autocomplete | Search Autocomplete     | core         | Live (platform-level)   |
| floating_widget     | Floating Widget         | **addon**    | Live (added 2026-05-21) |

**StorePlan enum** (schema.prisma:454): `free`, `starter`, `professional`, `enterprise`. Default `starter`. No public-facing pricing page in codebase — direct Force Media sales.

---

### Competitive Analysis

| Dimension                    | FWB / Force Store                                                                                         | Shopify (Kuwait)                          | Salla                             | Wix (Kuwait)                                | WooCommerce                   |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------- | ------------------------------------------- | ----------------------------- |
| Bilingual (EN+AR) out of box | Native — bilingual fields on every model, RTL admin                                                       | Add-on (Translate & Adapt ~$20/mo)        | Native AR, limited EN storefront  | Plugin-based, RTL partial                   | Plugin (WPML $99+/yr)         |
| AI translation               | Built-in, free (Gemini Flash Lite)                                                                        | Shopify Magic — EN-only, paid plans only  | Not available                     | Not available                               | Not available                 |
| AI bulk SEO                  | Built-in free — store+categories+products in one sweep                                                    | Shopify Magic — partial, no AR            | Not available                     | Not available                               | Not available                 |
| AEO / AI-engine-optimization | Full 7-layer (Schema.org, /llms.txt, FAQ/HowTo sweeps)                                                    | Schema.org partial, no /llms.txt          | Not available                     | Not available                               | SEO plugins only              |
| Kuwait payment stack (KNET)  | Native (Tap, MyFatoorah, Hesabe, UPayments)                                                               | No KNET. PayTabs/HyperPay via apps        | Native Mada/STC Pay (Saudi-first) | Limited — 3rd party                         | WooPayments plugin            |
| WhatsApp commerce            | WBS bridge: 4-event order notifications via approved Meta templates                                       | Via 3rd-party app ($$$)                   | Via 3rd-party                     | Via 3rd-party                               | Via plugin                    |
| Customization depth          | Per-section typography, per-section bg preset, SmartPaletteModal, 7 theme flags, card size/shape controls | Theme editor (limited free) or Liquid dev | Section-based but limited         | Drag-and-drop but no per-section font/color | Unlimited but requires dev    |
| Storefront themes            | 5 themes (all merchant-configurable)                                                                      | 100+ (most paid $150–350)                 | ~30                               | Hundreds (generic)                          | Thousands (marketplace)       |
| Full accounting (CoA)        | Yes — Finance hub with journal, expenses, P&L                                                             | No (requires QuickBooks/Xero app)         | No                                | No                                          | No                            |
| Inventory management         | Yes — full stock module                                                                                   | Yes (built-in)                            | Basic                             | Basic                                       | Via WooCommerce Stock Manager |
| PWA                          | Per-store, feature-gated                                                                                  | No (requires app or headless)             | Yes                               | No                                          | Via plugin                    |
| Multi-tenant / SaaS model    | Yes — agency deploys many stores from one codebase                                                        | No                                        | No                                | No                                          | No                            |
| Pricing                      | Agency/white-label. No public pricing                                                                     | $39–$399/mo + 2% transaction fee          | ~$15–$99/mo SAR                   | $17–$159/mo                                 | Free + hosting + plugins      |

**Key observations:**

- Shopify charges ~$20/mo just for Arabic translation. FWB ships it built-in and AI-assisted at no per-feature cost — 15–25% effective cost reduction per store.
- Salla is Saudi-first (Mada, STC Pay) — KNET integration absent. FWB's native Kuwait payment stack is a structural moat for Kuwait.
- Multi-tenant architecture (one codebase → N merchant stores) is atypical for the SMB e-commerce space at this price point.

---

### Pricing Positioning

**Current model:** Force Media sells FWB as a managed service through its agency. No public self-serve signup. The `StorePlan` enum exists but pricing surface isn't wired to checkout flow.

**Cost-to-platform per active store/month estimates:**

- Vercel Hobby → Pro mandatory at scale (admin + web share plan).
- Railway single-instance API: ~$10–20/mo shared across tenants; ~80 req/s max sustained on 1GB.
- Neon free tier (10 branches) → paid at higher store counts.
- Gemini Flash Lite: $0 on free tier at typical catalog sizes; ~$5/store/mo at typical paid use.
- Cloudflare R2: near-zero at SMB volumes.
- **Total per-store cost at current scale: $2–8/store/month.** Supports SaaS price point of $30–100/mo with healthy margins.

**Monetization gap:** Addon-tier features (loyalty, WhatsApp, floating_widget, affiliate, upsell_crosssell, sms, push_notifications) are natural candidates for paid tier. None currently connected to billing — super-admin enables manually.

---

### Moat Analysis

| Pillar                      | 12-month | 24-month | 60-month           | Key Risk                                          |
| --------------------------- | -------- | -------- | ------------------ | ------------------------------------------------- |
| AI-as-default (Gemini)      | High     | Medium   | Low (table stakes) | Gemini free-tier pricing changes                  |
| Arabic-first data model     | High     | High     | High               | None structural                                   |
| Kuwait payment stack (KNET) | High     | High     | High               | Salla/Zid entering Kuwait with local KNET         |
| WBS WhatsApp bridge         | High     | High     | Medium             | Meta's native commerce features could commoditize |
| Customization granularity   | High     | Medium   | Medium             | Requires continued investment                     |
| Multi-tenant architecture   | High     | High     | High               | Requires sustained engineering investment         |
| AEO / GEO architecture      | High     | Medium   | Unknown            | AI engine behavior changes                        |

---

### Top 5 Commercial Strengths

1. **Zero-cost AI that would cost $20–50/mo as add-ons on Shopify**: translation, SEO, AEO sweeps, review tools — all backed by Gemini free tier with smart-skip idempotency. Kuwait merchant switching from Shopify saves this on day 1.

2. **Kuwait payment stack is native, not bolt-on**: KNET via Tap/MyFatoorah/Hesabe/UPayments, configured per-store. Salla is Saudi-first with no KNET.

3. **Arabic-first architecture, not afterthought**: bilingual fields on every DB model, RTL admin, Arabic-locale search, AI prompts optimized for Gulf merchant context. Hard to retrofit — structural.

4. **Full Finance hub with Chart-of-Accounts accounting**: SMBs typically pay separately for QuickBooks. FWB ships journal entries, expense approval, P&L, full CoA inside the same admin.

5. **Multi-tenant operator model**: Force Media deploys one codebase for N merchants. Platform improvements reach all merchants simultaneously with no per-merchant upgrade work.

---

### Top 5 Commercial Weaknesses

1. **No self-serve signup or public pricing**: caps growth to what the agency can close manually. DB schema ready but checkout surface doesn't exist.

2. **5 themes vs 100+ on Shopify**: limited variety is a real purchase objection.

3. **No app marketplace**: Shopify's ~8,000 apps is a major retention driver. Every integration must be built first-party.

4. **Single Railway instance bottleneck (~190 req/s sustained)**: high-traffic store can degrade for all tenants. Vertical scale = Railway Pro; horizontal = architectural changes.

5. **Three experimental features with no backing code** (`customer_wallet`, `email_campaigns`, `staff_accounts`): `hidden: true` in feature registry. Absence of multi-staff accounts limits appeal to merchants with teams.
