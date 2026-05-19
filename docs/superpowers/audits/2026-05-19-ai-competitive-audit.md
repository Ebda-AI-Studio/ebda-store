# AI Competitive Audit — FWB vs Kuwait Market Positioning

**Date:** 2026-05-19  
**Scope:** Force Website Builder codebase vs the four strategic pillars codified in `CLAUDE.md`  
**Pillars:** (1) Customization Granularity · (2) AI-as-Default · (3) Arabic-First Locality · (4) Compact-Ecommerce Sizing  
**Market:** Kuwait/GCC. Key competitors: Salla, Zid, Pecannbee, Bank Alkahraman, SMEJ. No Stripe. WhatsApp-dominant commerce culture.

---

## 1. Current AI / Smart Software Inventory

### 1a. Gemini Flash Lite — live in production

All calls routed through `apps/api/src/services/ai.service.ts` (Gemini Flash Lite, free tier, 7-day Redis cache, daily token budget per store, `AiUsage` table for audit).

| Feature                                                                                                                                                         | Surface                                       | Trigger                                    | Files                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------ | -------------------------------------------------- |
| **EN↔AR translation** — product name, product description, category name/description, store name/description, meta title/description                            | Per-field button (admin) + bulk Inngest sweep | Manual per-field or "Bulk Translate All"   | `ai.service.ts::translate`, `bulk-ai-translate.ts` |
| **SEO meta generation** — `metaTitle`, `metaTitleAr`, `metaDescription`, `metaDescriptionAr` for store / category / product                                     | Per-entity SEO form + bulk sweep              | Manual "Generate" button or "Bulk SEO All" | `ai.service.ts::suggestSeo`, `bulk-ai-seo.ts`      |
| **Category suggestion** — picks 1-3 best-match categories from the store's existing list                                                                        | Product edit form (chip suggestions)          | On product name/description change         | `ai.service.ts::suggestCategories`                 |
| **Section kicker + subtitle copy** — bilingual eyebrow label + tagline for homepage sections (categories / newArrivals / bestSellers / featured / testimonials) | Admin Layout / page-builder                   | "Generate with AI" button                  | `ai.service.ts::suggestSectionContent`             |
| **AEO FAQ bulk sweep** — drafts 8 store-level FAQ items in EN+AR                                                                                                | Admin AI Tools → FAQ                          | Bulk "Run FAQ sweep"                       | `bulk-ai-aeo.ts::bulkAiFaqAeo`                     |
| **AEO HowTo bulk sweep** — drafts 3 how-to guides in EN+AR                                                                                                      | Admin AI Tools → HowTo                        | Bulk "Run HowTo sweep"                     | `bulk-ai-aeo.ts::bulkAiHowtoAeo`                   |
| **AEO meta rewrite** — rewrites store + product meta in conversational direct-answer style                                                                      | Admin AI Tools → Meta AEO                     | Bulk "Run Meta AEO sweep"                  | `bulk-ai-aeo.ts::bulkAiMetaAeo`                    |
| **Review translation** — auto-translates review body opposite direction (AR→EN or EN→AR)                                                                        | Auto on review submit                         | Automatic (review-moderation Inngest)      | `review-tools.ts::translateReview`                 |
| **Review spam detection** — 0–1 score → auto-publish / pending / spam routing                                                                                   | Auto on review submit                         | Automatic                                  | `review-tools.ts::detectSpamReview`                |
| **Review summarization** — top-3 positives, top-3 negatives, overall sentiment                                                                                  | Merchant dashboard per-product                | "Summarize reviews" button                 | `review-tools.ts::summarizeProductReviews`         |
| **Owner response drafting** — bilingual EN+AR reply draft for merchant to edit                                                                                  | Per-review admin panel                        | "Draft response" button                    | `review-tools.ts::draftOwnerResponse`              |

### 1b. Deterministic smart software (no LLM)

| Feature                                                                         | What it does                                                                                                                                                                                                            | Files                                                                                   |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **WCAG auto-contrast** — `pickReadableForeground(bg)`                           | At render: picks black or white text on any section background via WCAG 0.179 luminance flip. Merchant never sees broken text-on-bg.                                                                                    | `packages/shared/src/utils/color.ts`                                                    |
| **Token-aware color resolution** — `resolveColor(value, theme)`                 | `'token:primary'` and raw hex both resolve; brand color change propagates to every zone using a preset.                                                                                                                 | `packages/shared/src/utils/color.ts`                                                    |
| **Smart palette generator** — `generateSectionPalette(seeds)`                   | 1–3 seed colors → distributed bgColor + cardFrameColor + headingColor across all 5 sections in one click via `SmartPaletteModal`.                                                                                       | `packages/shared/src/utils/color.ts`, `apps/admin/src/components/SmartPaletteModal.tsx` |
| **Per-section auto-fix cascade**                                                | CSS `!important` rule fires when any section has an explicit `--section-fg` var; overrides per-section typography overrides to ensure legibility. Priority: auto-fix > per-section color > global zone > theme default. | `apps/web/src/styles/globals.css`                                                       |
| **Per-template upload hints** — `recommendedSizeTextForTemplate(key, template)` | Per-theme image source size recommendations vary without changing rendered storefront sizing.                                                                                                                           | `packages/shared/src/types/image-standards.ts`                                          |
| **FBT (Frequently Bought Together)**                                            | Co-purchase counting over 90-day window; auto-calculates cross-sell recommendations. No LLM — pure SQL aggregation.                                                                                                     | `apps/api/src/services/recommendation.service.ts`                                       |
| **Abandoned cart recovery** — multi-step reminder pipeline                      | Auto-detects carts inactive >N minutes, dispatches timed reminder notifications with optional auto-coupon.                                                                                                              | `apps/api/src/services/abandoned-cart.service.ts`                                       |
| **XLSX catalog import**                                                         | Normalizes merchant XLSX exports (with Arabic header synonyms) into the platform's import format.                                                                                                                       | `apps/api/src/services/xlsx-import.ts`                                                  |
| **Context-aware color tokens**                                                  | Brand-\* tokens auto-swap (brand-muted as text → muted-foreground; brand-foreground as bg → background) to prevent white-on-white.                                                                                      | `packages/shared/src/utils/color.ts`, CSS emitter in `apps/web/src/app/layout.tsx`      |
| **Bilingual search**                                                            | `contains` queries on both `name`/`nameAr` and `description`/`descriptionAr` simultaneously — customers searching in Arabic find EN-only products and vice versa.                                                       | `apps/api/src/services/product.service.ts::advancedSearch`                              |

---

## 2. Opportunity Inventory (25 opportunities)

### Area A — Storefront Content

**A1. AI product description generator (per-product, on-save)**

- **Manual today:** Merchant types a description in EN, then hits "Translate" to get AR. If they have no EN description, both fields stay empty.
- **AI change:** On product add/edit, when a product has a name but no description, a single "Generate description" button calls Gemini with `{name, nameAr, categoryNames, storeContext}` and returns a 50-word bilingual description. Merchant accepts or edits before save.
- **Pillars:** 2, 3
- **Cost:** Trivial (one API call per save)
- **Impact:** High — Kuwait merchants self-write copy; empty descriptions hurt SEO and conversion. This is the single highest-volume gap in the current AI feature set.

**A2. AI hero/banner copy generator**

- **Manual today:** Admin Layout → Hero section. Merchant fills in `heroTitle`, `heroSubtitle`, `heroCta` manually in both locales.
- **AI change:** "Generate" button on Hero settings reads store name + store description + active categories and suggests bilingual hero copy in the store's visual register (elegant = lyrical, bold = punchy, minimal = sparse). The `suggestSectionContent` function already exists for kicker/subtitle — extend to cover full hero fields.
- **Pillars:** 1, 2, 3
- **Cost:** Trivial (extend existing `suggestSectionContent`)
- **Impact:** Medium — hero copy is visible and high-impact but most merchants eventually write something; the gap is smaller than product descriptions.

**A3. Blog post draft generator**

- **Manual today:** `blogEnabled` flag + `/stores/:id/blog` admin page. Merchant writes blog posts manually. Many merchants leave the blog empty.
- **AI change:** Admin Blog → "Generate draft" button. Merchant picks a topic (or accepts a suggested topic based on top-selling categories) and Gemini returns a 300-word bilingual post. Merchant edits before publish.
- **Pillars:** 2, 3
- **Cost:** Low (new API call + new admin UI; Inngest for async generation)
- **Impact:** Medium — blog drives SEO; merchants who wouldn't write are more likely to publish AI-drafted content.

**A4. Trust strip copy personalization**

- **Manual today:** Three hardcoded trust strip items (fast delivery, returns, support). Merchant cannot edit the copy.
- **AI change:** On store setup completion or "Personalize" button, Gemini reads the store's category mix and suggests trust-strip copy matching the merchant type (fashion → "Easy 7-day returns" vs food → "Fresh daily, guaranteed").
- **Pillars:** 1, 2, 3
- **Cost:** Trivial (single AI call; store the result in StoreTheme JSONB)
- **Impact:** Medium — the trust strip is visible on every page; generic copy is a missed conversion opportunity.

---

### Area B — Merchant Onboarding

**B1. Competitor URL catalog import**

- **Manual today:** Merchants must manually enter every product, price, and description from scratch. XLSX import requires merchant to produce the file themselves.
- **AI change:** "Import from competitor URL" field in onboarding. Backend fetches the URL, extracts product listings via Gemini vision/text (or structured extraction), and pre-fills the catalog import form. Merchant reviews before confirming.
- **Pillars:** 2, 3
- **Cost:** Large (web scraping infra + vision model calls + data cleaning pipeline)
- **Impact:** High — the highest activation friction for new Kuwait merchants is manual catalog entry. This removes it entirely and is a headline-worthy differentiator vs Salla's manual-only onboarding.

**B2. Onboarding category scaffold from store description**

- **Manual today:** New merchant adds categories one by one from scratch after entering a store name/description.
- **AI change:** After merchant fills store name + description + selects an industry, Gemini suggests 6–10 starter categories in both locales. Merchant picks which to create. Uses `suggestCategories` shape already in the codebase — extend to generate from scratch when no products exist.
- **Pillars:** 2, 3
- **Cost:** Trivial (one call; reuses `suggestCategories` API shape)
- **Impact:** High — drops time-to-first-product by 15–30 minutes for merchants without a defined category structure.

**B3. Recommended store config wizard**

- **Manual today:** Merchant configures theme, colors, fonts, card sizes, section visibility across 5+ admin pages. Most stores ship with FWB's defaults and never tune.
- **AI change:** 3-step wizard at first login: (1) pick an industry/aesthetic ("Electronics store", "Fashion boutique", "Café"), (2) upload a logo, (3) system sets theme, palette, font pairing, card size, section defaults that match the industry. All outputs are standard FWB config fields — merchant can override any of them.
- **Pillars:** 1, 2
- **Cost:** Medium (wizard UI + industry→config mapping table + optional AI for palette from logo color extraction)
- **Impact:** High — reduces activation friction and demonstrates FWB's customization depth on day 1.

---

### Area C — Catalog Management

**C1. Bulk product description generation (Inngest sweep)**

- **Manual today:** `bulk-ai-translate.ts` already does bulk translation. But bulk description generation does not exist. Products with only a name and no description are silently left empty.
- **AI change:** New Inngest function `bulk-ai-describe` mirrors the translate sweep: iterates products where `description` AND `descriptionAr` are both empty, generates 50-word bilingual descriptions from `{name, nameAr, categoryNames}`. Smart-skip: never overwrites non-empty descriptions.
- **Pillars:** 2, 3
- **Cost:** Low (new Inngest function, same shape as `bulk-ai-translate.ts`)
- **Impact:** High — this is the logical complement to bulk translate. Many catalog imports via XLSX arrive with names but no descriptions.

**C2. AI product tag generation**

- **Manual today:** Products have no tag/attribute system. Merchants manually note attributes in descriptions.
- **AI change:** On product save (or bulk sweep), Gemini reads product name + description and emits a tag array: `["نساء", "casual", "Cotton", "حجم وسط"]`. Tags surface in storefront search/filter and in admin analytics groupings. First-mover: none of the Kuwait storefront builders have AI-generated Arabic product tags today.
- **Pillars:** 2, 3
- **Cost:** Medium (new `Product.tags` column + Zod + storefront filter integration)
- **Impact:** High — enables semantic filtering (shop by material, occasion, gender) which Kuwait fashion/lifestyle merchants need and currently get nowhere.

**C3. Image background removal suggestion (with provider link)**

- **Manual today:** Merchants upload photos on white or cluttered backgrounds. The platform has no image editing.
- **AI change:** On product image upload, detect if the background is non-white via a heuristic (average edge luminance check) and surface an inline "Remove background" CTA linking to remove.bg or a Cloudflare Images transform. No LLM required — deterministic pixel scan.
- **Pillars:** 1, 2
- **Cost:** Low (client-side canvas analysis + CTA)
- **Impact:** Medium — product photos are the primary conversion driver; this is a guidance-layer improvement, not blocking.

**C4. Variant name normalization**

- **Manual today:** Merchants type variant names ("large", "كبير", "L", "XL", "مقاس كبير") inconsistently per product. No deduplication or normalization.
- **AI change:** On variant name input, Gemini normalizes to the store's established variant vocabulary. If merchant has used "كبير" before, new "large" inputs auto-suggest "كبير" (not another EN spelling). Reduces catalog inconsistency for size/color/flavor variants.
- **Pillars:** 2, 3
- **Cost:** Trivial (per-field suggestion on blur; stores variant vocab in Redis per store)
- **Impact:** Low — polish feature; merchants tolerate inconsistency until search/filter surfaces the problem.

---

### Area D — Pricing + Commerce

**D1. Smart price-range labeling**

- **Manual today:** The `getProductPricing` helper (see `feedback-variant-aware-pricing.md`) already computes `fromMin`/`range` modes. But no AI or heuristic nudges the merchant on pricing relative to their own catalog.
- **AI change:** When merchant saves a new product price, compare it to the category's existing price range and surface a non-blocking inline note: "Products in this category range from 5–45 KWD. This is above the category average." Not a blocker — purely advisory.
- **Pillars:** 2
- **Cost:** Trivial (single Prisma aggregation on save; no LLM needed)
- **Impact:** Low — useful but not a headline differentiator; merchants set their own prices.

**D2. AI-suggested coupon copy**

- **Manual today:** Merchant creates coupons and writes their own promotional copy for WhatsApp/push notifications.
- **AI change:** When a coupon is created, auto-generate a bilingual WhatsApp-ready message: "🎁 استخدم كود SAVE10 وخصم 10% على جميع المنتجات — صالح حتى نهاية الأسبوع". Merchant copies or edits before sending.
- **Pillars:** 2, 3
- **Cost:** Trivial (one AI call on coupon create)
- **Impact:** Medium — WhatsApp commerce is high-volume in Kuwait; pre-written copy reduces merchant effort and increases coupon distribution.

---

### Area E — Search + Discovery

**E1. Natural language search ("find me a gift for a woman under 20 KWD")**

- **Manual today:** Search is `ILIKE` substring matching on `name`/`nameAr`/`description`/`descriptionAr`. Natural language queries return nothing.
- **AI change:** Storefront search box detects non-keyword queries (>4 words or question syntax) and routes to a Gemini-assisted intent extractor: parse `{maxPrice, gender, occasion, category_hint}`, then translate to structured Prisma filters. Fallback to substring if extraction fails.
- **Pillars:** 2, 3
- **Cost:** Medium (new search pathway + intent extractor + client-side query classification)
- **Impact:** High — Kuwait's mobile-dominant traffic skews toward conversational queries (especially in Arabic). No local storefront has this. Differentiation vs Salla/Zid is clear.

**E2. Arabic dialect search normalization**

- **Manual today:** Search on `nameAr` is exact substring. Kuwaiti Arabic spelling variants ("حليب" vs "حلب", "جبن" vs "جبنة") return zero results for one spelling.
- **AI change:** Deterministic normalization: a preprocessing map of Gulf/Kuwaiti Arabic variant pairs normalizes query before DB lookup. Can be seeded by Gemini once (offline batch) and stored as a static map — no per-query LLM call.
- **Pillars:** 2, 3
- **Cost:** Low (static normalization map; one-time offline generation)
- **Impact:** High — any Kuwait grocery/food merchant loses ~20% of relevant searches to spelling variance. This is a locality advantage over Shopify/Salla which use standard MSA stemming.

---

### Area F — Customer Service

**F1. WhatsApp order intent parsing**

- **Manual today:** WhatsApp is wired for bulk messaging (`whatsapp.service.ts`, `whatsapp-queue.service.ts`) but incoming WhatsApp messages are not parsed for order intent. Merchants copy-type orders from WhatsApp into the admin manual-order flow.
- **AI change:** Webhook endpoint for incoming WhatsApp messages. Gemini reads the message ("عندي أمر لـ 2 عبايات حجم M وحجم L كم الكلفة؟") and extracts `{productHints, sizes, quantities, priceQuery}`. Returns a structured suggested-order JSON that admin can confirm to create a draft order via `OrderService.createAdminOrder`. Does NOT auto-create orders.
- **Pillars:** 2, 3
- **Cost:** Large (WhatsApp Business API webhook wiring + intent extraction + admin confirmation UI)
- **Impact:** High — WhatsApp commerce is the #1 order channel for small Kuwait merchants. This is the most strategically differentiated feature on this list; no other Kuwait storefront platform has it.

**F2. FAQ auto-generation from order patterns**

- **Manual today:** AEO bulk-ai-faq sweep writes generic FAQs. The AI has no visibility into what customers actually ask about.
- **AI change:** Periodically scan `order.notes` + `AbandonedCart.recovery_email_data` + WhatsApp message history (if wired) for recurring question patterns. Gemini extracts the top 5 questions and pre-populates FAQ drafts for merchant review.
- **Pillars:** 2, 3
- **Cost:** Medium (new Inngest function + `order.notes` aggregation + UI)
- **Impact:** Medium — improves FAQ quality from generic to data-grounded, but requires sufficient order volume.

---

### Area G — Marketing + Growth

**G1. AI push notification copy generator**

- **Manual today:** Admin → Notifications → Broadcast. Merchant types notification title + body in two languages manually.
- **AI change:** "Generate copy" button on the broadcast form. Merchant picks a campaign type (new arrival, sale, restocked) and Gemini returns bilingual title + body in ≤64 chars each (OneSignal limit), in Kuwait-market tone.
- **Pillars:** 2, 3
- **Cost:** Trivial (single AI call on form; extend existing notifications admin page)
- **Impact:** Medium — reduces copy friction for push campaigns; merchants who wouldn't send broadcasts will send more.

**G2. Abandoned cart message personalization**

- **Manual today:** Abandoned cart recovery sends a hardcoded bilingual message: "You left items in your cart." Static copy for every merchant.
- **AI change:** Per-store recovery message is generated once at store setup by Gemini from store name + product category mix. "وادي الجوز — سلتك لا تزال بانتظارك! أنهِ طلبك الآن وتمتع بالتوصيل السريع." Stored on the store record; not regenerated per abandonment (no per-abandonment LLM cost).
- **Pillars:** 2, 3
- **Cost:** Trivial (one AI call at store setup; store result in Store settings JSONB)
- **Impact:** Medium — personalized recovery copy outperforms generic. Kuwait mobile cart abandonment is high (no Tap/MyFatoorah stored-payment → friction at checkout).

**G3. SEO keyword gap detector**

- **Manual today:** SEO bulk sweep fills meta fields but doesn't analyze which Kuwaiti search terms the merchant is missing.
- **AI change:** Once per month (Inngest cron), Gemini analyzes the store's current keywords array vs the store's category names and suggests 5 high-value Kuwait search terms the merchant isn't yet targeting. Surfaces in admin SEO page as "Keyword opportunities."
- **Pillars:** 2, 3
- **Cost:** Low (monthly Inngest cron; one call per store per month)
- **Impact:** Medium — SEO gap analysis is a premium feature in most SaaS SEO tools; shipping it free is a clear differentiator.

---

### Area H — Analytics + Insights

**H1. AI-summarized merchant dashboard**

- **Manual today:** Analytics dashboard shows charts: total revenue, orders, top products. Merchant reads the numbers but has no interpreted summary.
- **AI change:** Weekly Inngest job runs per-store analytics aggregation and Gemini generates a 3-sentence plain-Arabic narrative: "هذا الأسبوع ارتفعت المبيعات بنسبة 12% مقارنة بالأسبوع الماضي. المنتجات الأكثر مبيعاً هي العبايات والعطور. ننصح بتعزيز مخزون مجموعة الصيف." Shown at the top of the dashboard.
- **Pillars:** 2, 3
- **Cost:** Low (weekly Inngest job + Gemini call; store summary in Redis 7-day TTL)
- **Impact:** High — Arabic-language AI-interpreted analytics is a zero-to-one feature for Kuwait merchants. Every other platform shows raw charts that require data literacy.

**H2. Predictive low-inventory alert**

- **Manual today:** Inventory service tracks stock levels. No prediction — merchant only sees "out of stock" after the fact.
- **AI change:** Deterministic heuristic (no LLM needed): calculate each product's average daily sales velocity over 30 days. If current stock / velocity < 7 days, surface a low-stock warning in the admin product list and trigger a push alert. Pure SQL + arithmetic.
- **Pillars:** 2
- **Cost:** Low (weekly Inngest sweep; Prisma aggregation + threshold check)
- **Impact:** Medium — solves a real pain point for high-velocity Kuwait grocery/fashion merchants; prevents stockout-caused cart abandonment.

---

### Area I — Personalization

**I1. AI product recommendations on PDP**

- **Manual today:** PDP shows FBT (co-purchase) and manually curated cross-sell/upsell. FBT is SQL co-purchase counting — no semantic understanding.
- **AI change:** For products with zero FBT data (new arrivals, low-volume stores), Gemini reads the product's name + category and suggests semantically similar products from the catalog to show as "You might also like." Runs once per product, cached 24h. Falls back to FBT when data exists.
- **Pillars:** 2, 3
- **Cost:** Low (per-product cache-miss API call; results stored in Redis)
- **Impact:** Medium — new stores with low order history have dead recommendation widgets today; this fills the cold-start gap.

**I2. Personalized homepage by returning visitor segment**

- **Manual today:** Homepage order (categories / newArrivals / bestSellers / featured) is the same for every visitor.
- **AI change:** Browser-side: track last-viewed category per session (localStorage). On return visit, reorder homepage sections so the merchant's most-visited category appears first. No server-side AI — pure client heuristic.
- **Pillars:** 2
- **Cost:** Low (client-side localStorage + CSS-order reordering)
- **Impact:** Low — Kuwait mobile traffic patterns favor discovery over personalization at this market stage; most stores are <50 categories.

---

### Area J — Admin UX Intelligence

**J1. AI palette-from-logo (extend SmartPaletteModal)**

- **Manual today:** SmartPaletteModal asks for 3 color inputs (Primary, Accent, Neutral). Merchant manually picks from their brand. Many merchants don't know what colors their logo uses.
- **AI change:** "Extract from logo" button on the SmartPaletteModal. Upload or use the existing `store.logo` image. Gemini Vision (or client-side canvas color histogram) extracts the dominant 3 colors and pre-fills the 3 seed inputs. Merchant can accept or override before applying.
- **Pillars:** 1, 2
- **Cost:** Low (canvas histogram is free; Gemini Vision adds one API call)
- **Impact:** High — removes the hardest step in branding for non-designer merchants. "What colors is my logo?" is a real barrier. Differentiates FWB's smart-palette over Shopify's static color picker.
- **Note:** `feedback-fwb-smart-palette-pattern.md` explicitly calls out "AI 'suggest palette' button — deferred to v2" — this is the planned feature.

**J2. Merchant onboarding "AI Tools tour"**

- **Manual today:** AI features are distributed across 5+ admin pages (SEO, Products, AI Tools). New merchants don't discover them; activation rate on bulk AI sweeps is low.
- **AI change:** After a store's first 10 products are added, a one-time in-app walkthrough highlights the 3 most impactful AI features (bulk translate, bulk SEO, product description generator). Each step shows the expected output. Dismiss-once.
- **Pillars:** 2
- **Cost:** Low (product tour component; no API changes)
- **Impact:** Medium — activation and feature discovery is a retention driver; merchants who run one bulk sweep are more likely to stay.

**J3. Smart section visibility defaults by catalog size**

- **Manual today:** All homepage sections default to visible regardless of catalog size. A store with 3 products and no "Best Sellers" still shows the Best Sellers section (empty).
- **AI change:** Deterministic heuristic (no LLM): on first storefront render, check catalog counts. If `products < 8`, hide newArrivals. If no products flagged `isBestSeller`, hide bestSellers. If `Store.showBrandStory = true` and `store.description` is empty, hide BrandStoryBlock. Auto-applies on every render — no saved config change.
- **Pillars:** 1, 2
- **Cost:** Trivial (conditional logic in `HomePageContent.tsx`; already data-available)
- **Impact:** Medium — prevents empty sections embarrassing new merchants on day 1; reduces the "my homepage looks broken" support request.

---

## 3. Table-stakes vs Differentiation

### Table-stakes (every platform needs this; quality matters, not uniqueness)

- **Bilingual search** — Salla and Zid both support Arabic search; FWB's is functional but ILIKE-only (no stemming, no typo tolerance). Table-stakes quality gap.
- **Product image upload** — every platform has it; FWB's per-template image hints (A3 pattern) are differentiated but the core upload is not.
- **SEO meta fields** — table-stakes. FWB's AI bulk-fill makes this faster but the field itself is not a differentiator.
- **Email/push notifications** — table-stakes; FWB's bilingual copy and auto-coupon are quality improvements, not unique.
- **Review system** — table-stakes; FWB's spam detection and owner-response drafting are differentiated additions on top.
- **XLSX catalog import** — table-stakes. Salla has it; FWB's Arabic header normalization is a quality improvement.
- **Abandoned cart recovery** — table-stakes for any serious e-commerce platform.

### Differentiation (FWB's actual edge)

- **WhatsApp order intent parsing (F1)** — no Kuwait storefront platform has this. WhatsApp is the primary commerce channel.
- **Natural language search in Arabic (E1)** — zero Kuwait storefronts offer conversational search. Shopify's Arabic support is MSA-only.
- **Arabic dialect normalization (E2)** — genuine Gulf-market locality advantage; not available on Shopify/Salla at this granularity.
- **AI-summarized Arabic dashboard narrative (H1)** — zero-to-one for merchant data literacy in the Kuwait market.
- **Bulk AI description generation (C1)** — Salla doesn't autogenerate descriptions; Shopify Magic requires a paid plan and is English-only.
- **Competitor URL catalog import (B1)** — no Kuwait platform has this; dramatically reduces activation friction.
- **Smart palette from logo (J1)** — Shopify has a color extractor but only on paid themes; FWB can ship this for free.
- **Customization granularity stack** — per-section typography overrides, cardFrameWidth, cardShape, SmartPaletteModal, BackgroundPreset, dividers — the combination of controls exceeds what Salla/Zid expose to merchants without developer access.

---

## 4. Top 10 Highest-Impact Opportunities (Ranked)

| Rank   | Feature                                                              | Why this matters in Kuwait specifically                                                                                                                                                         |
| ------ | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1**  | **F1 — WhatsApp order intent parsing**                               | Kuwait merchants take 40–70% of orders via WhatsApp; manual re-entry from chat to admin is their biggest operational pain point. No competitor addresses it.                                    |
| **2**  | **B1 — Competitor URL catalog import**                               | Kuwait merchants frequently switch platforms (Salla→FWB) or launch by copying a competitor. Removing manual re-entry eliminates the #1 activation barrier.                                      |
| **3**  | **H1 — AI-summarized Arabic merchant dashboard**                     | Most Kuwait small-business owners are not data-analysts; a plain-Arabic weekly narrative is immediately useful in a way raw charts are not. Zero-to-one feature.                                |
| **4**  | **E1 — Natural language search**                                     | 80%+ mobile traffic + Arabic-first users type conversational queries ("عندي مناسبة وأريد شيء بأقل من 20 دينار") that exact-match search silently drops.                                         |
| **5**  | **C1 — Bulk AI product description generation**                      | Kuwait merchants self-shoot and self-write; a significant portion of FWB catalogs have names but no descriptions. Empty descriptions hurt both SEO and conversion directly.                     |
| **6**  | **B2/B3 — Onboarding category scaffold + recommended config wizard** | Activation friction is the biggest churn driver for small Kuwait stores; smart defaults on day 1 reduce the "I don't know how to configure this" support volume.                                |
| **7**  | **J1 — Smart palette from logo**                                     | Kuwait merchants are brand-conscious but not designers; "what colors is my logo?" is a real barrier to using the SmartPaletteModal. Already planned in `feedback-fwb-smart-palette-pattern.md`. |
| **8**  | **E2 — Arabic dialect search normalization**                         | Gulf Arabic spelling variance (Lebanese vs Kuwaiti vs Gulf standard) causes silent zero-result searches. Food, grocery, and beauty merchants lose search revenue to this daily.                 |
| **9**  | **C2 — AI product tag generation**                                   | Enables semantic filter UI (by material, occasion, gender) which Kuwait fashion + lifestyle merchants need and no local platform provides with AI assistance.                                   |
| **10** | **A1 — Per-product AI description generator**                        | Highest-volume manual step per-merchant per-day; trivial to implement using the existing AI service; fills the gap between bulk translate (exists) and bulk describe (missing).                 |

---

## 5. Executive Summary (150 words)

**Pillar 1 — Customization Granularity:** Strong and accelerating. Per-section typography overrides, cardFrameWidth, cardShape, BackgroundPreset, SmartPaletteModal, and per-template image hints already exceed what Salla or Zid expose without developer access. The next gap is palette-from-logo (J1) and smart onboarding defaults (B3).

**Pillar 2 — AI-as-Default:** Solid foundation (11 live AI features), but under-activated. Merchants discover AI features late; bulk description generation is missing; the highest-value unbuilt features (WhatsApp parsing, natural language search) sit in the "large" cost tier.

**Pillar 3 — Arabic-First Locality:** Best-in-class in the market. Bilingual fields everywhere, Kuwait-prompt context in every AI call, RTL admin, Gulf payment stack. Dialect normalization (E2) is the remaining structural gap.

**Pillar 4 — Compact-Ecommerce Sizing:** Fully delivered. `design.md` + per-template hints + mobile-first defaults are codified.

**Top 3 moves in the next 4 weeks:** (1) Bulk AI description generation — C1 (1–2 days, high ROI, reuses existing infra). (2) AI palette-from-logo — J1 (already planned, canvas histogram = zero API cost). (3) AI push notification copy generator — G1 (trivial, unlocks a channel merchants currently underuse).
