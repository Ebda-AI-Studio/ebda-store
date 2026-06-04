# Layout / Section Ratios / Spacing Scale Audit
**Date:** 2026-06-05  
**Scope:** apps/web storefront — all 5 themes + shared page clients  
**Priority ladder:** P0 = ships broken / jarring on real stores · P1 = noticeable inconsistency, one-PR fix · P2 = polish / future sprint

---

## Executive Summary (10 lines)

1. **Section vertical rhythm is almost consistent on the homepage** — 3 of the 8 homepage sections use `py-14 sm:py-16 lg:py-20` exactly, but the categories section breaks the pattern with an asymmetric `pt-12 pb-14 sm:pt-16 sm:pb-16 lg:pt-20 lg:pb-20`, and the fallback ProductGrid section rogue-fires `lg:py-24` (4 steps above siblings).
2. **Page outer containers split between `max-w-7xl` (most pages) and bare `container` (4 pages: About, Compare, Wishlist, CategoryGrid for 4 of 5 themes)** — these resolve to different widths at 1280+ viewports and create visible content-edge misalignment.
3. **Page outer vertical padding is universally `py-8`** for transactional pages (Products, PDP, Cart, Checkout, Categories) vs `py-12/py-16` on static pages — acceptable but undocumented, creating a two-tier rhythm that looks unintentional.
4. **PLP default gap is off-grid: `gap-4 sm:gap-5 lg:gap-6`** — `gap-5` is not an 8pt value. The 5-theme ProductGrids all use `gap-3 md:gap-4` (on-grid), but the PLP grid overrides them with the 3-step ramp that includes an off-grid mid-step.
5. **Product card aspect ratios split across themes** — 4 themes use `aspect-square sm:aspect-[3/4]`; bold uses pure `aspect-square`; PDP skeleton uses `aspect-square`; ProductCarousel default is `aspect-square`. This is intentional-per-theme but is never unified in a single constant, so changing the default requires touching 7 files.
6. **Category card aspect defaults are 4-way split**: modern `aspect-square sm:aspect-[4/3]`, elegant `aspect-square sm:aspect-[2/3]`, classic + bold `aspect-square sm:aspect-[3/4]`, minimal `aspect-square sm:aspect-[4/3]` — all different at desktop breakpoint with no shared default.
7. **Cart = `lg:grid-cols-12` 8/4 split; checkout = `lg:grid-cols-12` 7/5 split** — both correct proportions but inconsistent between two adjacent conversion-funnel pages. Customers see a visual jump moving cart → checkout.
8. **PDP gallery/info split is `lg:grid-cols-2` (50/50)** — acceptable but differs from industry standard 55/45 and creates a very narrow info column at 1280px. No md breakpoint — 2-col activates abruptly at 1024px.
9. **SectionHeading heading-to-content gap is `mb-8 sm:mb-12`** (consistent throughout), but the ProductCarousel wraps the full section (including SectionHeading) inside `px-4 sm:px-6 lg:px-8`, while the ProductGrid fallback path wraps only the inner content in `mx-auto max-w-7xl px-4 sm:px-6 lg:px-8` — creating a horizontal-padding inconsistency between carousel and grid modes.
10. **Recommended system:** adopt the 8pt Tailwind scale; standardize sections to `py-12 sm:py-16 lg:py-20`; lock outer containers to `mx-auto max-w-7xl px-4 sm:px-6 lg:px-8` on all pages.

---

## 1. Page Container Audit

### Canonical container (most pages)
```
mx-auto w-full max-w-7xl px-4 [py-8] sm:px-6 lg:px-8
```
Used by: Products PLP (line 383), Cart (line 280), PDP (line 416), Categories (line 58), Checkout (line 796).

### Deviations — P0/P1

| Page / Surface | File:Line | Container | Issue |
|---|---|---|---|
| **About** | `AboutClient.tsx:30` | `container mx-auto px-4 py-12 sm:py-16` | `container` class (Tailwind default ~1280px, no padding tiers) instead of `max-w-7xl`. Width will differ from all other pages at ≥1280px. |
| **Compare** | `CompareClient.tsx:69,85,143` | `container mx-auto px-4 py-8` | Same — `container` not `max-w-7xl`. |
| **Wishlist** | `WishlistClient.tsx:172,192,258` | `container mx-auto px-4 py-8` | Same. |
| **CategoryGrid (4 of 5 themes)** | `elegant/CategoryGrid.tsx:62`, `classic/CategoryGrid.tsx:62`, `minimal/CategoryGrid.tsx:64`, `bold/CategoryGrid.tsx:71` | `container mx-auto px-4` | These 4 themes use bare `container` while the parent section wrapper in HomePageContent already does `mx-auto max-w-7xl px-4 sm:px-6 lg:px-8` — double padding on desktop (the inner `container` adds px-4 on top of the outer's lg:px-8, eating 32px of grid space). |
| **Modern CategoryGrid** | `modern/CategoryGrid.tsx` | wraps inside outer `max-w-7xl` set by HomePageContent | Consistent, no issue. |
| **Search** | `SearchClient.tsx:205` | `mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 lg:px-8` | Consistent. |
| **Blog page/post** | `blog/page.tsx:61`, `blog/[slug]/BlogPostClient.tsx:48` | `py-12 sm:py-16 lg:py-20` outer | OK, but inner uses `max-w-3xl mx-auto` which is narrower — intentional for readability. |

**P0 FIX — About, Compare, Wishlist:** Replace `container mx-auto px-4` with `mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8` to align with all other pages.

**P1 FIX — CategoryGrid (4 themes):** Remove the inner `container mx-auto px-4` wrapper from each theme's CategoryGrid. The parent in HomePageContent provides the `max-w-7xl` container; the inner one is superfluous and causes double-padding at lg breakpoint.

### Vertical padding comparison

| Page | Outer `py-*` | Notes |
|---|---|---|
| Products PLP | `py-8` | — |
| PDP | `py-8` | — |
| Cart | `py-8` | — |
| Checkout | `py-8` | — |
| Categories | `py-8` | — |
| Search | `py-8` | — |
| Contact | `py-12` | ← One step higher than transactional pages |
| About | `py-12 sm:py-16` | ← Two-step ramp |
| Privacy/Terms/FAQ/Shipping | `py-12` | Same as Contact |
| Checkout Success | `py-16` | Intentional — center-of-screen feel |
| Checkout Error | `py-12` | |

**P2 observation:** Transactional pages consistently use `py-8`; content/info pages use `py-12`. This two-tier convention is actually sensible (content pages breathe more) but should be documented. Currently ad-hoc.

---

## 2. Section Vertical Rhythm (Homepage)

### Homepage section `py-*` values

| Section (data-section) | Classes | File:Line |
|---|---|---|
| categories | `pt-12 pb-14 sm:pt-16 sm:pb-16 lg:pt-20 lg:pb-20` | `HomePageContent.tsx:377` |
| newArrivals | `py-14 sm:py-16 lg:py-20` | `HomePageContent.tsx:482` |
| bestSellers | `py-14 sm:py-16 lg:py-20` | `HomePageContent.tsx:565` |
| testimonials | `py-14 sm:py-16 lg:py-20` | `HomePageContent.tsx:693` |
| extraCarousels | `py-14 sm:py-16 lg:py-20` | `HomePageContent.tsx:784` |
| brandStory | `py-12 sm:py-16 lg:py-20` | `BrandStoryBlock.tsx:51` |
| trustStrip | `py-12 sm:py-16 lg:py-20` | `TrustStrip.tsx:117` |
| blog page | `py-12 sm:py-16 lg:py-20` | `blog/page.tsx:61` |
| **fallback ProductGrid** | `py-14 sm:py-16 lg:py-24` | `HomePageContent.tsx:834` |

**P1 — Categories asymmetric top/bottom:** `pt-12 pb-14` at mobile is a deliberate "close the gap to hero" decision (documented comment at line 356), but `pb-14` vs sibling `py-14` means the bottom gap between categories and newArrivals is `14 + 14 = 28` (consistent), while the top gap from hero to categories is `12` not `14`. The asymmetry is *intentional* but creates a mild optical imbalance because SectionDividers between sections render their own spacing.

**P0 — Fallback ProductGrid `lg:py-24`:** `HomePageContent.tsx:834` — the fallback section when both carousels are disabled uses `lg:py-24` instead of `lg:py-20`. This is 24px taller than every other section at large viewports. If a merchant turns off both newArrivals and bestSellers and falls back to featured, the page rhythm breaks.
- **Fix:** Change `lg:py-24` → `lg:py-20` at line 834.

**P1 — brandStory and trustStrip use `py-12`** at mobile vs newArrivals/bestSellers/testimonials `py-14`. The 8px mobile difference is unlikely to be noticed but violates the single rhythm goal.

### 8pt scale conformance

8pt scale Tailwind steps: `0, 0.5(2px), 1(4px), 2(8px), 3(12px), 4(16px), 5(20px), 6(24px), 7(28px), 8(32px), 10(40px), 12(48px), 14(56px), 16(64px), 20(80px), 24(96px)`.

Off-grid values found (not multiples of 4px):
- `py-14` = 56px ✅ on-grid  
- `py-16` = 64px ✅ on-grid  
- `py-20` = 80px ✅ on-grid  
- `pt-12 pb-14` = 48px/56px ✅ on-grid  
- `py-12` = 48px ✅ on-grid  
- `py-24` = 96px ✅ on-grid (but inconsistent vs siblings)  

The section-level py values are on-grid. Off-grid values appear in internal component spacings:
- `PecannbeeProductCard.tsx:91` — `p-3 sm:p-4` = 12px/16px → on-grid ✅  
- `ProductCarousel scroll pb-4` — 16px → on-grid ✅  
- `gap-1.5` in SectionHeading (line 173) = 6px → **P2 off-grid** (use `gap-2`)  
- `gap-2.5` in bold Hero CTA (line 92) = 10px → **P2 off-grid** (use `gap-2` or `gap-3`)  
- `py-2.5` in modern ProductCard CTA (line 231) = 10px → **P2 off-grid** (use `py-2` or `py-3`)  

### Recommended unified section rhythm

```
Standard homepage section:    py-12 sm:py-16 lg:py-20
  → mobile: 48px top + bottom
  → tablet: 64px top + bottom  
  → desktop: 80px top + bottom

Section heading to grid gap:  mb-8 sm:mb-12 (current, keep)

Hero-to-categories top reduction: pt-8 sm:pt-12 lg:pt-16 (intentional tight coupling, document it)
```

All 5 of `{py-14, py-12}` mobile values should converge to `py-12` for the standard tier.

---

## 3. Column Splits / Proportions

### Cart grid — `lg:grid-cols-12` 8/4
`CartClient.tsx:396` → `lg:grid-cols-12 lg:gap-8` → `lg:col-span-8` items + `lg:col-span-4` summary.

Ratio: **2:1** (66.7% / 33.3%). Industry standard and sensible for e-commerce — enough summary width for totals.

### Checkout grid — `lg:grid-cols-12` 7/5  
`CheckoutClient.tsx:848` → `lg:grid-cols-12 lg:gap-8` → `lg:col-span-7` form + `lg:col-span-5` summary (via `OrderSummary.tsx:50` `lg:col-span-5`).

Ratio: **7:5** (58.3% / 41.7%). Slightly wider summary than cart.

**P1 inconsistency:** Cart and Checkout are adjacent funnel pages with similar content structures (items list + order summary) but different column ratios (8/4 vs 7/5). The checkout summary feels proportionally wider than the cart summary, which can create visual discontinuity mid-funnel.

**Recommended fix:** Standardize both to `lg:grid-cols-12` with `8/4` split — the cart summary at 4-of-12 col has plenty of space for totals, and the checkout summary is narrower but the checkout form has more fields, so 8-col form makes more sense. Change `CheckoutClient.tsx:848` form div from `lg:col-span-7` to `lg:col-span-8`, and `OrderSummary.tsx:50` from `lg:col-span-5` to `lg:col-span-4`.

### PDP gallery/info — `lg:grid-cols-2` (50/50)
`ProductDetailClient.tsx:450` → `grid gap-8 lg:grid-cols-2`.

Ratio: **1:1** (50% / 50%). The info panel (name, price, add-to-cart, description, specs) often has more visual weight than a single image, making the 50/50 split feel unbalanced.

**P1 recommendation:** Change to `lg:grid-cols-12` with `lg:col-span-5` gallery + `lg:col-span-7` info — standard Shopify-style 5:7 (41.7% / 58.3%). This gives more space to the purchase decision area. Current `gap-8` (32px) is acceptable.

Also: PDP activates 2-column at `lg` (1024px) with no `md` intermediate — below 1024px the gallery stacks full-width above info. Consider adding `md:grid-cols-2` so tablet users don't scroll past the full-width image before seeing the buy button.

### PDP thumbnail strip — `grid grid-cols-4 gap-4`
`ProductDetailClient.tsx:487` → 4-column strip below main image.

This is hardcoded — no breakpoint scaling. On mobile (where the gallery is 100vw), `grid-cols-4` renders 4 thumbnails side by side which at 390px mobile = ~85px each including gap. Functional but tight. Consider `grid-cols-4 sm:grid-cols-5 md:grid-cols-4` or allow the merchant to set thumbnail count.

### Product grid columns — PLP vs Search

| Surface | Grid | File:Line |
|---|---|---|
| PLP (grid view) | `grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6` | `ProductsClient.tsx:573` |
| Search results | `grid-cols-2 md:grid-cols-3 lg:grid-cols-4` | `SearchClient.tsx:390,425` |
| PDP related products | `grid-cols-2 sm:grid-cols-3` | `ProductDetailClient.tsx:711` |
| Category fallback skeleton | `grid-cols-2 md:grid-cols-3 lg:grid-cols-4` | `CategoriesClient.tsx:83` |
| ProductGrid (5 themes) | theme-controlled, 2/3/4 col max | per-theme files |

**P1 — PLP goes to 5 and 6 columns at xl/2xl; Search is capped at 4 columns.** A customer who searches and then browses PLP sees a different card density. Recommendation: cap PLP at `2xl:grid-cols-5` (remove `2xl:grid-cols-6`) or extend Search to match.

**P1 — PDP related products only goes to 3 columns.** At 1280px a `grid-cols-2 sm:grid-cols-3` layout for related products looks sparse. Extend to `md:grid-cols-3 lg:grid-cols-4` to match Search.

---

## 4. Card Aspect Ratios

### Product card — theme defaults

| Theme | Image aspect (mobile) | Image aspect (desktop sm:) | File:Line |
|---|---|---|---|
| modern | `aspect-square` | `sm:aspect-[3/4]` | `modern/ProductCard.tsx:104` |
| elegant | `aspect-square` | `sm:aspect-[3/4]` | `elegant/ProductCard.tsx:106` |
| classic | `aspect-square` | `sm:aspect-[3/4]` | `classic/ProductCard.tsx:85` |
| minimal | `aspect-square` | `sm:aspect-[3/4]` | `minimal/ProductCard.tsx:81` |
| **bold** | `aspect-square` | **`aspect-square` (no sm override)** | `bold/ProductCard.tsx:84` |
| PecannbeeProductCard (PLP) | merchant-controlled via `cardAspect` | falls back to `aspect-square` | `PecannbeeProductCard.tsx:89` |
| ProductCarousel (carousel) | merchant-controlled via `cardAspect` | falls back to `aspect-square` | `ProductCarousel.tsx:89` |

**P1 — Bold theme stays square at all breakpoints** while the other 4 themes go portrait on desktop. This is a bold design decision (brutalist = square grid) but is inconsistent with image-standards.ts which recommends `3:4` for the product primary surface. Bold card gets an 800×800 `1:1` override in image-standards (line 163) — intentional, documented.

**Verification gap:** The carousel and PecannbeeProductCard default to `aspect-square` when no `cardAspect` is set by the merchant. The 4 non-bold themes use `aspect-square sm:aspect-[3/4]` in their theme cards but the shared carousel and PLP card use pure `aspect-square`. Result: homepage carousels and PLP render square cards while the category/search context renders portrait cards. This is a cross-surface inconsistency that confuses product photographers.

**P0 FIX — Carousel default aspect:** `ProductCarousel.tsx:89` currently: `const aspectCls = shape.aspect || cardAspectClass(cardAspect) || 'aspect-square';`. This should be `'aspect-square sm:aspect-[3/4]'` as the fallback (matching 4 of 5 theme ProductCards) unless pack = bold, where `aspect-square` is correct. Alternatively, expose this as a per-theme default that the carousel inherits.

**P0 FIX — PecannbeeProductCard default aspect:** `PecannbeeProductCard.tsx:89` same issue — fallback is `aspect-square` instead of `aspect-square sm:aspect-[3/4]`. Fix to match theme cards.

### Category card — theme defaults

| Theme | Mobile aspect | Desktop aspect (sm:) | File:Line |
|---|---|---|---|
| modern | `aspect-square` | `sm:aspect-[4/3]` landscape | `modern/CategoryCard.tsx:40` |
| elegant | `aspect-square` | `sm:aspect-[2/3]` portrait | `elegant/CategoryCard.tsx:26` |
| classic | `aspect-square` | `sm:aspect-[3/4]` portrait | `classic/CategoryCard.tsx:26` |
| minimal | `aspect-square` | `sm:aspect-[4/3]` landscape | `minimal/CategoryCard.tsx:26` |
| bold | `aspect-square` | `sm:aspect-[3/4]` portrait | `bold/CategoryCard.tsx:26` |

**P1 — 4-way split on category desktop aspect.** Modern and minimal go landscape `[4/3]`, elegant goes deep portrait `[2/3]`, classic and bold go standard portrait `[3/4]`. This is brand-expressive (intentional per theme voice) but means the categories section height varies dramatically between themes. Document these as theme-invariants so they don't get accidentally normalized.

### PDP image aspect — configurable but default `aspect-square`
`ProductDetailClient.tsx:185-192` → merchant can set `imageAspect` in page-builder. Default: `aspect-square`. Recommended upload ratio in image-standards.ts: `3:4` (portrait). Mismatch between default render aspect and recommended upload ratio will crop portraits.

**P1 recommendation:** Change default from `aspect-square` → `aspect-[3/4]` so the rendered default matches the recommended upload spec. Add a clear admin hint that the current setting crops to square.

### Hero aspect ratios — cross-theme inconsistency

| Theme | Desktop | Mobile | File:Line |
|---|---|---|---|
| HeroBanner / HeroSlider (shared) | `sm:aspect-[1920/700]` (~2.74:1) | `aspect-[var(--hero-m-aspect)]` (4:3) | `HeroBanner.tsx:84-85`, `HeroSlider.tsx:125` |
| modern Hero (legacy) | `aspect-[4/3] lg:aspect-[5/4]` image | `min-h-[44vh] sm:min-h-[560px]` outer | `modern/Hero.tsx:135` |
| elegant Hero (legacy) | `aspect-[4/3] sm:aspect-[16/10] lg:aspect-auto` | `min-h-[60vh]` | `elegant/Hero.tsx:54` |
| classic Hero (legacy) | `min-h-[480px] lg:min-h-[640px]` height only | — | `classic/Hero.tsx:33` |
| minimal Hero (legacy) | `aspect-[21/9]` (2.33:1) | — | `minimal/Hero.tsx:65` |
| bold Hero (legacy) | `min-h-[50vh] md:min-h-screen` | — | `bold/Hero.tsx:31` |

**P1 — Legacy Hero components use 5 different aspect approaches.** Modern/elegant use aspect ratios for the image panel; classic uses fixed min-height; minimal uses a wide 21:9 aspect; bold fills 100vh. New HeroBanner/HeroSlider are normalized. The legacy heroes will be progressively replaced but merchants still using them see wildly different vertical proportions.

---

## 5. Grid Gaps

### Section-level gridGapClass (shared helper)

`card-size.ts:75-87` defines:
- `tight`: `gap-1.5 sm:gap-2` — P2, `gap-1.5` is off-grid (6px; use `gap-2`)
- `normal` (default): `gap-3 sm:gap-4` — on-grid ✅
- `loose`: `gap-5 sm:gap-6` — P2, `gap-5` is off-grid (20px; use `gap-4` or `gap-6`)  
- `xloose`: `gap-8 sm:gap-10` — `gap-10` = 40px, on-grid ✅

**P1 — `tight` uses `gap-1.5` (6px, off-grid).** Fix to `gap-2 sm:gap-2` or `gap-2 sm:gap-3`.  
**P1 — `loose` uses `gap-5` (20px, off-grid).** Fix to `gap-4 sm:gap-6` or `gap-6 sm:gap-8`.

### PLP grid gap hardcoded fallback — off-grid
`ProductsClient.tsx:573`:
```tsx
gap-4 sm:gap-5 lg:gap-6
```
`gap-5` = 20px — **off-grid.** When `productCardDefaults.cardGap` is unset, the PLP grid uses an ad-hoc 3-step ramp with an off-grid midpoint instead of the shared `gridGapClass()` helper.

**P0 FIX:** Replace `'gap-4 sm:gap-5 lg:gap-6'` with `gridGapClass('normal')` which gives `'gap-3 sm:gap-4'`. Or if larger gaps are desired at desktop: `'gap-4 lg:gap-6'` (both on-grid, no sm:gap-5).

### Per-theme ProductGrid gaps (consistent)
All 5 themes use `gap-3 md:gap-4` — on-grid, consistent. ✅

### SectionHeading internal gap — off-grid
`SectionHeading.tsx:168`: `gap-2 sm:gap-3` outer — on-grid ✅  
`SectionHeading.tsx:173`: `gap-1.5 sm:gap-2` inner kicker row — `gap-1.5` = 6px, **off-grid.** Fix to `gap-2 sm:gap-2`.

---

## 6. Recommendations

### Unified 8pt Spacing Scale (allowed Tailwind values)

```
Gaps between cards:     gap-2  gap-3  gap-4  gap-6  gap-8
Section padding (py):   py-8   py-12  py-16  py-20  py-24
Internal component p:   p-2    p-3    p-4    p-6    p-8
Heading-to-content mb:  mb-6   mb-8   mb-12
Element spacing mt/mb:  mt-2   mt-4   mt-6   mt-8   mt-12  mt-16
```

Values to remove from the codebase: `gap-1.5`, `gap-5`, `gap-7`, `gap-10`, `py-5`, `py-6`, `py-10`, `py-14` (→ normalize to py-12), `py-24` on homepage (→ py-20).

### Standard Section Rhythm

```tsx
// Standard homepage section
<section className="py-12 sm:py-16 lg:py-20">
  <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
    <SectionHeading ... />  {/* mb-8 sm:mb-12 built-in */}
    {/* grid content */}
  </div>
</section>

// Hero-attached categories section (close coupling intentional)
<section className="pt-8 sm:pt-12 lg:pt-16 pb-12 sm:pb-16 lg:pb-20">
  ...
</section>
```

Concrete changes by section:

| Section | Current mobile | Target mobile | File:Line |
|---|---|---|---|
| categories | `pt-12 pb-14` | `pt-8 pb-12` | `HomePageContent.tsx:377` |
| newArrivals | `py-14` | `py-12` | `HomePageContent.tsx:482` |
| bestSellers | `py-14` | `py-12` | `HomePageContent.tsx:565` |
| testimonials | `py-14` | `py-12` | `HomePageContent.tsx:693` |
| extraCarousels | `py-14` | `py-12` | `HomePageContent.tsx:784` |
| fallback grid | `py-14 ... lg:py-24` | `py-12 sm:py-16 lg:py-20` | `HomePageContent.tsx:834` |
| brandStory | `py-12` | ✅ keep | `BrandStoryBlock.tsx:51` |
| trustStrip | `py-12` | ✅ keep | `TrustStrip.tsx:117` |

### Standard Container (apply to all 7 deviating pages/components)

```tsx
// All content pages
<div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">

// About, Compare, Wishlist: change `container` to the above
// CategoryGrid (4 themes): remove the inner container entirely
```

### Standard Column Splits

| Layout | Current | Target | Files to change |
|---|---|---|---|
| Cart items/summary | `8/4 on 12-col` | ✅ keep | — |
| Checkout form/summary | `7/5 on 12-col` | `8/4 on 12-col` | `CheckoutClient.tsx:850`, `OrderSummary.tsx:50` |
| PDP gallery/info | `6/6 on 12-col (implicit)` | `5/7 on 12-col` | `ProductDetailClient.tsx:450` |

### Card Aspects

```tsx
// ProductCarousel fallback — ProductCarousel.tsx:89
const aspectCls = shape.aspect || cardAspectClass(cardAspect) || 'aspect-square sm:aspect-[3/4]';

// PecannbeeProductCard fallback — PecannbeeProductCard.tsx:89
const aspectOverride = shape.aspect || cardAspectClass(cardAspect) || 'aspect-square sm:aspect-[3/4]';

// Bold pack exception: if pack === 'bold', force 'aspect-square'
```

### gridGapClass fixes — card-size.ts

```tsx
// Line 78 — tight
case 'tight':
  return 'gap-2 sm:gap-3';   // was 'gap-1.5 sm:gap-2'

// Line 79 — loose
case 'loose':
  return 'gap-4 sm:gap-6';   // was 'gap-5 sm:gap-6'
```

---

## Priority Queue

### P0 — Fix before next merchant goes live

| # | Issue | File:Line | Fix |
|---|---|---|---|
| P0-1 | Fallback ProductGrid `lg:py-24` breaks homepage rhythm | `HomePageContent.tsx:834` | Change to `lg:py-20` |
| P0-2 | PLP default gap `sm:gap-5` is off-grid | `ProductsClient.tsx:573` | Replace with `gridGapClass('normal')` or `'gap-4 lg:gap-6'` |
| P0-3 | ProductCarousel aspect fallback `aspect-square` — mismatches 4/5 theme cards | `ProductCarousel.tsx:89` | Change fallback to `'aspect-square sm:aspect-[3/4]'` |
| P0-4 | PecannbeeProductCard aspect fallback `aspect-square` — mismatches 4/5 theme cards | `PecannbeeProductCard.tsx:89` | Change fallback to `'aspect-square sm:aspect-[3/4]'` |

### P1 — Next sprint

| # | Issue | File:Line | Fix |
|---|---|---|---|
| P1-1 | About/Compare/Wishlist use `container` not `max-w-7xl` | Multiple | `mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8` |
| P1-2 | CategoryGrid (4 themes) inner `container mx-auto px-4` double-pads desktop | 4 theme files | Remove inner container |
| P1-3 | Checkout `7/5` split vs Cart `8/4` — inconsistent funnel | `CheckoutClient.tsx:850`, `OrderSummary.tsx:50` | Normalize to `8/4` |
| P1-4 | PDP `grid-cols-2` → `lg:grid-cols-12` `5/7` split | `ProductDetailClient.tsx:450` | Wider info panel |
| P1-5 | PDP related products capped at 3 cols | `ProductDetailClient.tsx:711` | Extend to `lg:grid-cols-4` |
| P1-6 | Homepage section mobile py-14 → py-12 across 5 sections | `HomePageContent.tsx:482,565,693,784` | Reduce by 8px each |
| P1-7 | gridGapClass `tight` = `gap-1.5` (off-grid) | `card-size.ts:78` | `gap-2 sm:gap-3` |
| P1-8 | gridGapClass `loose` = `gap-5` (off-grid) | `card-size.ts:79` | `gap-4 sm:gap-6` |
| P1-9 | SectionHeading inner kicker row `gap-1.5` (off-grid) | `SectionHeading.tsx:173` | `gap-2` |
| P1-10 | PLP goes 5/6 cols at xl/2xl but Search caps at 4 | `ProductsClient.tsx:573` | Add `xl:grid-cols-5` to Search or cap PLP at 5 |

### P2 — Polish

| # | Issue | File:Line | Fix |
|---|---|---|---|
| P2-1 | PDP default imageAspect = `aspect-square` mismatches upload spec `3:4` | `ProductDetailClient.tsx:187` | Default to `aspect-[3/4]` |
| P2-2 | PDP no `md` column breakpoint — jumps to 2-col at lg | `ProductDetailClient.tsx:450` | Add `md:grid-cols-2` |
| P2-3 | modern/bold Hero CTAs use `gap-2.5` (off-grid) | `modern/Hero.tsx:56`, `bold/Hero.tsx:92` | `gap-3` |
| P2-4 | modern ProductCard CTA `py-2.5` (off-grid) | `modern/ProductCard.tsx:231` | `py-3` |
| P2-5 | Cart image thumb hardcoded `h-28 w-28 sm:h-32 sm:w-32` (not in 8pt: 112/128) | `CartClient.tsx:427` | `h-32 w-32 sm:h-32 sm:w-32` or CSS variable |
| P2-6 | PDP thumbnail strip `grid-cols-4 gap-4` hardcoded; no breakpoint | `ProductDetailClient.tsx:487` | `grid-cols-4 sm:grid-cols-5` |
| P2-7 | Blog inner content uses `max-w-3xl` (intentional readability narrow but narrower than prose standard `max-w-2xl`) | `BlogPostClient.tsx` | Keep or document |
| P2-8 | Category card aspects are 4-way split across themes — document as theme-invariants | Per-theme CategoryCard | Add inline comment per theme: "theme-identity: do not normalize" |
