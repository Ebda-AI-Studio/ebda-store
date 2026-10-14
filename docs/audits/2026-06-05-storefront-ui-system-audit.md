# Storefront UI/UX System Audit — Force Website Builder

**Date:** 2026-06-05
**Scope:** Storefront rendering surfaces (checkout, products-list, product-detail, categories-list, you-may-like, product-card, header/hero, global) measured against the FWB canonical design system.
**Method:** Code-confirmed (file:line) findings only. Every finding below was read in source and verified against the source-of-truth spec files.

---

## 1. The Mechanical System Model

The storefront is governed by three mechanical systems. Every finding in this report is a place where a render path bypassed one of them. Fix-the-system, not fix-the-symptom: a correct fix routes the element back through the canonical source so a single change moves all paths together.

### 1a. The ONE Type Scale

There is exactly **one** size source per element class. Themes supply _flavor only_ (weight, tracking, font-family, color), never size.

- **Product card name + price + cta + body padding + gap + button box** → all derive from `getProductCardTextSizes(cardSize)` (`packages/shared/src/types/store-theme.ts:499-568`). One `cardSize` ('xxs'|'xs'|'sm'|'md'|'lg'|'xl') drives the whole card.
  - `md` (default): name/price `text-base sm:text-lg`, cta `text-sm`, pad `p-3 sm:p-4`, gap `gap-2`, btn `min-h-10 px-4 py-2`.
  - **16px floor** on name + price (never below `text-base`), the sole exception being `xxs` (ultra-compact tile).
  - **NAME-vs-PRICE invariant:** name ≥ price on `xxs`/`xs`/`sm`/`md` (parity). Price may step ONE notch above name only on `lg`/`xl`.
- **Section/zone text** → `TYPOGRAPHY_ZONES` + the design.md table. Section "see all" = `text-sm` (14px). Section title = `text-3xl sm:text-4xl lg:text-5xl`. Every zone defaults to 16px at theme level; identity = weight/tracking/family.
- **Hero headline** → `text-4xl sm:text-5xl md:text-6xl lg:text-7xl` (bold steps up one notch). The _only_ intentional scale exception.
- **Anti-pattern (hard rule):** no `text-[Npx]` arbitrary values on any zone-tagged element — they win specificity over the per-store CSS emitter and silently no-op merchant overrides. FWB's 4-step scale = 12 / 14 / 16 / 18 / 22.

### 1b. The ONE Spacing + Image-Cap Scale

- Card body padding `p-3 sm:p-4` (or `getProductCardTextSizes().pad` for cardSize-awareness); content `gap-2`; grid `gap-3 md:gap-4`. Never `p-5+`, never `gap-3+` on content.
- **Caps belong on the OUTERMOST/frame element** ("shrink the container first via `max-w`, not the content").
- **Product image (primary) = 600×800, 3:4 portrait** — canonical across all 7 ProductCard render paths. Square mode (800×800, 1:1) only when `cardAspect:'square'`. PDP gallery uses `aspect-square` per `globals.css:485-487` but must not show oversized imagery (no marketing-page imagery on transactional surfaces).

### 1c. The Color-Token + Inversion Rule

- Resolve any surface background via `resolveColor(value, theme)` (`packages/shared/src/utils/color.ts:148-180`). `token:<name>` → real `hsl()`, always falling back to `hsl(var(--<key>))` so it never paints undefined.
- Pick the foreground via `pickReadableForeground(resolvedBg)` (`color.ts:191-207`): WCAG luminance flip at **0.179** → `#000` on light, `#fff` on dark. `#FF6E00` (Force orange, L≈0.324) correctly yields BLACK (7.48:1 AA-pass).
- **Every tinted/brand surface** (filter bar, category frame, headings on colored bg, hero on a configured bg) MUST run bg through `resolveColor` and foreground through `pickReadableForeground`. Hardcoding `text-white`/`text-foreground` on a configurable surface is a contrast leak.
- Note: the old runtime `--section-fg` auto-fix cascade was _removed_ (it false-triggered on token bgs). Do NOT re-add a CSS auto-fix cascade — invert at render time in the component instead.

---

## 2. Findings by Surface

Severity legend: **critical** = invisible/unreadable or brand-defining surface broken in production · **high** = spec violation users will notice · **medium** = consistency/override-leak that degrades merchant control.

### 2.1 Checkout

#### CHK-1 — Coupon code block: non-responsive padding + missing data-zone wiring · medium

- **File:** `apps/web/src/app/checkout/OrderSummary.tsx:103-114`
- **Wrong:** Applied-coupon block uses `p-3` (no `sm:p-4`) and `text-sm text-[hsl(var(--success))]` with **no `data-zone`** attribute. Padding violates the `p-3 sm:p-4` card-body floor; the text can't receive merchant typography overrides.
- **Fix:** Change `p-3` → `p-3 sm:p-4` (line 103). Wrap the coupon block in a `data-zone="cta"` (or new `couponCode`) zone. Keep `text-sm` as a named class (not arbitrary). The `--success` color is contextually correct but should still respect zone color overrides.

### 2.2 Products List

#### PL-1 — Filter sidebar is NOT primary-filled + NOT inverted (Anchor C) · critical

- **File:** `apps/web/src/app/products/ProductsFilterSidebar.tsx:387` (aside), `523` (panel body), `139-175` (results summary), `321`/`348` (category buttons)
- **Wrong:** The filter bar uses only `border-primary/25` accents (line 139) and per-button `bg-primary text-white` (lines 321/348). The outer `<aside>` (line 387) and panel body (523) have **zero background**. The spec requires the entire filter bar to be FILLED with `token:primary` and all contents auto-inverted via `pickReadableForeground`. Lines 141/157/182/202/220/280/311 use `text-foreground`/`text-muted-foreground` on what should be an inverted primary surface.
- **Fix:**
  1. Line 387 aside: add `bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]`.
  2. Results summary (139-175): replace `text-foreground`/`text-muted-foreground` → `text-[hsl(var(--primary-foreground))]`.
  3. Active category buttons (321/348): `bg-primary text-white` → `bg-primary/20 text-[hsl(var(--primary-foreground))]` (or outline variant) so selection reads against the now-primary container.
  4. Sidebar section headings (line 182/202/311): → `text-[hsl(var(--primary-foreground))]`.
     The aside becomes a primary container; every text child inherits the inverted foreground.

#### PL-2 — ProductListItem (7th product render path) missing data-zone on name + price · medium

- **File:** `apps/web/src/app/products/ProductListItem.tsx:90` (name), `:97` (price)
- **Wrong:** Line 90 `<h3 className="mt-1 text-lg font-semibold text-foreground">` and line 97 `<span className="text-xl font-bold text-primary tabular-nums">` lack `data-zone`. These are the only two product render paths missing zone identifiers (9 other files are correctly wired). Merchant typography overrides silently no-op in list view.
- **Fix:** Line 90 → add `data-zone="productName"`. Line 97 → add `data-zone="productPrice"`. The named size classes (`text-lg`/`text-xl`) are acceptable; only the missing attributes are the defect.

### 2.3 Product Detail (PDP)

#### PDP-1 — Price (`text-2xl`) renders larger than name + hardcode defeats merchant override (Anchor D, part 1) · critical

- **File:** `apps/web/src/app/products/[slug]/ProductDetailClient.tsx:537` (name h1), `550` (price span)
- **Wrong:** Name h1 carries `text-3xl font-bold` **with** `style={zoneStyle(pdpNameZone, pdpScale)}` on the same element (override works). Price has `data-zone="productPrice"` + `zoneStyle` on the **parent div** (545-548), but the inner **span** hardcodes `text-2xl` (line 550) — the Tailwind class on the child wins over the parent's inline `fontSize`, so (a) the merchant `productPrice` override is silently ignored, and (b) default 24px price vs 30px name holds today, but any merchant shrinking the name via `pdpNameZone` makes price > name, violating the NAME-vs-PRICE invariant — unguarded.
- **Fix:** Remove `text-2xl` from line 550: `<span className="font-bold text-primary">`. Move `data-zone="productPrice"` + `style={zoneStyle(pdpPriceZone, pdpScale)}` onto the span itself (mirror the name pattern at 536-539) so the zone drives size. Also defensively, the price baseline should sit one notch _below_ name (e.g. cap at `text-xl`). Add a page-builder save-time validator that warns if `pdpPriceZone.fontSize > pdpNameZone.fontSize`. Document the PDP NAME-vs-PRICE rule in design.md (currently only documented for cards).

#### PDP-2 — Name hardcodes `text-3xl`, overriding the merchant name zone · medium

- **File:** `ProductDetailClient.tsx:537`
- **Wrong:** `text-3xl` on the h1 is a Tailwind utility (`!important` by default) that wins over the inline `zoneStyle` fontSize, so a merchant cannot grow/shrink the PDP name.
- **Fix:** Drop `text-3xl` from line 537 → `className="font-bold text-foreground"`; let `zoneStyle(pdpNameZone, pdpScale)` drive size. (Apply alongside PDP-1 so name and price are both zone-driven and the hierarchy is preserved by the validator.)

#### PDP-3 — Gallery image 800×800 + no max-w cap → oversized vs 600×800 (Anchor D, part 2) · high

- **File:** `ProductDetailClient.tsx:457-459` (frame div), `464-465` (Image width/height), `467` (sizes), `186` (aspect default)
- **Wrong:** `<Image width={800} height={800}>` (square source) with `sizes="(max-width: 1024px) 100vw, 50vw"`, and the outer frame div has **no `max-w`** — the gallery can balloon to ~586px (md:col-span-5 of max-w-7xl) and serve an 800px source on mobile. Spec product image = 600×800 (3:4). Default aspect falls back to `aspect-square` (line 186) when the spec default is portrait.
- **Fix:**
  1. Line 457 frame div: add `max-w-[600px]` to the className (cap on the OUTER frame).
  2. Lines 464-465: `width={600} height={800}` to match the canonical 3:4 source.
  3. Line 467 sizes: tighten to `(max-width: 768px) 100vw, (max-width: 1024px) 40vw, 32vw` to match the col-span-5 render width.
  4. Line 186: default fallback `aspect-square` → `aspect-[3/4]` so merchants without an explicit pick inherit the portrait default. (Where a store legitimately uses square mode, the 800×800/`aspect-square` source remains correct — drive both from the merchant `cardAspect`, not a hardcode.)

#### PDP-4 — "You May Also Like" heading can render light text on light bg (Anchor B) · critical

- **File:** `apps/web/src/templates/shared/SectionHeading.tsx:253-268, 277-298`; `section-typography.ts:26-57` (resolveSectionZone receives no bg); `ProductCarousel.tsx:166`; `HomePageContent.tsx:483`
- **Wrong:** SectionHeading applies `color: headingZone?.color` as an inline style on the h2 with **no contrast check**. `resolveSectionZone()` never receives the section background, so it cannot call `pickReadableForeground`. The section bg is applied separately on the wrapper. When a merchant saves a light heading color (e.g. `token:secondary` resolving near-white) or the heading lands on a white page, the headline is invisible. `pickReadableForeground` exists (`color.ts:191-207`) but is unused in the storefront override path — it only runs in admin preview / `generateSectionPalette`.
- **Fix:** Thread the section background into the heading color resolution:
  1. Add a `sectionBgColor?: string` prop to `SectionHeading` and to `resolveSectionZone()`.
  2. When no explicit merchant heading color is set, compute `merged.color = pickReadableForeground(resolveColor(bgColor, theme)) ?? '#000000'`.
  3. Have `ProductCarousel` / `CategoryGrid` / `TestimonialRow` forward the section bg they already receive.
  4. As an immediate guard for the PDP related-products block specifically: strip a saved light color when no contrast context exists — `const relatedHeadingZone = pdpHeadingZone?.fontSize ? { ...pdpHeadingZone, color: undefined } : { fontSize: '20px' }` — forcing the guaranteed-dark `text-foreground` fallback.

### 2.4 Categories List

#### CAT-1 — Category cards lack the brand-primary frame on all 5 themes (Anchor E) · critical

- **Files:** `apps/web/src/templates/modern/CategoryCard.tsx:56`, `elegant/CategoryCard.tsx:39`, `classic/CategoryCard.tsx:39`, `minimal/CategoryCard.tsx:38`, `bold/CategoryCard.tsx:37-38`
- **Wrong:** Modern, Elegant, Minimal, Bold image-frame divs have **no border**. Classic has `border border-border/60` (neutral, not primary). The platform invariant is a `token:primary` border on every category card; none satisfy it. This is a platform-level (not per-theme) requirement.
- **Fix:** Add `border border-[hsl(var(--primary))]` to the image-container div in all 5 files (modern 56, elegant 39, minimal 38, bold 37-38; classic 39 replace `border-border/60` → `border-[hsl(var(--primary))]`).

#### CAT-2 — CategoriesClient does not forward `cardFrameColor` to the grid (root cause) · high

- **Files:** `apps/web/src/app/categories/CategoriesClient.tsx:72-80`; supporting gap: `apps/web/src/templates/types.ts:612` (`CategoryCardProps` lacks frame props)
- **Wrong:** `T.CategoryGrid` is called without `cardFrameColor` even though the prop exists on `CategoryGridProps` (types.ts:638), all 5 theme grids honor it, `HomePageContent.tsx:411` _does_ pass it, and `layout.categories.cardFrameColor` holds the merchant value. The categories-list page silently drops the merchant's frame color while the homepage respects it. Separately, the `CategoryCard` components themselves are frame-unaware (only `CategoryGrid`/`CategoryStrip` wrap a frame div), which is the architectural reason CAT-1 has to be patched per theme.
- **Fix:**
  1. `CategoriesClient.tsx:72`: add `cardFrameColor={layout.categories.cardFrameColor}` (plus the sibling frame props HomePageContent passes: `showCardFrame`, `cardFrameStyle`, `cardFrameWidth`, `cardFrameSize`).
  2. Longer-term: push `cardFrameColor` + frame props onto `CategoryCardProps` (types.ts:612) and apply the frame on the card root (mirror `PecannbeeProductCard.tsx:142-146`: `style={showCardFrame && cardFrameColor && store.theme ? { borderColor: resolveColor(cardFrameColor, store.theme) } : undefined}`), eliminating the wrapper-div pattern so CAT-1 and CAT-2 collapse into one platform-level fix.

### 2.5 You-May-Like (shared carousel)

#### YML-1 — Section heading no-contrast (same root as PDP-4) · high

- **File:** `SectionHeading.tsx:253-298`; `section-typography.ts:26`; `ProductCarousel.tsx:166`
- This is the same defect as PDP-4 but applies to _every_ `ProductCarousel`/recommendation heading platform-wide (homepage new-arrivals, related products, etc.). Fixing PDP-4 via the `sectionBgColor` threading in `resolveSectionZone`/`SectionHeading` resolves YML-1 across all carousel callers in one change. Treat PDP-4's fix as the platform fix; do not patch only the PDP path.

### 2.6 Product Card (all 5 themes)

#### PC-1 — Theme ProductCards hardcode name/price size instead of `getProductCardTextSizes(cardSize)` · high

- **Files:**
  - `minimal/ProductCard.tsx:193` — name `text-xs` (12px, below the 16px floor)
  - `elegant/ProductCard.tsx:253` — name `text-xs`
  - `classic/ProductCard.tsx:185` — name `text-sm md:text-base`
  - `bold/ProductCard.tsx:183` — name `text-base`
  - `modern/ProductCard.tsx:255` — name `text-sm`
- **Wrong:** Each receives `cardSize` (line 44/45) but **none import or call** `getProductCardTextSizes`. They hardcode size, so the cardSize control does not scale them, and minimal/elegant ship 12px names — under the 16px floor. `PecannbeeProductCard` and `ProductCarousel` use the helper correctly, proving the platform standard.
- **Fix (one batch, all 5 files):** import `getProductCardTextSizes` from `@ebda/shared`, call `const textSizes = getProductCardTextSizes(cardSize)`, and replace the hardcoded name size with `${textSizes.name}` (and price with `${textSizes.price}`). Keep each theme's flavor (weight/tracking/uppercase/family/color) untouched — only the size token moves to the helper. Example (classic): `className={\`font-serif ${textSizes.name} text-foreground mb-2 ...\`}`.

#### PC-2 — Theme ProductCards hardcode body padding instead of `textSizes.pad` · medium

- **Files:** `modern/ProductCard.tsx:241`, `elegant:249`, `classic:180`, `minimal:189`, `bold:179`
- **Wrong:** All 5 use literal `p-3 sm:p-4`. Correct _value_ for `md`, but not derived from `cardSize`, so non-default sizes (xs→`p-2 sm:p-2.5`, lg→`p-4 sm:p-5`, xl→`p-5 sm:p-6`) don't apply — density breaks for non-md cards. Pecannbee + ProductCarousel use `textSizes.pad`.
- **Fix:** Replace `p-3 sm:p-4` with `${textSizes.pad}` in all 5 (same import added in PC-1).

#### PC-3 — Theme ProductCards ignore `cardAspect`; Bold hardlocks `aspect-square` · medium

- **File:** `bold/ProductCard.tsx:85` (cited), plus modern/elegant/classic/minimal hardcoded to `aspect-square sm:aspect-[3/4]`
- **Wrong:** None of the 5 theme ProductCards destructure or honor `cardAspect` — only shared components (Pecannbee, ProductCarousel, CategoryCard) implement `cardAspectClass(cardAspect)`. This violates the design principle that `aspect-*` is structural/uniform, not theme-specific. Bold is the most prescriptive case (no portrait override at all), but it's a platform-wide gap, not a Bold-only bug.
- **Fix (platform-level):** add `cardAspect` (+ `cardShape`/`showLabel`/`showHover`) to all 5 theme ProductCard signatures; compute `const aspectOverride = shape.aspect || cardAspectClass(cardAspect) || <theme-default>` and apply it (mirror Pecannbee/ProductCarousel). Bold's theme default stays `aspect-square`.

#### PC-4 — Free-form `fontSize` zone input allows arbitrary `text-[Npx]` to bypass the scale · high

- **Files:** `apps/admin/src/components/ZoneEditor.tsx:188-200` (unvalidated input); `section-typography.ts:74-85` (`responsiveFontSize` accepts any string); `PecannbeeProductCard.tsx:278-296, 309-324` (inline-style fontSize)
- **Wrong:** The admin fontSize field has no validation; `responsiveFontSize()` injects any string into inline styles. A merchant entering `text-[20px]` (or any arbitrary value) persists unchecked and bypasses the 4-step scale + 16px floor.
- **Fix:** (1) Add a hint + on-blur validation in `ZoneEditor` documenting the allowed values (12/14/16/18/22px ↔ text-xs/sm/base/lg/xl/2xl). (2) In `responsiveFontSize()` reject `text-[…]` bracket syntax — accept only px/rem/em/% or documented token names. (3) Document in the data-zone rule that zone `fontSize` is px-only, no Tailwind arbitrary brackets.

### 2.7 Header / Hero

#### HERO-1 — Hero headline hardcodes `text-white` with no bg-contrast check · medium

- **File:** `apps/web/src/templates/shared/pack-styles.ts:84` (modern), `108` (classic), `145` (minimal), `169` (bold), `198` (elegant); applied in `HeroBanner.tsx:122`
- **Wrong:** All 5 `heroHeadline` classes contain `text-white drop-shadow-xl`. The Tailwind `text-white` wins the cascade over the optional inline `headingZone` color (HeroBanner ~line 128). A merchant configuring a light hero background gets an invisible/low-contrast headline. `pickReadableForeground` exists and solves exactly this.
- **Fix:** Remove `text-white` from all 5 `heroHeadline` classes (keep size/weight/tracking/`drop-shadow`). In `HeroBanner.tsx`, resolve color at runtime: `const heroColor = headingZone?.color ?? pickReadableForeground(resolveColor(heroBgColorValue, store.theme) ?? '#ffffff')` and apply it to the h1 `style`.

### 2.8 Global

#### G-1 — Section "see all" link oversized at `text-xl` across all 5 themes · medium

- **File:** `apps/web/src/templates/shared/pack-styles.ts:81` (modern), `105` (classic), `142` (minimal), `166` (bold), `195` (elegant)
- **Wrong:** All 5 `sectionSeeAll` entries use `text-xl` (20px). The standardized size is `text-sm` (14px) — a 6px oversizing against the standing rule that eliminated the prior xs/11px/sm mishmash.
- **Fix:** Change all 5 `sectionSeeAll` to `text-sm`, retaining per-theme flavor (weight/tracking/uppercase/family). Identity carries via weight, not size.

---

## 3. The 5 User-Anchor Bugs

| Anchor                             | What the user sees                                    | Finding(s)    | Severity      | One-line fix                                                                                                                                                     |
| ---------------------------------- | ----------------------------------------------------- | ------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** Checkout summary             | Coupon block padding/typography off the system        | CHK-1         | medium        | `p-3` → `p-3 sm:p-4` + wrap in `data-zone="cta"` (OrderSummary.tsx:103)                                                                                          |
| **B** You-may-like white-on-white  | Recommendation/related headline invisible on light bg | PDP-4 / YML-1 | critical      | Thread `sectionBgColor` into `resolveSectionZone`/`SectionHeading`, auto-invert via `pickReadableForeground` when no explicit color (SectionHeading.tsx:253-298) |
| **C** Filter bar                   | Sidebar not primary-filled, not inverted              | PL-1          | critical      | Fill `<aside>` with `bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]`, invert children (ProductsFilterSidebar.tsx:387)                            |
| **D** PDP price>name + huge images | Price larger than name; gallery oversized             | PDP-1, PDP-3  | critical/high | Drop `text-2xl` on price span + move zone onto it (550); add `max-w-[600px]` + `width={600} height={800}` (457/464)                                              |
| **E** Categories primary frame     | Category cards have no brand frame                    | CAT-1, CAT-2  | critical/high | Add `border border-[hsl(var(--primary))]` to all 5 CategoryCards + forward `cardFrameColor` from CategoriesClient.tsx:72                                         |

---

## 4. Prioritized Fix Plan

Grouped so related edits ship in one commit/PR. Order: contrast/visibility → hierarchy/override leaks → size/spacing caps → consistency.

### PR 1 — Contrast & visibility (critical, ship first)

1. **Section-heading auto-invert (Anchor B):** add `sectionBgColor` to `resolveSectionZone()` + `SectionHeading`; auto-compute `pickReadableForeground` when no explicit color; forward bg from `ProductCarousel`/`CategoryGrid`/`HomePageContent`. Immediate guard: strip light color on PDP related-products zone. Fixes **PDP-4 + YML-1** platform-wide.
2. **Filter sidebar primary-fill + invert (Anchor C):** `ProductsFilterSidebar.tsx:387` aside → primary bg + inverted text; lines 139-175 and 182/202/311 → `text-[hsl(var(--primary-foreground))]`; active buttons 321/348 → `bg-primary/20` + inverted. Fixes **PL-1**.
3. **Category brand frame (Anchor E):** add `border border-[hsl(var(--primary))]` to all 5 `CategoryCard.tsx` (modern 56, elegant 39, classic 39, minimal 38, bold 37-38) **and** forward `cardFrameColor` from `CategoriesClient.tsx:72`. Fixes **CAT-1 + CAT-2**.
4. **Hero headline runtime color:** strip `text-white` from 5 `heroHeadline` classes; resolve via `pickReadableForeground` in `HeroBanner.tsx`. Fixes **HERO-1**.

### PR 2 — Hierarchy & override leaks (critical/high)

5. **PDP price vs name (Anchor D-1):** remove `text-2xl` from price span (ProductDetailClient.tsx:550), move `data-zone`/`zoneStyle` onto the span; remove `text-3xl` from name h1 (537); add page-builder validator warning when price fontSize > name fontSize. Fixes **PDP-1 + PDP-2**.
6. **ProductListItem zone wiring:** add `data-zone="productName"` (line 90) + `data-zone="productPrice"` (line 97). Fixes **PL-2**.
7. **Zone fontSize validation:** restrict `ZoneEditor` input + `responsiveFontSize()` to the 4-step px scale, reject `text-[…]`. Fixes **PC-4**.

### PR 3 — Image & spacing caps (high/medium)

8. **PDP gallery cap (Anchor D-2):** add `max-w-[600px]` to frame div (457); `width={600} height={800}` (464-465); tighten `sizes` (467); default aspect `aspect-square` → `aspect-[3/4]` (186). Fixes **PDP-3**.
9. **Checkout coupon padding/zone (Anchor A):** `p-3` → `p-3 sm:p-4` + `data-zone="cta"` (OrderSummary.tsx:103). Fixes **CHK-1**.

### PR 4 — Type/spacing consistency on theme cards (high/medium)

10. **Theme ProductCard name/price → `getProductCardTextSizes`:** all 5 themes (minimal 193, elegant 253, classic 185, bold 183, modern 255) import the helper and use `textSizes.name`/`textSizes.price`; keep flavor. Fixes **PC-1** (and the 16px-floor violation in minimal/elegant).
11. **Theme ProductCard padding → `textSizes.pad`:** all 5 (modern 241, elegant 249, classic 180, minimal 189, bold 179). Fixes **PC-2**.
12. **Theme ProductCard aspect → `cardAspectClass(cardAspect)`:** wire `cardAspect` into all 5 theme signatures. Fixes **PC-3**.

### PR 5 — Global cleanup (medium)

13. **Section "see all" → `text-sm`:** all 5 `sectionSeeAll` in pack-styles.ts (81/105/142/166/195). Fixes **G-1**.

---

## Appendix — Source-of-Truth Files

- Type scale: `packages/shared/src/types/store-theme.ts:499-568` (`getProductCardTextSizes`)
- Zones: `packages/shared/src/types/typography.ts:45-97` (`TYPOGRAPHY_ZONES`, 14 zones)
- Color: `packages/shared/src/utils/color.ts` (`resolveColor` 148-180, `pickReadableForeground` 191-207, flip @ 0.179)
- Tokens/CSS: `apps/web/src/styles/globals.css` (`:root` 6-92; `.gallery-main` 485-487)
- Image caps: `packages/shared/src/types/image-standards.ts`; design.md:86-161
