# Brand Engine — Phase 2: per-template branded baseline (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship per-template, fully-tokenized layout baselines so any store/demo with an empty `layoutSettings` renders polished and on-brand in its template's own identity — colors driven by the Phase-1 engine, sizes/ratios consistent within each template and distinct across — without changing wadyaljuz.

**Architecture:** A shared structural base (`BASE_BRANDED_LAYOUT`, extracted from wadyaljuz's tokenized layout with content stripped) + a small per-template identity descriptor applied by `buildTemplateBaseline`, yielding `TEMPLATE_LAYOUT_BASELINES`. `resolveLayoutSettings(input, templateId?)` merges a store's saved layout over its template baseline (saved wins; no `templateId` → today's behavior). API layout routes pass `store.template`. Demos inherit by setting `layoutSettings = {}`.

**Tech Stack:** TypeScript, `@ebda/shared` (`StoreLayoutSettings`, `DEFAULT_LAYOUT_SETTINGS`, `resolveLayoutSettings`), vitest, Prisma. Spec: `docs/superpowers/specs/2026-06-05-brand-engine-phase2-baseline-design.md`.

**Scope note:** Phase 2 of the Brand Engine. Phase 1 (color engine `deriveBrandRoles`) is merged (PR #61). This plan is the layout baseline. Independent, shippable, single PR.

**Working tree:** This plan executes in the isolated worktree `/Users/ahmadsharaf/Desktop/projects/fwb-phase2-wt` on branch `phase2-iso` (a parallel agent is active in the main tree). Run all commands from the worktree root. If `node_modules` is missing there, run `npm install` once before the first test step. At PR time the branch is rebased onto current `origin/main`.

---

## File structure

- **Create** `packages/shared/src/types/template-baselines.ts` — `BASE_BRANDED_LAYOUT`, `TemplateIdentity`, `buildTemplateBaseline`, `TEMPLATE_IDENTITIES`, `TEMPLATE_LAYOUT_BASELINES`, `getTemplateBaseline`. Imports **type-only** from `store-layout.ts` plus the value `DEFAULT_LAYOUT_SETTINGS` (one-way; store-layout never imports this file at module-eval — see Task 4 cycle note).
- **Create** `packages/shared/src/types/__tests__/template-baselines.test.ts` — unit tests.
- **Modify** `packages/shared/src/types/store-layout.ts` — `resolveLayoutSettings` gains optional `templateId` + base-merges the optional keys.
- **Modify** `packages/shared/src/index.ts` (or the types barrel it re-exports from) — export the new symbols.
- **Modify** `apps/api/src/routes/public-store-layout.routes.ts` + `apps/api/src/routes/store-layout.routes.ts` — thread `store.template`.
- **Create** `packages/database/scripts/verify-baseline-nodrift.mjs` — read-only wadyaljuz gate.
- **Modify** `packages/database/prisma/clone-demo-stores.ts` — demos get `layoutSettings = {}`.
- **Modify** `CLAUDE.md` — document the per-template baseline.

---

## Task 1: `BASE_BRANDED_LAYOUT` — tokenized, content-stripped elegant base

The elegant baseline IS wadyaljuz's real saved layout, with **content stripped** (hero images, marketing copy) and **content-gating flags reset to safe defaults** (testimonials off for new stores), keeping all **style** (sizes, frames, token colors, typography). wadyaljuz's layout is already fully tokenized, so no color rewrite is needed.

**Files:**

- Create: `packages/shared/src/types/template-baselines.ts`
- Test: `packages/shared/src/types/__tests__/template-baselines.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { BASE_BRANDED_LAYOUT } from '../template-baselines';

// Recursively collect every string value under a `*[cC]olor` / bgColor / customColor key.
function collectColorValues(obj: unknown, out: string[] = []): string[] {
  if (Array.isArray(obj)) {
    obj.forEach(v => collectColorValues(v, out));
  } else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === 'string' && /color$/i.test(k) && v.length > 0) out.push(v);
      else collectColorValues(v, out);
    }
  }
  return out;
}

describe('BASE_BRANDED_LAYOUT', () => {
  it('every color value is a brand token (no hardcoded colors)', () => {
    const colors = collectColorValues(BASE_BRANDED_LAYOUT);
    expect(colors.length).toBeGreaterThan(0);
    for (const c of colors) expect(c.startsWith('token:')).toBe(true);
  });

  it('carries no wadyaljuz content (empty hero slides, no marketing copy)', () => {
    expect(BASE_BRANDED_LAYOUT.hero.slides).toEqual([]);
    expect(BASE_BRANDED_LAYOUT.categories.title).toBeUndefined();
    expect(BASE_BRANDED_LAYOUT.categories.subtitle).toBeUndefined();
  });

  it('resets content-gating flags to the safe new-store defaults', () => {
    expect(BASE_BRANDED_LAYOUT.testimonials.enabled).toBe(false);
    expect(BASE_BRANDED_LAYOUT.reviewSection.enabled).toBe(false);
  });

  it('keeps the polished elegant style (frames, sizes, sizing contract)', () => {
    expect(BASE_BRANDED_LAYOUT.categories.showCardFrame).toBe(true);
    expect(BASE_BRANDED_LAYOUT.categories.desktopColumns).toBe(3);
    expect(BASE_BRANDED_LAYOUT.sizing.productImageAspect).toBe('1:1');
    expect(BASE_BRANDED_LAYOUT.productCardDefaults?.cardSize).toBe('xxs');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/shared/src/types/__tests__/template-baselines.test.ts`
Expected: FAIL — `BASE_BRANDED_LAYOUT` is not defined.

- [ ] **Step 3: Write the base literal**

Create `packages/shared/src/types/template-baselines.ts`:

```ts
import type { StoreLayoutSettings } from './store-layout';
import type { TemplateId } from './store-theme';
import { DEFAULT_LAYOUT_SETTINGS } from './store-layout';

/**
 * The shared structural baseline — wadyaljuz's real (already-tokenized) layout
 * with CONTENT stripped (hero images, marketing copy) and content-gating flags
 * reset to the safe new-store defaults (testimonials/reviews OFF — KW Law
 * 39/2014 fake-reviews posture). This IS the `elegant` baseline; the other four
 * templates derive from it via `buildTemplateBaseline` (see below).
 *
 * Every color is a `token:*` ref so the Phase-1 brand engine paints it.
 */
export const BASE_BRANDED_LAYOUT: StoreLayoutSettings = {
  hero: {
    enabled: true,
    mode: 'slider',
    autoplayMs: 5000,
    slides: [],
    bgColor: 'token:primary',
    presentation: 'full-bleed',
    typography: { heading: { fontSize: '18px', textAlign: 'start' } },
  },
  categories: {
    enabled: true,
    layout: 'grid',
    captionPosition: 'below',
    desktopColumns: 3,
    mobileColumns: 2,
    bgColor: 'token:primary',
    cardGap: 'tight',
    cardSize: 'xxs',
    cardShape: 'rounded-square',
    showCardFrame: true,
    cardFrameColor: 'token:card',
    cardFrameStyle: 'shadow',
    cardFrameWidth: 'normal',
    cardFrameSize: 'normal',
    dividers: {
      kicker: { color: 'custom', width: 'short', enabled: false, customColor: 'token:card' },
      subtitle: { color: 'custom', width: 'short', enabled: true, customColor: 'token:card' },
    },
    typography: {
      kicker: { color: 'token:card' },
      seeAll: { color: 'token:card', fontSize: '16px' },
      heading: { color: 'token:card', textAlign: 'center' },
      subtitle: { color: 'token:card', fontSize: '16px', textAlign: 'start' },
    },
  },
  newArrivals: {
    enabled: true,
    limit: 16,
    bgColor: 'token:card',
    cardGap: 'tight',
    cardSize: 'xs',
    cardShape: 'rounded-square',
    cardAspect: 'theme',
    showCardFrame: true,
    cardFrameColor: 'token:primary',
    cardFrameStyle: 'soft',
    cardFrameWidth: 'normal',
    cardFrameSize: 'normal',
    typography: {
      seeAll: { color: 'token:primary', textDecoration: 'none' },
      heading: { color: 'token:primary', textAlign: 'start' },
      subtitle: { color: 'token:primary' },
      productName: { color: 'token:primary' },
      productPrice: { color: 'token:primary' },
    },
  },
  bestSellers: {
    enabled: true,
    limit: 12,
    bgColor: 'token:primary',
    cardGap: 'tight',
    cardSize: 'xs',
    cardShape: 'rounded-square',
    cardAspect: 'theme',
    showCardFrame: true,
    cardFrameColor: 'token:card',
    cardFrameStyle: 'soft',
    cardFrameWidth: 'normal',
    cardFrameSize: 'normal',
    typography: {
      seeAll: { color: 'token:card' },
      heading: { color: 'token:card', textAlign: 'start' },
      productCta: { color: 'token:foreground' },
    },
  },
  filterSidebar: { enabled: true, defaultOpen: true },
  testimonials: {
    enabled: false, // reset from wadyaljuz's `true` — new stores start off
    minRating: 4,
    verifiedOnly: true,
    bgColor: 'token:primary',
    typography: { heading: { color: 'token:secondary', textAlign: 'start' } },
  },
  reviewSection: { enabled: false },
  trustStrip: { bgColor: 'token:card' },
  footer: { bgColor: 'token:primary' },
  productsPage: {},
  productDetailPage: {},
  categoriesPage: {},
  checkoutPage: {},
  cartPage: {},
  productCardDefaults: {
    cardSize: 'xxs',
    cardShape: 'rounded-square',
    cardFrameSize: 'compact',
    showCardFrame: true,
    cardFrameColor: 'token:primary',
  },
  sizing: {
    heroAspect: '2.45:1',
    productImageAspect: '1:1',
    categoryImageAspect: '1:1',
  },
};
```

> Note: `DEFAULT_LAYOUT_SETTINGS` is imported now so it's in scope for Task 3's fallback; it is not spread into the literal (the literal is self-contained — this avoids any module-eval ordering dependency on `DEFAULT_LAYOUT_SETTINGS`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/shared/src/types/__tests__/template-baselines.test.ts`
Expected: PASS (4 tests). If TS complains a field isn't on a settings interface, the interface name/field differs — open `store-layout.ts`, match the exact field, fix the literal (do NOT loosen the test).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/template-baselines.ts packages/shared/src/types/__tests__/template-baselines.test.ts
git commit -m "feat(shared): base-branded-layout — tokenized elegant baseline"
```

---

## Task 2: `TemplateIdentity` + `buildTemplateBaseline`

A compact per-template identity descriptor, applied to a deep clone of `BASE_BRANDED_LAYOUT` to produce a distinct-but-consistent baseline. The base is never mutated.

**Files:**

- Modify: `packages/shared/src/types/template-baselines.ts`
- Test: `packages/shared/src/types/__tests__/template-baselines.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append:

```ts
import { buildTemplateBaseline, type TemplateIdentity } from '../template-baselines';

const boldIdentity: TemplateIdentity = {
  productCardSize: 'lg',
  categoryCardSize: 'md',
  frameWidth: 'thick',
  frameSize: 'compact',
  cardGap: 'tight',
  desktopColumns: 2,
  mobileColumns: 2,
  cardShape: 'rounded-square',
  productAspect: 'square',
  productImageAspect: '1:1',
};

describe('buildTemplateBaseline', () => {
  it('applies the identity into every card surface', () => {
    const b = buildTemplateBaseline(boldIdentity);
    expect(b.newArrivals.cardSize).toBe('lg');
    expect(b.bestSellers.cardSize).toBe('lg');
    expect(b.productCardDefaults?.cardSize).toBe('lg');
    expect(b.categories.cardSize).toBe('md');
    expect(b.categories.desktopColumns).toBe(2);
    expect(b.newArrivals.cardFrameWidth).toBe('thick');
    expect(b.newArrivals.cardAspect).toBe('square');
    expect(b.sizing.productImageAspect).toBe('1:1');
  });

  it('does not mutate BASE_BRANDED_LAYOUT', () => {
    buildTemplateBaseline(boldIdentity);
    expect(BASE_BRANDED_LAYOUT.newArrivals.cardSize).toBe('xs'); // unchanged
    expect(BASE_BRANDED_LAYOUT.categories.desktopColumns).toBe(3);
  });

  it('keeps every color a token after applying an identity', () => {
    const colors = collectColorValues(buildTemplateBaseline(boldIdentity));
    for (const c of colors) expect(c.startsWith('token:')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/shared/src/types/__tests__/template-baselines.test.ts`
Expected: FAIL — `buildTemplateBaseline` not defined.

- [ ] **Step 3: Implement**

Append to `template-baselines.ts`:

```ts
import type {
  CardSize,
  CardFrameWidth,
  CardFrameSize,
  CardGap,
  CardShape,
  CardAspect,
  SizingContract,
} from './store-layout';

/** The per-template identity — distinct numbers on the shared scale. */
export interface TemplateIdentity {
  productCardSize: CardSize; // newArrivals + bestSellers + productCardDefaults
  categoryCardSize: CardSize;
  frameWidth: CardFrameWidth;
  frameSize: CardFrameSize;
  cardGap: CardGap;
  desktopColumns: number;
  mobileColumns: number;
  cardShape: CardShape;
  productAspect: CardAspect; // newArrivals/bestSellers cardAspect
  productImageAspect: SizingContract['productImageAspect'];
}

// Structured-clone-free deep clone good enough for plain JSON layout objects.
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Apply a template identity to a deep clone of BASE_BRANDED_LAYOUT. Only the
 * size/frame/column/aspect knobs change; all token colors + typography +
 * section toggles stay from the base, so every template stays on-brand and
 * internally consistent while reading proportionally distinct.
 */
export function buildTemplateBaseline(identity: TemplateIdentity): StoreLayoutSettings {
  const b = clone(BASE_BRANDED_LAYOUT);

  b.categories.cardSize = identity.categoryCardSize;
  b.categories.desktopColumns = identity.desktopColumns;
  b.categories.mobileColumns = identity.mobileColumns;
  b.categories.cardFrameWidth = identity.frameWidth;
  b.categories.cardFrameSize = identity.frameSize;
  b.categories.cardGap = identity.cardGap;
  b.categories.cardShape = identity.cardShape;

  for (const carousel of [b.newArrivals, b.bestSellers]) {
    carousel.cardSize = identity.productCardSize;
    carousel.cardFrameWidth = identity.frameWidth;
    carousel.cardFrameSize = identity.frameSize;
    carousel.cardGap = identity.cardGap;
    carousel.cardShape = identity.cardShape;
    carousel.cardAspect = identity.productAspect;
  }

  if (b.productCardDefaults) {
    b.productCardDefaults.cardSize = identity.productCardSize;
    b.productCardDefaults.cardFrameSize = identity.frameSize;
    b.productCardDefaults.cardShape = identity.cardShape;
  }

  b.sizing.productImageAspect = identity.productImageAspect;

  return b;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/shared/src/types/__tests__/template-baselines.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/template-baselines.ts packages/shared/src/types/__tests__/template-baselines.test.ts
git commit -m "feat(shared): template identity descriptor + buildTemplateBaseline"
```

---

## Task 3: the 5 baselines + `getTemplateBaseline`

**Files:**

- Modify: `packages/shared/src/types/template-baselines.ts`
- Test: `packages/shared/src/types/__tests__/template-baselines.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append:

```ts
import { TEMPLATE_LAYOUT_BASELINES, getTemplateBaseline } from '../template-baselines';

describe('TEMPLATE_LAYOUT_BASELINES', () => {
  const ids = ['modern', 'elegant', 'classic', 'minimal', 'bold'] as const;

  it('has a baseline for all 5 templates', () => {
    for (const id of ids) expect(TEMPLATE_LAYOUT_BASELINES[id]).toBeTruthy();
  });

  it('elegant equals the calibrated base verbatim', () => {
    expect(TEMPLATE_LAYOUT_BASELINES.elegant).toEqual(BASE_BRANDED_LAYOUT);
  });

  it('templates are proportionally distinct (bold ≠ minimal on product card size)', () => {
    expect(TEMPLATE_LAYOUT_BASELINES.bold.newArrivals.cardSize).not.toBe(
      TEMPLATE_LAYOUT_BASELINES.minimal.newArrivals.cardSize
    );
    expect(TEMPLATE_LAYOUT_BASELINES.modern.categories.desktopColumns).not.toBe(
      TEMPLATE_LAYOUT_BASELINES.bold.categories.desktopColumns
    );
  });

  it('every baseline is fully tokenized', () => {
    for (const id of ids) {
      const colors = collectColorValues(TEMPLATE_LAYOUT_BASELINES[id]);
      for (const c of colors) expect(c.startsWith('token:')).toBe(true);
    }
  });

  it('getTemplateBaseline returns the baseline, falls back for unknown id', () => {
    expect(getTemplateBaseline('bold')).toBe(TEMPLATE_LAYOUT_BASELINES.bold);
    expect(getTemplateBaseline('nope' as never)).toBe(DEFAULT_LAYOUT_SETTINGS);
  });
});
```

> The test imports `DEFAULT_LAYOUT_SETTINGS` — add `import { DEFAULT_LAYOUT_SETTINGS } from '../store-layout';` to the test file's imports.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/shared/src/types/__tests__/template-baselines.test.ts`
Expected: FAIL — `TEMPLATE_LAYOUT_BASELINES` not defined.

- [ ] **Step 3: Implement**

Append to `template-baselines.ts`:

```ts
/** Per-template identities. elegant = the calibrated base (no delta). */
export const TEMPLATE_IDENTITIES: Record<Exclude<TemplateId, 'elegant'>, TemplateIdentity> = {
  modern: {
    productCardSize: 'sm',
    categoryCardSize: 'xs',
    frameWidth: 'normal',
    frameSize: 'normal',
    cardGap: 'normal',
    desktopColumns: 4,
    mobileColumns: 2,
    cardShape: 'rounded-square',
    productAspect: 'square',
    productImageAspect: '1:1',
  },
  classic: {
    productCardSize: 'md',
    categoryCardSize: 'sm',
    frameWidth: 'thin',
    frameSize: 'comfortable',
    cardGap: 'normal',
    desktopColumns: 3,
    mobileColumns: 2,
    cardShape: 'soft',
    productAspect: 'portrait',
    productImageAspect: '3:4',
  },
  minimal: {
    productCardSize: 'sm',
    categoryCardSize: 'xs',
    frameWidth: 'thin',
    frameSize: 'spacious',
    cardGap: 'loose',
    desktopColumns: 4,
    mobileColumns: 2,
    cardShape: 'square',
    productAspect: 'square',
    productImageAspect: '1:1',
  },
  bold: {
    productCardSize: 'lg',
    categoryCardSize: 'md',
    frameWidth: 'thick',
    frameSize: 'compact',
    cardGap: 'tight',
    desktopColumns: 2,
    mobileColumns: 2,
    cardShape: 'rounded-square',
    productAspect: 'square',
    productImageAspect: '1:1',
  },
};

/** The packaged per-template baselines. Stores with empty layout inherit by template. */
export const TEMPLATE_LAYOUT_BASELINES: Record<TemplateId, StoreLayoutSettings> = {
  elegant: BASE_BRANDED_LAYOUT,
  modern: buildTemplateBaseline(TEMPLATE_IDENTITIES.modern),
  classic: buildTemplateBaseline(TEMPLATE_IDENTITIES.classic),
  minimal: buildTemplateBaseline(TEMPLATE_IDENTITIES.minimal),
  bold: buildTemplateBaseline(TEMPLATE_IDENTITIES.bold),
};

/** Safe lookup. Unknown id → the bare global default (back-compat behavior). */
export function getTemplateBaseline(templateId: TemplateId): StoreLayoutSettings {
  return TEMPLATE_LAYOUT_BASELINES[templateId] ?? DEFAULT_LAYOUT_SETTINGS;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/shared/src/types/__tests__/template-baselines.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/template-baselines.ts packages/shared/src/types/__tests__/template-baselines.test.ts
git commit -m "feat(shared): per-template layout baselines + getTemplateBaseline"
```

---

## Task 4: thread `templateId` into `resolveLayoutSettings`

The resolver merges a store's saved layout over its **template** baseline. Two correctness rules: (1) omitting `templateId` reproduces today's behavior exactly (base = `DEFAULT_LAYOUT_SETTINGS`); (2) the **optional** section keys must fall back to the base (`raw.X ?? base.X`) and `productCardDefaults` must deep-merge — otherwise a new store would drop the baseline's footer/trustStrip/productCardDefaults.

**Cycle note:** `template-baselines.ts` imports `DEFAULT_LAYOUT_SETTINGS` (value) + types from `store-layout.ts`. `store-layout.ts` will import `getTemplateBaseline` (value) from `template-baselines.ts`. To avoid a module-eval cycle, `template-baselines.ts` must use `DEFAULT_LAYOUT_SETTINGS` **only inside the `getTemplateBaseline` function body** (runtime), never at module top-level — which is already the case (Task 1 note: the base literal is self-contained, not spread from `DEFAULT_LAYOUT_SETTINGS`). With that, the back-edge is runtime-only and safe.

**Files:**

- Modify: `packages/shared/src/types/store-layout.ts` (`resolveLayoutSettings`, ~line 842)
- Test: `packages/shared/src/types/__tests__/store-layout-resolve.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/types/__tests__/store-layout-resolve.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveLayoutSettings, DEFAULT_LAYOUT_SETTINGS } from '../store-layout';
import { TEMPLATE_LAYOUT_BASELINES } from '../template-baselines';

describe('resolveLayoutSettings(input, templateId?)', () => {
  it('empty input + templateId returns that template baseline', () => {
    const r = resolveLayoutSettings({}, 'bold');
    expect(r.newArrivals.cardSize).toBe('lg');
    expect(r.categories.desktopColumns).toBe(2);
    // optional keys come from the baseline, not dropped
    expect(r.footer?.bgColor).toBe('token:primary');
    expect(r.trustStrip?.bgColor).toBe('token:card');
    expect(r.productCardDefaults?.cardSize).toBe('lg');
  });

  it('saved values win over the template baseline', () => {
    const saved = { categories: { desktopColumns: 5 }, footer: { bgColor: 'token:secondary' } };
    const r = resolveLayoutSettings(saved, 'bold');
    expect(r.categories.desktopColumns).toBe(5); // saved wins
    expect(r.footer?.bgColor).toBe('token:secondary'); // saved wins
    expect(r.newArrivals.cardSize).toBe('lg'); // unspecified → baseline
  });

  it('no templateId reproduces the legacy global-default behavior', () => {
    expect(resolveLayoutSettings({})).toEqual(DEFAULT_LAYOUT_SETTINGS);
    // legacy: optional keys absent when not saved and no template base
    expect(resolveLayoutSettings({}).footer).toBeUndefined();
  });

  it('unknown templateId falls back to the global default', () => {
    expect(resolveLayoutSettings({}, 'bogus' as never)).toEqual(DEFAULT_LAYOUT_SETTINGS);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/shared/src/types/__tests__/store-layout-resolve.test.ts`
Expected: FAIL — `resolveLayoutSettings` ignores the 2nd arg / optional keys undefined.

- [ ] **Step 3: Implement**

In `store-layout.ts`, add the import near the top (after the existing imports):

```ts
import type { TemplateId } from './store-theme';
import { getTemplateBaseline } from './template-baselines';
```

Replace the `resolveLayoutSettings` function body with:

```ts
export function resolveLayoutSettings(
  input: unknown,
  templateId?: TemplateId
): StoreLayoutSettings {
  const base = templateId ? getTemplateBaseline(templateId) : DEFAULT_LAYOUT_SETTINGS;
  if (!input || typeof input !== 'object') return base;
  const raw = input as Partial<StoreLayoutSettings>;

  return {
    hero: { ...base.hero, ...(raw.hero ?? {}) },
    categories: { ...base.categories, ...(raw.categories ?? {}) },
    newArrivals: { ...base.newArrivals, ...(raw.newArrivals ?? {}) },
    bestSellers: { ...base.bestSellers, ...(raw.bestSellers ?? {}) },
    filterSidebar: { ...base.filterSidebar, ...(raw.filterSidebar ?? {}) },
    productsPage: { ...base.productsPage, ...(raw.productsPage ?? {}) },
    productDetailPage: { ...base.productDetailPage, ...(raw.productDetailPage ?? {}) },
    categoriesPage: { ...base.categoriesPage, ...(raw.categoriesPage ?? {}) },
    checkoutPage: { ...base.checkoutPage, ...(raw.checkoutPage ?? {}) },
    cartPage: { ...base.cartPage, ...(raw.cartPage ?? {}) },
    testimonials: { ...base.testimonials, ...(raw.testimonials ?? {}) },
    reviewSection: { ...base.reviewSection, ...(raw.reviewSection ?? {}) },
    // Optional sections: saved wins, else inherit the (template) base.
    brandStory: raw.brandStory ?? base.brandStory,
    trustStrip: raw.trustStrip ?? base.trustStrip,
    blogCarousel: raw.blogCarousel ?? base.blogCarousel,
    announcement: raw.announcement ?? base.announcement,
    header: raw.header ?? base.header,
    footer: raw.footer ?? base.footer,
    extraCarousels: raw.extraCarousels ?? base.extraCarousels,
    sizing: { ...base.sizing, ...(raw.sizing ?? {}) },
    productCardDefaults: {
      ...(base.productCardDefaults ?? {}),
      ...(raw.productCardDefaults ?? {}),
    },
    sectionOrder: raw.sectionOrder ?? base.sectionOrder,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/shared/src/types/__tests__/store-layout-resolve.test.ts`
Expected: PASS (4 tests). Then re-run the whole shared suite to catch regressions:
Run: `npx vitest run packages/shared`
Expected: all green (the legacy `resolveLayoutSettings({})` path is unchanged because `DEFAULT_LAYOUT_SETTINGS` has no optional keys → `raw.X ?? undefined`).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/store-layout.ts packages/shared/src/types/__tests__/store-layout-resolve.test.ts
git commit -m "feat(shared): resolveLayoutSettings merges over per-template baseline"
```

---

## Task 5: export the new symbols from the package barrel

**Files:**

- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Find how store-layout is exported**

Run: `grep -n "store-layout\|store-theme" packages/shared/src/index.ts`
Expected: a line like `export * from './types/store-layout';`.

- [ ] **Step 2: Add the export**

Add next to the other `types/*` exports in `packages/shared/src/index.ts`:

```ts
export {
  BASE_BRANDED_LAYOUT,
  TEMPLATE_LAYOUT_BASELINES,
  TEMPLATE_IDENTITIES,
  getTemplateBaseline,
  buildTemplateBaseline,
} from './types/template-baselines';
export type { TemplateIdentity } from './types/template-baselines';
```

> If `store-layout` is exported via `export * from './types/store-layout'`, the new file may already be picked up only if it's also `export *`-ed; add the explicit block above regardless so the names are guaranteed exported.

- [ ] **Step 3: Typecheck + build**

Run: `npx tsc --noEmit -p packages/shared/tsconfig.json`
Expected: no errors (no circular-import error — the back-edge is runtime-only).
Run: `npm run build --workspace=@ebda/shared`
Expected: builds; `grep -n derive... ` not needed — confirm: `grep -rn "getTemplateBaseline" packages/shared/dist/types/template-baselines.d.ts` returns the export.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "feat(shared): export per-template baseline api"
```

---

## Task 6: thread `store.template` through the API layout routes

So the storefront's SSR layout resolves against the store's template baseline. Both routes already load the store; add `template` to the `select` and pass it.

**Files:**

- Modify: `apps/api/src/routes/public-store-layout.routes.ts`
- Modify: `apps/api/src/routes/store-layout.routes.ts`

- [ ] **Step 1: public-store-layout — load template once, use in both paths**

In `apps/api/src/routes/public-store-layout.routes.ts`, the committed-layout block currently is:

```ts
const store = await prisma.store.findFirst({
  where: { id: storeId, status: 'active' },
  select: { layoutSettings: true },
});
```

Change the `select` to include `template`:

```ts
      select: { layoutSettings: true, template: true },
```

and change `const layout = resolveLayoutSettings(store.layoutSettings);` to:

```ts
const layout = resolveLayoutSettings(store.layoutSettings, store.template);
```

For the **draft** branch above it (`const layout = resolveLayoutSettings(draftBundle.layout);`), load the store's template before the draft check so the preview also uses the template baseline. At the top of the handler, after `storeId` is known and before the `draftToken` check, add:

```ts
const storeMeta = await prisma.store.findFirst({
  where: { id: storeId, status: 'active' },
  select: { template: true },
});
const templateId = storeMeta?.template;
```

then change the draft resolve to:

```ts
const layout = resolveLayoutSettings(draftBundle.layout, templateId);
```

and the committed block can reuse `templateId` instead of re-selecting `template` (either is fine; if you keep the single `storeMeta` fetch, change the committed `select` back to just `{ layoutSettings: true }` and pass `templateId`). Keep ONE store fetch for template to avoid an extra query.

- [ ] **Step 2: store-layout (admin) — GET + PUT**

In `apps/api/src/routes/store-layout.routes.ts`, the admin GET (~line 600):

```ts
const store = await prisma.store.findUnique({
  where: { id: storeId },
  select: { layoutSettings: true, template: true },
});
const layout = resolveLayoutSettings(store?.layoutSettings ?? {}, store?.template);
```

The admin PUT (~line 630) — load template and thread it through both resolves:

```ts
const current = await prisma.store.findUnique({
  where: { id: storeId },
  select: { layoutSettings: true, template: true },
});
const previousLayout = current?.layoutSettings ?? {};
const merged = resolveLayoutSettings(
  {
    ...resolveLayoutSettings(previousLayout, current?.template),
    ...patch,
  },
  current?.template
);
```

- [ ] **Step 3: Typecheck the API**

Run: `npx tsc --noEmit -p apps/api/tsconfig.json`
Expected: no errors. (`store.template` is the Prisma `StoreTemplate` enum, assignable to `TemplateId` since both are the same 5 string literals; if TS objects, cast `store.template as TemplateId` at the call — the enum values are identical.)

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/public-store-layout.routes.ts apps/api/src/routes/store-layout.routes.ts
git commit -m "feat(api): resolve store layout against its template baseline"
```

---

## Task 7: wadyaljuz no-drift gate (read-only)

Proves wadyaljuz's resolved layout is byte-identical before/after (it has a full saved layout that wins the merge). palora is logged for visibility but not gated (it intentionally adopts the minimal baseline).

**Files:**

- Create: `packages/database/scripts/verify-baseline-nodrift.mjs`

- [ ] **Step 1: Write the script**

```js
// READ-ONLY (spec §5 gate): wadyaljuz's resolved layout must be byte-identical
// before/after Phase 2. palora is logged but NOT gated (adopts minimal baseline).
//   run:  node packages/database/scripts/verify-baseline-nodrift.mjs
import { PrismaClient } from '@prisma/client';
import { resolveLayoutSettings } from '@ebda/shared';

const prisma = new PrismaClient();

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

const stores = await prisma.store.findMany({
  where: { slug: { in: ['wady-aljuz', 'palora'] } },
  select: { slug: true, template: true, layoutSettings: true },
});

let failed = false;
for (const s of stores) {
  const saved = s.layoutSettings ?? {};
  const before = resolveLayoutSettings(saved); // legacy (no templateId)
  const after = resolveLayoutSettings(saved, s.template); // phase 2
  const same = deepEqual(before, after);
  if (s.slug === 'wady-aljuz') {
    console.log(`wady-aljuz [${s.template}] no-drift: ${same ? 'PASS' : 'FAIL'}`);
    if (!same) {
      failed = true;
      // Show the first differing top-level key for debugging.
      for (const k of Object.keys(after)) {
        if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
          console.error(`  DRIFT at "${k}"`);
        }
      }
    }
  } else {
    console.log(
      `palora [${s.template}] adopts baseline (not gated): changed=${!same} (expected: true)`
    );
  }
}

await prisma.$disconnect();
if (failed) {
  console.error('\nFAIL: wadyaljuz layout drifted — do not ship.');
  process.exit(1);
}
console.log('\nPASS: wadyaljuz unchanged.');
```

- [ ] **Step 2: Run against live data (read-only)**

From the repo root with the prod `DATABASE_URL` in scope (the worktree may lack `.env`; copy it: `cp /Users/ahmadsharaf/Desktop/projects/force-website-builder/packages/database/.env packages/database/.env` or `railway run`):

Run: `cd packages/database && node scripts/verify-baseline-nodrift.mjs`
Expected: `wady-aljuz [elegant] no-drift: PASS` and `palora [minimal] adopts baseline (not gated): changed=true`. If wadyaljuz FAILS, the elegant baseline diverged from wadyaljuz's saved values on a key wadyaljuz did NOT save — reconcile the `BASE_BRANDED_LAYOUT` value for that key to match wadyaljuz, OR confirm wadyaljuz saved that key (it should have all 11). Never weaken the gate.

- [ ] **Step 3: Commit**

```bash
git add packages/database/scripts/verify-baseline-nodrift.mjs
git commit -m "test(database): read-only wadyaljuz no-drift gate for layout baseline"
```

---

## Task 8: demos inherit their template baseline

Change the existing cloner so each demo store gets `layoutSettings = {}` (inherits its template baseline) while keeping the copied brand theme (so the Phase-1 engine colors all demos from wadyaljuz's branding). 4 demos (modern/classic/minimal/bold); wadyaljuz remains the live elegant showcase.

**Files:**

- Modify: `packages/database/prisma/clone-demo-stores.ts`

- [ ] **Step 1: Override layoutSettings in the clone**

In `clone-demo-stores.ts`, find the `prisma.store.create({ data: { ...rest, slug, domain: null, template: tpl.template, ... } })` block in `cloneInto` (~line 100). Add `layoutSettings: {}` to the `data` object so the demo inherits its template baseline instead of copying wadyaljuz's elegant layout:

```ts
      data: {
        ...rest,
        slug,
        domain: null,
        template: tpl.template,
        layoutSettings: {}, // inherit the per-template baseline (Phase 2) — do NOT copy wadyaljuz's elegant layout
        // ...existing overrides (name/owner/etc.) unchanged
      },
```

Keep `theme` copied from wadyaljuz (brand colors) — that is what makes the Phase-1 engine paint every demo from one palette. Leave the rest of the script unchanged.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p packages/database/tsconfig.json 2>/dev/null || npx tsc --noEmit packages/database/prisma/clone-demo-stores.ts --skipLibCheck`
Expected: no new errors (Prisma `Json` accepts `{}`).

- [ ] **Step 3: Commit**

```bash
git add packages/database/prisma/clone-demo-stores.ts
git commit -m "feat(database): demos inherit per-template baseline (empty layout)"
```

- [ ] **Step 4: (Execution-time, after merge + deploy) seed the demos against prod**

Run (manual, prod): `railway run npx tsx packages/database/prisma/clone-demo-stores.ts`
Expected: `✓ demo-modern … ✓ demo-classic … ✓ demo-minimal … ✓ demo-bold`. Then load `<platform-domain>/demo-bold` etc. and confirm each renders distinct + on-brand. This step is NOT a code commit; it runs once after the PR merges.

---

## Task 9: docs parity

**Files:**

- Modify: `CLAUDE.md` (the "Per-store visual configuration" section)

- [ ] **Step 1: Document the baseline**

Add a subsection under "Per-store visual configuration" in `CLAUDE.md`:

```markdown
**Per-template branded baseline (Brand Engine Phase 2, 2026-06-05):** a store
with empty `layoutSettings` inherits its template's polished, fully-tokenized
baseline via `resolveLayoutSettings(saved, store.template)`. Baselines live in
`packages/shared/src/types/template-baselines.ts`: `BASE_BRANDED_LAYOUT` (the
calibrated `elegant` base, extracted from wadyaljuz with content stripped) +
`TEMPLATE_IDENTITIES` (per-template size/frame/column/aspect deltas) →
`TEMPLATE_LAYOUT_BASELINES`. Colors are `token:*` only (the Phase-1 engine
paints them). Saved values always win the merge, so wadyaljuz (full saved
layout) is unchanged; palora (empty layout) adopts the minimal baseline by
design. Demos (`demo-<template>`) carry wadyaljuz's brand colors + empty layout
→ one palette, five identities. Gate: `scripts/verify-baseline-nodrift.mjs`.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(shared): document per-template branded baseline"
```

---

## Self-review

- **Spec coverage:** §3 scale model → Tasks 1–3 (base + identities + builder). §4 architecture units → Tasks 1–8. §5 wadyaljuz immutability → Task 7 (+ resolver merge precedence in Task 4). §6 demos → Task 8. §7 customization freedom → preserved (baselines are defaults; saved wins — Task 4). §8 testing → Tasks 1–4, 7. palora decision → Task 7 (logged, not gated) + Task 9.
- **Placeholders:** none — every code step is complete; the only non-code "execution-time" steps (Task 7 Step 2 live run, Task 8 Step 4 prod seed) are explicitly runtime, not code gaps.
- **Type consistency:** `TemplateIdentity`, `buildTemplateBaseline`, `BASE_BRANDED_LAYOUT`, `TEMPLATE_LAYOUT_BASELINES`, `getTemplateBaseline`, `resolveLayoutSettings(input, templateId?)` named identically across Tasks 1–6. Enum literals (`CardShape`, `productImageAspect '1:1'|'3:4'`, frame/gap/size) verified against `store-layout.ts`. `TemplateId` (store-theme) === `StoreTemplate` (Prisma) 5 values.
- **Cycle safety:** Task 4 note — `template-baselines.ts` uses `DEFAULT_LAYOUT_SETTINGS` only at runtime inside `getTemplateBaseline`; `store-layout.ts` ↔ `template-baselines.ts` back-edge is runtime-only.
