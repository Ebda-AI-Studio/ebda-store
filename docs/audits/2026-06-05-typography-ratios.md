# Typography Ratios Audit — Force Website Builder Storefront

**Date:** 2026-06-05  
**Scope:** `apps/web/src` — all 5 themes (modern/classic/elegant/minimal/bold), shared components, and app-level pages  
**Status:** Read-only audit. No edits made.

---

## 1. Complete Font-Size Inventory

### Tailwind Named Classes in Use (templates only)

| Class | px equivalent | Usage count |
|---|---|---|
| `text-xs` | 12px | 61 |
| `text-sm` | 14px | 121 |
| `text-base` | 16px (or 17px desktop per globals.css) | 45 |
| `text-lg` | 18px | 25 |
| `text-xl` | 20px | 15 |
| `text-2xl` | 24px | 11 |
| `text-3xl` | 30px | 12 |
| `text-4xl` | 36px | 9 |
| `text-5xl` | 48px | 8 |
| `text-6xl` | 60px | 8 |
| `text-7xl` | 72px | present (hero) |
| `text-8xl` | 96px | 2 (bold hero only) |

**Globals.css base:** `body { font-size: 16px; }` desktop bumps to `17px` at 1024px. Arabic RTL: `15.2px` mobile / `16.15px` desktop. Tailwind's `text-base` resolves relative to this, not a hardcoded 16px in HTML root.

### Arbitrary Sizes in Use

| Class | px | Usage | Where |
|---|---|---|---|
| `text-[22px]` | 22px | 5 (pack-styles sectionHeading mobile) | ALL 5 themes — `pack-styles.ts:79,103,140,164,193` |
| `text-[10px]` | 10px | 22 | Elegant/Minimal badges, TrustStrip sm, PecannbeeCard badges |
| `text-[11px]` | 11px | 15 | Elegant CategoryCard label, Minimal CartTable price, PecannbeeCard NEW badge |
| `text-[9px]` | 9px | 4 | Elegant ProductCard badge, Elegant Header cart count, Minimal Header cart count |
| `text-[13px]` | 13px | 1 | — |
| `text-[22px]` | 22px | 5 | Section heading mobile floor (all themes) |

### `getProductCardTextSizes()` Table (`packages/shared/src/types/store-theme.ts:499`)

| cardSize | name | price | cta |
|---|---|---|---|
| `xxs` | `text-[10px] sm:text-xs` (10→12px) | `text-[11px] sm:text-xs` (11→12px) | `text-[10px] sm:text-xs` |
| `xs`, `sm` | `text-base` (16px flat) | `text-base` | `text-sm` |
| `md` (default) | `text-base sm:text-lg` (16→18px) | `text-base sm:text-lg` | `text-sm` |
| `lg` | `text-lg` (18px) | `text-lg sm:text-xl` (18→20px) | `text-sm sm:text-base` |
| `xl` | `text-lg sm:text-xl` (18→20px) | `text-xl sm:text-2xl` (20→24px) | `text-base` |

---

## 2. Current Type Scale Analysis: Per-Page / Per-Theme

### 2.1 Hero Headlines (`heroHeadline` token in `pack-styles.ts`)

| Theme | Mobile | sm (640) | md (768) | lg (1024) | File:line |
|---|---|---|---|---|---|
| modern | 36px (`text-4xl`) | 48px | 60px | 72px | `pack-styles.ts:84` |
| classic | 36px | 48px | 60px | 72px | `pack-styles.ts:108` |
| minimal | **36px** `text-4xl` | 48px | 60px | 72px | `pack-styles.ts:145` |
| elegant | 36px | 48px | 60px | 72px | `pack-styles.ts:198` |
| bold | **48px** `text-5xl` | 60px | 72px | 96px | `pack-styles.ts:169` |

**Hero component overrides** (hardcoded, ignore pack-styles token):

| Theme | Component h1 | Ratio from base | File:line |
|---|---|---|---|
| modern (no image) | `text-4xl sm:text-5xl md:text-6xl lg:text-7xl` = 36/48/60/72px | 2.25→3→3.75→4.5× | `modern/Hero.tsx:43` |
| modern (with image) | `text-4xl md:text-5xl lg:text-6xl` = 36/48/60px | — | `modern/Hero.tsx:93` |
| classic | `text-4xl md:text-5xl lg:text-6xl` = 36/48/60px | — | `classic/Hero.tsx:56` |
| elegant (tall) | `text-5xl md:text-6xl lg:text-7xl` = 48/60/72px | — | `elegant/Hero.tsx:125` |
| elegant (split) | `text-4xl md:text-5xl lg:text-6xl` = 36/48/60px | — | `elegant/Hero.tsx:76` |
| minimal | `text-4xl sm:text-5xl md:text-6xl lg:text-7xl xl:text-8xl` = 36–96px | — | `minimal/Hero.tsx:30` |
| bold | `text-5xl sm:text-6xl md:text-7xl lg:text-8xl` = 48/60/72/96px | — | `bold/Hero.tsx:80` |

**Breaking inconsistency:** `modern/Hero.tsx` h1 uses `text-4xl md:text-5xl lg:text-6xl` (3-step, skips `lg:text-7xl` from pack-styles), while `minimal` adds `xl:text-8xl`. The pack-styles `heroHeadline` token for modern says `lg:text-7xl` but the component overrides to `lg:text-6xl`. **Pack-styles token and component h1 are out of sync for modern.**

---

### 2.2 Section Headings (h2 on homepage carousels / category sections)

All 5 themes share this from `pack-styles.ts` `sectionHeading`:

```
text-[22px] sm:text-3xl md:text-4xl lg:text-5xl
= 22px / 30px / 36px / 48px
```

Ratios between steps:
- 22→30: ×1.36
- 30→36: ×1.20
- 36→48: ×1.33

**Problem:** The 22px mobile start is NOT a Tailwind step — it's an arbitrary value. It should be `text-2xl` (24px) or `text-xl` (20px) to stay on-scale. The `design.md` Typography table (`design.md:41`) specifies `text-3xl sm:text-4xl lg:text-5xl` (30/36/48px) but pack-styles starts at `text-[22px]`, a different bottom step. **Pack-styles and design.md are misaligned on the mobile floor for section headings.**

Bold exception: same classes but `leading-[0.95]` instead of `leading-[1.1]`.

---

### 2.3 Per-Page H1 Headings (app pages — NOT themed hero)

| Page | h1 class | px | File:line |
|---|---|---|---|
| PLP `/products` | `text-3xl font-bold sm:text-4xl` | 30→36px | `ProductsClient.tsx:406` |
| PDP `/products/[slug]` (loading state) | `text-2xl font-bold` | 24px | `ProductDetailClient.tsx:354` |
| PDP `/products/[slug]` (loaded product name) | `text-3xl font-bold` | 30px | `ProductDetailClient.tsx:533` |
| Cart `/cart` | `text-3xl font-bold` | 30px | `CartClient.tsx:300` |
| Checkout `/checkout` | `text-2xl font-bold` | 24px | `CheckoutClient.tsx:774` |
| Account dashboard | `text-2xl font-bold` | 24px | `AccountDashboardClient.tsx:63` |
| Account settings | `text-2xl font-bold` | 24px | `SettingsClient.tsx:248,265` |
| Account loyalty | `text-2xl font-bold` | 24px | `LoyaltyClient.tsx:129,190` |
| Auth FormCard (modern) | `text-3xl font-bold` | 30px | `modern/FormCard.tsx:23` |
| Auth FormCard (classic) | `text-2xl font-serif` | 24px | `classic/FormCard.tsx:23` |
| Auth FormCard (elegant) | `text-3xl font-light` | 30px | `elegant/FormCard.tsx:23` |
| Auth FormCard (minimal) | `text-sm tracking-[0.22em] uppercase` | **14px** | `minimal/FormCard.tsx:23` |
| Auth FormCard (bold) | `text-xl font-black uppercase` | 20px | `bold/FormCard.tsx:24` |
| ReviewSection h2 | `text-2xl font-bold` | 24px | `ReviewSection.tsx:287` |
| ReviewSection large rating | `text-5xl font-bold` | 48px | `ReviewSection.tsx:294` |

**Critical inconsistency:** Auth page h1 varies from 14px (minimal FormCard) to 30px (modern/elegant) across themes with no logic. A login page is a page, not a section — its h1 should be consistent at ~24px (`text-2xl`) regardless of theme.

**Critical inconsistency:** PLP h1 = 30px (`text-3xl`); PDP product-name h1 = 30px (`text-3xl`) — these match, good. But PDP loading-state h1 = 24px (`text-2xl`), and Cart h1 = 30px, Checkout h1 = 24px. No pattern.

---

### 2.4 Sub-Headings (h2/h3 inside pages)

| Location | class | px | File:line |
|---|---|---|---|
| PDP FAQ heading (h2) | `text-2xl font-bold` | 24px | `ProductDetailClient.tsx:68` |
| PDP "Related products" section h2 | `text-2xl font-bold` | 24px | `ProductDetailClient.tsx:705` |
| PDP spec-table h2 (inline name area) | `text-lg font-bold` | 18px | `ProductDetailClient.tsx:686` |
| Cart items section h2 | `text-2xl font-bold` | 24px | `CartClient.tsx:343` |
| ReviewSection "Customer reviews" h2 | `text-2xl font-bold` | 24px | `ReviewSection.tsx:287` |
| BrandStoryBlock h2 | `text-2xl sm:text-3xl font-bold` | 24→30px | `BrandStoryBlock.tsx:68` |
| TestimonialRow review title h3 | `text-lg font-semibold` | 18px | `TestimonialRow.tsx:47` |
| Classic Header store name | `text-2xl font-serif font-bold` | 24px | `classic/Header.tsx:155` |
| Elegant Header store name | `text-3xl font-light` | 30px | `elegant/Header.tsx:139` |
| Modern Header store name | `text-xl font-bold` | 20px | `modern/Header.tsx:115` |
| Bold Header store name | `text-xl font-black uppercase` | 20px | `bold/Header.tsx:73` |

**Inconsistency:** Store name in header is 20px (modern/bold), 24px (classic), 30px (elegant). Since the store name is the same semantic element across themes, the 24px→30px range is fine but the 20px floor in modern is out of step.

---

### 2.5 Body / Product Name / Price

| Role | Class | px | Notes |
|---|---|---|---|
| Body text (description, review copy) | implicit (globals.css: 16px/17px) | 16→17px | No explicit utility on most `<p>` |
| Product card name (md default) | `text-base sm:text-lg` | 16→18px | `store-theme.ts:560` |
| Product card price (md default) | `text-base sm:text-lg` | 16→18px | `store-theme.ts:561` |
| PDP product name h1 | `text-3xl font-bold` | 30px | `ProductDetailClient.tsx:533` |
| PDP price | `text-3xl font-bold text-primary` | 30px | `ProductDetailClient.tsx:546` |
| PDP compare-at/strike price | `text-xl text-muted-foreground line-through` | 20px | `ProductDetailClient.tsx:552` |
| Elegant ProductCard name | `text-xs tracking-[0.15em] uppercase` | **12px** | `elegant/ProductCard.tsx:252` |
| Elegant ProductCard CTA button | `text-[10px]` | **10px** | `elegant/ProductCard.tsx:233` |
| Elegant ProductCard tax label | `text-[10px]` | **10px** | `elegant/ProductCard.tsx:271` |
| Minimal ProductCard name | `text-xs tracking-[0.18em] uppercase` | **12px** | `minimal/ProductCard.tsx:189` |
| Minimal ProductCard price | `text-[11px]` | **11px** | `minimal/ProductCard.tsx:206` |
| Bold ProductCard name | `text-base uppercase` | 16px | `bold/ProductCard.tsx:182` |

**CRITICAL violation of standing rule:** `elegant/ProductCard.tsx` and `minimal/ProductCard.tsx` use 10px and 12px for product names — violating the global "main reading text ≥16px" rule codified in design.md and pack-styles comments. The `getProductCardTextSizes()` helper enforces the floor, but the **per-theme ProductCard components override it with hardcoded subminimum sizes**. The pack-styles name/price tokens carry size info as well (via `font-*` classes) but the per-theme ProductCard components have additional hardcoded `text-xs`, `text-[10px]`, `text-[11px]` on the name and price elements, bypassing `getProductCardTextSizes()`.

---

### 2.6 Labels, Captions, and Chrome

| Role | Class | px | File:line |
|---|---|---|---|
| Section kicker (all themes, SectionHeading) | `text-base font-semibold uppercase tracking-[0.18em]` | 16px | `SectionHeading.tsx:204` |
| Section subtitle (SectionHeading) | `text-xl text-muted-foreground` | 20px | `SectionHeading.tsx:336` |
| Category caption – modern/classic | `text-sm sm:text-base` / `text-lg font-serif` | 14→16px / 18px | `modern/CategoryCard.tsx:92` / `classic/CategoryCard.tsx:87` |
| Category caption – elegant | `text-base font-light` | 16px | `elegant/CategoryCard.tsx:96` |
| Category caption – minimal | `text-xs tracking-[0.22em] uppercase` | **12px** | `minimal/CategoryCard.tsx:81` |
| Category caption – bold | `text-base font-black uppercase` | 16px | `bold/CategoryCard.tsx:112` |
| Elegant CategoryCard overlay label | `text-[11px] tracking-[0.32em] uppercase` | 11px | `elegant/CategoryCard.tsx:62` |
| Announcement bar – modern | `text-sm` | 14px | `modern/AnnouncementBar.tsx:68` |
| Announcement bar – classic | `text-sm font-serif` | 14px | `classic/AnnouncementBar.tsx:20` |
| Announcement bar – elegant/minimal | `text-[10px] tracking-[0.3em]` | **10px** | `elegant/AnnouncementBar.tsx:20`, `minimal/AnnouncementBar.tsx:20` |
| Announcement bar – bold | `text-sm sm:text-base` | 14→16px | `bold/AnnouncementBar.tsx:20` |
| Footer nav heading – modern/bold | `text-xs font-bold uppercase` | 12px | `modern/Footer.tsx:170` |
| Footer nav heading – elegant | `text-xs tracking-[0.25em] uppercase` | 12px | `elegant/Footer.tsx:198` |
| Footer links | `text-sm` | 14px | all themes |
| Footer store name – modern/classic/bold | `text-xl sm:text-3xl` / `text-xl` / `text-3xl` | 20/24/30px | footers |
| TrustStrip sm | `text-[10px] sm:text-xs` | 10→12px | `TrustStrip.tsx:86` |
| TrustStrip md | `text-[11px] sm:text-sm` | 11→14px | `TrustStrip.tsx:94` |
| TrustStrip lg | `text-sm sm:text-base` | 14→16px | `TrustStrip.tsx:102` |
| Search autocomplete items | `text-sm` | 14px | `SearchAutocomplete.tsx:244` |
| Variant selector labels | `text-sm font-medium` | 14px | `VariantSelector.tsx:105` |
| Tax-inclusive label | `text-xs` | 12px | all ProductCards |
| PecannbeeCard "NEW" / "SALE" badge | `text-[11px]` | 11px | `PecannbeeProductCard.tsx:239,250` |

---

### 2.7 Button / CTA

| Role | Class | px | File:line |
|---|---|---|---|
| Product card CTA (pack-styles, all themes) | `text-sm` | 14px | `pack-styles.ts:67,90,…` |
| Hero CTA – modern | `text-base` | 16px | `modern/Hero.tsx:56` |
| Hero CTA – classic | `text-sm` | 14px | `classic/Hero.tsx:76` |
| Hero CTA – elegant | `text-xs` | **12px** | `elegant/Hero.tsx:92,141` |
| Hero CTA – minimal | `text-[11px]` | **11px** | `minimal/Hero.tsx:42` |
| Hero CTA – bold | `text-sm sm:text-base` | 14→16px | `bold/Hero.tsx:92` |
| Form submit button | `text-sm` (most) | 14px | multiple |

**CRITICAL:** Elegant Hero CTA is 12px (`text-xs`), Minimal Hero CTA is 11px. These are the PRIMARY call-to-action button on the hero — the most important clickable element above the fold. Sub-14px CTA copy is a legibility and accessibility violation. WCAG 2.5.5 does not mandate font size on buttons but industry best practice for tap targets starts at 14px label text with 44px minimum height.

---

## 3. Line-Height Audit

### Base Document
- `globals.css:224`: `body { line-height: 1.6; }` — within the 1.5–1.75 target. **Pass.**

### Heading Line-Heights

| Token | Value | Verdict |
|---|---|---|
| All section headings (pack-styles) | `leading-[1.1]` = 1.1 | Appropriate for headings (tighter is expected) |
| Bold section headings | `leading-[0.95]` | 0.95 for section-level h2 at 22px mobile — **too tight**, risks clipping descenders on Arabic glyphs |
| Bold hero | `leading-[0.9]` then `sm:leading-[0.9]` | Brutalist intent, but 0.9 at 48px+ will clip Arabic descenders (ش/خ) |
| Modern/classic/elegant hero | `leading-[1.05]` | Acceptable for display headings |
| Minimal hero | `leading-[1.05]` | Acceptable |

**File references:** `bold/Hero.tsx:80` (`leading-[0.95] sm:leading-[0.9]`), `pack-styles.ts:164` (bold sectionHeading `leading-[0.95]`).

**RTL concern:** `globals.css:209-213` resets `letter-spacing: normal` for Arabic. But `line-height: 0.9` or `0.95` is NOT reset — Arabic fonts (IBM Plex Sans Arabic) have taller ascenders and descenders than Latin. Any line-height below 1.2 on Arabic text will cause visible glyph clipping.

### Body/Prose Line-Heights

| Location | Class | Value | Verdict |
|---|---|---|---|
| PDP description | `leading-relaxed` | 1.625 | Pass |
| Hero subtitles | `leading-relaxed` | 1.625 | Pass |
| Elegant hero subtitle | `leading-loose` | 2.0 | Slightly wide but intentional for luxury feel |
| Footer descriptions | `leading-relaxed` | 1.625 | Pass |
| Elegant footer text | `leading-loose` | 2.0 | Acceptable for elegant aesthetic |
| ReviewSection copy | `leading-relaxed` | 1.625 | Pass |
| BrandStoryBlock | `leading-relaxed` | 1.625 | Pass |

No body text is missing a line-height — the global 1.6 baseline covers elements without explicit utilities.

---

## 4. Line-Length (Prose Width) Audit

### Target: 65–75ch

| Location | Container | Estimated max chars | Verdict |
|---|---|---|---|
| PDP description `<p>` | `max-w-7xl` column half (grid lg:grid-cols-2) | ~55–65ch at 1280px | Borderline — no explicit `max-w-prose` |
| Blog post body | `max-w-3xl` (768px) at `text-base sm:text-lg` | ~70–75ch | **Pass** |
| Hero subtitle (modern) | `max-w-xl` (512px) | ~55–60ch | Pass |
| Hero subtitle (minimal) | `max-w-sm` (384px) | ~45ch | Pass |
| Footer description | `max-w-xs` or `max-w-sm` | ~40–45ch | Pass |
| BrandStoryBlock body | no explicit cap | up to full column width | **Flag** — no max-w on body copy |
| SectionHeading subtitle | `max-w-2xl` (672px) at `text-xl` | ~60–65ch | Borderline |
| Account dashboard cards | full container | ~90ch+ on desktop | **Fails** for long text |

**PDP description** (`ProductDetailClient.tsx:560`) — rendered in a grid column at `max-w-7xl`, which at 1280px desktop = a half-column ≈ 560px wide. At 16px body text that's ~70 ch. No explicit `max-w-prose` cap; the grid column acts as an organic constraint. Acceptable but fragile — on stores with 1-column PDP layouts or very wide displays it would exceed 75ch.

**BrandStoryBlock** (`BrandStoryBlock.tsx:72`) — `<p className="mt-4 text-base sm:text-lg text-foreground/75 leading-relaxed line-clamp-6">` has no max-w-prose on the paragraph itself. Inherits its column width from the section container. At full-width layouts this could hit 100+ chars.

---

## 5. Font-Weight Hierarchy Audit

| Theme | h1/h2 | h3/subhead | Body | Price | CTA | Assessment |
|---|---|---|---|---|---|---|
| modern | `font-extrabold`/`font-semibold` | `font-semibold` | none (400 default) | `font-bold text-primary` | `font-semibold` | **Clear hierarchy** |
| classic | `font-normal` (serif) | `font-serif` | 400 | `font-medium` serif | `font-serif uppercase` | **Intentional flat-weight serif** — identity choice, not a bug |
| elegant | `font-light`/`font-extralight` | `font-light` | 400 | `font-light` | `font-medium uppercase` | **Intentional ultralight** — identity choice |
| minimal | `font-extralight` | `font-light` | 400 | `font-light` | `font-medium uppercase` | **Intentional ultralight** — identity choice |
| bold | `font-black` | `font-black` | 400 | `font-black` | `font-black uppercase` | **Single-weight shock** — identity choice, but price at font-black is heavy |

The weight hierarchy is **intentionally flat per theme** (classic/elegant/minimal only vary by tracking), which matches the design philosophy. No violations.

---

## 6. Tabular-Nums on Prices

**Grep result: zero instances of `tabular-nums`, `lining-nums`, or `font-variant-numeric` anywhere in `apps/web/src`.**

Per web interface guidelines, price columns (cart table, order summary, account orders) should use `tabular-nums` to prevent width jitter as numbers change. This is missing on:

- `apps/web/src/app/cart/CartClient.tsx` — price column, total
- `apps/web/src/templates/*/CartTable.tsx` — per-item price + quantity
- `apps/web/src/templates/*/OrderSummary.tsx` — subtotal, tax, total rows
- `apps/web/src/app/products/[slug]/ProductDetailClient.tsx:546` — PDP price
- All `getProductCardTextSizes()` consumers (carousel + PLP cards)
- `apps/web/src/app/account/orders/OrdersClient.tsx` — order total column

`formatPrice()` in `@force/shared` returns a string; `tabular-nums` must be applied via Tailwind on the surrounding element. Tailwind class is `tabular-nums` (applies `font-variant-numeric: tabular-nums`).

---

## 7. Is There a Consistent Modular Ratio?

### Current de-facto scale extracted from all in-use sizes:

```
9px → 10px → 11px → 12px → 14px → 16px → 17px → 18px → 20px → 22px → 24px → 30px → 36px → 48px → 60px → 72px → 96px
```

That is **17 distinct sizes** across the storefront. The steps are:
- 9→10: ×1.11
- 10→11: ×1.10
- 11→12: ×1.09
- 12→14: ×1.17 (Tailwind jump xs→sm)
- 14→16: ×1.14
- 16→17: ×1.06 (globals.css desktop bump)
- 17→18: ×1.06
- 18→20: ×1.11
- 20→22: ×1.10
- 22→24: ×1.09
- 24→30: ×1.25 (2xl→3xl)
- 30→36: ×1.20
- 36→48: ×1.33
- 48→60: ×1.25
- 60→72: ×1.20
- 72→96: ×1.33

**There is no consistent modular ratio.** The lower end (9–22px) is an ad-hoc crawl of small increments; the upper end (24–96px) is roughly 1.25–1.33 but alternates erratically.

### Ratio Breaks (Specific)

1. **Section heading mobile: `text-[22px]` instead of a Tailwind step** — `pack-styles.ts:79,103,140,164,193`. Falls between `text-xl` (20px) and `text-2xl` (24px). Design.md says `text-3xl sm:text-4xl lg:text-5xl` but pack-styles uses `text-[22px]`. Creates a phantom off-scale step.

2. **PLP h1 = 30px (`text-3xl`), PDP h1 = 30px, Cart h1 = 30px, BUT Checkout h1 = 24px and Account h1 = 24px** — Page-title h1 is either 24px or 30px with no semantic rule. `CheckoutClient.tsx:774` vs `ProductsClient.tsx:406`.

3. **Elegant Hero CTA = 12px, Minimal Hero CTA = 11px, Modern Hero CTA = 16px** — The single most important CTA on the page spans 11–16px across themes. `elegant/Hero.tsx:92,141`, `minimal/Hero.tsx:42`, `modern/Hero.tsx:56`.

4. **Elegant ProductCard name = `text-xs` (12px), bypassing the 16px floor** — `elegant/ProductCard.tsx:252`. The floor is enforced in `getProductCardTextSizes()` but not used here; the component hardcodes `text-xs`.

5. **Minimal ProductCard name = `text-xs` (12px) + price = `text-[11px]`** — `minimal/ProductCard.tsx:189,206`. Same bypass as elegant.

6. **SectionHeading kicker = `text-base` (16px) but design.md table says 11-13px** — `SectionHeading.tsx:204`. The kicker chip at 16px competes visually with body text and loses its "small label" role. Design.md:42 specifies `text-[11px]` / `text-xs` for section kicker.

7. **SectionHeading subtitle = `text-xl` (20px)** — `SectionHeading.tsx:336`. This is LARGER than the body and equal to the "see all" link text. Design.md:43 says `text-sm sm:text-base` (14→16px) for section subtitle. A 20px subtitle competes with the 22–30px section heading.

8. **Modern/classic category caption = `text-sm sm:text-base` (14→16px) but modern/classic pack-styles `categoryCaption` token says `text-base sm:text-lg` (16→18px)** — `modern/CategoryCard.tsx:92` uses `text-sm md:text-base` while pack-styles:92 has `text-base sm:text-lg`. Component doesn't consume pack-styles token, creating silent drift.

9. **Footer store name varies 20→24→30px** across themes with no semantic justification — `modern/Footer.tsx:126` (text-xl), `classic/Footer.tsx:84` (text-xl), `bold/Footer.tsx:82` (text-3xl). Bold at 30px footer name is aggressive.

10. **Bold footer store name = `text-3xl` (30px)** while content is `text-sm` — ratio between h and body in footer is 30:14 = 2.14×. Disproportionate. `bold/Footer.tsx:82`.

---

## 8. Recommended Unified Modular Type Scale

### Rationale for Major-Third (1.25)

The compact-ecommerce target (Pecannbee KW) uses tight size steps. A 1.25 major-third gives 7 meaningful steps from caption to display without producing oversized headings. The platform's body base is 16px (globals.css). Design.md endorses this density.

### Proposed Scale

| Step name | Multiplier | Raw px | Rounded px | Tailwind class | Role |
|---|---|---|---|---|---|
| caption | base ÷ 1.25² | 10.24px | 10px | `text-[10px]` | Badges, tax labels, sub-labels (retain as-is) |
| label | base ÷ 1.25 | 12.8px → 12px | 12px | `text-xs` | Footer nav headings, kicker chips, fine print |
| small | base ÷ 1.00 × 0.875 | 14px | 14px | `text-sm` | CTAs, captions, meta text, announcement bar |
| **body** | **base × 1.0** | **16px** | **16px** | **`text-base`** | **Product names, prices, descriptions, card text** |
| lead | base × 1.25 | 20px | 20px | `text-xl` | Hero subtitles, feature text, subheadings |
| h3 | base × 1.25² | 25px → 24px | 24px | `text-2xl` | Page h1 (transactional pages), section sub-heads |
| h2 | base × 1.25³ | 31.25px → 30px | 30px | `text-3xl` | Section headings (desktop/sm), PLP h1 |
| h1 | base × 1.25⁴ | 39px → 36px | 36px | `text-4xl` | Hero headline mobile floor |
| display | base × 1.25⁵ | 48.8px → 48px | 48px | `text-5xl` | Hero headline sm+ |
| display-lg | base × 1.25⁶ | 61px → 60px | 60px | `text-6xl` | Hero headline md+ |
| display-xl | base × 1.25⁷ | 76.3px → 72px | 72px | `text-7xl` | Hero headline lg+ (bold can extend to 96px) |

Conveniently, Tailwind's named scale from `text-2xl` upward fits nearly perfectly within ±5% of Major-Third. The only discrepancy is `text-3xl` = 30px vs the theoretical 31.25px — close enough.

### Role-to-Step Mapping

| Storefront role | Recommended step | Tailwind | Notes |
|---|---|---|---|
| Badge / tax label / fine print | caption | `text-[10px]` | Retain as-is; these are decorative |
| Footer nav heading, kicker chip, announcement bar (elegant/minimal) | label | `text-xs` (12px) | Standardize elegant/minimal announcement bar from `text-[10px]` to `text-xs` |
| CTA buttons, meta text, breadcrumbs | small | `text-sm` (14px) | All hero CTAs should be ≥14px |
| Product name (card, md default), price (card), body, category caption | body | `text-base` (16px) | Enforce floor — fix elegant/minimal ProductCard |
| Section subtitle, hero subtitle, "see all" link | lead | `text-xl` (20px) | Section subtitle keeps text-xl |
| Section kicker (SectionHeading) | label or small | `text-xs` or `text-sm` | Currently text-base (16px) — should drop to 12–14px per design.md |
| Section heading mobile | h3 | `text-2xl` (24px) | Replace `text-[22px]` with `text-2xl` |
| Section heading sm | h2 | `text-3xl` (30px) | Keep |
| Section heading lg | h1 | `text-4xl` (36px) | Change from `lg:text-5xl` (48px) to `lg:text-4xl` to match compact-ecommerce |
| Page h1 (transactional: checkout, account, auth) | h3 | `text-2xl` (24px) | Standardize; currently mixed 24→30px |
| Page h1 (PLP, PDP, cart) | h2 | `text-3xl` (30px) | Keep existing |
| Hero headline (mobile floor) | h1 | `text-4xl` (36px) | Keep |
| Hero headline sm | display | `text-5xl` (48px) | Keep |
| Hero headline md | display-lg | `text-6xl` (60px) | Keep |
| Hero headline lg | display-xl | `text-7xl` (72px) | Keep; bold only to `text-8xl` |

### Reconciliation with `design.md`

`design.md:39-54` specifies:
- Section heading: `text-3xl sm:text-4xl lg:text-5xl` = 30/36/48px. The recommended scale keeps `sm:text-3xl md:text-4xl` but drops `lg:text-5xl` to `lg:text-4xl` to keep section headings more compact (48px for a secondary heading is oversized at large viewports for compact ecommerce).
- Product name/price: `text-base sm:text-lg` — matches recommended.
- Hero: `text-4xl sm:text-5xl md:text-6xl lg:text-7xl` — matches recommended.
- Section kicker: `text-[11px]`/`text-xs` — **SectionHeading.tsx currently uses `text-base` (16px); must revert to `text-xs` or `text-[11px]`**.

---

## 9. Concrete Fix List (by file and class change)

### P0 — Blocking legibility / 16px floor violations

| # | File:line | Current | Fix | Severity |
|---|---|---|---|---|
| 1 | `elegant/ProductCard.tsx:252` | `text-xs` (12px) product name | `text-base sm:text-lg` OR use `getProductCardTextSizes()` | **P0** |
| 2 | `elegant/ProductCard.tsx:233` | `text-[10px]` CTA button | `text-sm` | **P0** |
| 3 | `minimal/ProductCard.tsx:189` | `text-xs` (12px) product name | `text-base sm:text-lg` via `getProductCardTextSizes()` | **P0** |
| 4 | `minimal/ProductCard.tsx:206` | `text-[11px]` price | `text-base sm:text-lg` via `getProductCardTextSizes()` | **P0** |
| 5 | `elegant/Hero.tsx:92,141` | `text-xs` (12px) hero CTA | `text-sm` (14px) minimum | **P0** |
| 6 | `minimal/Hero.tsx:42` | `text-[11px]` hero CTA | `text-sm` (14px) minimum | **P0** |
| 7 | `minimal/FormCard.tsx:23` | `text-sm` (14px) h1 for login/register | `text-2xl font-light` — matches page h1 convention | **P0** (login heading at 14px is illegible) |

### P1 — Ratio consistency / scale normalization

| # | File:line | Current | Fix | Severity |
|---|---|---|---|---|
| 8 | `pack-styles.ts:79,103,140,164,193` (all 5 `sectionHeading`) | `text-[22px] sm:text-3xl md:text-4xl lg:text-5xl` | `text-2xl sm:text-3xl md:text-4xl` (22px→24px, drop lg:text-5xl) | P1 |
| 9 | `SectionHeading.tsx:204` | `text-base` (16px) kicker | `text-xs tracking-[0.18em]` or `text-[11px] tracking-[0.18em]` (per design.md:42) | P1 |
| 10 | `CheckoutClient.tsx:774` | `text-2xl font-bold` h1 | Keep — standardize to `text-2xl` for all transactional h1s (consistent with account pages) | P1 |
| 11 | `CartClient.tsx:300` | `text-3xl font-bold` h1 | Change to `text-2xl font-bold` to match checkout/account h1 level | P1 |
| 12 | `modern/Hero.tsx:93` | `text-4xl md:text-5xl lg:text-6xl` h1 (image variant) | `text-4xl sm:text-5xl md:text-6xl lg:text-7xl` — match pack-styles token | P1 |
| 13 | `elegant/AnnouncementBar.tsx:20` | `text-[10px]` | `text-xs` (12px) | P1 |
| 14 | `minimal/AnnouncementBar.tsx:20` | `text-[10px]` | `text-xs` (12px) | P1 |
| 15 | `minimal/CategoryCard.tsx:81` | `text-xs tracking-[0.22em]` category caption | `text-base font-light` — enforce 16px floor per design.md:47 | P1 |
| 16 | `bold/Footer.tsx:82` | `text-3xl font-black` store name in footer | `text-xl font-black` — 30px in footer body is disproportionate | P1 |
| 17 | `elegant/ProductCard.tsx:198,207` | `text-[9px]` badge | `text-[10px]` (already used in PecannbeeCard — normalize) | P1 |
| 18 | All CartTable / OrderSummary price columns | no `tabular-nums` | Add `tabular-nums` to price spans in all 5 `CartTable.tsx` + all 5 `OrderSummary.tsx` | P1 |
| 19 | `ProductDetailClient.tsx:546` | `text-3xl font-bold` price span | Add `tabular-nums` | P1 |

### P2 — Refinement / enhancement

| # | File:line | Current | Fix | Severity |
|---|---|---|---|---|
| 20 | `SectionHeading.tsx:336` | `text-xl text-muted-foreground` subtitle | Acceptable at 20px; add `leading-relaxed` for multi-line safety | P2 |
| 21 | `BrandStoryBlock.tsx:72` | no max-w on body `<p>` | Add `max-w-prose` or `max-w-xl` | P2 |
| 22 | `ProductDetailClient.tsx:560` | no max-w on description `<p>` | Add `max-w-prose` on the description paragraph | P2 |
| 23 | `pack-styles.ts:164` bold sectionHeading | `leading-[0.95]` | `leading-[1.0]` — 0.95 clips Arabic descenders | P2 |
| 24 | `bold/Hero.tsx:80` | `leading-[0.9]` | `leading-[1.0]` — 0.9 at 48px+ clips Arabic | P2 |
| 25 | `modern/Header.tsx:115` | `text-xl` store name | `text-2xl` to match classic/elegant (20px→24px) | P2 |
| 26 | `AccountDashboardClient.tsx:125,160,189` | `text-2xl font-bold` stat numbers | Add `tabular-nums` on order count / stat numbers | P2 |
| 27 | `ReviewSection.tsx:287,294` | `text-2xl` / `text-5xl` | Add `tabular-nums` on the `text-5xl` rating number | P2 |
| 28 | `elegant/CategoryCard.tsx:62` | `text-[11px] tracking-[0.32em]` overlay label | Fine as a decorative overlay; retain | P2 (no change needed) |
| 29 | `classic/CategoryCard.tsx:87` | `text-lg font-serif` (18px) caption | Acceptable — classic persona allows slightly larger; retain | P2 (no change needed) |

---

## 10. Summary: Top Findings + Recommended Scale

### Top 10 Findings

1. **Elegant and Minimal ProductCard components hardcode 10–12px for product names and prices** (`elegant/ProductCard.tsx:252`, `minimal/ProductCard.tsx:189,206`), violating the standing 16px floor. The `getProductCardTextSizes()` helper that enforces the floor is not used on these components — they have their own hardcoded text classes.

2. **Elegant and Minimal Hero CTAs are 10–12px** (`elegant/Hero.tsx:92,141` = `text-xs`; `minimal/Hero.tsx:42` = `text-[11px]`). The most important above-fold call-to-action has sub-14px labels — a legibility and accessibility failure.

3. **The section heading mobile floor is an off-scale arbitrary value (`text-[22px]`)** across all 5 themes in `pack-styles.ts`. It should be `text-2xl` (24px) to stay on the Tailwind type scale. This creates a phantom step that no other element uses.

4. **SectionHeading kicker is `text-base` (16px)** (`SectionHeading.tsx:204`) when design.md mandates `text-[11px]`/`text-xs`. A 16px kicker chip visually competes with body text and loses its role as an eyebrow label.

5. **Zero `tabular-nums` across the entire codebase.** All price columns in cart, order summary, PDP, and account statistics are proportional-width numerals. On multi-product carts this causes column misalignment as quantity changes.

6. **Bold sectionHeading `leading-[0.95]` and hero `leading-[0.9]`** will clip Arabic glyphs (IBM Plex Sans Arabic has tall ascenders). Minimum safe line-height for Arabic at heading sizes is 1.1.

7. **Page h1 is inconsistent across transactional pages**: PLP = 30px, PDP = 30px, Cart = 30px, but Checkout = 24px, Account = 24px. No semantic logic. Should be: PLP/PDP/Cart = `text-3xl` (shopping pages), Checkout/Account = `text-2xl` (utility pages).

8. **Minimal FormCard h1 is `text-sm` (14px)** (`minimal/FormCard.tsx:23`) — the login and registration page headings render at 14px, the smallest h1 across all pages and themes.

9. **17 distinct font sizes in production** (9px through 96px) with no consistent modular ratio. The lower end (9–22px) is a crawl of 1–2px increments with no design logic.

10. **BrandStoryBlock and PDP description lack `max-w-prose`** (`BrandStoryBlock.tsx:72`, `ProductDetailClient.tsx:560`). On full-width column layouts, prose text can exceed 100 characters per line.

### Recommended Scale (Compact Ecommerce / Major-Third 1.25)

```
caption  10px  text-[10px]  → badges, tax labels
label    12px  text-xs      → footer nav heads, kicker chip, fine print
small    14px  text-sm      → CTAs, meta, announcement bar
body     16px  text-base    → product names, prices, descriptions  ← BASE
lead     20px  text-xl      → subtitles, feature copy
h3       24px  text-2xl     → transactional page h1, sub-sections
h2       30px  text-3xl     → PLP/PDP/Cart h1, section heading sm+
h1       36px  text-4xl     → hero headline mobile, section heading desktop
display  48px  text-5xl     → hero sm
disp-lg  60px  text-6xl     → hero md
disp-xl  72px  text-7xl     → hero lg (bold extends to text-8xl)
```

This is 11 steps; 4 are already on Tailwind defaults (`text-sm`, `text-base`, `text-xl`, `text-2xl`–`text-7xl`). The only arbitrary value kept is `text-[10px]` for genuine micro-labels (badges). The `text-[22px]` phantom step is eliminated.
