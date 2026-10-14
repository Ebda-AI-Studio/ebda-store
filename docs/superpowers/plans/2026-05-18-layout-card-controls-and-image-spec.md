# Layout Card Controls & Image-Spec Refresh — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land four merchant-tunable improvements in one batch: (1) mobile image-size spec refresh per Ahmad's reference set (banner 900×700, category 630×630, product 600×600), (2) new `xxs` card size for ultra-compact grids, (3) per-section background-color picker on every homepage section, (4) per-section AND store-wide product-card frame color that reaches PLP / category / search — not just homepage carousels.

**Architecture:** All four changes ride the existing FWB pattern: types in `@ebda/shared/types/store-layout.ts`, Zod in `apps/api/src/routes/store-layout.routes.ts`, admin UI in `apps/admin/src/app/stores/[id]/layout/page.tsx`, consumer wiring in `apps/web/src/app/HomePageContent.tsx` + `ProductCarousel.tsx` + `PecannbeeProductCard.tsx` + the 5 theme `ProductCard.tsx`. Two new design elements: (a) a `ProductCardDefaults` block in layout settings that PLP / category / search read so the size/frame picker no longer stops at the homepage edge, and (b) a `bgColor` field on every section interface that the storefront applies as an inline style on the section wrapper (orthogonal to the existing theme-level `backgroundPreset` alternation; per-section bgColor wins when set).

**Tech Stack:** TypeScript, Zod, React (Next.js 16 App Router for `apps/admin` + `apps/web`), Tailwind CSS, Prisma JSONB column (`stores.layout_settings`), no migration needed.

---

## Spec coverage map

| Ahmad ask                                                              | Where it lands                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Image sizes (banner/category/product mobile)                           | `packages/shared/src/types/image-standards.ts` + `design.md` + admin upload hints                                                                                                                                                                                                                                                                                                                                                       |
| Smaller card option (`xxs`)                                            | `CardSize` enum + `categorySizeClass` / `productSizeClass` helpers + admin pickers + Zod                                                                                                                                                                                                                                                                                                                                                |
| Card size picker on PLP/category/search                                | New `productCardDefaults` in layout + PLP/category/search wrappers pass through + PecannbeeProductCard accepts the props                                                                                                                                                                                                                                                                                                                |
| Per-section bg color                                                   | `bgColor?: string` on Hero/Categories/NewArrivals/BestSellers/Testimonials + admin color picker + section wrapper inline style                                                                                                                                                                                                                                                                                                          |
| Card frame color (per-section override + global default)               | `cardFrameColor?: string` on Categories/NewArrivals/BestSellers + `productCardDefaults.cardFrameColor` global + frame elements apply inline `borderColor`                                                                                                                                                                                                                                                                               |
| Other templates' banner + card source sizes from Shopify + Stitch refs | New Sprint 6 — audit `feedback-polaris-vs-storefront-image-sizes` (Shopify theme spec) + `stitch-design-taste` skill + `2026-04-25-ui-ux-audit.md` + `feedback-fwb-theme-identity-audit`, produce per-theme matrix → `IMAGE_STANDARDS[key].templateOverrides` + new `recommendedSizeTextForTemplate(key, templateId)` helper + per-theme rows in design.md. Storefront rendering stays uniform; only admin upload hints vary per theme. |

---

## Consumer-trap discipline (per `feedback-fwb-card-controls-consumer-trap`)

Every new field MUST be touched in all FOUR layers before claiming done:

1. **Type** — `packages/shared/src/types/store-layout.ts` + matching `ProductCarouselProps` / `CategoryStripProps` / `CategoryGridProps` / new product-card-defaults pass-through in `apps/web/src/templates/types.ts`
2. **Zod** — `apps/api/src/routes/store-layout.routes.ts` `layoutSchema`
3. **Wiring** — `apps/web/src/app/HomePageContent.tsx` forwards every prop; `ProductsClient.tsx` + category/search pages forward `productCardDefaults`
4. **Consumer** — every render path destructures + applies: `ProductCarousel.tsx`, `CategoryStrip.tsx`, 5 theme `CategoryGrid.tsx`, `PecannbeeProductCard.tsx`, 5 theme `ProductCard.tsx`

After each section commit, run the 4-grep detection recipe from the consumer-trap memory before marking the task done.

---

## File structure (created / modified)

**Create:**

- `apps/web/src/templates/shared/section-bg.ts` — helper that maps `bgColor` string → inline `style` object (returns `undefined` when unset so the section wrapper falls back to the theme's alternation logic).

**Modify:**

- `packages/shared/src/types/image-standards.ts` — refreshed banner / new category / product mobile keys
- `packages/shared/src/types/store-layout.ts` — `xxs` CardSize, `bgColor` on 5 section interfaces, `cardFrameColor` on Categories/NewArrivals/BestSellers, new `ProductCardDefaults` interface + slot in `StoreLayoutSettings`, defaults + resolver merge
- `apps/web/src/templates/shared/card-size.ts` — `xxs` cases in `categorySizeClass` / `productSizeClass`
- `apps/api/src/routes/store-layout.routes.ts` — Zod additions for every new field
- `apps/admin/src/app/stores/[id]/layout/page.tsx` — bg color + frame color pickers per section + new Product Card Defaults block + xxs in size pickers
- `apps/web/src/app/HomePageContent.tsx` — section wrappers honor `bgColor`; product-card sections pass `cardFrameColor` + `productCardDefaults`
- `apps/web/src/templates/shared/ProductCarousel.tsx` — apply `cardFrameColor` inline on the frame element
- `apps/web/src/templates/shared/CategoryStrip.tsx` — same for category strip frames
- `apps/web/src/templates/{modern,elegant,classic,minimal,bold}/CategoryGrid.tsx` — accept + apply `cardFrameColor`
- `apps/web/src/templates/shared/PecannbeeProductCard.tsx` — accept `cardSize`/`cardAspect`/`cardShape`/`showCardFrame`/`cardFrameStyle`/`cardFrameColor`/`showLabel`/`showHover` props and apply
- `apps/web/src/templates/{modern,elegant,classic,minimal,bold}/ProductCard.tsx` — same prop additions and application
- `apps/web/src/app/products/ProductsClient.tsx` + category + search render paths — read `layout.productCardDefaults` and forward to the cards
- `apps/web/src/templates/types.ts` — extend `ProductCardProps` + `CategoryStripProps` + `CategoryGridProps` + add `ProductCardDefaultsProps`
- `design.md` — image-spec table refreshed
- `apps/admin/src/components/ImageUpload.tsx` consumer sites — wire `recommendedSizeHint` from the new IMAGE_STANDARDS keys where banner / mobile category / mobile product uploaders live

---

## Task list

### Sprint 1 — Image-spec refresh (low risk, high signal)

#### Task 1: Update `IMAGE_STANDARDS` mobile keys

**Files:**

- Modify: `packages/shared/src/types/image-standards.ts`

- [ ] **Step 1: Update `bannerMobile` to 900×700**

Replace the existing `bannerMobile` block with:

```ts
bannerMobile: {
  width: 900,
  height: 700,
  aspect: '9:7',
  formats: ['JPEG', 'WebP'],
  safeZone: { width: 700, height: 600 },
  description:
    'Full-width promotional banner — mobile. Near-square crop (9:7) per Ahmad 2026-05-18 reference set. Subject/CTA must fit inside the 700×600 center safe zone so iPhone-mini crops don’t lose the message.',
},
```

- [ ] **Step 2: Add `categoryMobile` key**

Insert directly after `categoryPortrait`:

```ts
categoryMobile: {
  width: 630,
  height: 630,
  aspect: '1:1',
  formats: ['JPEG', 'WebP', 'PNG'],
  description:
    'Category card image — mobile-tuned 1:1 (630×630). Smaller file than categorySquare’s 800×800 desktop ref. Use when merchant only ships one image and storefront is mobile-first.',
},
```

- [ ] **Step 3: Add `productMobile` key**

Insert directly after `productSquare`:

```ts
productMobile: {
  width: 600,
  height: 600,
  aspect: '1:1',
  formats: ['JPEG', 'WebP'],
  description:
    'Product photo — mobile-tuned 1:1 (600×600). Smaller file than productSquare’s 800×800. Pair with cardAspect = square. No baked-in text or sale badges.',
},
```

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types/image-standards.ts
git commit -m "feat(shared): refresh mobile image specs (banner 900x700, category/product 630x630/600x600)"
```

#### Task 2: Mirror in `design.md`

**Files:**

- Modify: `design.md` (Image asset standards section)

- [ ] **Step 1: Update the row for `bannerMobile`** — change `800×600` to `900×700 (9:7)` and update its description column to match the const.

- [ ] **Step 2: Add rows for `categoryMobile` (630×630, 1:1) and `productMobile` (600×600, 1:1)** in alphabetical order within the table.

- [ ] **Step 3: Commit**

```bash
git add design.md
git commit -m "docs: mirror refreshed mobile image spec in design.md"
```

#### Task 3: Wire `recommendedSizeHint` for the new keys

**Files:**

- Modify: `apps/admin/src/app/stores/[id]/layout/page.tsx` (banner mobile uploader if present)
- Modify: `apps/admin/src/app/stores/[id]/categories/CategoryForm.tsx` (add fallback hint when merchant uploads via mobile pipeline)
- Modify: `apps/admin/src/app/stores/[id]/products/new/page.tsx` + `[productId]/edit/page.tsx`

- [ ] **Step 1: Grep call sites that already pass `recommendedSizeHint`**

```bash
grep -n "recommendedSizeHint" apps/admin/src/app
```

For each site already using `bannerMobile` / `categorySquare` / `productPrimary` / `productSquare`, no change needed — the const update propagates automatically.

- [ ] **Step 2: Add new uploader hints if banner-mobile/category-mobile/product-mobile slots exist as separate fields**

If a mobile-specific upload slot exists in admin (currently true only for hero), wire `recommendedSizeText('bannerMobile')` to it. The category and product uploaders can stay on the desktop keys — the merchant uploads ONE image and the storefront downsamples; the mobile keys are reference-only docs for now (no separate upload field is added in this plan).

- [ ] **Step 3: Commit**

```bash
git add apps/admin/src/app
git commit -m "feat(admin): wire refreshed banner-mobile recommended-size hint"
```

---

### Sprint 2 — `xxs` card size

#### Task 4: Add `xxs` to `CardSize` enum

**Files:**

- Modify: `packages/shared/src/types/store-layout.ts:110`

- [ ] **Step 1: Update the `CardSize` type**

Replace the existing CardSize type + the doc comment block above it with:

```ts
/**
 * Generic per-store CARD SIZE — used across categories, products,
 * carousels. Drives the `max-w-*` cap each card applies.
 *   xxs: 90 / 110     (true icon-tile, 2026-05-18 — denser than xs)
 *   xs:  120 / 140    (compact icon-tile)
 *   sm:  150 / 180    (Ahmad 2026-05-16 default — "smaller")
 *   md:  200 / 240    (medium balanced)
 *   lg:  240 / 300    (hero feature tile)
 *   xl:  280 / 360    (oversized, marketing-page only)
 */
export type CardSize = 'xxs' | 'xs' | 'sm' | 'md' | 'lg' | 'xl';
```

- [ ] **Step 2: Run typecheck — every exhaustive switch on `CardSize` now flags**

Run: `npm run typecheck`
Expected: any `switch (size) { case 'xs': … }` without a default returns a TS error. Capture the file list — they need explicit `xxs` cases in the next task.

#### Task 5: Add `xxs` branches in `card-size.ts` helpers

**Files:**

- Modify: `apps/web/src/templates/shared/card-size.ts`

- [ ] **Step 1: Add `xxs` to `categorySizeClass`**

```ts
case 'xxs':
  return 'max-w-[90px] md:max-w-[110px]';
```

Place it before the `case 'xs':` line.

- [ ] **Step 2: Add `xxs` to `productSizeClass`**

```ts
case 'xxs':
  return 'max-w-[110px] md:max-w-[130px]';
```

Place it before the `case 'xs':` line.

- [ ] **Step 3: Re-run typecheck**

Run: `npm run typecheck`
Expected: PASS. If other consumer files emerge from the earlier task that aren't covered by these two helpers (e.g. `getProductCardTextSizes` in `@ebda/shared`), add `xxs` branches there too with sane font-size pairs (text-[10px] mobile / text-xs desktop for the name, etc.).

#### Task 6: Add `xxs` to Zod schema

**Files:**

- Modify: `apps/api/src/routes/store-layout.routes.ts`

- [ ] **Step 1: Find every `z.enum(['xs', 'sm', 'md', 'lg', 'xl'])` and prepend `'xxs'`**

```bash
grep -n "'xs', 'sm', 'md', 'lg', 'xl'" apps/api/src/routes/store-layout.routes.ts
```

For each match, change to `z.enum(['xxs', 'xs', 'sm', 'md', 'lg', 'xl'])`.

#### Task 7: Add `xxs` option to admin size pickers

**Files:**

- Modify: `apps/admin/src/app/stores/[id]/layout/page.tsx`

- [ ] **Step 1: Find size `<select>` blocks**

```bash
grep -nE "value=\"xs\"|value=\"sm\"|value=\"md\"" apps/admin/src/app/stores/\[id\]/layout/page.tsx
```

For each `<select>` that picks a `CardSize`, prepend:

```tsx
<option value="xxs">Tiniest (90/110px)</option>
```

before the existing `<option value="xs">` line.

- [ ] **Step 2: Commit**

```bash
git add packages/shared/src/types/store-layout.ts apps/web/src/templates/shared/card-size.ts apps/api/src/routes/store-layout.routes.ts apps/admin/src/app/stores/\[id\]/layout/page.tsx
git commit -m "feat(layout): add xxs card size (90/110 category, 110/130 product)"
```

---

### Sprint 3 — Per-section background color

#### Task 8: Add `bgColor` to section interfaces

**Files:**

- Modify: `packages/shared/src/types/store-layout.ts`

- [ ] **Step 1: Add a shared section-background helper interface above the section interfaces**

Insert directly above `HeroSettings`:

```ts
/**
 * Per-section background color override. Hex string ('#RRGGBB' or
 * '#RGB') — when set, the storefront applies it as inline
 * `style={{ backgroundColor }}` on the section wrapper, overriding
 * both the theme `backgroundPreset` alternation AND the global
 * `--bg-section-alt` token. Unset / empty string = inherit the
 * existing alternation logic. Bilingual not needed (color is
 * locale-free).
 */
export interface SectionBgOverride {
  bgColor?: string;
}
```

- [ ] **Step 2: Extend the 5 section interfaces**

For each of `HeroSettings`, `CategoriesSettings`, `ProductCarouselSettings`, `TestimonialsSettings`, change `extends SectionTitleOverride` (where present) to `extends SectionTitleOverride, SectionBgOverride`. For `HeroSettings` (which doesn't currently extend SectionTitleOverride), add `extends SectionBgOverride` directly. For `FilterSidebarSettings` — skip; it doesn't render a backgrounded section.

#### Task 9: Add `bgColor` to Zod schema

**Files:**

- Modify: `apps/api/src/routes/store-layout.routes.ts`

- [ ] **Step 1: Add a reusable color string validator at the top of the schema block**

```ts
// Hex color, 3 or 6 digits, optional alpha. Empty string allowed = unset.
const hexColor = z
  .string()
  .regex(/^(#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|)$/, 'Must be a hex color')
  .optional();
```

- [ ] **Step 2: Add `bgColor: hexColor` to each of:** `heroSchema`, `categoriesSchema`, `newArrivalsSchema` / `bestSellersSchema` (or the shared `productCarouselSchema` they extend), `testimonialsSchema`.

#### Task 10: Wire HomePageContent + create `section-bg.ts` helper

**Files:**

- Create: `apps/web/src/templates/shared/section-bg.ts`
- Modify: `apps/web/src/app/HomePageContent.tsx`

- [ ] **Step 1: Create the helper**

```ts
import type { CSSProperties } from 'react';

/**
 * Map a per-section bgColor (hex string) to an inline style object.
 * Returns `undefined` when the merchant hasn't picked a color so the
 * section wrapper falls back to its theme-level background (the
 * backgroundPreset alternation or the default --bg-page).
 *
 * Only accepts hex colors validated by the Zod schema — never lets
 * a merchant inject `expression()` / `url()` style values.
 */
export function sectionBgStyle(bgColor: string | undefined): CSSProperties | undefined {
  if (!bgColor) return undefined;
  if (!/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?([0-9a-fA-F]{2})?$/.test(bgColor)) return undefined;
  return { backgroundColor: bgColor };
}
```

- [ ] **Step 2: Apply on each section wrapper in HomePageContent**

For every section block in `HomePageContent.tsx` (hero, categories, newArrivals, bestSellers, testimonials), wrap with `<section style={sectionBgStyle(layout.<section>.bgColor)} ...>`. For sections that already pass through to a template component, lift the inline `style` to the wrapping element AROUND the component — not inside the component (so the bg fills the full-bleed section width even when the component is contained).

#### Task 11: Admin UI — per-section color picker

**Files:**

- Modify: `apps/admin/src/app/stores/[id]/layout/page.tsx`

- [ ] **Step 1: Add a reusable ColorField component near the top of the file** (or import from an existing one — grep `type="color"` first):

```tsx
function ColorField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: string | undefined;
  onChange: (v: string) => void;
  hint?: string;
}) {
  return (
    <label className="flex items-center justify-between gap-3 py-2">
      <span className="text-sm text-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value || '#ffffff'}
          onChange={e => onChange(e.target.value)}
          className="h-8 w-12 cursor-pointer rounded border border-border bg-background"
        />
        {value ? (
          <button
            type="button"
            onClick={() => onChange('')}
            className="text-xs text-muted-foreground underline"
          >
            Clear
          </button>
        ) : null}
      </div>
    </label>
  );
}
```

- [ ] **Step 2: Add a ColorField in each section's settings block**

Under the existing Hero / Categories / New Arrivals / Best Sellers / Testimonials sections, add:

```tsx
<ColorField
  label="Section background color"
  value={layout.<section>.bgColor}
  onChange={(v) => updateSection('<section>', { bgColor: v })}
  hint="Overrides the theme background preset for this section only."
/>
```

Match the existing form's update helper name (it may be `setLayout` / `updateLayout` etc.; use whichever surrounding controls already use).

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/types/store-layout.ts apps/api/src/routes/store-layout.routes.ts apps/web/src/templates/shared/section-bg.ts apps/web/src/app/HomePageContent.tsx apps/admin/src/app/stores/\[id\]/layout/page.tsx
git commit -m "feat(layout): per-section bgColor admin control"
```

- [ ] **Step 4: Verify the 4-layer detection grep**

```bash
grep -n "bgColor" packages/shared/src/types/store-layout.ts apps/web/src/templates/types.ts
grep -n "bgColor" apps/api/src/routes/store-layout.routes.ts
grep -n "bgColor\|sectionBgStyle" apps/web/src/app/HomePageContent.tsx
grep -n "sectionBgStyle" apps/web/src/templates/shared/section-bg.ts
```

All four must return ≥1 match.

---

### Sprint 4 — Card frame color (per-section + global default)

#### Task 12: Define `ProductCardDefaults` interface + add `cardFrameColor` to section interfaces

**Files:**

- Modify: `packages/shared/src/types/store-layout.ts`

- [ ] **Step 1: Add the new interface above `StoreLayoutSettings`**

```ts
/**
 * Global product-card defaults — drives the PLP, category, search, and
 * any non-homepage product-card surface. Homepage carousels
 * (newArrivals / bestSellers) read their own fields first and fall back
 * to these defaults when a per-section override is unset.
 *
 * Added 2026-05-18 because card-size / frame controls used to stop at
 * the homepage edge; merchants couldn't change PLP card density or
 * frame color without a code change.
 */
export interface ProductCardDefaults {
  cardSize?: CardSize;
  cardAspect?: CardAspect;
  cardShape?: CardShape;
  cardGap?: CardGap;
  showLabel?: boolean;
  showHover?: boolean;
  showCardFrame?: boolean;
  cardFrameStyle?: 'soft' | 'outline' | 'shadow' | 'paper';
  /** Hex color — applied as inline `style.borderColor` on the frame element. */
  cardFrameColor?: string;
}
```

- [ ] **Step 2: Add `cardFrameColor?: string` to both `CategoriesSettings` and `ProductCarouselSettings`**

Place the new field directly after the existing `cardFrameStyle?` line in each interface.

- [ ] **Step 3: Add `productCardDefaults?: ProductCardDefaults` to `StoreLayoutSettings`**

```ts
export interface StoreLayoutSettings {
  hero: HeroSettings;
  categories: CategoriesSettings;
  newArrivals: ProductCarouselSettings;
  bestSellers: ProductCarouselSettings;
  filterSidebar: FilterSidebarSettings;
  testimonials: TestimonialsSettings;
  reviewSection: ReviewSectionSettings;
  sizing: SizingContract;
  /** Defaults applied to all non-homepage product-card surfaces. */
  productCardDefaults?: ProductCardDefaults;
}
```

- [ ] **Step 4: Extend `resolveLayoutSettings` merge**

Inside the return statement, add:

```ts
productCardDefaults: { ...(raw.productCardDefaults ?? {}) },
```

#### Task 13: Add Zod for `cardFrameColor` + `productCardDefaults`

**Files:**

- Modify: `apps/api/src/routes/store-layout.routes.ts`

- [ ] **Step 1: Add `cardFrameColor: hexColor` to both carousel + categories schemas**

(Reuses the `hexColor` validator added in Task 9.)

- [ ] **Step 2: Add a `productCardDefaultsSchema`**

```ts
const productCardDefaultsSchema = z
  .object({
    cardSize: z.enum(['xxs', 'xs', 'sm', 'md', 'lg', 'xl']).optional(),
    cardAspect: z.enum(['theme', 'square', 'portrait', 'landscape']).optional(),
    cardShape: z
      .enum([
        'theme',
        'circle',
        'rounded-square',
        'square',
        'soft',
        'portrait',
        'landscape',
        'pill',
      ])
      .optional(),
    cardGap: z.enum(['tight', 'normal', 'loose', 'xloose']).optional(),
    showLabel: z.boolean().optional(),
    showHover: z.boolean().optional(),
    showCardFrame: z.boolean().optional(),
    cardFrameStyle: z.enum(['soft', 'outline', 'shadow', 'paper']).optional(),
    cardFrameColor: hexColor,
  })
  .partial()
  .optional();
```

- [ ] **Step 3: Add `productCardDefaults: productCardDefaultsSchema` to the top-level `layoutSchema`**

#### Task 14: Wire HomePageContent — pass `cardFrameColor` per section + global to PLP-bound forwarders

**Files:**

- Modify: `apps/web/src/app/HomePageContent.tsx`

- [ ] **Step 1: Pass `cardFrameColor` to ProductCarousel/CategoryStrip/CategoryGrid**

For each existing `<ProductCarousel ... />` invocation (one for newArrivals, one for bestSellers), add:

```tsx
cardFrameColor={layout.<section>.cardFrameColor || layout.productCardDefaults?.cardFrameColor}
```

For `<CategoryStrip>` / `<CategoryGrid>` invocation, pass the per-section `categories.cardFrameColor`.

#### Task 15: ProductCarousel applies `cardFrameColor`

**Files:**

- Modify: `apps/web/src/templates/shared/ProductCarousel.tsx`
- Modify: `apps/web/src/templates/types.ts`

- [ ] **Step 1: Extend `ProductCarouselProps` in `types.ts`** — add `cardFrameColor?: string`.

- [ ] **Step 2: Destructure `cardFrameColor` in the component signature.**

- [ ] **Step 3: Apply on the frame wrapper**

Find the existing line at ~257 that produces `cardFrameClass(showCardFrame, cardFrameStyle)`. Change the JSX from:

```tsx
className={`snap-start shrink-0 w-[44vw] sm:w-[28vw] md:w-[22vw] lg:w-[19vw] xl:w-[17vw] ${sizeCap} ${cardFrameClass(showCardFrame, cardFrameStyle)}`}
```

to:

```tsx
className={`snap-start shrink-0 w-[44vw] sm:w-[28vw] md:w-[22vw] lg:w-[19vw] xl:w-[17vw] ${sizeCap} ${cardFrameClass(showCardFrame, cardFrameStyle)}`}
style={showCardFrame && cardFrameColor ? { borderColor: cardFrameColor } : undefined}
```

The frame helper already includes the `border` width via `border` / `border-2`; this inline `borderColor` overrides the theme `--border` HSL for this element only when set.

#### Task 16: CategoryStrip + 5 theme CategoryGrid apply `cardFrameColor`

**Files:**

- Modify: `apps/web/src/templates/shared/CategoryStrip.tsx`
- Modify: `apps/web/src/templates/{modern,elegant,classic,minimal,bold}/CategoryGrid.tsx`
- Modify: `apps/web/src/templates/types.ts`

- [ ] **Step 1: Extend `CategoryStripProps` + `CategoryGridProps`** — add `cardFrameColor?: string`.

- [ ] **Step 2: For each component**, find the wrapper that already gets `cardFrameClass(showCardFrame, cardFrameStyle)` and add the same conditional inline-style pattern from Task 15.

#### Task 17: PecannbeeProductCard accepts the global defaults

**Files:**

- Modify: `apps/web/src/templates/shared/PecannbeeProductCard.tsx`
- Modify: `apps/web/src/templates/types.ts`

- [ ] **Step 1: Extend `ProductCardProps` in `types.ts`** — add `cardSize`, `cardAspect`, `cardShape`, `cardGap`, `showLabel`, `showHover`, `showCardFrame`, `cardFrameStyle`, `cardFrameColor` as optional props.

- [ ] **Step 2: In `PecannbeeProductCard`**, destructure the new props.

- [ ] **Step 3: Apply at the card root**

Wrap (or augment) the card's outermost `<Link>` / `<div>` so:

- `productSizeClass(cardSize)` applied as `max-w-*`
- `cardAspectClass(cardAspect)` applied on the image wrapper
- `cardShapeClasses(cardShape).radius` applied on the card wrapper
- `cardFrameClass(showCardFrame, cardFrameStyle)` applied on the card wrapper
- `style={showCardFrame && cardFrameColor ? { borderColor: cardFrameColor } : undefined}` on the same element

- [ ] **Step 4: Keep current behaviour when props are unset** — every helper already returns `''` / falsy on undefined inputs, so existing tenants see no visual change.

#### Task 18: 5 theme `ProductCard.tsx` files accept the same props

**Files:**

- Modify: `apps/web/src/templates/{modern,elegant,classic,minimal,bold}/ProductCard.tsx`

- [ ] **Step 1: Apply the same prop additions + render changes from Task 17 in each of the 5 theme product cards.**

These cards inherit `ProductCardProps` from `types.ts`, so destructuring + helper application is the only per-file work.

- [ ] **Step 2: Verify the platform-level rule** — per `CLAUDE.md` rule #1, all three render paths must receive the same change. Grep:

```bash
grep -l "cardFrameColor" apps/web/src/templates/shared/PecannbeeProductCard.tsx apps/web/src/templates/{modern,elegant,classic,minimal,bold}/ProductCard.tsx apps/web/src/templates/shared/ProductCarousel.tsx
```

Expected: 7 file matches.

#### Task 19: PLP / category / search forward `productCardDefaults`

**Files:**

- Modify: `apps/web/src/app/products/ProductsClient.tsx`
- Modify: `apps/web/src/app/category/[slug]/...` (resolve actual path via `find apps/web/src/app -name 'page.tsx' -path '*category*'`)
- Modify: `apps/web/src/app/search/page.tsx` (resolve actual path likewise)

- [ ] **Step 1: In each page**, read `layout.productCardDefaults` (the page receives `layout` from the server fetch — it's already plumbed for hero/template logic).

- [ ] **Step 2: Pass props through to the rendered `PecannbeeProductCard` / theme `ProductCard`**

```tsx
<PecannbeeProductCard
  product={…}
  cardSize={layout.productCardDefaults?.cardSize}
  cardAspect={layout.productCardDefaults?.cardAspect}
  cardShape={layout.productCardDefaults?.cardShape}
  cardGap={layout.productCardDefaults?.cardGap}
  showLabel={layout.productCardDefaults?.showLabel}
  showHover={layout.productCardDefaults?.showHover}
  showCardFrame={layout.productCardDefaults?.showCardFrame}
  cardFrameStyle={layout.productCardDefaults?.cardFrameStyle}
  cardFrameColor={layout.productCardDefaults?.cardFrameColor}
/>
```

If the wrapping component doesn't currently get `layout`, plumb it from the server page that already fetches `resolveLayoutSettings(...)`.

#### Task 20: Admin UI — Product Card Defaults block + per-section color pickers

**Files:**

- Modify: `apps/admin/src/app/stores/[id]/layout/page.tsx`

- [ ] **Step 1: Add a `ColorField` for `cardFrameColor` in each of Categories / New Arrivals / Best Sellers**

```tsx
<ColorField
  label="Card frame color (this section)"
  value={layout.<section>.cardFrameColor}
  onChange={(v) => updateSection('<section>', { cardFrameColor: v })}
/>
```

- [ ] **Step 2: Add a new `Product Card Defaults` block at the bottom of the page**

It mirrors the existing per-section card-control cluster but writes to `layout.productCardDefaults` and is labelled in the page like:

> **Product card defaults** — applied to the catalog, category, search, and any product surface outside the homepage. Per-section settings above override these for the homepage carousels.

Include all 9 controls (size / aspect / shape / gap / showLabel / showHover / showCardFrame / cardFrameStyle / cardFrameColor) using the existing helper components (`SelectField` / `RowToggle` / `ColorField`).

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/types/store-layout.ts apps/api/src/routes/store-layout.routes.ts apps/web/src/templates/types.ts apps/web/src/templates/shared/ProductCarousel.tsx apps/web/src/templates/shared/CategoryStrip.tsx apps/web/src/templates/shared/PecannbeeProductCard.tsx apps/web/src/templates/{modern,elegant,classic,minimal,bold}/CategoryGrid.tsx apps/web/src/templates/{modern,elegant,classic,minimal,bold}/ProductCard.tsx apps/web/src/app/HomePageContent.tsx apps/web/src/app/products/ProductsClient.tsx apps/admin/src/app/stores/\[id\]/layout/page.tsx
git commit -m "feat(layout): per-section + global product card frame color, applies to PLP and homepage carousels"
```

- [ ] **Step 4: Verify the 4-layer detection grep for `cardFrameColor`**

```bash
# Type
grep -n "cardFrameColor" packages/shared/src/types/store-layout.ts apps/web/src/templates/types.ts
# Zod
grep -n "cardFrameColor" apps/api/src/routes/store-layout.routes.ts
# Wiring
grep -n "cardFrameColor" apps/web/src/app/HomePageContent.tsx apps/web/src/app/products/ProductsClient.tsx
# Consumer
grep -n "cardFrameColor" apps/web/src/templates/shared/{ProductCarousel,PecannbeeProductCard,CategoryStrip}.tsx apps/web/src/templates/{modern,elegant,classic,minimal,bold}/{ProductCard,CategoryGrid}.tsx
```

All four greps must return ≥1 match. Missing the consumer grep is the silent-fail mode per `feedback-fwb-card-controls-consumer-trap`.

---

### Sprint 6 — Per-theme recommended source sizes (audit Shopify + Stitch refs)

**Why this sprint exists:** The current `IMAGE_STANDARDS` const is sourced from ONE reference (the zFloos / pecannbee compact spec). Per Ahmad's directive 2026-05-18: the other 4 templates' banner + card source sizes should also draw from the references we already have on file — Shopify theme docs and the local `stitch-design-taste` skill + `2026-04-25-ui-ux-audit.md`. The 5 themes have distinct visual identities (per `feedback-fwb-theme-identity-audit`) so the merchant's optimal _upload_ size varies by theme even though the rendered storefront stays structurally uniform.

**Non-negotiable invariant from `feedback-fwb-theme-identity-audit`:** rendered storefront sizing (`max-w-*`, `aspect-*`, `gap-*`, `p-*`) STAYS UNIFORM across themes. This sprint changes only the _recommended source-image size_ shown to merchants in admin upload hints, NOT the rendered cap classes. The storefront downsamples (via `next/image` srcset) appropriately.

**Reference inventory (all on disk — re-read before authoring):**

| Reference                   | Location                                                                                                                   | What we steal                                                                                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shopify theme docs (recap)  | `~/.claude/projects/-Users-ahmadsharaf/memory/feedback-polaris-vs-storefront-image-sizes.md`                               | 2048×2048 product (1:1), 2048×1024 hero (or 2400×1000), 1500×800 collection, OG 1200×630 — heavier source recs for pinch-zoom / retina-luxury aesthetic |
| Stitch design taste skill   | `apps/web/.claude/skills/stitch-design-taste/SKILL.md` + `skills/stitch-design-taste/`                                     | Local Stitch audit findings, per-pack visual rules                                                                                                      |
| 2026-04-25 UI/UX audit      | `docs/superpowers/audits/2026-04-25-ui-ux-audit.md`                                                                        | Hero `sizes` + LCP findings — informs which themes need the biggest hero source                                                                         |
| Theme identity audit        | `~/.claude/projects/-Users-ahmadsharaf-Desktop-projects-force-website-builder/memory/feedback-fwb-theme-identity-audit.md` | 5-theme cosmetic-identity matrix (luxury / boutique / heritage / ascetic / streetwear)                                                                  |
| design.md image-asset table | `design.md` repo root                                                                                                      | Current canonical (zFloos-derived) sizes — the BASELINE this sprint augments                                                                            |
| Pack styles                 | `apps/web/src/templates/shared/pack-styles.ts`                                                                             | Per-pack visual flavor (where typography / weight / tracking deviates per theme)                                                                        |

**Pre-authoring matrix to produce** — the subagent must build this BEFORE writing code. The matrix is the source-of-truth for the per-theme keys it then writes.

| Surface        | Theme   | Recommended source                       | Rationale (file:line cite from refs)                                                                       |
| -------------- | ------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Hero (desktop) | modern  | 2048×1024 (~2:1, Shopify-style)          | Tech-startup glass-blur header + retina laptops; Shopify spec / feedback-polaris-vs-storefront-image-sizes |
| Hero (desktop) | elegant | 1920×800 portrait-tilt (luxury boutique) | Italic word-split hero H1, portrait imagery favored; theme-identity-audit                                  |
| Hero (desktop) | classic | 1920×700 (current)                       | Heritage retail, serif chrome — current spec works                                                         |
| Hero (desktop) | minimal | 1920×700 (current, compact)              | Ascetic — biggest source not warranted; pages need fast LCP per 04-25 audit                                |
| Hero (desktop) | bold    | 2400×1000 brutalist crop                 | Streetwear, brutalist scale; Shopify upper bound                                                           |
| Product image  | modern  | 800×1067 (3:4)                           | Hi-res tech-startup feel                                                                                   |
| Product image  | elegant | 1200×1600 portrait (3:4 retina)          | Luxury boutique; Shopify pinch-zoom warranted                                                              |
| Product image  | classic | 800×1067 (3:4)                           | Heritage retail                                                                                            |
| Product image  | minimal | 600×800 (current 3:4)                    | Compact; ascetic doesn't reward huge sources                                                               |
| Product image  | bold    | 800×800 square (1:1)                     | Brutalist tile feel, aspect-square per pack-style                                                          |
| Category card  | modern  | 1000×1000 (1:1 retina)                   | Glass header demands crisp tiles                                                                           |
| Category card  | elegant | 600×800 (3:4 portrait)                   | Lookbook tiles                                                                                             |
| Category card  | classic | 800×800 (1:1)                            | Heritage retail                                                                                            |
| Category card  | minimal | 600×600 (1:1)                            | Compact                                                                                                    |
| Category card  | bold    | 1200×1200 (1:1 retina)                   | Brutalist tile, big mark                                                                                   |

(The subagent fills the actual cited line numbers + adjusts dims based on what the references actually say. The table above is the _shape_ of the output, not the final numbers — the audit step refines them.)

#### Task 21: Audit references + author per-theme matrix

**Files:**

- Create: `docs/superpowers/audits/2026-05-18-per-theme-image-spec-audit.md` (the audit output that justifies the matrix)

- [ ] **Step 1: Re-read all 6 references from the inventory above.** Cite file:line for each source quote that informs a matrix cell.

- [ ] **Step 2: Run the theme-identity-audit prompt** from `feedback-fwb-theme-identity-audit` against `apps/web/src/templates/{modern,elegant,classic,minimal,bold}/{Hero,ProductCard,CategoryGrid,Header}.tsx`. The output guides whether each theme's character justifies a heavier source size (luxury/retina) or stays compact.

- [ ] **Step 3: Write the matrix to `docs/superpowers/audits/2026-05-18-per-theme-image-spec-audit.md`** with three columns per surface (current value, recommended per-theme, ref cite). Include a 100-word summary at the end on which themes get bigger source recs and why.

- [ ] **Step 4: Pause for Ahmad sign-off** on the matrix before code changes. (The subagent commits the audit document at this point and reports back; the parent reviews the table before dispatching Tasks 22-24.)

#### Task 22: Add per-theme variant keys to `IMAGE_STANDARDS`

**Files:**

- Modify: `packages/shared/src/types/image-standards.ts`

- [ ] **Step 1: Extend the `ImageStandard` interface with an optional `templateOverrides` map**

```ts
export interface ImageStandard {
  width: number;
  height: number;
  aspect: string;
  formats: ReadonlyArray<'JPEG' | 'WebP' | 'PNG' | 'SVG' | 'ICO'>;
  safeZone?: { width: number; height: number };
  description: string;
  /**
   * Per-template recommended-source override. When a merchant's store
   * template (modern / elegant / classic / minimal / bold) appears as
   * a key here, that recommendation is shown in admin upload hints
   * instead of the base width/height. Rendered storefront sizing stays
   * UNIFORM per the theme-identity-audit rule — only the *upload hint*
   * varies per theme.
   */
  templateOverrides?: Partial<
    Record<
      'modern' | 'elegant' | 'classic' | 'minimal' | 'bold',
      { width: number; height: number; aspect: string; note?: string }
    >
  >;
}
```

- [ ] **Step 2: Populate `templateOverrides` on every key whose matrix row from Task 21 says it should vary** — `heroDesktop`, `heroMobile`, `productPrimary`, `productSquare`, `productMobile`, `categorySquare`, `categoryPortrait`, `categoryMobile`. The numbers come from the audit doc; cite the audit doc + ref source in a comment above each entry.

#### Task 23: New `recommendedSizeTextForTemplate` helper

**Files:**

- Modify: `packages/shared/src/types/image-standards.ts`

- [ ] **Step 1: Add the helper at the bottom of the file**

```ts
import type { TemplateId } from './template-id';

/**
 * Like `recommendedSizeText`, but resolves a per-template override
 * when one exists. Falls back to the base width/height otherwise.
 *
 *   recommendedSizeTextForTemplate('heroDesktop', 'elegant')
 *     → "Recommended: 1920 × 800 px (JPEG / WebP) — elegant theme"
 *   recommendedSizeTextForTemplate('heroDesktop', undefined)
 *     → "Recommended: 1920 × 700 px (JPEG / WebP)"  (base)
 */
export function recommendedSizeTextForTemplate(
  key: ImageStandardKey,
  template: TemplateId | undefined
): string {
  const base = IMAGE_STANDARDS[key];
  const override = template ? base.templateOverrides?.[template] : undefined;
  if (override) {
    return `Recommended: ${override.width} × ${override.height} px (${base.formats.join(' / ')}) — ${template} theme`;
  }
  return `Recommended: ${base.width} × ${base.height} px (${base.formats.join(' / ')})`;
}
```

Add a sibling `recommendedSizeTextForTemplateI18n(key, template, lang)` that returns the bilingual EN/AR pair, mirroring the existing `recommendedSizeTextI18n` shape.

#### Task 24: Admin uploaders read the per-template helper

**Files:**

- Modify: every admin uploader site that already calls `recommendedSizeText(<key>)`. Find them:

```bash
grep -rln "recommendedSizeText" apps/admin/src
```

- [ ] **Step 1: For each call site**, swap `recommendedSizeText('heroDesktop')` → `recommendedSizeTextForTemplate('heroDesktop', store.template)`. The `store.template` value is already available in the admin context (`StoreProvider.currentStore.template`). When the call site is server-side, get the value from the page props or a thin client wrapper.

- [ ] **Step 2: Verify the hint string visibly changes per theme**

```bash
# Local: pick a tenant set to 'elegant', open admin upload page for hero
# Verify hint reads "1920 × 800 px (JPEG / WebP) — elegant theme"
# Switch the tenant to 'modern' in admin → reload upload page →
# Verify hint reads "2048 × 1024 px (JPEG / WebP) — modern theme"
```

#### Task 25: Mirror the matrix in `design.md`

**Files:**

- Modify: `design.md` (Image asset standards section)

- [ ] **Step 1: Add a "Per-template recommended overrides" subsection BELOW the existing canonical table.** It's a smaller table indexed by `template × surface` showing only the cells where the override differs from the canonical. Include a one-line cite per cell back to the audit doc.

- [ ] **Step 2: Add a short paragraph above the new subsection** explaining: storefront rendering stays uniform per `feedback-fwb-theme-identity-audit`; only upload hints vary per theme. Link to the audit doc by relative path.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/types/image-standards.ts design.md apps/admin/src docs/superpowers/audits/2026-05-18-per-theme-image-spec-audit.md
git commit -m "feat(shared,admin): per-theme recommended source sizes from shopify + stitch refs"
```

- [ ] **Step 4: Run lint + typecheck**

```bash
npm run typecheck && npm run lint
```

Both must pass before this sprint closes.

---

### Sprint 5 — Verification

#### Task 21: Full typecheck + build + tests

- [ ] **Step 1:** `npm run typecheck`
- [ ] **Step 2:** `npm run build`
- [ ] **Step 3:** `npm run test:unit`
- [ ] **Step 4:** `npm run lint`

All four must pass. Fix any errors that surface before moving on.

#### Task 22: Browser-QA visual sanity sweep

Per `CLAUDE.md` rule 10 (live-review iteration is part of the design loop):

- [ ] **Step 1:** Start `npm run dev:web` + `npm run dev:admin`.
- [ ] **Step 2:** In admin, open `/stores/<id>/layout` and verify each new control:
  - Per-section `bgColor` (5 sections) — pick a vivid color → save → confirm storefront section bg changes.
  - `cardFrameColor` per section + global — pick a color → save → verify homepage carousels AND `/products` PLP both pick it up.
  - `xxs` size — pick → confirm storefront card width visibly drops to ~90/110px (category) and ~110/130px (product).
- [ ] **Step 3:** Visit a tenant (wadyaljuz or palora) on `dev:web` and check three render paths:
  - `/` (homepage carousels)
  - `/products` (catalog PLP)
  - `/category/<slug>` (category page)
    All three must reflect `productCardDefaults` settings.
- [ ] **Step 4:** Visual check the 5 themes in admin — set a tenant to each and verify the frame color renders identically across `modern / elegant / classic / minimal / bold`.

#### Task 23: Update graphify + memory + push

- [ ] **Step 1:** `graphify update .` (AST-only, no LLM cost).
- [ ] **Step 2:** Add commit hash + one-line entry to `wiki/projects/force-website-builder.md` in the memory vault (per CLAUDE.md memory-upkeep rule).
- [ ] **Step 3:** If a new cross-project pattern surfaced (e.g. "per-section bg color helper is reusable for any multi-tenant CMS"), extend the relevant MOC at `wiki/_moc/`.
- [ ] **Step 4:** Push the project repo + the vault (vault has its own remote; pipeline script does this automatically when you say "update memory").

---

## Self-review notes

- **Spec coverage** — all 4 Ahmad asks have a sprint. Image refresh = Sprint 1. xxs size = Sprint 2. Per-section bgColor = Sprint 3. Card frame color global+override = Sprint 4. ✓
- **Placeholders** — none. Every step has either real code or an exact grep recipe.
- **Type consistency** — `cardFrameColor` spelled identically across type / Zod / wiring / consumer. `ProductCardDefaults` spelled identically. `xxs` enum value reused in helpers + Zod + admin pickers.
- **Consumer-trap discipline** — Task 11, 20 explicitly re-run the 4-grep recipe before commit. Task 18 grep includes the platform-level rule check (7 product-card files).

---

**Estimated effort:** ~3-4 hours focused work. Largest risk: the PLP / category / search wiring (Task 19) — if those pages don't currently receive `layout` from the server, plumbing it through is a small refactor in each. The 5-theme prop-additions (Task 18) are mechanical but require touching 10 files (5 ProductCard + 5 CategoryGrid).
