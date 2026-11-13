# Phase B0 — Platform Commerce Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the commerce features every Ebda template needs before Qamar is built: colour swatches, a Size × Length chip grid, product facts, per-item personalisation, lead time and a "delivers by" chip, a sticky mobile add-to-cart bar and cart total bar, hero video, size charts, and an animated receipt on the order-confirmation page.

**Architecture:** All of this is platform code (CLAUDE.md "Platform-level fixes"). Data goes in Prisma columns and tables with strict RLS, Zod sits at every edge, and the storefront renders from data. A feature shows only when a merchant has filled its data, so every store looks the same on deploy day. Each task ships schema → API → admin → storefront → docs for one feature, and is complete and reviewable on its own. Phase B1 (Qamar skin, demo catalogue, `storedemo.ebda.app`, MKT-15) is a separate plan written after B0 lands, because the Qamar looks use these features.

**Tech Stack:** Prisma 6 + Neon (strict RLS, `ebda_app` role), Express on Cloudflare Workers, Next.js 16 App Router (web/admin), Zod in `@ebda/shared`, Vitest, Playwright.

**Spec:**

- `docs/ebda/templates/research/SUMMARY.md`: P0 rows 1–5, plus row 7 (video) and row 8 (size chart / two-axis chips), which are the Joomah items.
- `docs/ebda/templates/research/qamar.md`.
- `docs/plans/done/2026-10-14-templates-and-editor-program.md` (Phase B).
- Ahmad, 2026-10-14: the receipt-printer animation from Instagram reel `DecOpDXt1Fs` is used for every template (frame notes in Task 10).

## Rulings made during execution

Every decision that overrode this plan, rejected a review finding or accepted a residual was written at decision time and is now in `docs/RULINGS.md` under "2026-10-14 — Phase B0 platform commerce": B0-1..B0-5 (the ones written into this plan below), B0-6..B0-35 in the order they were made, T5-1..T5-3 and T9-1..T9-3 (the implementers' own), and B0-36..B0-39 (the Task 11 sweep: bulk import/export columns, the `storedemo` seed, MCP reads, the local-only E2E). Where this plan and a ruling disagree, the ruling wins; the two that change what the plan says are **B0-1a** (the delivery window counts business days and skips Friday, not calendar days) and **B0-6** (the sticky bar reuses the existing 56 px lift instead of `--bottom-tabbar-h`). The feature reference that describes what shipped is `docs/ebda/templates/platform-commerce.md`.

## Global Constraints

- Arabic-first. Every storefront string goes through `t(en, ar)` / `LanguageContext.tsx`. Every merchant-entered field has an `Ar` twin. When the active locale's value is empty, fall back to the other language, never to blank.
- Platform-level only. Never branch on a store slug or id. Product-card changes land on **every card render path**:
  - `templates/shared/StorefrontProductCard.tsx`
  - `templates/{modern,elegant,classic,minimal,bold}/ProductCard.tsx`
  - `templates/shared/ProductCarousel.tsx`
  - `ProductListItem`
  - `templates/dahab/ProductCard.tsx`
  - `templates/dahab/ProductCarousel.tsx`

  `grep -rln "ProductCard\b" apps/web/src/templates` must show the new element in all of them.

- PDP changes land on **both PDP paths**: `apps/web/src/app/products/[slug]/ProductDetailClient.tsx` (default) and `apps/web/src/templates/dahab/ProductDetail.tsx`.
- Tenant guard: every Prisma `where` / `data` on a model with `storeId` carries a top-level `storeId` equal to the authorised store. A new tenant table gets `ENABLE` + `FORCE` RLS and the `ebda_tenant_isolation` policy (template: `packages/database/prisma/migrations/20261008000020_product_3d_models/migration.sql`).
- Migrations are named `2026101600XX00_<name>/migration.sql`, numbered in task order (Task 1 → `20261016000100`, Task 3 → `…0300`, and so on). They are additive only, with no destructive change.
- New visual features are OFF unless a merchant enters data (UI rule 2). No new `StoreTheme` toggles: the ThemeTab ceiling is 7.
- Sizing follows `design.md` (compact). Fixed-bottom UI follows the two-trap recipe (UI rule 6). Admin colours use `ColorField` only (UI rule 14). Admin pages run in the same order as the storefront (UI rule 5).
- No new npm dependencies. Lockfile changes are made only under npm 10 (`npx -y npm@10 …`).
- Every cached product read: a write to option values, facts, personalisation, lead time or size chart MUST call the existing product cache bust that variant writes already call (grep `invalidateProduct`/`bustProduct` in `variant.service.ts` and reuse it). An `invalidate*` with zero call sites is a bug.
- Every data has a UI. Each new column or table names its admin viewer and storefront viewer in its task.
- Money stays an integer in the store's minor unit (the existing `price` scale). Never floats.
- Commit subjects are all lowercase (commitlint). `git add` takes explicit paths only. Never `--no-verify`.
- Reduced motion: every animation has a `prefers-reduced-motion: reduce` path that shows the end state instantly.

## Taste bar (Ahmad, 2026-10-14: "Ebda must have the same thing")

Reference: Instagram reel `DeeZGosSon1`, "Taste". When anyone can build anything with a prompt, every product on the shelf does the same thing. What wins is taste: **what to make, what to leave out, and how it should feel when you open it.** Every Egyptian store builder will ship swatches and size charts. Ebda's difference is that ours look and feel considered. **Ruling B0-4** makes this binding on every UI task in this plan, because "looks good" is not a finish line. Cost if wrong: about one extra review round per UI task.

**1. What to leave out. These are hard limits, and a reviewer rejects the task on any breach:**

- **Product card.** Below the price, a card shows at most 5 swatch dots (then `+N`) and at most 2 fact chips. Nothing else is added in B0:
  - no HOT/FEATURED badges;
  - no stock nags;
  - no countdowns;
  - no second CTA.

  The merchant's existing `badgeLabel` stays the only badge.

- **PDP fold on a 390px phone (amended by B0-49).** The first screen shows the gallery, the title, the price and the first option selector. Personalisation, the add-to-cart button and the delivery chip follow in that order; on products with several options they sit below the fold. The add-to-cart action is always reachable: the sticky bar shows from first paint whenever the main button is off-screen, in either direction (below the fold or scrolled past), and is hidden while the main button is visible.

  Facts and the size chart sit below, or one tap away.

- **Accent colour.** One accent, used for the primary action only. Swatches, chips and the delivery line use ink and muted tokens, never a new colour.
- **Unfilled features.** A feature with no merchant data renders nothing. There are no empty states, placeholders or "coming soon" on the storefront.
- **Strings.** At most one line of helper text per control. If the copy needs two lines, the control is wrong.
- **Text.** No gradient text, side-stripe borders, glassmorphism or ghost cards (impeccable absolute bans). The radius comes from `var(--radius)` only.

**2. How it feels when you open it:**

- **First paint is the product.** The product image (or the hero poster) is the LCP element. Nothing animates before it is visible.
- **Motion only where it means something.** Three moments in B0 move:
  - the receipt prints;
  - the sticky bar slides in;
  - a swatch tap crossfades the gallery image.

  Everything else is still. The easing is ease-out-quint or ease-out-expo, with no bounce. Every animation has a reduced-motion end state.

- **Arabic is the design language, not a translation.** Each surface is designed and screenshotted in Arabic first, with Arabic-Indic numerals on, then checked in English.
- **The feature reads as the store's, not as Ebda's.** Each component pulls from the active skin and look tokens, so a Dahab store and a Qamar Atelier store each look native.

**3. The taste gate, run at the end of every UI task** (Tasks 2, 3, 4, 5, 6, 8, 9 and 10). It sits between "tests pass" and "commit":

- Screenshot the changed surface at 390×844 Arabic and 1280×800 English, on two skins: `minimal` (the default Ebda Store path) and `dahab`. Where a demo store can preview looks, also screenshot with `?look=qamar.atelier`. Save them under the task's report directory.
- Run the `impeccable` skill's `critique` on that surface. Fix every P0/P1, and record any P2 you leave as a Ruling with cost-if-wrong.
- Compare the result against the research references (`docs/ebda/templates/research/qamar.md`). The bar is the **restraint of Mamzi and Everlane**, with **Egyptian-shopper clarity** (COD and delivery always visible). The anti-bar is Alamal's clutter.
- Write a three-line taste note in the task report: what was left out, what moves and why, and what it feels like on open.

The task reviewer checks the screenshots and note against sections 1–2 and rejects the task on a breach. Ahmad's live review (UI rule 10, 2–4 rounds) happens on the PR before merge.

## Review Focus

1. **Same product + variant, different personalisation text.** Expected: two cart lines and two order lines. With the same text, the quantity merges into one line. (Task 5, test `personalised lines stay separate`.)
2. **Option where only some values have a swatch, or a hex plus an image.** Expected:
   - Values with neither render as text chips.
   - A value with an image shows the image over the hex.
   - No empty circles.

   (Task 2, test `mixed swatch values`.)

3. **English locale on an Arabic-only merchant** (facts, size chart, personalisation label only in Arabic). Expected: the Arabic text is shown, never a blank cell or label. (Tasks 3, 5 and 9, `falls back to arabic` tests.)
4. **Hero video under reduced motion, Save-Data, or a video that 404s.** Expected: the poster image is shown with the same box size (no layout shift) and no broken video element. (Task 8, test `video falls back to poster`.)
5. **Store with no active shipping zone, or a zone with no `estimatedDaysMin`/`Max`.** Expected: the "delivers by" chip is hidden, never "0 days" or "NaN". (Task 4, test `no zone hides chip`.)
6. **Size chart deleted while products and categories still point to it.** Expected: the FK is `SET NULL` and the PDP link disappears without a 500. (Task 9, integration test `deleting a chart nulls references`.)
7. **Receipt for a COD or awaiting-payment order.** Expected: it never says "paid". The status line follows the order's real payment state. (Task 10, test `cod receipt never says paid`.)

---

## File map

| Area               | Files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema             | `packages/database/prisma/schema.prisma` + 5 migrations (Tasks 1, 3, 4, 5, 9)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Shared Zod/helpers | `packages/shared/src/commerce/` (new): `swatch.ts`, `product-facts.ts`, `personalisation.ts`, `delivery-window.ts`, `size-chart.ts`, `index.ts`; export from `packages/shared/src/index.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| API                | `routes/variant.routes.ts`, `services/variant.service.ts`, `routes/product.routes.ts`, `services/product.service.ts` (`STOREFRONT_PRODUCT_SELECT`), `routes/cart.routes.ts`, `services/cart.service.ts`, `services/order.service.ts`, `routes/public.routes.ts`, `routes/upload.routes.ts`, new `routes/size-chart.routes.ts` + `services/size-chart.service.ts`, `services/invoice.service.ts`                                                                                                                                                                                                                                 |
| Builder            | `packages/shared/src/builder/{settings-schema,registry,layout-schema}.ts`, admin `builder/_components/SettingsPanel.tsx` + new `VideoField.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Admin              | `products/[productId]/variants/_components/SimpleVariantsForm.tsx`, `products/[productId]/edit/_components/` (new `FactsCard.tsx`, `PersonalisationCard.tsx`, `FulfilmentCard.tsx`), `orders/[orderId]/_components/ItemsCard.tsx`, new `size-charts/` page, category edit                                                                                                                                                                                                                                                                                                                                                       |
| Storefront         | `components/VariantSelector.tsx`, new `components/commerce/` (`SwatchDots.tsx`, `FactsTable.tsx`, `FactChips.tsx`, `PersonalisationField.tsx`, `DeliveryChip.tsx`, `StickyAddToCart.tsx`, `StickyCartTotal.tsx`, `SizeChartDialog.tsx`, `HeroVideo.tsx`, `ReceiptPrinter.tsx`), both PDP paths, all card paths, `CartContext.tsx`, `app/cart/CartClient.tsx`, `templates/dahab/CartDrawer.tsx`, `app/checkout/OrderSummary.tsx`, `app/checkout/success/SuccessClient.tsx`, hero renderers (`templates/shared/HeroSlider.tsx`, `templates/shared/HeroBannerLink.tsx`, `templates/dahab/Hero.tsx`), new `app/size-guide/page.tsx` |
| Docs               | `CLAUDE.md` (pillar 5: Taste), new `docs/ebda/templates/platform-commerce.md`, plus `docs/architecture/store-theme-flags.md` (card render-path list unchanged, new card elements noted), `docs/ebda/templates/research/SUMMARY.md` status column                                                                                                                                                                                                                                                                                                                                                                                |

---

### Task 1: Swatch data on option values (schema → API → admin)

**Files:**

- Create: `packages/database/prisma/migrations/20261016000100_option_value_swatches/migration.sql`
- Modify: `packages/database/prisma/schema.prisma` (model `ProductOptionValue`, ~line 1148)
- Create: `packages/shared/src/commerce/swatch.ts`, `packages/shared/src/commerce/index.ts`; modify `packages/shared/src/index.ts`
- Modify: `apps/api/src/routes/variant.routes.ts:15-45`, `apps/api/src/services/variant.service.ts` (`addOption`, `addOptionValue`, `updateOptionValue`), every public product select that lists `valueAr: true` (grep it in `apps/api/src`)
- Modify: `apps/admin/src/app/stores/[id]/products/[productId]/variants/_components/SimpleVariantsForm.tsx`, `…/variants/_components/types.ts`
- Test: `tests/unit/commerce-swatch.test.ts`, `tests/integration/option-value-swatch.test.ts`

**Interfaces:**

- Produces: the DB columns `swatch_hex TEXT NULL` and `swatch_image_url TEXT NULL` on `product_option_values`, and the API fields `swatchHex: string | null` and `swatchImageUrl: string | null` on every option value in admin and public product payloads.
- Produces (`@ebda/shared`):
  - `swatchHexSchema`
  - `optionValueSwatchSchema`
  - `type Swatch = { hex: string | null; imageUrl: string | null }`
  - `swatchOf(v: { swatchHex?: string | null; swatchImageUrl?: string | null }): Swatch | null`, which returns null when both are empty.

- [ ] **Step 1: Write the failing unit test**

```ts
// tests/unit/commerce-swatch.test.ts
import { describe, it, expect } from 'vitest';
import { swatchHexSchema, swatchOf } from '@ebda/shared';

describe('swatch', () => {
  it('accepts #RRGGBB only', () => {
    expect(swatchHexSchema.safeParse('#1F4E54').success).toBe(true);
    expect(swatchHexSchema.safeParse('1F4E54').success).toBe(false);
    expect(swatchHexSchema.safeParse('#fff').success).toBe(false);
    expect(swatchHexSchema.safeParse('red').success).toBe(false);
  });
  it('swatchOf returns null when both empty', () => {
    expect(swatchOf({})).toBeNull();
    expect(swatchOf({ swatchHex: null, swatchImageUrl: '' })).toBeNull();
  });
  it('swatchOf keeps image and hex', () => {
    expect(swatchOf({ swatchHex: '#000000', swatchImageUrl: 'https://x.r2.dev/a.webp' })).toEqual({
      hex: '#000000',
      imageUrl: 'https://x.r2.dev/a.webp',
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/commerce-swatch.test.ts`
Expected: FAIL. `swatchHexSchema` is not exported.

- [ ] **Step 3: Implement the shared module**

```ts
// packages/shared/src/commerce/swatch.ts
import { z } from 'zod';

export const swatchHexSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Use #RRGGBB');

/** Both optional + nullable so the admin can clear either one explicitly. */
export const optionValueSwatchSchema = z.object({
  swatchHex: swatchHexSchema.nullable().optional(),
  swatchImageUrl: z.string().url().max(2048).nullable().optional(),
});

export type Swatch = { hex: string | null; imageUrl: string | null };

export function swatchOf(v: {
  swatchHex?: string | null;
  swatchImageUrl?: string | null;
}): Swatch | null {
  const hex = v.swatchHex || null;
  const imageUrl = v.swatchImageUrl || null;
  return hex || imageUrl ? { hex, imageUrl } : null;
}
```

```ts
// packages/shared/src/commerce/index.ts
export * from './swatch';
```

Add `export * from './commerce';` to `packages/shared/src/index.ts`. Later tasks append their modules to `commerce/index.ts`.

- [ ] **Step 4: Run the unit test**

Run: `npx vitest run tests/unit/commerce-swatch.test.ts` → PASS.

- [ ] **Step 5: Schema + migration**

In `ProductOptionValue`, add the following below `valueAr`:

```prisma
  swatchHex      String?  @map("swatch_hex")
  swatchImageUrl String?  @map("swatch_image_url")
```

```sql
-- 20261016000100_option_value_swatches/migration.sql
-- Colour swatch per option value (hex dot and/or a fabric/photo thumbnail).
-- product_option_values is a tenant child (RLS via product join, 20261004000000);
-- adding columns needs no policy change.
ALTER TABLE "product_option_values" ADD COLUMN "swatch_hex" TEXT;
ALTER TABLE "product_option_values" ADD COLUMN "swatch_image_url" TEXT;
ALTER TABLE "product_option_values" ADD CONSTRAINT "product_option_values_swatch_hex_format"
  CHECK ("swatch_hex" IS NULL OR "swatch_hex" ~ '^#[0-9A-Fa-f]{6}$');
```

Run: `npm run db:generate` → succeeds.

- [ ] **Step 6: API**

In `variant.routes.ts`:

- `createOptionSchema.values[]` becomes `z.object({ value, valueAr }).merge(optionValueSwatchSchema)`.
- `createOptionValueSchema` and `updateOptionValueSchema` both `.merge(optionValueSwatchSchema)`.

In `variant.service.ts`:

- `addOption`, `addOptionValue` and `updateOptionValue` pass `swatchHex` / `swatchImageUrl` through to Prisma (`undefined` = leave alone, `null` = clear).
- After each write, call the same product-cache bust the variant writes use.

In every select that lists option values (`grep -rn "valueAr: true" apps/api/src`), add `swatchHex: true, swatchImageUrl: true`.

- [ ] **Step 7: Integration test**

```ts
// tests/integration/option-value-swatch.test.ts
// Follow tests/integration/variant*.test.ts fixtures (store + owner + product).
it('stores, returns and clears a swatch', async () => {
  const opt = await post(`/stores/${storeId}/products/${productId}/options`, {
    name: 'Color',
    nameAr: 'اللون',
    values: [{ value: 'Teal', valueAr: 'تيل', swatchHex: '#1F4E54' }, { value: 'Plain' }],
  });
  expect(opt.status).toBe(201);
  const pub = await get(`/public/products/${slug}`); // storefront payload
  const values = pub.body.data.product.options[0].values;
  expect(values.find(v => v.value === 'Teal').swatchHex).toBe('#1F4E54');
  expect(values.find(v => v.value === 'Plain').swatchHex).toBeNull();
  const tealId = values.find(v => v.value === 'Teal').id;
  await put(
    `/stores/${storeId}/products/${productId}/options/${opt.body.data.id}/values/${tealId}`,
    { swatchHex: null }
  );
  const again = await get(`/public/products/${slug}`);
  expect(
    again.body.data.product.options[0].values.find(v => v.value === 'Teal').swatchHex
  ).toBeNull();
});
it('rejects a bad hex with 400', async () => {
  const r = await post(`/stores/${storeId}/products/${productId}/options`, {
    name: 'Shade',
    values: [{ value: 'X', swatchHex: 'red' }],
  });
  expect(r.status).toBe(400);
});
```

Match the helper names to the existing variant integration test you copy from. The public-product URL is whatever `public.routes.ts` serves a PDP from (grep `products/:slug`).

Run: `npm run test:integration -- option-value-swatch` → PASS.

- [ ] **Step 8: Admin**

In `SimpleVariantsForm.tsx`, each option value row gets two controls:

- A `ColorField` labelled "لون العينة / Swatch colour", with the value from `swatchHex` and a "clear" action that sends `null`.
- The existing image-upload control (reuse the one the variant image uses, folder `products`), labelled "صورة العينة / Swatch photo".

Add `swatchHex?: string | null; swatchImageUrl?: string | null` to `OptionValue` in `types.ts`. Run the guard:

`grep -rn 'type="color"' apps/admin/src | grep -v ColorField` → empty.

- [ ] **Step 9: Typecheck + commit**

Run: `npm run typecheck` → exit 0.

```bash
git add packages/database/prisma/schema.prisma packages/database/prisma/migrations/20261016000100_option_value_swatches packages/shared/src/commerce packages/shared/src/index.ts apps/api/src/routes/variant.routes.ts apps/api/src/services/variant.service.ts apps/api/src/services/product.service.ts apps/api/src/routes/public.routes.ts apps/admin/src/app/stores/\[id\]/products/\[productId\]/variants tests/unit/commerce-swatch.test.ts tests/integration/option-value-swatch.test.ts
git commit -m "feat(commerce): swatch colour and photo on option values"
```

(Add only the files you actually changed. If a select lives in a different file, add that one instead.)

---

### Task 2: Swatches + Size × Length chips on the storefront (PDP + every card)

**Files:**

- Modify: `apps/web/src/lib/api.ts` (`ProductOption` value type gets `swatchHex?`, `swatchImageUrl?`)
- Modify: `apps/web/src/components/VariantSelector.tsx`
- Create: `apps/web/src/components/commerce/SwatchDots.tsx`
- Modify: every card render path (Global Constraints list) + `apps/api/src/services/product.service.ts` listing select
- Test: `apps/web/src/components/VariantSelector.swatch.test.tsx`, `apps/web/src/components/commerce/SwatchDots.test.tsx`

**Interfaces:**

- Consumes: `swatchOf()` and the `swatchHex` / `swatchImageUrl` fields from Task 1.
- Produces: `<SwatchDots product={p} max={5} />`. It renders nothing when no option has any swatch value.
- Produces: `VariantSelector` renders automatically. An option with ≥1 swatch value renders as round swatch buttons; the others render as chips. The Dahab `appearance='swatch'` and `swatchColor` props keep working unchanged.

- [ ] **Step 1: Failing tests**

```tsx
// apps/web/src/components/VariantSelector.swatch.test.tsx
// Render with the same providers VariantSelector's existing tests use (grep a *.test.tsx that renders it; copy its wrapper).
const options = [
  {
    name: 'Color',
    nameAr: 'اللون',
    values: [
      { id: 'a', value: 'Teal', valueAr: 'تيل', swatchHex: '#1F4E54', swatchImageUrl: null },
      {
        id: 'b',
        value: 'Rose',
        valueAr: 'روز',
        swatchHex: '#C98B8B',
        swatchImageUrl: 'https://x.r2.dev/rose.webp',
      },
      { id: 'c', value: 'Plain', valueAr: 'سادة', swatchHex: null, swatchImageUrl: null },
    ],
  },
  {
    name: 'Size',
    nameAr: 'المقاس',
    values: [
      { id: 's', value: 'S' },
      { id: 'm', value: 'M' },
    ],
  },
  {
    name: 'Length',
    nameAr: 'الطول',
    values: [
      { id: 'l52', value: '52' },
      { id: 'l56', value: '56' },
    ],
  },
];
// variants: every Color×Size×Length combo in stock EXCEPT Teal / M / 56 (inventory 0)

it('mixed swatch values', () => {
  render(<VariantSelector variants={variants} options={options} onVariantSelect={() => {}} />);
  const teal = screen.getByRole('radio', { name: /Teal|تيل/ });
  expect(teal.querySelector('[data-swatch-hex="#1F4E54"]')).not.toBeNull();
  const rose = screen.getByRole('radio', { name: /Rose|روز/ });
  expect(rose.querySelector('img')).not.toBeNull(); // image wins over hex
  const plain = screen.getByRole('radio', { name: /Plain|سادة/ });
  expect(plain.querySelector('[data-swatch-hex]')).toBeNull(); // text chip, no empty circle
  expect(plain).toHaveTextContent(/Plain|سادة/);
});

it('strikes the out-of-stock combo once the other axes are picked', async () => {
  render(<VariantSelector variants={variants} options={options} onVariantSelect={() => {}} />);
  await userEvent.click(screen.getByRole('radio', { name: /Teal|تيل/ }));
  await userEvent.click(screen.getByRole('radio', { name: 'M' }));
  const l56 = screen.getByRole('radio', { name: '56' });
  expect(l56).toBeDisabled();
  expect(l56.className).toMatch(/line-through/);
  expect(screen.getByRole('radio', { name: '52' })).not.toBeDisabled();
});
```

```tsx
// apps/web/src/components/commerce/SwatchDots.test.tsx
it('renders up to max dots then +N', () => {
  const p = {
    options: [
      {
        name: 'Color',
        values: Array.from({ length: 7 }, (_, i) => ({
          id: `${i}`,
          value: `c${i}`,
          swatchHex: '#000000',
          swatchImageUrl: null,
        })),
      },
    ],
  };
  render(<SwatchDots product={p} max={5} />);
  expect(screen.getAllByTestId('swatch-dot')).toHaveLength(5);
  expect(screen.getByText('+2')).toBeInTheDocument();
});
it('renders nothing without swatches', () => {
  const { container } = render(
    <SwatchDots
      product={{ options: [{ name: 'Size', values: [{ id: '1', value: 'S' }] }] }}
      max={5}
    />
  );
  expect(container).toBeEmptyDOMElement();
});
```

Run: `npx vitest run apps/web/src/components/VariantSelector.swatch.test.tsx apps/web/src/components/commerce/SwatchDots.test.tsx` → FAIL.

If the existing chips use `role="button"` with `aria-pressed` rather than `radio`, keep the existing role and adapt the queries. Do not change roles other tests depend on. The strike-through test may already pass for `disabled` (the availability logic exists at `VariantSelector.tsx:98-110`). If so, the new assertion is only the `line-through` class.

- [ ] **Step 2: Implement `SwatchDots`**

```tsx
// apps/web/src/components/commerce/SwatchDots.tsx
'use client';
import { swatchOf } from '@ebda/shared';

type V = {
  id: string;
  value: string;
  valueAr?: string | null;
  swatchHex?: string | null;
  swatchImageUrl?: string | null;
};
type P = { options?: Array<{ name: string; values: V[] }> | null };

/** Colour dots for a product card. Uses the FIRST option that has any swatch. */
export function SwatchDots({ product, max = 5 }: { product: P; max?: number }) {
  const opt = product.options?.find(o => o.values.some(v => swatchOf(v)));
  if (!opt) return null;
  const vals = opt.values.filter(v => swatchOf(v));
  const shown = vals.slice(0, max);
  return (
    <div className="flex items-center gap-1" aria-hidden="true">
      {shown.map(v => {
        const s = swatchOf(v)!;
        return (
          <span
            key={v.id}
            data-testid="swatch-dot"
            className="inline-block h-3 w-3 overflow-hidden rounded-full border border-foreground/15"
            style={s.imageUrl ? undefined : { backgroundColor: s.hex ?? undefined }}
          >
            {s.imageUrl && (
              <img src={s.imageUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
            )}
          </span>
        );
      })}
      {vals.length > max && (
        <span className="text-[10px] text-muted-foreground">+{vals.length - max}</span>
      )}
    </div>
  );
}
```

- [ ] **Step 3: VariantSelector**

In the value-button render (around line 160–200), compute `const sw = swatchOf(value)` for each value, and `const swatchOption = option.values.some(v => swatchOf(v))` once per option.

When `swatchOption && sw` is true, render a round 32px button:

- Contents: `<span data-swatch-hex={sw.hex ?? undefined} style={{ backgroundColor: sw.hex ?? undefined }}>`, wrapping `<img>` when `sw.imageUrl` is set.
- Ring: `ring-2 ring-foreground` when selected.
- Accessible name: the localised value via `aria-label`.

When `swatchOption && !sw`, render the existing chip. Add `line-through opacity-50` next to every existing `disabled={!available}`, for both appearances. Keep the Dahab `appearance === 'swatch'` branch untouched. Show the selected swatch's localised name beside the option label ("اللون: تيل").

Gallery crossfade (taste bar §2). The PDP already swaps to the picked variant's `imageUrl` (`ProductDetailClient.tsx:~190, ~490`). Make that swap a 200 ms opacity crossfade (ease-out-quint, instant under reduced motion) on both PDP paths, and do not change the image source logic. When the picked colour has no variant image but its option value has a `swatchImageUrl`, the gallery stays on the current image. A fabric close-up is not a product photo.

- [ ] **Step 4: Card payload**

In the storefront LISTING select in `product.service.ts` (the one listing pages and carousels use; not the PDP one), add:

```ts
options: {
  orderBy: { position: 'asc' },
  take: 3,
  select: { name: true, nameAr: true, values: {
    where: { OR: [{ swatchHex: { not: null } }, { swatchImageUrl: { not: null } }] },
    orderBy: { position: 'asc' }, take: 8,
    select: { id: true, value: true, valueAr: true, swatchHex: true, swatchImageUrl: true },
  } },
},
```

This adds one batched query per listing page.

**Cache class:** the payload rides the existing product listing cache. Task 1 already busts it on every option-value write. State that in a comment at the select.

- [ ] **Step 5: Wire `<SwatchDots product={product} max={5} />` into every card path**

Place it under the price line in each card in the Global Constraints list. Then verify:

```bash
for f in $(grep -rln "export.*ProductCard\|export.*ProductCarousel\|export.*ProductListItem" apps/web/src/templates apps/web/src/components); do grep -L "SwatchDots" "$f"; done
```

Expected: no output, or only files that hand rendering to a card that already has it. List any exceptions in the task report.

- [ ] **Step 6: Tests pass + typecheck**

Run: `npx vitest run apps/web/src/components` → PASS. `npm run typecheck` → exit 0.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/api.ts apps/web/src/components/VariantSelector.tsx apps/web/src/components/VariantSelector.swatch.test.tsx apps/web/src/components/commerce/SwatchDots.tsx apps/web/src/components/commerce/SwatchDots.test.tsx apps/api/src/services/product.service.ts <each card file touched>
git commit -m "feat(storefront): colour swatches on pdp and every product card, struck-out sold-out combos"
```

---

### Task 3: Product facts (specs, fabric, karat, ingredients)

**Files:**

- Create: `packages/database/prisma/migrations/20261016000300_product_facts/migration.sql`
- Modify: `schema.prisma` (`Product`)
- Create: `packages/shared/src/commerce/product-facts.ts`
- Modify: `apps/api/src/routes/product.routes.ts:44` (`createProductSchema`), `product.service.ts` (`STOREFRONT_PRODUCT_SELECT` + listing select)
- Create: `apps/admin/src/app/stores/[id]/products/[productId]/edit/_components/FactsCard.tsx`; modify `edit/page.tsx`
- Create: `apps/web/src/components/commerce/FactsTable.tsx`, `FactChips.tsx`; modify both PDP paths, every card path, `apps/web/src/app/compare/` page
- Test: `tests/unit/commerce-product-facts.test.ts`, `apps/web/src/components/commerce/FactsTable.test.tsx`

**Interfaces:**

- Produces: column `products.facts JSONB NOT NULL DEFAULT '[]'`.
- Produces (`@ebda/shared`):
  - `productFactSchema`
  - `productFactsSchema` (max 24, max 2 with `onCard`)
  - `type ProductFact = { key: string; keyAr: string; value: string; valueAr: string; onCard: boolean }`
  - `factText(f, lang: 'ar'|'en'): { key: string; value: string }` (falls back across languages)
  - `cardFacts(facts): ProductFact[]` (the `onCard` ones, max 2)

- [ ] **Step 1: Failing unit test**

```ts
// tests/unit/commerce-product-facts.test.ts
import { productFactsSchema, factText, cardFacts } from '@ebda/shared';

const f = (o: Partial<any> = {}) => ({
  key: 'Fabric',
  keyAr: 'الخامة',
  value: 'Linen',
  valueAr: 'كتان',
  onCard: false,
  ...o,
});

it('caps at 24 rows and 2 card chips', () => {
  expect(productFactsSchema.safeParse(Array.from({ length: 25 }, () => f())).success).toBe(false);
  expect(
    productFactsSchema.safeParse([f({ onCard: true }), f({ onCard: true }), f({ onCard: true })])
      .success
  ).toBe(false);
  expect(productFactsSchema.safeParse([f({ onCard: true }), f()]).success).toBe(true);
});
it('needs a key and value in at least one language', () => {
  expect(productFactsSchema.safeParse([f({ key: '', keyAr: '' })]).success).toBe(false);
  expect(productFactsSchema.safeParse([f({ key: '', value: '' })]).success).toBe(true);
});
it('falls back to arabic', () => {
  expect(factText(f({ key: '', value: '' }), 'en')).toEqual({ key: 'الخامة', value: 'كتان' });
  expect(factText(f(), 'ar')).toEqual({ key: 'الخامة', value: 'كتان' });
});
it('cardFacts returns onCard rows only', () => {
  expect(cardFacts([f(), f({ onCard: true, value: 'Silk' })]).map(x => x.value)).toEqual(['Silk']);
});
```

Run → FAIL.

- [ ] **Step 2: Implement**

```ts
// packages/shared/src/commerce/product-facts.ts
import { z } from 'zod';

const clean = (max: number) => z.string().trim().max(max).default('');

export const productFactSchema = z
  .object({
    key: clean(40),
    keyAr: clean(40),
    value: clean(120),
    valueAr: clean(120),
    onCard: z.boolean().default(false),
  })
  .refine(f => (f.key || f.keyAr) && (f.value || f.valueAr), {
    message: 'Fact needs a name and a value',
  });

export const productFactsSchema = z
  .array(productFactSchema)
  .max(24)
  .refine(a => a.filter(f => f.onCard).length <= 2, { message: 'At most 2 facts on the card' });

export type ProductFact = z.infer<typeof productFactSchema>;

export function factText(f: ProductFact, lang: 'ar' | 'en') {
  const pick = (en: string, ar: string) => (lang === 'ar' ? ar || en : en || ar);
  return { key: pick(f.key, f.keyAr), value: pick(f.value, f.valueAr) };
}

export function cardFacts(facts: ProductFact[] | null | undefined): ProductFact[] {
  return (facts ?? []).filter(f => f.onCard).slice(0, 2);
}
```

Append `export * from './product-facts';` to `commerce/index.ts`. Run → PASS.

- [ ] **Step 3: Schema + migration**

```prisma
  facts Json @default("[]") // ProductFact[] — @ebda/shared productFactsSchema
```

```sql
-- 20261016000300_product_facts/migration.sql
ALTER TABLE "products" ADD COLUMN "facts" JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "products" ADD CONSTRAINT "products_facts_is_array" CHECK (jsonb_typeof("facts") = 'array');
```

- [ ] **Step 4: API**

Add `facts: productFactsSchema.optional()` to `createProductSchema` (update inherits it through `.partial()`). Add `facts: true` to `STOREFRONT_PRODUCT_SELECT` and to the listing select (cards need `onCard`).

Add an integration case to the existing product route test: PUT `facts` with 3 rows → GET returns them; PUT 25 rows → 400.

- [ ] **Step 5: Admin FactsCard**

`FactsCard.tsx` is a repeatable row editor:

- Fields: name EN, name AR, value EN, value AR, and an "show on card" checkbox, which disables once 2 are checked.
- Controls: up/down reorder and delete.
- Presets row: chip buttons that add a pre-filled key. The keys are الخامة/Fabric, العناية/Care, المقاس على الموديل/Model wears, المنشأ/Origin, العيار/Karat and المكونات/Ingredients.
- An **AI translate** button per row that fills the empty language. It calls the existing `POST /stores/:storeId/ai/translate` (`apps/api/src/routes/ai.routes.ts:52`; read its body shape there).

Place the card after the description card (admin mirrors storefront: facts sit under the description on the PDP). It saves through the page's existing save, so there is one writer: the page owns the PUT, and FactsCard only edits form state.

- [ ] **Step 6: Storefront**

```tsx
// apps/web/src/components/commerce/FactsTable.tsx
'use client';
import { factText, type ProductFact } from '@ebda/shared';
import { useLanguage } from '@/contexts/LanguageContext';

export function FactsTable({ facts }: { facts: ProductFact[] | null | undefined }) {
  const { language, t } = useLanguage();
  if (!facts?.length) return null;
  const lang = language === 'ar' ? 'ar' : 'en';
  return (
    <section aria-label={t('Product details', 'تفاصيل المنتج')} className="mt-6">
      <dl className="divide-y divide-border border-y border-border text-sm">
        {facts.map((f, i) => {
          const x = factText(f, lang);
          return (
            <div key={i} className="grid grid-cols-[minmax(6rem,35%)_1fr] gap-3 py-2">
              <dt className="text-muted-foreground">{x.key}</dt>
              <dd className="text-foreground">{x.value}</dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
```

`FactChips.tsx` renders `cardFacts(product.facts)` as up to two `text-[11px]` chips showing `factText(...).value` only. It returns null when empty. Wire `FactsTable` under the description in both PDP paths. Wire `FactChips` into every card path, next to `SwatchDots`. On the compare page, add one row per distinct fact key across the compared products, with "—" where a product lacks the key.

Test `FactsTable.test.tsx`: renders the Arabic fallback under English, and renders nothing for `[]`.

- [ ] **Step 7: Typecheck, tests, commit**

```bash
git add <files>
git commit -m "feat(commerce): product facts with pdp table, card chips, compare rows and ai translate"
```

---

### Task 4: Lead time + "delivers by" chip

**Files:**

- Create: `packages/database/prisma/migrations/20261016000400_product_lead_time/migration.sql`
- Modify: `schema.prisma` (`Product`: `leadTimeDays Int? @map("lead_time_days")`)
- Create: `packages/shared/src/commerce/delivery-window.ts`
- Modify: `product.routes.ts` (`leadTimeDays: z.number().int().min(0).max(60).nullable().optional()`), `STOREFRONT_PRODUCT_SELECT`
- Create: `apps/admin/.../edit/_components/FulfilmentCard.tsx`
- Create: `apps/web/src/components/commerce/DeliveryChip.tsx`; modify both PDP paths
- Test: `tests/unit/commerce-delivery-window.test.ts`, `apps/web/src/components/commerce/DeliveryChip.test.tsx`

**Interfaces:**

- Produces: `deliveryWindow({ now: Date, leadTimeDays: number | null, zones: Array<{ isActive: boolean; estimatedDaysMin: number | null; estimatedDaysMax: number | null; estimatedDays?: number | null }> }): { from: Date; to: Date } | null`
  - Uses the FASTEST active zone that has numbers (min of the mins, and that zone's max).
  - Adds the lead time to both ends.
  - Returns null when no active zone has numbers.
- Produces: `<DeliveryChip leadTimeDays={p.leadTimeDays} />`. It reads the store's public shipping zones from the endpoint `/shipping` already uses (grep `shipping-zones` / `getShippingZones` in `apps/web/src/lib/api.ts`). It formats with the existing `formatDate(…, { timezone: store.timezone, language, numerals })`.

**Ruling B0-1:** calendar days, no weekend skipping, and no delivery-date picker in B0. The checkout already has merchant delivery windows (`settings.checkoutDelivery`). A date picker is a Lamma need and goes into the Lamma plan. Cost if wrong: dates read 1–2 days optimistic around Fridays until the Lamma work adds a calendar.

- [ ] **Step 1: Failing test**

```ts
// tests/unit/commerce-delivery-window.test.ts
import { deliveryWindow } from '@ebda/shared';
const now = new Date('2026-10-14T10:00:00Z');
const day = (n: number) => new Date(now.getTime() + n * 86_400_000);

it('uses the fastest active zone', () => {
  const w = deliveryWindow({
    now,
    leadTimeDays: null,
    zones: [
      { isActive: true, estimatedDaysMin: 3, estimatedDaysMax: 5 },
      { isActive: true, estimatedDaysMin: 1, estimatedDaysMax: 2 },
      { isActive: false, estimatedDaysMin: 0, estimatedDaysMax: 0 },
    ],
  });
  expect(w).toEqual({ from: day(1), to: day(2) });
});
it('adds lead time', () => {
  expect(
    deliveryWindow({
      now,
      leadTimeDays: 7,
      zones: [{ isActive: true, estimatedDaysMin: 1, estimatedDaysMax: 2 }],
    })
  ).toEqual({ from: day(8), to: day(9) });
});
it('falls back to estimatedDays when min/max missing', () => {
  expect(
    deliveryWindow({
      now,
      leadTimeDays: null,
      zones: [{ isActive: true, estimatedDaysMin: null, estimatedDaysMax: null, estimatedDays: 3 }],
    })
  ).toEqual({ from: day(3), to: day(3) });
});
it('no zone hides chip', () => {
  expect(deliveryWindow({ now, leadTimeDays: 2, zones: [] })).toBeNull();
  expect(
    deliveryWindow({
      now,
      leadTimeDays: 2,
      zones: [{ isActive: true, estimatedDaysMin: null, estimatedDaysMax: null }],
    })
  ).toBeNull();
});
```

Run → FAIL.

- [ ] **Step 2: Implement**

```ts
// packages/shared/src/commerce/delivery-window.ts
type Zone = {
  isActive: boolean;
  estimatedDaysMin: number | null;
  estimatedDaysMax: number | null;
  estimatedDays?: number | null;
};
const DAY = 86_400_000;

export function deliveryWindow(a: {
  now: Date;
  leadTimeDays: number | null;
  zones: Zone[];
}): { from: Date; to: Date } | null {
  const ranges = a.zones
    .filter(z => z.isActive)
    .map(z => {
      const min = z.estimatedDaysMin ?? z.estimatedDays ?? null;
      const max = z.estimatedDaysMax ?? z.estimatedDays ?? min;
      return min == null || max == null ? null : { min, max: Math.max(min, max) };
    })
    .filter((r): r is { min: number; max: number } => r !== null)
    .sort((x, y) => x.min - y.min || x.max - y.max);
  if (!ranges.length) return null;
  const lead = Math.max(0, a.leadTimeDays ?? 0);
  const t = a.now.getTime();
  return {
    from: new Date(t + (ranges[0].min + lead) * DAY),
    to: new Date(t + (ranges[0].max + lead) * DAY),
  };
}
```

Append it to `commerce/index.ts`. Run → PASS.

- [ ] **Step 3: Schema, migration, API**

```sql
-- 20261016000400_product_lead_time/migration.sql
ALTER TABLE "products" ADD COLUMN "lead_time_days" INTEGER;
ALTER TABLE "products" ADD CONSTRAINT "products_lead_time_days_range" CHECK ("lead_time_days" IS NULL OR "lead_time_days" BETWEEN 0 AND 60);
```

Add `leadTimeDays` to the Zod schema and `STOREFRONT_PRODUCT_SELECT`.

- [ ] **Step 4: Admin FulfilmentCard**

`FulfilmentCard.tsx` is a number input "مدة التجهيز (أيام) / Made-to-order days" (0–60, empty = ready to ship), with helper text "يظهر للعميل: يوصلك بين … و …". Place it after the inventory card. The page owns the save.

- [ ] **Step 5: DeliveryChip**

The chip reads like this:

- `يوصلك بين الأحد ١٩ أكتوبر والثلاثاء ٢١ أكتوبر` / `Arrives Sun 19 Oct – Tue 21 Oct`.
- When `from === to`: `يوصلك الأحد ١٩ أكتوبر`.
- When `leadTimeDays > 0`, a second muted line: `بيتجهز خصيصًا لك في {n} أيام` / `Made for you in {n} days`.

It uses a truck icon from the icon set the PDP already imports, and returns null when `deliveryWindow` is null. Place it under the add-to-cart button in both PDP paths.

Test `DeliveryChip.test.tsx`: mock the zones fetch to return `[]` and assert empty output; mock one zone and assert the Arabic text contains `يوصلك`.

- [ ] **Step 6: Typecheck, tests, commit**

```bash
git commit -m "feat(commerce): made-to-order lead time and delivers-by chip on pdp"
```

---

### Task 5: Per-item personalisation (PDP → cart → order → admin → invoice), plus the storefront `variantName` snapshot fix

**Files:**

- Create: `packages/database/prisma/migrations/20261016000500_personalisation/migration.sql`
- Modify: `schema.prisma` (`Product.personalisation Json?`, `CartItem.note String?`, `OrderItem.personalisation String?`)
- Create: `packages/shared/src/commerce/personalisation.ts`
- Modify:
  - `product.routes.ts` and `STOREFRONT_PRODUCT_SELECT`
  - `cart.routes.ts:22-36` (`addToCartSchema`, `bulkSyncSchema`)
  - `cart.service.ts` (`addItem` ~325-470, `addItems` ~641)
  - `order.service.ts:1547-1560`
  - `services/invoice.service.ts`
  - the order email item renderer (grep `productName` under `apps/api/src/lib/email*` / `templates`)
- Modify:
  - `apps/web/src/contexts/CartContext.tsx` (line identity, ~252-300)
  - `cart-hydration.ts`, `cart-lines.ts`
  - `apps/web/src/lib/api.ts` (`addToCart`, `syncCart`)
  - both PDP paths
  - `app/cart/CartClient.tsx`
  - `templates/dahab/CartDrawer.tsx`
  - `app/checkout/OrderSummary.tsx`
  - `app/checkout/success/SuccessClient.tsx` item rows
- Create: `apps/web/src/components/commerce/PersonalisationField.tsx`, `apps/admin/.../edit/_components/PersonalisationCard.tsx`
- Modify: `apps/admin/src/app/stores/[id]/orders/[orderId]/_components/ItemsCard.tsx`, `types.ts`
- Test: `tests/unit/commerce-personalisation.test.ts`, `tests/integration/cart-personalisation.test.ts`

**Interfaces:**

- Produces (`@ebda/shared`):
  - `personalisationConfigSchema = { enabled: boolean; label: string; labelAr: string; maxLength: 1..200; required: boolean }`
  - `type PersonalisationConfig`
  - `cleanNote(raw: unknown): string | null`: trims, strips C0/C1 control chars and bidi overrides (U+202A–202E, U+2066–2069), caps at 200, and turns empty into null.
  - `personalisationLabel(cfg, lang)`, with the cross-language fallback.
- Produces (API):
  - `POST /public/cart/items` and the bulk sync accept `note?: string` (≤200).
  - A cart line's identity is `(cartId, productId, variantId, note)`.
  - `OrderItem.personalisation` = the cart line's note.
  - `OrderItem.variantName` is now written on storefront orders, as `variant.title` (`titleAr` when the order locale is `ar` and it is set).
- Produces (web): `CartItem.note?: string`. The line identity helper is `sameLine(a, b) = a.productId === b.productId && (a.variantId ?? null) === (b.variantId ?? null) && (a.note ?? null) === (b.note ?? null)`.

- [ ] **Step 1: Failing unit test**

```ts
// tests/unit/commerce-personalisation.test.ts
import { cleanNote, personalisationConfigSchema, personalisationLabel } from '@ebda/shared';
it('cleans notes', () => {
  expect(cleanNote('  Sara ‮ ')).toBe('Sara');
  expect(cleanNote('a\u0000b')).toBe('ab');
  expect(cleanNote('')).toBeNull();
  expect(cleanNote(42)).toBeNull();
  expect(cleanNote('x'.repeat(250))).toHaveLength(200);
});
it('validates config', () => {
  expect(
    personalisationConfigSchema.safeParse({
      enabled: true,
      label: '',
      labelAr: 'الاسم',
      maxLength: 20,
      required: true,
    }).success
  ).toBe(true);
  expect(
    personalisationConfigSchema.safeParse({
      enabled: true,
      label: '',
      labelAr: '',
      maxLength: 20,
      required: true,
    }).success
  ).toBe(false);
  expect(
    personalisationConfigSchema.safeParse({
      enabled: true,
      label: 'Name',
      labelAr: '',
      maxLength: 0,
      required: false,
    }).success
  ).toBe(false);
});
it('falls back to arabic', () => {
  expect(
    personalisationLabel(
      { enabled: true, label: '', labelAr: 'الاسم على الطوق', maxLength: 20, required: false },
      'en'
    )
  ).toBe('الاسم على الطوق');
});
```

- [ ] **Step 2: Implement**

```ts
// packages/shared/src/commerce/personalisation.ts
import { z } from 'zod';

export const personalisationConfigSchema = z
  .object({
    enabled: z.boolean(),
    label: z.string().trim().max(60).default(''),
    labelAr: z.string().trim().max(60).default(''),
    maxLength: z.number().int().min(1).max(200),
    required: z.boolean().default(false),
  })
  .refine(c => !c.enabled || c.label || c.labelAr, { message: 'Label needed' });

export type PersonalisationConfig = z.infer<typeof personalisationConfigSchema>;

// C0/C1 controls + bidi embedding/override/isolate chars (log/display spoofing).
const STRIP = /[\u0000-\u001F\u007F-\u009F‪-‮⁦-⁩]/g;

export function cleanNote(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(STRIP, '').trim().slice(0, 200);
  return s ? s : null;
}

export function personalisationLabel(c: PersonalisationConfig, lang: 'ar' | 'en'): string {
  return lang === 'ar' ? c.labelAr || c.label : c.label || c.labelAr;
}
```

Run → PASS.

- [ ] **Step 3: Migration (rebuild the two partial unique indexes to include the note)**

```sql
-- 20261016000500_personalisation/migration.sql
ALTER TABLE "products" ADD COLUMN "personalisation" JSONB;
ALTER TABLE "cart_items" ADD COLUMN "note" TEXT;
ALTER TABLE "order_items" ADD COLUMN "personalisation" TEXT;

-- A personalised line is its own line: "Sara" and "Omar" on the same abaya are two
-- lines. Same text merges. COALESCE keeps the null-note case enforcing (see
-- 20260622000000_cart_item_null_variant_unique for why NULLs need care).
DROP INDEX IF EXISTS "cart_items_cart_id_product_id_no_variant";
DROP INDEX IF EXISTS "cart_items_cart_id_product_id_variant_id_with_variant";
CREATE UNIQUE INDEX "cart_items_line_no_variant"
  ON "cart_items" ("cart_id", "product_id", (COALESCE("note", '')))
  WHERE "variant_id" IS NULL;
CREATE UNIQUE INDEX "cart_items_line_with_variant"
  ON "cart_items" ("cart_id", "product_id", "variant_id", (COALESCE("note", '')))
  WHERE "variant_id" IS NOT NULL;
```

Update the comment block above `CartItem` in `schema.prisma` to name the new index names and this migration.

- [ ] **Step 4: Failing integration test**

```ts
// tests/integration/cart-personalisation.test.ts
// Use cartSessionId() from tests/helpers/bundle-fixtures.ts (retry-safe, per CLAUDE.md).
it('personalised lines stay separate', async () => {
  const sid = cartSessionId();
  await addToCart(sid, { productId, quantity: 1, note: 'Sara' });
  await addToCart(sid, { productId, quantity: 1, note: 'Omar' });
  await addToCart(sid, { productId, quantity: 2, note: 'Sara' });
  const cart = await getCart(sid);
  const lines = cart.items.filter(i => i.productId === productId);
  expect(lines.map(l => [l.note, l.quantity]).sort()).toEqual([
    ['Omar', 1],
    ['Sara', 3],
  ]);
});
it('required personalisation is enforced server-side', async () => {
  // product2.personalisation = { enabled: true, required: true, maxLength: 10, label: 'Name', labelAr: 'الاسم' }
  const r = await addToCartRaw(cartSessionId(), { productId: product2Id, quantity: 1 });
  expect(r.status).toBe(400);
  const long = await addToCartRaw(cartSessionId(), {
    productId: product2Id,
    quantity: 1,
    note: 'x'.repeat(11),
  });
  expect(long.status).toBe(400);
});
it('note and variantName land on the order line', async () => {
  // add a variant line with note 'Sara', place a COD order through /public/orders
  const order = await placeCodOrder(sid);
  const line = order.items.find(i => i.variantId === variantId);
  expect(line.personalisation).toBe('Sara');
  expect(line.variantName).toBe(variantTitle);
});
it('a note on a product without personalisation is dropped', async () => {
  /* note ignored → null on the line */
});
```

Copy the add-to-cart / place-order helpers from an existing cart or order integration test. Run → FAIL.

- [ ] **Step 5: API implementation**

- **`cart.routes.ts`:** `note: z.string().max(400).optional()` on `addToCartSchema` and the bulk item schema. The 400 allowance comes before cleaning; `cleanNote` caps at 200.
- **`CartService.addItem(…, note?)`:**
  - `const n = cleanNote(note)`.
  - Read `product.personalisation` (add it to the product select there) and parse it with `personalisationConfigSchema.safeParse`.
  - If it is not enabled, then `n = null`.
  - If it is enabled and `n` is longer than `maxLength`, throw a 400 `PERSONALISATION_TOO_LONG`.
  - If it is enabled, required and `!n`, throw a 400 `PERSONALISATION_REQUIRED`.
  - The `existingItem` lookup gets `note: n` in its `where`, and the create gets `note: n`.
  - Apply the same in `addItems`.
- **`OrderService.create` items map (~1547):** add the following.

```ts
personalisation: (item as { note?: string | null }).note ?? null,
variantName: item.variant
  ? (data.locale === 'ar' && item.variant.titleAr) || item.variant.title
  : null,
```

Make sure the cart read includes `variant: { select: { title: true, titleAr: true, … } }`. Check `CartService.getOrCreate`'s include and add the titles if they are missing.

- **Admin order `getById`:** OrderItem scalars already flow through. Add `personalisation` to the admin `OrderItemDetail` type.
- **Invoice + order email:** render `personalisation` under the product name as `✎ {text}`, HTML-escaped with the escaper those renderers already use.

Run the integration test → PASS.

- [ ] **Step 6: Web cart identity**

In `CartContext.tsx`:

- Add `note?: string` to `CartItem`.
- Replace both `i.productId === productId && i.variantId === item.variantId` comparisons with `sameLine(i, item)`. Export `sameLine` from `cart-lines.ts` and unit-test it in that file's existing test.
- `addItem` passes `item.note` to `api.addToCart(productId, quantity, variantId, note)`.
- `mapServerItem` maps `note`.
- `toSyncPayload` carries `note`.

Update `api.ts` `addToCart` / `syncCart` signatures.

- [ ] **Step 7: Storefront + admin UI**

- **`PersonalisationField.tsx`:**
  - The label comes from `personalisationLabel`.
  - The input has `maxLength={cfg.maxLength}` and a live counter `٣/٢٠`.
  - `required` shows an asterisk, and the ATC stays disabled with an inline message `اكتب {label} الأول` until it is filled.
  - It renders only when `cfg?.enabled`.
- **Both PDP paths:** render it above the ATC and pass `note` into `addItem`.
- **Cart page, Dahab drawer, checkout `OrderSummary` and the success page rows:** show `✎ {note}` under the variant title.
- **Admin `PersonalisationCard.tsx`** (on product edit, after facts):
  - toggle "اسمح للعميل يكتب تخصيص / Allow personalisation"
  - label EN/AR, with presets "الاسم للتطريز", "الحروف للحفر" and "ملاحظة"
  - max length (default 20)
  - required checkbox
- **Admin `ItemsCard.tsx`:** show `personalisation` in a highlighted row under the item name, with a copy button for the workshop.

- [ ] **Step 8: Typecheck, unit + integration, commit**

```bash
git commit -m "feat(commerce): per-item personalisation from pdp to admin, invoice and email; snapshot variant name on storefront orders"
```

---

### Task 6: Sticky mobile add-to-cart (PDP) + sticky cart total (cart page)

**Files:**

- Create: `apps/web/src/components/commerce/StickyAddToCart.tsx`, `StickyCartTotal.tsx`, `useInView.ts`
- Modify: both PDP paths, `app/cart/CartClient.tsx`
- Test: `apps/web/src/components/commerce/StickyAddToCart.test.tsx`

**Interfaces:**

- Produces: `<StickyAddToCart anchorRef={RefObject<HTMLElement>} title price disabled onAdd label />`. It shows only below `md` and only while the anchor (the main ATC button) is out of view. It sets `document.body.dataset.stickyAtc = '1'` while visible (removed on hide or unmount). The global CSS reserves the bottom padding off that flag (UI rule 6).
- Produces: `<StickyCartTotal total itemCount href="/checkout" disabled />`. It shows below `md` on the cart page when the cart has ≥1 item. It sets `body.dataset.stickyCart = '1'`.

- [ ] **Step 1: Failing test**

```tsx
it('appears only when the main button scrolls out of view', () => {
  // mock IntersectionObserver: capture the callback
  render(<Harness />); // a page with a ref'd button + <StickyAddToCart anchorRef={ref} .../>
  expect(screen.queryByTestId('sticky-atc')).toBeNull();
  act(() => ioCallback([{ isIntersecting: false }]));
  expect(screen.getByTestId('sticky-atc')).toBeInTheDocument();
  expect(document.body.dataset.stickyAtc).toBe('1');
  act(() => ioCallback([{ isIntersecting: true }]));
  expect(screen.queryByTestId('sticky-atc')).toBeNull();
  expect(document.body.dataset.stickyAtc).toBeUndefined();
});
it('calls onAdd and respects disabled', async () => {
  /* click → onAdd once; disabled → not called */
});
```

- [ ] **Step 2: Implement**

```ts
// apps/web/src/components/commerce/useInView.ts
'use client';
import { useEffect, useState, type RefObject } from 'react';
export function useInView(ref: RefObject<Element | null>): boolean {
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return inView;
}
```

```tsx
// apps/web/src/components/commerce/StickyAddToCart.tsx
'use client';
import { useEffect, type RefObject } from 'react';
import { useInView } from './useInView';

export function StickyAddToCart(p: {
  anchorRef: RefObject<HTMLElement | null>;
  title: string;
  price: string;
  label: string;
  disabled?: boolean;
  onAdd: () => void;
}) {
  const show = !useInView(p.anchorRef);
  useEffect(() => {
    if (show) document.body.dataset.stickyAtc = '1';
    else delete document.body.dataset.stickyAtc;
    return () => {
      delete document.body.dataset.stickyAtc;
    };
  }, [show]);
  if (!show) return null;
  return (
    <div
      data-testid="sticky-atc"
      className="fixed inset-x-0 bottom-[var(--bottom-tabbar-h,0px)] z-40 border-t border-border bg-background/95 px-4 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] backdrop-blur md:hidden motion-safe:animate-in motion-safe:slide-in-from-bottom-4"
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-muted-foreground">{p.title}</p>
          <p className="text-sm font-semibold tabular-nums">{p.price}</p>
        </div>
        <button
          type="button"
          disabled={p.disabled}
          onClick={p.onAdd}
          className="h-11 rounded-[var(--radius)] bg-primary px-5 text-sm font-semibold text-primary-foreground disabled:opacity-50"
        >
          {p.label}
        </button>
      </div>
    </div>
  );
}
```

Before writing `bottom-[var(--bottom-tabbar-h,0px)]`, grep `BottomTabBar` for how other fixed-bottom UI lifts above it, and reuse that exact mechanism. The variable name here is a placeholder for whatever the codebase uses. If `animate-in` is not available (tailwindcss-animate), use the existing motion utility in `globals.css` instead.

In `apps/web/src/styles/globals.css`, add:

```css
@media (max-width: 767px) {
  body[data-sticky-atc='1'],
  body[data-sticky-cart='1'] {
    padding-bottom: calc(4.25rem + env(safe-area-inset-bottom));
  }
}
```

`StickyCartTotal` has the same shape: it shows the total and item count, with a "إتمام الطلب / Checkout" link, and no IntersectionObserver (it is always on the mobile cart page when items > 0). It is disabled with the minimum-order message when `minimumOrderFils` is unmet, reusing the cart page's existing check.

- [ ] **Step 3: Wire**

On both PDP paths, attach a ref to the main ATC button and render `StickyAddToCart` with the same disabled rule and the same handler as the main button (`handleAddToCart`). There must not be a second add path. Wire `CartClient.tsx` too.

- [ ] **Step 4: Tests, typecheck, commit**

```bash
git commit -m "feat(storefront): sticky mobile add-to-cart on pdp and sticky cart total"
```

---

### Task 7: Video setting kind + video upload

**Files:**

- Modify: `apps/api/src/routes/upload.routes.ts` (new `POST /uploads/video`), `apps/api/src/services/storage.service.ts` (folder set)
- Modify: `packages/shared/src/builder/settings-schema.ts` (new `'video'` kind + `s.video()`)
- Create: `apps/admin/src/app/stores/[id]/builder/_components/VideoField.tsx`; modify `SettingsPanel.tsx`
- Modify: `apps/web/next.config.js` CSP (`media-src` must allow the R2 public host the images use)
- Test: `tests/integration/upload-video.test.ts`, `tests/unit/builder-video-setting.test.ts`

**Interfaces:**

- Produces: `POST /uploads/video?folder=hero|builder`.
  - Requires `products:write`, same as the image routes.
  - Accepts `video/mp4` and `video/webm` only, ≤ 6 MB.
  - Returns `{ success: true, data: { url } }`, the same shape as `/uploads/image`.
- Produces: the setting kind `'video'` and `s.video(id, labelEn, labelAr, extra?)`.

**Ruling B0-2:** 6 MB cap. Research suggested 3 MB, but a 6–8 s 720p loop at a usable bitrate needs about 4–6 MB, and R2 egress is free. The poster image is the LCP element, never the video. Cost if wrong: one heavier optional download per hero view on slow networks. Save-Data and reduced motion already skip it (Task 8).

- [ ] **Step 1: Failing integration test**

```ts
it('accepts a small mp4 and returns an r2 url', async () => {
  const r = await uploadVideo(
    token,
    storeId,
    Buffer.from(MP4_HEADER_BYTES),
    'clip.mp4',
    'video/mp4',
    'hero'
  );
  expect(r.status).toBe(200);
  expect(r.body.data.url).toMatch(/\.mp4$/);
});
it('rejects >6MB with 413 and a non-video mime with 400', async () => {
  /* ... */
});
it('rejects a folder outside hero|builder', async () => {
  /* folder=logos → 400 */
});
```

Copy the multipart helper from the existing image-upload integration test (grep `uploads/image` under `tests/`). Sniff the magic bytes, not just the mime header: MP4 has `ftyp` at offset 4, and WebM starts `1A 45 DF A3`. Reuse the image route's sniffing approach if it has one.

- [ ] **Step 2: Implement the route**

Use a separate multer instance with `limits: { fileSize: 6 * 1024 * 1024, files: 1 }` and a `fileFilter` for the two mimes, plus magic-byte verification. Folder allowlist for this route: `hero`, `builder`. Reuse `resolveFolderAndStore` for the store ownership check, and reuse `StorageService` for the put, with `Content-Type` set and `Cache-Control: public, max-age=31536000, immutable`. Rate-limit it like the image route.

- [ ] **Step 3: Setting kind + admin field**

Add `'video'` to the kind union and an `s.video` helper mirroring `s.image`.

`VideoField.tsx` behaves like this:

- It uploads to `/uploads/video`.
- It shows a muted `<video>` preview with a size readout.
- It rejects files over 6 MB client-side with the Arabic message `الفيديو أكبر من ٦ ميجا`.
- It has a "remove" action.

`SettingsPanel.tsx` gets a `case 'video':` that mirrors `case 'image'` (localized support included).

- [ ] **Step 4: CSP**

Add the R2 public host to `media-src` in `next.config.js` (copy the host the `img-src` list already allows). Verify with `grep -n "media-src" apps/web/next.config.js`.

- [ ] **Step 5: Tests, typecheck, commit**

```bash
git commit -m "feat(builder): video upload endpoint and video setting kind"
```

---

### Task 8: Hero video

**Files:**

- Modify: `packages/shared/src/builder/layout-schema.ts` (`heroSlideSchema` gets `video`, `videoMobile`), `registry.ts` (`HERO_SLIDE_BLOCK` settings)
- Create: `apps/web/src/components/commerce/HeroVideo.tsx`
- Modify: `apps/web/src/templates/shared/HeroSlider.tsx`, `templates/shared/HeroBannerLink.tsx`, `templates/dahab/Hero.tsx`, plus any other hero slide renderer (`grep -rln "imageMobile" apps/web/src/templates apps/web/src/builder`)
- Test: `tests/unit/hero-slide-schema.test.ts` (extend), `apps/web/src/components/commerce/HeroVideo.test.tsx`

**Interfaces:**

- Consumes: `s.video` from Task 7.
- Produces: `<HeroVideo src srcMobile poster posterMobile alt className />`.
  - It always renders the poster `<img>` (or the existing next/image the slide used) as the base layer.
  - It overlays `<video muted loop playsInline autoPlay preload="metadata" poster>` ONLY when all three hold:
    - `!matchMedia('(prefers-reduced-motion: reduce)').matches`
    - `!navigator.connection?.saveData`
    - the video has not errored
  - On a `onError` it removes the video. The box size is the poster's, so there is no layout shift.

- [ ] **Step 1: Failing tests**

```tsx
it('video falls back to poster under reduced motion', () => {
  mockMatchMedia({ '(prefers-reduced-motion: reduce)': true });
  render(<HeroVideo src="https://x.r2.dev/a.mp4" poster="https://x.r2.dev/a.webp" alt="" />);
  expect(document.querySelector('video')).toBeNull();
  expect(screen.getByRole('img')).toBeInTheDocument();
});
it('video falls back to poster on error', () => {
  render(<HeroVideo src="https://x.r2.dev/missing.mp4" poster="https://x.r2.dev/a.webp" alt="" />);
  fireEvent.error(document.querySelector('video')!);
  expect(document.querySelector('video')).toBeNull();
});
it('respects Save-Data', () => {
  /* navigator.connection = { saveData: true } → no video */
});
```

Extend `hero-slide-schema.test.ts`:

- a slide with `video: 'https://…/a.mp4'` round-trips unchanged;
- a slide with `video: 'javascript:alert(1)'` is rejected (only `https:` / relative upload URLs are allowed; reuse the URL guard the schema applies to `link`).

- [ ] **Step 2: Implement**

- **Schema:** `video: safeMediaUrl.optional()` and `videoMobile: safeMediaUrl.optional()`, where `safeMediaUrl` reuses the existing scheme allowlist helper.
- **Registry:** `s.video('video', 'Background video (optional)', 'فيديو الخلفية (اختياري)', { localized: false })` and `s.video('videoMobile', 'Mobile video', 'فيديو الجوال')`, placed right after the two image settings. The image stays required for publish because it is the poster (`validatePublishReadiness` is unchanged).
- **`HeroVideo.tsx`:** the client component as specified above. Use `useSyncExternalStore` or a `useEffect` to read the media query, so SSR renders the poster only. The video mounts after hydration, which keeps the LCP on the image.
- **Renderers:** where a slide has `video`, wrap the existing image element with `HeroVideo`. On mobile, use `videoMobile ?? video` via `<source media="(max-width: 767px)">`.

- [ ] **Step 3: Tests, typecheck, commit**

```bash
git commit -m "feat(builder): hero slides take an optional looping video with poster fallback"
```

---

### Task 9: Size charts

**Files:**

- Create: `packages/database/prisma/migrations/20261016000900_size_charts/migration.sql`
- Modify: `schema.prisma` (new `SizeChart`; `Product.sizeChartId`, `Category.sizeChartId`; `Store.sizeCharts` relation)
- Create: `packages/shared/src/commerce/size-chart.ts`
- Create: `apps/api/src/routes/size-chart.routes.ts`, `apps/api/src/services/size-chart.service.ts`; mount next to the category routes (grep where `category.routes` is mounted)
- Modify: `product.routes.ts` (`sizeChartId: z.string().uuid().nullable().optional()`), the category update schema, and the public PDP payload (resolved chart)
- Create: `apps/admin/src/app/stores/[id]/size-charts/page.tsx` (+ `_components/SizeChartEditor.tsx`); add a sidebar entry under the Products group; add a picker to product edit (in FulfilmentCard) and to category edit
- Create: `apps/web/src/components/commerce/SizeChartDialog.tsx`, `apps/web/src/app/size-guide/page.tsx`; modify both PDP paths
- Test: `tests/unit/commerce-size-chart.test.ts`, `tests/integration/size-charts.test.ts`

**Interfaces:**

- Produces: table `size_charts`, with columns `id`, `store_id`, `name`, `name_ar`, `unit ('cm'|'in')`, `columns JSONB`, `rows JSONB`, `note`, `note_ar`, `created_at` and `updated_at`.
- Produces: `products.size_chart_id` and `categories.size_chart_id`, both FK `ON DELETE SET NULL`.
- Produces (`@ebda/shared`):
  - `sizeChartSchema = { name, nameAr, unit, columns: Array<{ label, labelAr }> (2..10), rows: string[][] (1..30, each row length === columns.length, cell ≤ 24), note, noteAr }`
  - `type SizeChart`
- Produces (API):
  - `GET/POST /stores/:storeId/size-charts`, `GET/PUT/DELETE /stores/:storeId/size-charts/:id` (`authenticate → authorize('store_admin','super_admin') → requireStoreAccess`).
  - Public PDP payload gets `sizeChart: SizeChart | null` = `product.sizeChart ?? product.category?.sizeChart ?? null`.
  - `GET /public/size-charts` lists the store's charts for `/size-guide`.

- [ ] **Step 1: Failing unit test**

```ts
import { sizeChartSchema } from '@ebda/shared';
const base = {
  name: 'Abaya',
  nameAr: 'عباية',
  unit: 'cm',
  columns: [
    { label: 'Size', labelAr: 'المقاس' },
    { label: 'Length', labelAr: 'الطول' },
  ],
  rows: [
    ['S', '52'],
    ['M', '54'],
  ],
  note: '',
  noteAr: '',
};
it('accepts a rectangular chart', () => expect(sizeChartSchema.safeParse(base).success).toBe(true));
it('rejects ragged rows', () =>
  expect(sizeChartSchema.safeParse({ ...base, rows: [['S']] }).success).toBe(false));
it('needs a name in one language', () =>
  expect(sizeChartSchema.safeParse({ ...base, name: '', nameAr: '' }).success).toBe(false));
it('caps rows at 30', () =>
  expect(
    sizeChartSchema.safeParse({ ...base, rows: Array.from({ length: 31 }, () => ['S', '1']) })
      .success
  ).toBe(false));
```

- [ ] **Step 2: Implement the schema**

```ts
// packages/shared/src/commerce/size-chart.ts
import { z } from 'zod';
const cell = z.string().trim().max(24);
export const sizeChartSchema = z
  .object({
    name: z.string().trim().max(60).default(''),
    nameAr: z.string().trim().max(60).default(''),
    unit: z.enum(['cm', 'in']).default('cm'),
    columns: z
      .array(z.object({ label: cell.default(''), labelAr: cell.default('') }))
      .min(2)
      .max(10),
    rows: z.array(z.array(cell)).min(1).max(30),
    note: z.string().trim().max(300).default(''),
    noteAr: z.string().trim().max(300).default(''),
  })
  .refine(c => c.name || c.nameAr, { message: 'Name needed' })
  .refine(c => c.rows.every(r => r.length === c.columns.length), {
    message: 'Every row needs one cell per column',
  });
export type SizeChart = z.infer<typeof sizeChartSchema>;
```

- [ ] **Step 3: Migration**

```sql
-- 20261016000900_size_charts/migration.sql
CREATE TABLE "size_charts" (
  "id" TEXT PRIMARY KEY,
  "store_id" TEXT NOT NULL REFERENCES "stores"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL DEFAULT '',
  "name_ar" TEXT NOT NULL DEFAULT '',
  "unit" TEXT NOT NULL DEFAULT 'cm' CHECK ("unit" IN ('cm','in')),
  "columns" JSONB NOT NULL,
  "rows" JSONB NOT NULL,
  "note" TEXT NOT NULL DEFAULT '',
  "note_ar" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "size_charts_store_id_idx" ON "size_charts"("store_id");

ALTER TABLE "products" ADD COLUMN "size_chart_id" TEXT REFERENCES "size_charts"("id") ON DELETE SET NULL;
ALTER TABLE "categories" ADD COLUMN "size_chart_id" TEXT REFERENCES "size_charts"("id") ON DELETE SET NULL;
CREATE INDEX "products_size_chart_id_idx" ON "products"("size_chart_id");
CREATE INDEX "categories_size_chart_id_idx" ON "categories"("size_chart_id");

ALTER TABLE size_charts ENABLE ROW LEVEL SECURITY;
ALTER TABLE size_charts FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON size_charts AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
GRANT SELECT, INSERT, UPDATE, DELETE ON size_charts TO ebda_app;
```

Check `20261008000020_product_3d_models/migration.sql` for the exact `GRANT` line and the id/timestamp types used there, and match them. Add the Prisma model with `@@map("size_charts")` and `storeId`, so the tenant guard covers it automatically.

FK sweep (global rule): `grep -rn "product.delete\|category.delete\|store.delete" apps/api/src`. With `SET NULL`, nothing else needs changing. Confirm that no handler hard-deletes in an order that trips the FK, and note the result in the task report.

- [ ] **Step 4: Failing integration test**

```ts
it('crud + tenant isolation', async () => {
  const c = await post(`/stores/${storeA}/size-charts`, base);
  expect(c.status).toBe(201);
  expect((await get(`/stores/${storeB}/size-charts/${c.body.data.id}`, tokenB)).status).toBe(404);
});
it('pdp resolves product chart, else category chart', async () => {
  /* … */
});
it('deleting a chart nulls references', async () => {
  // product.sizeChartId = chart; delete chart → 200; product.sizeChartId null; PDP payload sizeChart null
});
```

- [ ] **Step 5: Service + routes**

Write CRUD with `storeId` in every `where`. Validate with `sizeChartSchema`. Bust the product caches of products and categories that reference the chart on update and delete (reuse the product cache bust).

In the public PDP query, add:

- `sizeChart: { select: {…} }`
- `category: { select: { sizeChart: { select: {…} } } }`

Then flatten the two into `sizeChart`. Run the integration test → PASS.

- [ ] **Step 6: Admin**

- **`/stores/[id]/size-charts`:**
  - Lists the charts.
  - The editor is a grid where columns can be added or removed, and each header has AR and EN inputs.
  - Rows can be added or removed; cells are inputs.
  - Templates offered: "عباية (مقاس × طول)", "ملابس (S–XXL)", "مقاس الخاتم".
  - The unit is toggled with a toggle.
  - It shows a preview of the PDP dialog.
- **Product edit:** a "دليل المقاسات" select inside FulfilmentCard, with "من القسم" (inherit, null) as the default.
- **Category edit:** the same select.
- **Sidebar:** an entry "دليل المقاسات / Size charts" under the Products group.

- [ ] **Step 7: Storefront**

- **`SizeChartDialog.tsx`:**
  - A text button "دليل المقاسات / Size guide" with a ruler icon, placed next to the option label of the option named like size (`/size|مقاس/i`). If there is no such option, place it under the selector.
  - It opens the native `<dialog>`.
  - The table uses the localized headers (with cross-language fallback) and the unit in the caption.
  - The first column is sticky and the table scrolls horizontally inside the dialog.
  - It closes on Esc and backdrop click.
  - It renders nothing when `sizeChart` is null.
- **`/size-guide` page:** lists every chart for the store, so a merchant can add it to the nav through the existing navigation editor. The page returns a 404 (`notFound()`) when the store has no charts.
- Wire both PDP paths.

- [ ] **Step 8: Tests, typecheck, commit**

```bash
git commit -m "feat(commerce): size charts per product or category with pdp dialog and size guide page"
```

---

### Task 10: Receipt-printer order confirmation (every template)

**Reference** (Ahmad, 2026-10-14, Instagram reel `DecOpDXt1Fs`, 00:11–00:16). These are the frame notes; the reel's code is not copied.

1. **Printer card.** A dark rounded card shows the order line (name + sub-line) and the total. Under them, a status row has a spinner and reads "Printing your receipt".
2. **Feed.** Under the card is a slot (a darker lip). A white thermal-paper receipt feeds **down** out of the slot over about 1.6 s. Its torn zig-zag bottom edge leads, followed by the barcode, the order/payment/date block, the totals, the line items, and finally the logo at the top. The receipt is clipped at the slot, so it looks like it comes out of the machine.
3. **Done.** When the feed ends, the spinner becomes a green check and the status reads "Order complete".
4. **Receipt typography.** Monospace small caps for labels, dashed separators between blocks, a bold total row, and a barcode with the order number under it.

**Files:**

- Create: `apps/web/src/components/commerce/ReceiptPrinter.tsx`, `ReceiptPrinter.module.css`, `Barcode.tsx`
- Modify: `apps/web/src/app/checkout/success/SuccessClient.tsx` (replace the order-summary card at ~258-…, keep everything else: Instapay, Fawry and the WhatsApp COD button stay above)
- Modify: `apps/web/src/contexts/LanguageContext.tsx` (strings)
- Test: `apps/web/src/components/commerce/ReceiptPrinter.test.tsx`

**Interfaces:**

- Consumes: `order` (the existing `Order` type: `orderNumber`, `items`, `subtotal`, `shippingCost`, `discount`, `total`, `createdAt`, `paymentMethod`), the existing `paymentState: 'cod' | 'awaiting' | 'verifying' | 'paid' | 'failed'`, `groupOrderLinesForDisplay`, `formatPrice`, `formatDate`, the store logo and name.
- Produces: `<ReceiptPrinter order paymentState store />`.

Status-line copy per state. It is never "paid" unless the state is `paid`:

| State     | Icon        | Arabic                         | English                        |
| --------- | ----------- | ------------------------------ | ------------------------------ |
| verifying | spinner     | بنطبع فاتورتك…                 | Printing your receipt…         |
| paid      | green ✓     | تم الدفع، طلبك اتأكد           | Paid, order confirmed          |
| cod       | green ✓     | طلبك اتسجل، الدفع عند الاستلام | Order placed, pay on delivery  |
| awaiting  | amber clock | طلبك اتسجل، في انتظار الدفع    | Order placed, awaiting payment |
| failed    | red !       | الدفع ما تمش                   | Payment failed                 |

The receipt total label reads "الإجمالي / Total" in every state except `paid`, where it reads "المدفوع / Total paid".

**Theming** (works in all 6 skins plus every look, through tokens only):

- The printer card is `hsl(var(--foreground))` with text in `hsl(var(--background))`.
- The paper is `#FFFFFF` with ink `#141414` in every theme, because a receipt is paper.
- The radius is `var(--radius)`.
- Mono font stack: `ui-monospace, "IBM Plex Mono", Menlo, monospace` for Latin and digits. Arabic labels keep the body font, since there is no good Arabic mono.
- Every number is `tabular-nums`.
- RTL: labels on the start side, amounts on the end side (logical properties).

**Motion:**

- The receipt wrapper is `overflow: hidden` under the slot.
- The paper animates `transform: translateY(-100%) → translateY(0)` over `1600ms`, `cubic-bezier(0.22, 1, 0.36, 1)` (ease-out-quint), starting `250ms` after the order data is loaded.
- The zig-zag edge is `mask-image` / `clip-path` with a repeating 8px triangle edge on the bottom.
- When the feed ends (`animationend`) the status swaps from the spinner to the final icon, with a 150ms crossfade.
- If `paymentState` is still `verifying` when the feed ends, the spinner stays until the state changes.
- `prefers-reduced-motion: reduce`: no translate; the paper is shown in place and the final icon shows immediately.
- The animation runs once per order: `sessionStorage['receipt-printed:'+orderId]` (try/catch) skips it on a reload.

- [ ] **Step 1: Failing tests**

```tsx
it('cod receipt never says paid', () => {
  render(<ReceiptPrinter order={order} paymentState="cod" store={store} />, { wrapper: Ar });
  expect(screen.queryByText(/تم الدفع|المدفوع|paid/i)).toBeNull();
  expect(screen.getByText(/الدفع عند الاستلام/)).toBeInTheDocument();
  expect(screen.getByText('الإجمالي')).toBeInTheDocument();
});
it('paid receipt says total paid', () => {
  render(<ReceiptPrinter order={order} paymentState="paid" store={store} />, { wrapper: Ar });
  expect(screen.getByText('المدفوع')).toBeInTheDocument();
});
it('renders every line, bundle as one row, and the order number under the barcode', () => {
  render(<ReceiptPrinter order={orderWithBundle} paymentState="paid" store={store} />);
  expect(screen.getAllByTestId('receipt-line')).toHaveLength(
    groupOrderLinesForDisplay(orderWithBundle.items).length
  );
  expect(screen.getByTestId('receipt-barcode-caption')).toHaveTextContent(
    orderWithBundle.orderNumber
  );
});
it('shows personalisation under its line', () => {
  /* item.personalisation 'Sara' → '✎ Sara' */
});
it('reduced motion shows final state immediately', () => {
  mockMatchMedia({ '(prefers-reduced-motion: reduce)': true });
  render(<ReceiptPrinter order={order} paymentState="paid" store={store} />);
  expect(screen.getByTestId('receipt-paper').className).not.toMatch(/feeding/);
  expect(screen.getByTestId('receipt-status-icon')).toHaveAttribute('data-state', 'paid');
});
```

- [ ] **Step 2: Barcode**

`Barcode.tsx` is a deterministic decorative SVG built from the order number: Code-128-looking bars from a simple hash of each char into bar widths 1–3, with `aria-hidden="true"`. The caption under it is the real `#orderNumber` text (that is what is accessible and copyable). It is not a scannable barcode, and the code comment says so. **Ruling B0-3**: a scannable barcode would need a dependency and adds nothing until the orders app scans receipts. Cost if wrong: a later swap to a real Code-128 encoder in one component.

- [ ] **Step 3: Implement `ReceiptPrinter`**

The receipt contents run top to bottom:

1. Store logo, or the store name in the display font.
2. A dashed rule.
3. Line rows: qty × name, the variant, and `✎ personalisation` muted, with the amount at the end.
4. A dashed rule.
5. Subtotal, shipping, discount (when it is not 0), and the total row in bold and larger.
6. A dashed rule.
7. Order no., payment method (localized: كاش عند الاستلام / إنستاباي / فوري / كارت), and date (`formatDate` with the store timezone and numerals).
8. Barcode with its caption.
9. The zig-zag edge.

Use CSS modules for the keyframes (`@keyframes feed`) and the zig-zag mask. Everything else is Tailwind.

- [ ] **Step 4: Wire into `SuccessClient.tsx`**

Replace the existing order-summary card block (the `<div className="mt-8 rounded-xl border bg-card p-6 …">` and its children) with `<ReceiptPrinter order={order} paymentState={paymentState} store={store} />`. While `order` is null, render the printer card with the spinner and an empty slot, so the layout does not jump. Keep the Instapay / Fawry / COD components and the "continue shopping" link where they are.

Check whether the Dahab skin swaps the success page: `grep -rn "checkout/success\|SuccessClient" apps/web/src/templates`. If it does, wire the receipt there too.

- [ ] **Step 5: Visual check**

Run `npm run dev:web` against a local seeded store and place a COD order. Watch the feed in Arabic and English, under `?look=` on a demo-flagged store for 2 looks if one is seeded, and with OS reduced motion on. Save screenshots to the scratchpad and attach them to the task report. Report what was and was not visually verified.

- [ ] **Step 6: Tests, typecheck, commit**

```bash
git commit -m "feat(storefront): receipt-printer order confirmation for every template"
```

---

### Task 11: E2E, docs, blast radius

**Files:**

- Create: `tests/smoke/commerce-b0.spec.ts` (Playwright, same config as `tests/smoke`)
- Create: `docs/ebda/templates/platform-commerce.md`
- Modify: `docs/ebda/templates/research/SUMMARY.md` (Status column: rows 1–5, 7, 8 → HAVE, with this plan's link), `docs/architecture/store-theme-flags.md` (card elements: swatch dots + fact chips render from data on all card paths), `docs/ENVIRONMENT.md` only if an env var was added (none expected; state "no env change")

- [ ] **Step 1: Playwright flow** (local seeded store, API + web dev servers per `tests/smoke` README)

1. Open the PDP of a product that has a Colour option (swatches), Size × Length, 3 facts, personalisation required, `leadTimeDays` 5, a size chart, and one sold-out combo.
2. Assert the swatch buttons, struck combo, facts table, delivery chip text (`يوصلك`), and the size guide dialog opening with ≥2 rows.
3. Try to add without personalisation, and assert the button is disabled and the message is shown.
4. Type `Sara` and add. Set the viewport to 390×844, scroll past the ATC, assert the sticky bar is shown, and add again with `Omar` through the sticky bar.
5. Open the cart, and assert two lines with `✎ Sara` / `✎ Omar` and the sticky total bar.
6. Check out with COD.
7. On the success page, assert that the receipt shows both notes, says `الدفع عند الاستلام`, and does not contain `المدفوع`.
8. Open the admin order and assert both personalisation rows and the `variantName` values.

Run: `npx playwright test tests/smoke/commerce-b0.spec.ts` → PASS.

- [ ] **Step 2: Docs**

`platform-commerce.md` holds one section per feature: what it is, where the merchant edits it, where it renders (every path), data shape, limits, and rulings B0-1..3. Add rulings B0-1..3 to `docs/RULINGS.md` in the house format: `Ruling <id> — decision. evidence. Cost if wrong: …`.

- [ ] **Step 3: Blast-radius sweep**

Grep every new identifier across `apps packages tests docs scripts .github`:

`swatchHex|swatchImageUrl|swatch_hex|facts|leadTimeDays|lead_time_days|personalisation|cart_items_line_|sizeChart|size_chart|/uploads/video|ReceiptPrinter|stickyAtc|stickyCart`

- Confirm every consumer is updated: admin type files, the web `api.ts` types, the export/import of products (grep `bulk` export columns. If product export lists columns, add `facts`/`leadTimeDays` or record a ruling for why not), the MCP tools that read or write products (grep `apps/api/src/mcp` for product schemas), and `scripts/rls-payload-parity.mjs` coverage of the new public fields.
- Write the result into the PR body as `blast-radius: swept <ids> across <scopes> → …`.

- [ ] **Step 3b: Whole-flow taste pass + make taste a standing rule**

- Walk the full E2E flow (PDP → cart → checkout → receipt) on a 390px phone in Arabic and in English, on `minimal` and on `dahab`. Run the `impeccable` skill's `critique` on the flow as one experience, not per screen. Fix P0/P1 and rule on any P2.
- Add pillar 5 to the "Strategic positioning" list in `CLAUDE.md`:

  > 5. **Taste** — when anyone can build a store, the difference is what we leave out and how it feels when it opens. Every UI change passes the taste bar in `docs/plans/done/2026-10-14-phase-b0-platform-commerce.md` (§ Taste bar): hard leave-out limits, motion only where it means something, Arabic-first screenshots, an impeccable critique before commit.

  Also add `taste-bar` to the anti-patterns line: "features that add chrome without adding meaning".

- [ ] **Step 4: Full gates**

Run: `npm run typecheck && npm run lint && npm run test:unit` → all exit 0 (capture `$?` per command, not through a pipe). Run `npm run test:integration` against the local Postgres. Record the counts in the report.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md tests/smoke/commerce-b0.spec.ts docs/ebda/templates/platform-commerce.md docs/ebda/templates/research docs/architecture/store-theme-flags.md docs/RULINGS.md docs/plans/done/2026-10-14-phase-b0-platform-commerce.md
git commit -m "docs(commerce): b0 platform features doc, rulings, research status and e2e"
```

---

## After B0 (not in this plan)

**Ship:**

- Open a PR.
- CI must be green.
- Ahmad approves the merge.
- Run `gh workflow run cf-api-deploy.yml`, which runs the 5 migrations.
- Verify against production: `/health` commit = main; a read-only SQL check that the new columns and table exist; RLS forced on `size_charts`.
- Prod has 0 merchants using any of this yet. Say so in the deploy report.

**Then plan B1 — Qamar:**

- the `qamar` skin and enum value;
- Atelier / Lookbook / Vitrine built on these features;
- a demo catalogue with in-palette photos;
- the looks flipped to `built`;
- `storedemo.ebda.app` seeded in production (Ahmad approves the `--yes-production` run);
- the MKT-15 marketing section linking to it.
