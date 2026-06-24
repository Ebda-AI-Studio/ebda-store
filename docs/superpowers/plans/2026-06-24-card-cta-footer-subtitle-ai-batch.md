# Storefront card CTA system + footer/widget colors + dynamic breadcrumb + name casing + AI description balancer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship six FWB storefront/admin features in one batch: (1) "original brand colors" option for footer + floating-widget social icons; (2) a customizable product-card CTA + out-of-stock label system (label text, size, color, shape ×4, placement) + fix the favorite button being clipped by the card shape; (3) dynamic breadcrumb/heading/subtitle that reflects the current category; (4) stop forcing ALL-CAPS + oversized English product names; (5) an AI "rich-description language balancer" (detect richer of AR/EN, translate into the other, with bulk + per-product do/revert + autopilot integration); (6) fix the stale admin UI for card image shape/aspect/radius/name/price.

**Architecture:** Storefront card customization rides the existing `ProductCardDefaults` (StoreTheme/layout JSON) — new optional fields, default-off/neutral so existing stores are unchanged, threaded through the 8 render paths via the established `useStore().layout?.productCardDefaults` fallback pattern. Social "original colors" is two opt-in `StoreTheme` boolean flags. The AI balancer adds one `Product.aiBalanceBackup` JSON column for revert, a richness utility, two Inngest bulk jobs + per-product routes, and an autopilot step. The admin stale-UI bug is a 4-field Zod schema gap.

**Tech Stack:** Next.js 16 storefront (`apps/web`) + admin (`apps/admin`), Express API (`apps/api`), Prisma/Neon (`packages/database`), shared types (`packages/shared`), Gemini via `AIService`, Inngest bulk jobs, vitest (root `tests/unit`).

**Decisions locked (2026-06-24, Ahmad):** one combined plan; CTA/label shapes = **Rounded / Pill / Square / Soft**; AI balancer = **manual buttons + autopilot-integrated**.

---

## File structure (what each task owns)

- **Task 1 — Admin stale-UI fix (smallest, do first):** `apps/api/src/routes/store-layout.routes.ts` (add 4 fields to the `productCardDefaults` Zod schema). Pure bug fix; unblocks every card-default control already in the admin.
- **Task 2 — Shared card-CTA types:** `packages/shared/src/types/store-layout.ts` (extend `ProductCardDefaults`), `packages/shared/src/utils/card-size.ts` (shape/size class helpers for CTA + label).
- **Task 3 — Favorite-button clip fix + CTA/label render:** the 8 render paths.
- **Task 4 — Admin controls for the CTA/label system:** `apps/admin/.../page-builder/page.tsx` + the Zod schema.
- **Task 5 — Social "original colors":** `apps/web/.../shared/icons.tsx` (SocialGlyph), 5 footers (no change needed beyond prop), `FloatingWidget.tsx`, admin Theme/widget toggles, shared `StoreTheme` flag.
- **Task 6 — English name casing/size:** 3 theme cards (elegant/minimal/bold) + a `productNameCase` control.
- **Task 7 — Dynamic breadcrumb/heading/subtitle:** `apps/web/src/app/products/ProductsClient.tsx` (+ breadcrumb component if separate).
- **Task 8 — AI balancer schema + utility:** `packages/database/prisma/schema.prisma` + migration, `packages/shared/src/types/ai-autofill.ts`, new `apps/api/src/lib/ai/description-richness.ts`.
- **Task 9 — AI balancer engine + jobs + routes:** Inngest bulk balance/revert fns, `ai.routes.ts`, autopilot step in `ai-autofill.service.ts`.
- **Task 10 — AI balancer admin UI:** `ai-tools/page.tsx` + product edit page.
- **Task 11 — Docs parity + CLAUDE.md flag table.**

> **Platform-level rule (CLAUDE.md):** every card change MUST land in all 8 render paths; every theme-flag/copy change is platform-level. Grep after each card task to confirm coverage.

---

## Task 1: Fix the stale admin UI (Zod schema gap) — bug, do first

**Files:**

- Modify: `apps/api/src/routes/store-layout.routes.ts:517-550` (the `productCardDefaults` schema)

**Root cause (verified):** `productCardDefaults` Zod schema omits `cardImageAspect`, `cardImageRadius`, `showCardName`, `showCardPrice`; the top-level layout schema has no `.passthrough()`, so `PUT /admin/stores/:id/layout` silently strips them — they never persist, so the admin re-loads defaults (stale). Field names already match the `ProductCardDefaults` type + storefront; only the schema gap breaks the round-trip.

- [ ] **Step 1: Add the 4 missing fields** after the `typography:` line (~547) in the `productCardDefaults` object:

```ts
      // Items added 2026-06-24: image aspect+radius + name/price visibility.
      // Without these, Zod silently strips them on every PUT (same silent-strip
      // trap as typography above) → admin reloads stale defaults. Keep in sync
      // with ProductCardDefaults in packages/shared/src/types/store-layout.ts.
      cardImageAspect: z.enum(['1:1', '4:5', '3:4', '16:9', 'auto']).optional(),
      cardImageRadius: z.enum(['none', 'sm', 'md', 'lg', 'full']).optional(),
      showCardName: z.boolean().optional(),
      showCardPrice: z.boolean().optional(),
```

- [ ] **Step 2: Verify the API typechecks**

Run: `cd apps/api && npx tsc -p tsconfig.json --noEmit 2>&1 | grep -c "error TS"`
Expected: `0`.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/store-layout.routes.ts
git commit -m "fix(admin): persist card image aspect/radius + name/price (zod silent-strip gap)"
```

---

## Task 2: Shared card-CTA + label types + class helpers

**Files:**

- Modify: `packages/shared/src/types/store-layout.ts` (extend `ProductCardDefaults` ~787-834)
- Modify: `packages/shared/src/utils/card-size.ts` (add `ctaShapeClass`, `ctaSizeClass`, `labelShapeClass`)

The CTA system needs new optional, neutral-default fields so existing stores are unchanged.

- [ ] **Step 1: Extend `ProductCardDefaults`** — add after `showCardPrice?: boolean;`:

```ts
  /** CTA button on cards: visual + behavior. All optional; unset = current behavior. */
  ctaLabel?: boolean;                 // show a text label on the CTA (default: existing per-theme)
  ctaLabelTextEn?: string;            // override label text (EN); empty = theme default ("View"/"Add to cart")
  ctaLabelTextAr?: string;            // override label text (AR)
  ctaSize?: 'sm' | 'md' | 'lg';       // CTA button size; unset = derive from cardSize
  ctaShape?: 'rounded' | 'pill' | 'square' | 'soft';  // unset = theme default
  ctaColor?: string;                  // token:* or hex; unset = token:primary / theme default
  ctaTextColor?: string;              // token:* or hex; unset = contrast-guarded default
  /** Out-of-stock label badge: shape/size/placement/color, independent of CTA. */
  oosLabel?: boolean;                 // show the OOS label badge (default true = current ribbon)
  oosLabelTextEn?: string;            // default "Out of stock"
  oosLabelTextAr?: string;            // default "نفدت الكمية"
  oosLabelShape?: 'rounded' | 'pill' | 'square' | 'soft';
  oosLabelPlacement?: 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end';
  oosLabelColor?: string;             // bg color, token:* or hex
  oosLabelTextColor?: string;         // text color
  /** When OOS, dim the View/Add CTA in this color instead of disabling silently. */
  oosDimColor?: string;
```

- [ ] **Step 2: Add class helpers to `card-size.ts`** (mirror `cardShapeClasses`):

```ts
export type CtaShape = 'rounded' | 'pill' | 'square' | 'soft';
export function ctaShapeClass(shape?: CtaShape): string {
  switch (shape) {
    case 'pill':
      return 'rounded-full';
    case 'square':
      return 'rounded-none';
    case 'soft':
      return 'rounded-md';
    case 'rounded':
      return 'rounded-lg';
    default:
      return ''; // theme default — caller keeps existing class
  }
}
export type CtaSize = 'sm' | 'md' | 'lg';
export function ctaSizeClass(size?: CtaSize): string {
  switch (size) {
    case 'sm':
      return 'min-h-8 px-2.5 py-1 text-xs';
    case 'md':
      return 'min-h-10 px-4 py-2 text-sm';
    case 'lg':
      return 'min-h-12 px-6 py-3 text-base';
    default:
      return ''; // derive from cardSize textSizes.btn (existing)
  }
}
/** Reused for the OOS badge corners (same 4-shape vocabulary). */
export function labelShapeClass(shape?: CtaShape): string {
  return ctaShapeClass(shape) || 'rounded-md';
}
export function oosPlacementClass(
  p?: 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end'
): string {
  switch (p) {
    case 'top-end':
      return 'top-2 end-2';
    case 'bottom-start':
      return 'bottom-2 start-2';
    case 'bottom-end':
      return 'bottom-2 end-2';
    case 'top-start':
    default:
      return 'top-2 start-2';
  }
}
```

- [ ] **Step 3: Build the shared package + verify**

Run: `cd packages/shared && npx tsc -p tsconfig.json --noEmit 2>&1 | grep -c "error TS"`
Expected: `0`.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types/store-layout.ts packages/shared/src/utils/card-size.ts
git commit -m "feat(shared): card CTA + OOS-label customization types + class helpers"
```

---

## Task 3: Favorite-button clip fix + CTA/label rendering across the 8 render paths

**Files (the 8 paths):**

- `apps/web/src/templates/shared/PecannbeeProductCard.tsx`
- `apps/web/src/templates/{modern,elegant,classic,minimal,bold}/ProductCard.tsx`
- `apps/web/src/templates/shared/ProductCarousel.tsx`
- `apps/web/src/app/products/ProductListItem.tsx`
- Shared CTA component: `apps/web/src/templates/shared/ProductCardCta.tsx` (used by 5 themes)

**Sub-goal A — favorite button clip fix.** The wishlist button is `absolute` inside the `overflow-hidden` rounded image container, so the rounded corner clips it (worst on `circle`/`rounded-2xl`). Fix: render the favorite button as a sibling of the image container (on the card article/Link that is `position: relative` but NOT `overflow-hidden`), with `z-20`. Paths affected (have an add-to-wishlist heart): PecannbeeProductCard (`top-3 start-3`, line ~240, inside image div line ~189), Modern (`top-3 right-3`, inside Link `overflow-hidden` line ~135), Elegant (`top-4 right-4`, inside image div line ~141).

- [ ] **Step 1: PecannbeeProductCard — lift the wishlist button out of the image div.** Move the wishlist `<button>` (currently child of the image `<div>` at line ~189) to be a direct child of the `<article>` (line ~169) AFTER the image div, keeping `absolute top-3 start-3` + adding `z-20`. The `<article>` already is `relative`; remove `overflow-hidden` from the **article** (keep it on the image div only so the image still clips to the shape). Verify the OOS ribbon (which SHOULD clip with the image) stays inside the image div.

- [ ] **Step 2: Modern — same lift.** Move the wishlist button from inside the `<Link>`(line ~135, `overflow-hidden rounded-xl`) to a sibling of the Link on the `<article>` (line ~125, which has no overflow). Keep `absolute top-3 right-3 z-20`. Because the Link clips, the button must live on the article.

- [ ] **Step 3: Elegant — same lift.** Move the wishlist button out of the image `<div>` (line ~141) to the `<article>` (line ~118). Keep placement + `z-20`.

- [ ] **Step 4: Verify visually (build) + grep.** Run `cd apps/web && npx tsc -p tsconfig.json --noEmit 2>&1 | grep -c "error TS"` → `0`. Grep the 3 files to confirm the wishlist button is no longer a descendant of an `overflow-hidden` node.

**Sub-goal B — CTA + OOS-label customization.** Thread the new `ProductCardDefaults` fields into the CTA + OOS rendering. Read them via the established fallback: a prop OR `useStore().layout?.productCardDefaults` (per the #380 `T.ProductGrid threads zero props` lesson — theme cards must read from context).

- [ ] **Step 5: `ProductCardCta.tsx` (shared, used by modern/elegant/classic/minimal/bold).** Accept new optional props: `ctaShape`, `ctaSize`, `ctaColor`, `ctaTextColor`, `ctaLabelTextEn/Ar`, `oosDimColor`, `inStock`. Apply `ctaShapeClass(ctaShape)` (falls back to theme class when unset), `ctaSizeClass(ctaSize)` (falls back to existing), and `resolveColor(ctaColor, theme)` for bg + `ctaTextColor` for text with the existing contrast guard. When `inStock === false` and `oosDimColor` set, dim with that color instead of plain opacity. When `ctaLabelText*` set, use it instead of the per-theme default label.

- [ ] **Step 6: Thread the props from each of the 5 theme ProductCards** into `ProductCardCta`, reading from `(prop ?? useStore().layout?.productCardDefaults?.<field>)`.

- [ ] **Step 7: PecannbeeProductCard + ProductCarousel (inline CTAs).** Apply the same field reads to their inline CTA `<Link>`/`<button>` (shape/size/color/label) and OOS branch. These already read `productCtaZone` + `guardedCtaColor`; extend with the new fields.

- [ ] **Step 8: OOS label badge (all 8 paths that show OOS).** Replace/augment the `<OutOfStockRibbon>` with a configurable badge: when `oosLabel !== false`, render a badge using `labelShapeClass(oosLabelShape)` + `oosPlacementClass(oosLabelPlacement)` + `oosLabelColor`/`oosLabelTextColor` + `oosLabelText{En,Ar}` (defaults "Out of stock"/"نفدت الكمية"). Keep `OutOfStockRibbon` as the default when no oosLabel fields are set (back-compat). ProductListItem currently has NO OOS — add the badge there too for consistency.

- [ ] **Step 9: Typecheck + platform-coverage grep.** `cd apps/web && npx tsc -p tsconfig.json --noEmit 2>&1 | grep -c "error TS"` → `0`. Grep all 8 files for the new field reads; every card path must reference `ctaShape`/`oosLabel` or it isn't shipped (CLAUDE.md platform rule).

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/templates apps/web/src/app/products/ProductListItem.tsx
git commit -m "feat(web): customizable card CTA + OOS label (shape/size/color/placement) + fix favorite-button clip"
```

---

## Task 4: Admin controls for the CTA/label system + Zod

**Files:**

- Modify: `apps/admin/src/app/stores/[id]/page-builder/page.tsx` (the "Product cards (everywhere)" SectionCard, ~2297-2407)
- Modify: `apps/api/src/routes/store-layout.routes.ts` (extend the `productCardDefaults` Zod schema with the Task-2 fields)

- [ ] **Step 1: Extend the Zod schema** in `store-layout.routes.ts` `productCardDefaults` with every new field from Task 2 (enums for shapes/sizes/placement, strings for colors/labels, booleans). Mirror the existing enum style. Without this they silently strip (the exact bug from Task 1).

- [ ] **Step 2: Add admin controls** under "Product cards (everywhere)", grouped under a "Call-to-action button" group heading (mirror the existing select/checkbox pattern + `ColorField` per CLAUDE.md rule 14 — never raw `<input type=color>`):
  - CTA label toggle (`ctaLabel`), label text EN/AR inputs, CTA size select (sm/md/lg + "Auto"), CTA shape select (Rounded/Pill/Square/Soft + "Theme default"), CTA color (`ColorField`), CTA text color (`ColorField`).
  - "Out-of-stock label" group: toggle (`oosLabel`), text EN/AR, shape select, placement select (top-start/top-end/bottom-start/bottom-end), bg color + text color (`ColorField`), dim color (`ColorField`).
    Each `value={layout.productCardDefaults?.<field> ?? ''}` + `onChange` updating `layout.productCardDefaults` (follow the existing show-name/price pattern).

- [ ] **Step 3: EN/AR admin copy** — add labels to the admin i18n (`apps/admin/src/i18n/messages/{en,ar}.json`) if the page uses `useT`; else inline bilingual per the page's existing pattern.

- [ ] **Step 4: Typecheck both** (`apps/admin` + `apps/api`) → `0` errors.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/app/stores apps/api/src/routes/store-layout.routes.ts apps/admin/src/i18n
git commit -m "feat(admin): CTA + OOS-label controls in Page Builder (shape/size/color/placement)"
```

---

## Task 5: Social "original brand colors" — footer + floating widget

**Files:**

- Modify: `apps/web/src/templates/shared/icons.tsx` (`SocialGlyph` ~375-395, add per-brand hex map)
- Modify: `apps/web/src/templates/{modern,elegant,classic,minimal,bold}/Footer.tsx` (pass `originalColors` to `SocialGlyph`)
- Modify: `apps/web/src/templates/shared/FloatingWidget.tsx` (honor a "reset to brand" flag)
- Modify: `packages/shared/src/types/store-theme.ts` (add `footerSocialOriginalColor?: boolean`, `floatingWidgetOriginalColor?: boolean`) + admin mirror `apps/admin/src/app/stores/[id]/branding/_components/types.ts`
- Modify: admin Theme tab `apps/admin/.../branding/_components/ThemeTab.tsx` + floating-widget page toggle

Brand hex values already exist in `FloatingWidget.tsx` `KIND_DEFAULTS` (~124-140) — reuse them. `BrandIcon` components exist for instagram/whatsapp (full-color); others are single-path glyphs that need a brand `fill`.

- [ ] **Step 1: Add a `BRAND_COLORS` map in `icons.tsx`** keyed by platform (instagram `#E4405F`, whatsapp `#25D366`, facebook `#1877F2`, twitter/x `#000000`, tiktok `#000000`, youtube `#FF0000`, snapchat `#FFFC00`, telegram `#26A5E4`, linkedin `#0A66C2`, pinterest `#BD081C`).

- [ ] **Step 2: `SocialGlyph` accepts `originalColors?: boolean`.** When true: if `entry.BrandIcon` exists (instagram/whatsapp) render it; else render the `<svg>` with `fill={BRAND_COLORS[entry.key] ?? 'currentColor'}`. When false/unset: unchanged (`fill="currentColor"`).

- [ ] **Step 3: Thread the flag in all 5 footers.** Each footer reads `store.theme?.footerSocialOriginalColor` and passes `originalColors={...}` to `SocialGlyph`. (Footers already pass `className`; just add the prop.)

- [ ] **Step 4: FloatingWidget honors `floatingWidgetOriginalColor`.** When true, ignore per-button `bgColor`/`iconColor` overrides and use `KIND_DEFAULTS` (the brand colors) — i.e. `const bg = (theme.floatingWidgetOriginalColor ? defaults.bg : (button.bgColor ? resolveColor(...) : defaults.bg))`. Keep manual selection working when the flag is off.

- [ ] **Step 5: Shared type + admin mirror + toggles.** Add the two booleans to `StoreTheme` (shared) + the admin local mirror type. Add a "Use original brand colors" toggle in the Branding → Theme tab for the footer flag, and one on the floating-widget page for the widget flag. Default OFF (CLAUDE.md rule 2).

- [ ] **Step 6: Typecheck web + admin + shared** → `0`.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/templates packages/shared/src/types/store-theme.ts apps/admin/src/app/stores
git commit -m "feat: original-brand-color option for footer + floating-widget social icons"
```

---

## Task 6: English product name casing + size

**Files:**

- Modify: `apps/web/src/templates/{elegant,minimal,bold}/ProductCard.tsx` (remove unconditional `uppercase`)
- Modify: `packages/shared/src/types/store-layout.ts` (`productNameCase?: 'normal' | 'uppercase'` on `ProductCardDefaults`, default `'normal'`)
- Modify: the 8 card paths to apply the case class from the field

Three themes hardcode `uppercase` on the name (elegant ~292, minimal ~255, bold ~247). Sizes come from `getProductCardTextSizes(cardSize)` (already merchant-controllable via `cardSize`), so "too large" is solved by the merchant picking a smaller `cardSize` — but the forced caps is not controllable. Make caps a per-store opt-in (default normal).

- [ ] **Step 1: Add `productNameCase` to `ProductCardDefaults`** (default `'normal'`).
- [ ] **Step 2: In elegant/minimal/bold, replace the literal `uppercase`** with a class derived from `(layout?.productCardDefaults?.productNameCase === 'uppercase' ? 'uppercase' : '')`. Keep `tracking-*` as-is.
- [ ] **Step 3: Optional admin control** — add a "Product name case" select (Normal / Uppercase) to the Page Builder card section + Zod field.
- [ ] **Step 4: Typecheck** → `0`. Grep the 3 themes to confirm no remaining unconditional `uppercase` on the name.
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/templates packages/shared/src/types/store-layout.ts apps/admin apps/api
git commit -m "feat(web): product-name case is merchant-controlled (default normal, no forced caps)"
```

---

## Task 7: Dynamic breadcrumb / heading / subtitle reflecting the category

**Files:**

- Modify: `apps/web/src/app/products/ProductsClient.tsx` (subtitle ~461-469, H1 above it, and the breadcrumb trail if rendered here)
- Investigate first: `grep -rn "Home" apps/web/src/app/products apps/web/src/components` for the breadcrumb component rendering `Home / Products / All Products`.

Currently the subtitle is the hardcoded `t('Browse our collection of premium products', '…')` and the H1 is hardcoded `'All Products'`. `categoryFilter` (active slug) + `categories` are in scope; `categories.find(c => c.slug === categoryFilter)` gives `{ name, nameAr }`.

- [ ] **Step 1: Locate the breadcrumb** (`Home / Products / <last>`). If it's in `ProductsClient`, the last segment is the dynamic target; if it's a shared `Breadcrumb` component, pass the active label in.

- [ ] **Step 2: Derive the active context** in `ProductsClient`:

```ts
const activeCategory = categoryFilter ? categories.find(c => c.slug === categoryFilter) : null;
const ctxEn =
  categoryFilter === 'best-sellers' ? 'Best Sellers' : (activeCategory?.name ?? 'All Products');
const ctxAr =
  categoryFilter === 'best-sellers'
    ? 'الأكثر مبيعاً'
    : (activeCategory?.nameAr ?? activeCategory?.name ?? translations['All Products']);
```

- [ ] **Step 3: Use `t(ctxEn, ctxAr)`** for: the breadcrumb's last segment, the H1, and the subtitle. For the subtitle keep a light descriptor: e.g. `t(\`Browse \${ctxEn}\`, \`تصفح \${ctxAr}\`)`when a category is active, else the existing generic line for "all products". Preserve the existing`plpSubtitleZone`+`plpSubheadingColorStyle` styling (content-only change).

- [ ] **Step 4: Typecheck web** → `0`. Manually confirm `/products?category=<slug>` shows the category name in breadcrumb + heading + subtitle, and `/products` shows "All Products".

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/products
git commit -m "feat(web): breadcrumb/heading/subtitle reflect the active category (knows where you are)"
```

---

## Task 8: AI balancer — schema + richness utility

**Files:**

- Modify: `packages/database/prisma/schema.prisma` (`Product.aiBalanceBackup Json? @default("{}") @map("ai_balance_backup")`; add `description_balance` to `BulkAiJobKind` enum ~2427)
- Create: `packages/database/prisma/migrations/<ts>_add_product_ai_balance_backup/migration.sql`
- Create: `apps/api/src/lib/ai/description-richness.ts`
- Modify: `packages/shared/src/types/ai-autofill.ts` (no new managed fields needed; `description`/`descriptionAr` already managed)

- [ ] **Step 1: Schema** — add the column + enum value:

```prisma
  aiBalanceBackup       Json?       @default("{}") @map("ai_balance_backup")
```

and add `description_balance` to `enum BulkAiJobKind`.

- [ ] **Step 2: Hand-written migration** (FWB applies on boot — never `migrate dev` on prod):

```sql
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "ai_balance_backup" JSONB DEFAULT '{}';
-- enum add is idempotent-guarded:
ALTER TYPE "BulkAiJobKind" ADD VALUE IF NOT EXISTS 'description_balance';
```

- [ ] **Step 3: Richness utility** `description-richness.ts`:

```ts
const AR = /[؀-ۿ]/;
export function descriptionRichness(text?: string | null): number {
  const t = (text ?? '').trim();
  if (!t) return 0;
  // length + a small bonus for sentence structure; good-enough heuristic
  return t.length + (t.split(/[.!؟?\n]/).filter(Boolean).length - 1) * 5;
}
/** Which side is richer, or null when both empty / effectively tied-empty. */
export function richerSide(en?: string | null, ar?: string | null): 'en' | 'ar' | null {
  const e = descriptionRichness(en),
    a = descriptionRichness(ar);
  if (e === 0 && a === 0) return null;
  return e >= a ? 'en' : 'ar';
}
export const isMostlyArabic = (t?: string | null) => !!t && AR.test(t);
```

- [ ] **Step 4: Generate client + unit-test the utility.** Create `tests/unit/description-richness.test.ts` (root tests/unit, import `../../apps/api/src/lib/ai/description-richness`): empty→null, longer EN→'en', longer AR→'ar', fragment-EN vs rich-AR→'ar'. Run `npx vitest run tests/unit/description-richness.test.ts` → pass. `npm run db:generate`.

- [ ] **Step 5: Commit**

```bash
git add packages/database/prisma packages/shared apps/api/src/lib/ai/description-richness.ts tests/unit/description-richness.test.ts
git commit -m "feat(ai): Product.aiBalanceBackup column + description-richness utility (revert support)"
```

---

## Task 9: AI balancer — engine, bulk jobs, routes, autopilot

**Files:**

- Create: `apps/api/src/lib/inngest/functions/bulk-ai-balance-descriptions.ts`
- Create: `apps/api/src/lib/inngest/functions/bulk-ai-revert-balance.ts`
- Modify: `apps/api/src/lib/inngest/client.ts` (register both)
- Modify: `apps/api/src/routes/ai.routes.ts` (bulk + per-product routes)
- Modify: `apps/api/src/services/ai-autofill.service.ts` (`balanceProductDescription(storeId, productId, { force })` + a sweep step)

**Core balance op (shared helper in `ai-autofill.service.ts`):**

1. Load product `{ description, descriptionAr, aiFieldSources }`.
2. `side = richerSide(description, descriptionAr)`; if `null` → skip (nothing to balance). If both already full and similar length → skip (avoid churn) unless `force`.
3. Snapshot `{ description, descriptionAr, aiFieldSources }` into `aiBalanceBackup` (only if not already backed up, so repeated runs don't lose the original).
4. Translate the rich side into the other via `AIService.translate({ storeId, text: rich, from: side, to: other, kind: 'product-description' })`.
5. Write the thin side + stamp both `aiFieldSources.description` and `.descriptionAr` = `'ai'`.

- [ ] **Step 1: Implement `balanceProductDescription` + `revertProductBalance`** in `ai-autofill.service.ts` (revert restores from `aiBalanceBackup`, clears it). Reuse `assertAiQuota`/budget via `AIService.translate`.

- [ ] **Step 2: Bulk Inngest fns** modeled on `bulk-ai-translate.ts` — iterate active products, 2.5s throttle, call the helper, update the `BulkAiJob` progress row. `revert` fn reverts every product with a non-empty `aiBalanceBackup`.

- [ ] **Step 3: Routes in `ai.routes.ts`:**
  - `POST /:id/ai/bulk/balance-descriptions` → create `BulkAiJob{kind:'description_balance'}` + fire event.
  - `POST /:id/ai/bulk/revert-balance` → fire revert event.
  - `POST /:id/ai/products/:productId/ai/balance-description` → run helper inline, return `{ description, descriptionAr }`.
  - `POST /:id/ai/products/:productId/ai/revert-balance` → revert inline, return restored values.
    All behind the existing AI-route auth + feature gate.

- [ ] **Step 4: Autopilot integration** — in `sweepStore`/`fillProductFields`, after the existing fill, when autopilot is enabled call `balanceProductDescription(storeId, productId, { force: false })` so new/updated products get balanced (won't clobber a `human` side because translate writes the empty/thin side and stamps `ai`; the backup preserves the original for revert). Gate with the existing `aiAutopilot` flag.

- [ ] **Step 5: Typecheck api** → `0`. Add a focused unit test for `balanceProductDescription` decision logic (mock `AIService.translate`).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/inngest apps/api/src/routes/ai.routes.ts apps/api/src/services/ai-autofill.service.ts tests/unit
git commit -m "feat(ai): description language balancer engine + bulk/per-product/autopilot + revert"
```

---

## Task 10: AI balancer — admin UI (bulk + per-product)

**Files:**

- Modify: `apps/admin/src/app/stores/[id]/ai-tools/page.tsx` (new section + 2 BulkActionCards; extend `BulkAiJob.kind` union + `starting` keys)
- Modify: `apps/admin/src/app/stores/[id]/products/[productId]/edit/page.tsx` (per-product Balance + Revert buttons in the Basic Information card header; `handleBalanced(en, ar)` updates both fields)

- [ ] **Step 1: AI-tools page** — add a "Description language balance" section between Translation and SEO with two `BulkActionCard`s: "Balance descriptions" → `POST .../bulk/balance-descriptions`; "Revert balance" → `POST .../bulk/revert-balance`. Extend the local `BulkAiJob['kind']` union with `'description_balance'`. Reuse the generic polling/progress.

- [ ] **Step 2: Product edit page** — add a `BalanceDescriptionButton` (and revert) in the Basic Information card header next to `AITranslateMissingButton`; on success update both `description` + `descriptionAr` form state and flip both `aiSources` to `'ai'` (mirror `handleAiReset`).

- [ ] **Step 3: EN/AR copy** for the new buttons/section.

- [ ] **Step 4: Typecheck admin** → `0`.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/app/stores/[id]/ai-tools apps/admin/src/app/stores/[id]/products
git commit -m "feat(admin): AI description-balance bulk + per-product do/revert UI"
```

---

## Task 11: Docs parity

**Files:**

- Modify: root `CLAUDE.md` (StoreTheme flag table: add `footerSocialOriginalColor`, `floatingWidgetOriginalColor`, and the new `ProductCardDefaults` CTA/OOS/name-case fields; note the AI balancer + `aiBalanceBackup`).
- Modify: any `docs/merchant/*` or feature catalog touching product-card customization / AI tools.

- [ ] **Step 1: Update the flag table + AI section** in CLAUDE.md.
- [ ] **Step 2: Update merchant/business docs** if they enumerate card controls or AI tools.
- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs
git commit -m "docs: card CTA/OOS/name-case + social original-colors flags + AI balancer"
```

---

## Self-review

- **Spec coverage:** (1) social original colors → Task 5; (2) CTA system + favorite fix → Tasks 2,3,4; (3) dynamic breadcrumb → Task 7; (4) name casing/size → Task 6; (5) AI balancer → Tasks 8,9,10; (6) admin stale UI → Task 1. ✅
- **Platform rule:** Task 3 touches all 8 render paths + grep-verifies; Task 5 touches all 5 footers; copy stays bilingual. ✅
- **Defaults safe:** every new field is optional + neutral/off so existing stores are visually unchanged (CLAUDE.md rule 2). ✅
- **DB:** one additive nullable JSON column + idempotent enum add, hand-written migration (FWB convention). ✅
- **Revert correctness:** `aiBalanceBackup` snapshots only once (guards against repeated-run data loss); revert restores values + provenance + clears backup. ✅
- **Types consistency:** `ctaShape`/`oosLabelShape`/`productNameCase` enums identical across shared type, Zod schema, and admin selects. ✅
- **Known follow-ups to flag during execution:** locate the breadcrumb component (Task 7 Step 1) — if it's not in ProductsClient it may be a shared component needing a prop; ProductListItem has no OOS today (Task 3 Step 8 adds it) — confirm that's desired.

---

## Task 12 (added 2026-06-24, Ahmad Image #2): PLP variant-option facet filters (e.g. Size)

The old OSOSS site filters the PLP by product attributes (`?attributes[2953]=62231` → a "الحجم/Size" facet). FWB has no attribute model; "Size" is a **ProductOption / ProductVariantOption** (from the OSOSS variant import). Build option-facet filters:

- **API** (`product.service.ts` listPublic): compute available option facets (distinct `ProductOption.name` + values) across the products in the current category; accept an `options` filter param (e.g. `option:<name>=<value>` or option-value ids) and filter products that have a matching variant/option. Return facets in the list response.
- **Web** (`ProductsFilterSidebar.tsx` + `ProductsClient.tsx`): render each option group (Size, …) as a checkbox list under the price filter; selecting updates the URL + refetch (mirror the price-filter wiring). Bilingual labels (option names may be EN/AR).
- Default: facets only render when the category actually has options (most don't) — zero visual change otherwise.

## Task 13 (added 2026-06-24, Ahmad Image #3): backorder-aware CTA disable

The API returns BOTH `inStock = effectiveInventory > 0` and `acceptsBackorder` (already in the web `api.ts` type). Cards currently disable the CTA on `!inStock`, which wrongly disables OOS products that ALLOW backorder. Fix across all 8 render paths: define `orderable = product.inStock !== false || product.acceptsBackorder === true`; gate CTA pressability + the OOS/"نفدت الكمية" label on `!orderable` (a backorder-enabled OOS product stays pressable; an OOS + no-backorder product is non-pressable with the OOS label). Keep the existing OOS-label customization (Task 3) — just change what drives "unavailable".
