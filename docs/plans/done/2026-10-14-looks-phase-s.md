# Looks — Phase S (system contract) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every store has a _look_ (one of 15: 5 templates × 3), picked at onboarding or later, that sets its design tokens and section mix; switching looks never loses content, merchant design edits show as overrides with reset, and a demo store can preview any built look without saving.

**Architecture:** Looks are data in `@ebda/shared` (`packages/shared/src/looks/`), never forked code. The storefront composes the theme as `DEFAULT_THEME < TEMPLATE_THEMES[skin] < look tokens < stores.theme` through ONE function, `composeStoreTheme`, used by every resolver site. The look id lives in a new nullable column `stores.look`; switching is one API call (`PUT /stores/:id/look`) that sets skin + look, optionally clears overridden token keys, and applies the look's section mix to the builder (publish for an empty store, draft otherwise). Skins per template arrive in Phase B; until then every look renders on the `minimal` skin with its own tokens.

**Tech Stack:** TypeScript, Zod, Prisma (Neon, strict RLS + tenant guard), Express-on-Workers API, Next.js 16 storefront/admin, Vitest.

**Spec:** `docs/plans/done/2026-10-14-templates-and-editor-program.md` (Phase S + Rulings TPL-1..3, MKT-3), `docs/ebda/templates/2026-10-14-directions.md` (the 15 looks), `PRODUCT.md`. Current-system map: §"What exists today" below (gathered 2026-10-14 from source).

## Rulings (decided at plan time)

- **Ruling LOOKS-1 — a look is data over the shared section registry + token set; it never forks commerce code.** Evidence: TPL-1; Dahab's skin already shows the cost of a forked component set (12 handover sites). Cost if wrong: a look needs a layout the registry can't express → that look waits for a new section type in Phase B (acceptable).
- **Ruling LOOKS-2 — the look id is a Store column `stores.look` (nullable TEXT), not a StoreTheme key.** Evidence: StoreTheme is an untyped, shallow-merged JSON written by four surfaces (Branding, Smart Palette, builder publish, legacy PUT); a key there can be clobbered by any of them, and the resolver needs the look BEFORE it merges the theme. CLAUDE.md UI rule 3 prefers theme JSON unless API-gated — the look is read by the API (onboarding, demo gating, publish) so the column is justified. Cost if wrong: one extra column to migrate away from.
- **Ruling LOOKS-3 — switching look keeps content always; design overrides are kept unless the merchant chooses "reset".** Evidence: TPL-1 ("switching keeps content; a switch asks before discarding design overrides"). Cost if wrong: a merchant who expected a clean switch sees their old colours — the dialog's default and copy make the choice explicit.
- **Ruling LOOKS-4 — demo preview is a per-store flag `stores.is_demo` (API-gated) + `?look=<id>` honoured only on demo stores; checkout on a demo store is refused server-side.** Evidence: MKT-3; `assertOrderAllowed(storeId)` already gates order creation. Cost if wrong: a cached demo page leaks into a real store — prevented by `no-store` on any response that honoured `?look=`.
- **Ruling LOOKS-5 — the four template enum values (qamar, souq, jasmine, lamma) are NOT added in Phase S.** Evidence: `TemplateId` drives five exhaustive `Record<TemplateId,…>` maps (serverTemplate, pack-styles, baselines, TEMPLATE_THEMES, templates/index); adding ids before their skins exist forces placeholder entries. Each id is added in Phase B with its skin. Cost if wrong: none for Phase S; `LookDefinition.skin` carries the rendering skin meanwhile.

## Global Constraints

- Colours in StoreTheme are bare HSL triplets (`'26 100% 50%'`); convert from hex with `hexToHsl` (`packages/shared/src/utils/color.ts:207`).
- WCAG AA: every text pair ≥ 4.5:1 (`contrastRatio`, `color.ts:320`); nothing under 12px.
- No cream/sand page backgrounds (OKLCH L 0.84–0.97, C < 0.06, hue 40–100) — enforced by test.
- Tenant guard + strict RLS: every store write via `withStore(storeId, tx => …)`; every query carries top-level `storeId`/`id` = ambient store.
- Cache: every write path that changes what a storefront renders calls `StoreService.invalidateCache(store)` AND `bustStoreCaches(id, slug, domain)` (NEVER-stale class).
- Never branch on `store.slug`; never hardcode brand strings (BRAND).
- Bilingual: every merchant-facing string has ar + en (admin i18n `apps/admin/src/i18n/messages/{ar,en}.json`).
- commitlint all-lowercase subjects; `git add` explicit paths; never `--no-verify`.
- Docs parity in the same PR: `docs/architecture/store-theme-flags.md`, `docs/RULINGS.md`, `docs/ebda/templates/looks.md` (new).

## Review Focus

1. **Merchant edited colours, then switches look** → with "keep", their edited keys still win and show as overrides; with "reset", the new look's tokens show. (Task 6 test `applyLook keep vs reset`.)
2. **`stores.look` holds an id that no longer exists** (renamed/removed look) → storefront renders the skin defaults, never 500s; admin shows "choose a look". (Task 3 test `unknown look id falls back`.)
3. **`?look=` on a non-demo store** → ignored, response cacheable as normal; on a demo store → applied with `Cache-Control: private, no-store`. (Task 9 tests.)
4. **Order attempt on a demo store** (API direct, bypassing UI) → 403 `DEMO_STORE`, no order row, no stock hold. (Task 9 integration test.)
5. **Look fonts fail to load / Arabic glyph missing** → body falls back to the platform Arabic face (IBM Plex Sans Arabic), never Times. (Task 4 test asserts the fallback stack.)

---

## What exists today (facts, 2026-10-14)

- `stores.template` enum `StoreTemplate {modern classic minimal bold elegant dahab}` (`schema.prisma:827`); write path `PUT /stores/:id/template` → `StoreService.updateTemplate` (`store.service.ts:938`, hard-coded list :941).
- Theme compose: `{...getTemplateTheme(template), ...stores.theme}` in `apps/web/src/lib/store-resolver.ts:383`, `:553`, `:887`.
- `StoreService.updateTheme` (`store.service.ts:971`) shallow-merges; no delete.
- Families: `TEMPLATE_FAMILIES` + `applyTemplateFamily(doc, familyId)` (`packages/shared/src/builder/template-families.ts:31,139`) — sections only, stateless.
- Builder: `store_page_revisions` (draft/published), `PageBuilderService` publish merges `PageDefinition.theme` (allowlist `THEME_SETTINGS_SCHEMA`, `settings-schema.ts:292`).
- `headingFont` / `bodyFont` exist on StoreTheme with no storefront consumer.
- Onboarding: `TemplateStep.tsx:39` → `PUT /stores/:id/template`; `SELF_SERVE_TEMPLATES` (`onboarding.service.ts:39`) and admin `types.ts:15` list 5 legacy ids.
- Preview: builder canvas token (`?_preview&_builder=`) + `PreviewThemeOverride` (`StoreContext.tsx:433`); no public preview.
- Orders: `OrderService.create` calls `assertOrderAllowed(storeId)` first (`order.service.ts:597`).

## File map

- Create `packages/shared/src/looks/types.ts` — `LookId`, `LookTokens`, `LookDefinition`, `LOOK_TOKEN_KEYS`.
- Create `packages/shared/src/looks/registry.ts` — the 15 `LOOKS`, `getLook`, `looksForTemplate`, `LOOK_TEMPLATES`.
- Create `packages/shared/src/looks/compose.ts` — `lookTheme(look)`, `composeStoreTheme({template, look, theme})`, `overriddenLookKeys(theme, look)`.
- Create `packages/shared/src/looks/fonts.ts` — `LOOK_FONT_SPECS`, `lookFontsHref(look)`.
- Create `packages/shared/src/looks/index.ts` — re-exports; add to `packages/shared/src/index.ts`.
- Modify `packages/shared/src/types/store-theme.ts` — add `density`, `imageRatio`, `motion` keys + defaults.
- Modify `apps/web/src/lib/store-resolver.ts` (3 sites), `apps/web/src/lib/theme-css.ts`, `apps/web/src/contexts/StoreContext.tsx` (`themeToCssVars`), `apps/web/src/app/layout.tsx` (font link), `apps/web/src/styles/globals.css` (token consumers).
- Migration `packages/database/prisma/migrations/20261015000000_store_look_and_demo/migration.sql` + `schema.prisma` (`look String?`, `isDemo Boolean @default(false)`).
- Modify `apps/api/src/services/store.service.ts` (`updateTheme` null-delete, new `applyLook`), `apps/api/src/routes/store.routes.ts` (`PUT /:id/look`), `apps/api/src/services/onboarding.service.ts`, `apps/api/src/routes/onboarding.routes.ts`, `apps/api/src/services/order.service.ts` (`assertOrderAllowed`), definer selects in `apps/api/src/lib/definer.ts` if they enumerate store columns.
- Admin: `apps/admin/src/components/looks/LookPicker.tsx` (new), `apps/admin/src/app/onboarding/_components/TemplateStep.tsx`, `apps/admin/src/app/stores/[id]/template/page.tsx`, builder `ThemeSettingsPanel.tsx` (override badges), i18n.
- Web demo: `apps/web/src/components/demo/DemoLookBar.tsx` (new), `apps/web/middleware.ts`, resolver.
- Tests: `tests/unit/looks-registry.test.ts`, `tests/unit/looks-contrast.test.ts`, `tests/unit/looks-compose.test.ts`, `tests/unit/looks-fonts.test.ts`, `tests/integration/store-look.test.ts`, `tests/integration/demo-store.test.ts`, admin component test `apps/admin/src/components/looks/LookPicker.test.tsx`.
- Docs: `docs/ebda/templates/looks.md` (new), `docs/architecture/store-theme-flags.md`, `docs/RULINGS.md`.

---

### Task 1: Look types and the 15-look registry

**Files:**

- Create: `packages/shared/src/looks/types.ts`, `packages/shared/src/looks/registry.ts`, `packages/shared/src/looks/index.ts`
- Modify: `packages/shared/src/index.ts` (add `export * from './looks';`)
- Test: `tests/unit/looks-registry.test.ts`

**Interfaces:**

- Produces: `type LookTemplate = 'qamar'|'souq'|'jasmine'|'lamma'|'dahab'`; `type LookId = \`${LookTemplate}.${string}\``; `interface LookTokens`; `interface LookDefinition`; `LOOKS: readonly LookDefinition[]`; `getLook(id: string | null | undefined): LookDefinition | undefined`; `looksForTemplate(t: LookTemplate): LookDefinition[]`; `LOOK_TEMPLATES: readonly LookTemplate[]`; `LOOK_TOKEN_KEYS: readonly (keyof StoreTheme)[]`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/looks-registry.test.ts
import { describe, it, expect } from 'vitest';
import { LOOKS, LOOK_TEMPLATES, getLook, looksForTemplate, TEMPLATE_FAMILIES } from '@ebda/shared';

describe('looks registry', () => {
  it('has exactly 3 looks per template, 15 total, unique ids', () => {
    expect(LOOKS).toHaveLength(15);
    expect(new Set(LOOKS.map(l => l.id)).size).toBe(15);
    for (const t of LOOK_TEMPLATES) expect(looksForTemplate(t)).toHaveLength(3);
  });
  it('every look id is <template>.<slug> and matches its template', () => {
    for (const l of LOOKS) expect(l.id.startsWith(`${l.template}.`)).toBe(true);
  });
  it('every look maps to an existing template family', () => {
    const fam = new Set(TEMPLATE_FAMILIES.map(f => f.id));
    for (const l of LOOKS) expect(fam.has(l.template)).toBe(true);
  });
  it('bilingual names and a bold idea on every look', () => {
    for (const l of LOOKS) {
      expect(l.name.ar && l.name.en && l.idea.ar && l.idea.en).toBeTruthy();
    }
  });
  it('getLook resolves ids and rejects unknown/empty', () => {
    expect(getLook('qamar.atelier')?.name.en).toBe('Atelier');
    expect(getLook('qamar.nope')).toBeUndefined();
    expect(getLook(null)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it** — `npm run build -w packages/shared && npx vitest run tests/unit/looks-registry.test.ts` → FAIL (`LOOKS` not exported).

- [ ] **Step 3: Write `types.ts`**

```ts
// packages/shared/src/looks/types.ts
import type { StoreTheme, TemplateId, BorderRadius } from '../types/store-theme';

export type LookTemplate = 'qamar' | 'souq' | 'jasmine' | 'lamma' | 'dahab';
export type LookId = `${LookTemplate}.${string}`;
export type Density = 'compact' | 'regular' | 'airy';
export type ImageRatio = '1/1' | '4/5' | '3/4' | '4/3';
export type Motion = 'none' | 'subtle' | 'expressive';

/** Colour roles as hex; converted to HSL triplets by lookTheme(). */
export interface LookTokens {
  page: string;
  surface: string;
  ink: string;
  muted: string;
  primary: string;
  onPrimary: string;
  accent: string;
  line: string;
  /** Arabic display face, body face (Arabic-capable), Latin display face — Google Fonts family names. */
  fonts: { display: string; body: string; latin: string };
  radius: BorderRadius;
  density: Density;
  imageRatio: ImageRatio;
  motion: Motion;
}

export interface LookDefinition {
  id: LookId;
  template: LookTemplate;
  letter: 'A' | 'B' | 'C';
  name: { ar: string; en: string };
  forWhom: { ar: string; en: string };
  idea: { ar: string; en: string };
  tokens: LookTokens;
  /** Component skin used to render until the template's own skin ships (Ruling LOOKS-5). */
  skin: TemplateId;
  /** 'designed' = tokens + mix only; 'built' = skin + sections shipped and reviewed (demo bar lists only built). */
  status: 'designed' | 'built';
}

/** StoreTheme keys a look owns. A stored value for one of these is a merchant override. */
export const LOOK_TOKEN_KEYS = [
  'backgroundColor',
  'foregroundColor',
  'cardColor',
  'cardForeground',
  'popoverColor',
  'popoverForeground',
  'mutedColor',
  'mutedForeground',
  'primaryColor',
  'primaryForeground',
  'accentColor',
  'accentForeground',
  'secondaryColor',
  'secondaryForeground',
  'borderColor',
  'inputColor',
  'ringColor',
  'headingFont',
  'bodyFont',
  'borderRadius',
  'density',
  'imageRatio',
  'motion',
  'bgPage',
  'bgSectionAlt',
] as const satisfies readonly (keyof StoreTheme)[];
```

- [ ] **Step 4: Write `registry.ts`** (tokens from `docs/ebda/templates/2026-10-14-directions.md`; contrast-tuned values where the doc's accent fails as a button fill — Task 2 enforces)

```ts
// packages/shared/src/looks/registry.ts
import type { LookDefinition, LookTemplate } from './types';

export const LOOK_TEMPLATES: readonly LookTemplate[] = [
  'dahab',
  'qamar',
  'souq',
  'jasmine',
  'lamma',
];

const L = (d: LookDefinition) => d;
export const LOOKS: readonly LookDefinition[] = [
  L({
    id: 'qamar.atelier',
    template: 'qamar',
    letter: 'A',
    skin: 'minimal',
    status: 'designed',
    name: { ar: 'أتيليه', en: 'Atelier' },
    forWhom: { ar: 'لبوتيك هدومه بتتكلم لوحدها.', en: 'For a boutique whose clothes speak alone.' },
    idea: {
      ar: 'صور كبيرة وواجهة قليلة: الهدوم هي الواجهة.',
      en: 'Oversized photography, almost no chrome.',
    },
    tokens: {
      page: '#FFFFFF',
      surface: '#FFFFFF',
      ink: '#141414',
      muted: '#5C5C5C',
      primary: '#141414',
      onPrimary: '#FFFFFF',
      accent: '#6E1F2A',
      line: '#E6E6E6',
      fonts: {
        display: 'Noto Naskh Arabic',
        body: 'IBM Plex Sans Arabic',
        latin: 'Cormorant Garamond',
      },
      radius: 'none',
      density: 'airy',
      imageRatio: '3/4',
      motion: 'subtle',
    },
  }),
  L({
    id: 'qamar.lookbook',
    template: 'qamar',
    letter: 'B',
    skin: 'minimal',
    status: 'designed',
    name: { ar: 'لوك بوك', en: 'Lookbook' },
    forWhom: {
      ar: 'للستايلست والمحلات اللي بتبيع لوك كامل.',
      en: 'For stylists who sell whole outfits.',
    },
    idea: { ar: 'اشتري اللوك كله بضغطة.', en: 'Shop the whole outfit in one tap.' },
    tokens: {
      page: '#1E2340',
      surface: '#2A3158',
      ink: '#F4F1FA',
      muted: '#C3C0D8',
      primary: '#E8A33D',
      onPrimary: '#1E2340',
      accent: '#E8A33D',
      line: '#3B4270',
      fonts: { display: 'Lalezar', body: 'Tajawal', latin: 'Archivo' },
      radius: 'md',
      density: 'regular',
      imageRatio: '4/5',
      motion: 'expressive',
    },
  }),
  L({
    id: 'qamar.vitrine',
    template: 'qamar',
    letter: 'C',
    skin: 'minimal',
    status: 'designed',
    name: { ar: 'فاترينة', en: 'Vitrine' },
    forWhom: { ar: 'لهدوم المناسبات: فرح وخطوبة وسهرة.', en: 'For occasion wear.' },
    idea: { ar: 'تسوّق حسب المناسبة.', en: 'Occasion-first navigation.' },
    tokens: {
      page: '#F5F5F6',
      surface: '#FFFFFF',
      ink: '#1A1A1F',
      muted: '#55555E',
      primary: '#1F4E54',
      onPrimary: '#FFFFFF',
      accent: '#9E5E5E',
      line: '#E0E0E5',
      fonts: { display: 'Aref Ruqaa', body: 'Noto Sans Arabic', latin: 'Playfair Display' },
      radius: 'sm',
      density: 'regular',
      imageRatio: '3/4',
      motion: 'subtle',
    },
  }),
  L({
    id: 'souq.catalogue',
    template: 'souq',
    letter: 'A',
    skin: 'minimal',
    status: 'designed',
    name: { ar: 'كتالوج', en: 'Catalogue' },
    forWhom: {
      ar: 'لمحل فيه أصناف كتير والزبون عارف عايز إيه.',
      en: 'For many SKUs and shoppers who know what they want.',
    },
    idea: { ar: 'توصل للي عايزه في ضغطتين.', en: 'Find it in two taps.' },
    tokens: {
      page: '#FFFFFF',
      surface: '#F5F7FA',
      ink: '#10151C',
      muted: '#555D69',
      primary: '#1F5FD6',
      onPrimary: '#FFFFFF',
      accent: '#1F5FD6',
      line: '#E2E6EC',
      fonts: {
        display: 'IBM Plex Sans Arabic',
        body: 'IBM Plex Sans Arabic',
        latin: 'IBM Plex Sans',
      },
      radius: 'md',
      density: 'compact',
      imageRatio: '1/1',
      motion: 'subtle',
    },
  }),
  L({
    id: 'souq.night',
    template: 'souq',
    letter: 'B',
    skin: 'minimal',
    status: 'designed',
    name: { ar: 'سوق الليل', en: 'Night souq' },
    forWhom: {
      ar: 'لتاجر عايز دفا وشخصية.',
      en: 'For a retailer who wants warmth and personality.',
    },
    idea: { ar: 'سوق منوّر من غير زحمة.', en: 'Lit and alive without clutter.' },
    tokens: {
      page: '#0F3B2E',
      surface: '#14503F',
      ink: '#F6F3EA',
      muted: '#B4CDC0',
      primary: '#C89B3C',
      onPrimary: '#10151C',
      accent: '#E2702B',
      line: '#1E5A48',
      fonts: { display: 'Changa', body: 'Cairo', latin: 'Manrope' },
      radius: 'md',
      density: 'regular',
      imageRatio: '1/1',
      motion: 'expressive',
    },
  }),
  L({
    id: 'souq.showroom',
    template: 'souq',
    letter: 'C',
    skin: 'minimal',
    status: 'designed',
    name: { ar: 'شو روم', en: 'Showroom' },
    forWhom: {
      ar: 'لمجموعة صغيرة فاخرة بتتباع قطعة قطعة.',
      en: 'For a small premium range sold one object at a time.',
    },
    idea: { ar: 'المنتج هو البطل.', en: 'Product as hero.' },
    tokens: {
      page: '#F2F3F5',
      surface: '#FFFFFF',
      ink: '#0B0C0E',
      muted: '#565B63',
      primary: '#2A6BFF',
      onPrimary: '#FFFFFF',
      accent: '#2A6BFF',
      line: '#DFE2E7',
      fonts: { display: 'Alexandria', body: 'Readex Pro', latin: 'Inter Tight' },
      radius: 'lg',
      density: 'airy',
      imageRatio: '1/1',
      motion: 'subtle',
    },
  }),
  L({
    id: 'jasmine.apothecary',
    template: 'jasmine',
    letter: 'A',
    skin: 'minimal',
    status: 'designed',
    name: { ar: 'عطارة', en: 'Apothecary' },
    forWhom: {
      ar: 'للعناية الطبيعية اللي الثقة فيها من مكوناتها.',
      en: 'For natural skincare trusted for its ingredients.',
    },
    idea: { ar: 'المكونات الأول، وبعدين المنتج.', en: 'Ingredients first.' },
    tokens: {
      page: '#2E2A22',
      surface: '#3A352B',
      ink: '#F3EFE6',
      muted: '#CFC7B6',
      primary: '#C9822B',
      onPrimary: '#1E1B16',
      accent: '#D9984A',
      line: '#4A4438',
      fonts: { display: 'Amiri', body: 'Noto Sans Arabic', latin: 'Fraunces' },
      radius: 'sm',
      density: 'regular',
      imageRatio: '4/5',
      motion: 'subtle',
    },
  }),
  L({
    id: 'jasmine.bloom',
    template: 'jasmine',
    letter: 'B',
    skin: 'minimal',
    status: 'designed',
    name: { ar: 'بلوم', en: 'Bloom' },
    forWhom: {
      ar: 'للمكياج وجمهور صغير بيختار بالدرجة.',
      en: 'For colour cosmetics chosen by shade.',
    },
    idea: { ar: 'لون المنتج هو لون الصفحة.', en: 'The product colour is the page colour.' },
    tokens: {
      page: '#F6D7DC',
      surface: '#FFFFFF',
      ink: '#3A1E2A',
      muted: '#66404E',
      primary: '#B0154F',
      onPrimary: '#FFFFFF',
      accent: '#B0154F',
      line: '#E9C0C8',
      fonts: { display: 'Rubik', body: 'Tajawal', latin: 'DM Sans' },
      radius: 'lg',
      density: 'regular',
      imageRatio: '1/1',
      motion: 'expressive',
    },
  }),
  L({
    id: 'jasmine.clinic',
    template: 'jasmine',
    letter: 'C',
    skin: 'minimal',
    status: 'designed',
    name: { ar: 'عيادة', en: 'Clinic' },
    forWhom: {
      ar: 'للمواد الفعالة لما الزبون عنده مشكلة يحلها.',
      en: 'For actives that solve a concern.',
    },
    idea: { ar: 'الروتين هو القائمة.', en: 'The routine is the navigation.' },
    tokens: {
      page: '#FFFFFF',
      surface: '#E6F5F2',
      ink: '#13212B',
      muted: '#4A5862',
      primary: '#1F7F6C',
      onPrimary: '#FFFFFF',
      accent: '#1F7F6C',
      line: '#D3E8E3',
      fonts: { display: 'Readex Pro', body: 'Readex Pro', latin: 'Figtree' },
      radius: 'md',
      density: 'airy',
      imageRatio: '1/1',
      motion: 'subtle',
    },
  }),
  L({
    id: 'lamma.table',
    template: 'lamma',
    letter: 'A',
    skin: 'minimal',
    status: 'designed',
    name: { ar: 'سفرة العيلة', en: 'Family table' },
    forWhom: {
      ar: 'لمطبخ بيتي بياخد طلبات زي المطعم.',
      en: 'For a home kitchen taking same-day orders.',
    },
    idea: { ar: 'اطلب زي المنيو، مش زي المحل.', en: 'Order like a menu.' },
    tokens: {
      page: '#FFFFFF',
      surface: '#F7E6E1',
      ink: '#2A1A14',
      muted: '#655149',
      primary: '#B5482E',
      onPrimary: '#FFFFFF',
      accent: '#3E7A3A',
      line: '#EAD8D2',
      fonts: { display: 'El Messiri', body: 'Cairo', latin: 'Fraunces' },
      radius: 'md',
      density: 'regular',
      imageRatio: '4/3',
      motion: 'subtle',
    },
  }),
  L({
    id: 'lamma.notebook',
    template: 'lamma',
    letter: 'B',
    skin: 'minimal',
    status: 'designed',
    name: { ar: 'كشكول المطبخ', en: 'Kitchen notebook' },
    forWhom: { ar: 'لطباخة واحدة اسمها هو البراند.', en: 'For one named cook who is the brand.' },
    idea: { ar: 'الطباخة هي البراند.', en: 'The cook is the brand.' },
    tokens: {
      page: '#1F3D2B',
      surface: '#29503A',
      ink: '#F5F7F2',
      muted: '#C3D3C8',
      primary: '#E0A526',
      onPrimary: '#1F3D2B',
      accent: '#E0A526',
      line: '#345E46',
      fonts: { display: 'Aref Ruqaa', body: 'Noto Naskh Arabic', latin: 'Lora' },
      radius: 'sm',
      density: 'airy',
      imageRatio: '4/3',
      motion: 'subtle',
    },
  }),
  L({
    id: 'lamma.market',
    template: 'lamma',
    letter: 'C',
    skin: 'minimal',
    status: 'designed',
    name: { ar: 'سوق طازة', en: 'Fresh market' },
    forWhom: {
      ar: 'للبقالة والخضار اللي الطلب بيتكرر فيها.',
      en: 'For grocery with repeat baskets.',
    },
    idea: { ar: 'كل حاجة في ضغطتين.', en: 'Everything in two taps.' },
    tokens: {
      page: '#FFFFFF',
      surface: '#F4F4F4',
      ink: '#1B1B1B',
      muted: '#575757',
      primary: '#23744A',
      onPrimary: '#FFFFFF',
      accent: '#C8361F',
      line: '#E4E4E4',
      fonts: { display: 'Baloo Bhaijaan 2', body: 'Almarai', latin: 'Nunito' },
      radius: 'lg',
      density: 'compact',
      imageRatio: '1/1',
      motion: 'expressive',
    },
  }),
  L({
    id: 'dahab.worn',
    template: 'dahab',
    letter: 'A',
    skin: 'minimal',
    status: 'designed',
    name: { ar: 'على الإيد', en: 'Worn' },
    forWhom: {
      ar: 'لصايغ زباينه بيسألوا عن المقاس والعيار.',
      en: 'For a jeweller whose customers ask about size and karat.',
    },
    idea: { ar: 'متلبسة، مش معروضة: المقاس والعيار باينين دايمًا.', en: 'Worn, not displayed.' },
    tokens: {
      page: '#FFFFFF',
      surface: '#F6F6F6',
      ink: '#121212',
      muted: '#5A5A5A',
      primary: '#121212',
      onPrimary: '#FFFFFF',
      accent: '#9A6E2A',
      line: '#E8E8E8',
      fonts: { display: 'Reem Kufi', body: 'IBM Plex Sans Arabic', latin: 'Bodoni Moda' },
      radius: 'none',
      density: 'airy',
      imageRatio: '4/5',
      motion: 'subtle',
    },
  }),
  L({
    id: 'dahab.workshop',
    template: 'dahab',
    letter: 'B',
    skin: 'minimal',
    status: 'designed',
    name: { ar: 'الورشة', en: 'Workshop' },
    forWhom: { ar: 'لورشة فضة يدوي الصنعة فيها هي السبب.', en: 'For a handmade silver studio.' },
    idea: { ar: 'الصنعة هي المنتج.', en: 'The making is the product.' },
    tokens: {
      page: '#0F4C4A',
      surface: '#135957',
      ink: '#FFFFFF',
      muted: '#CFE2E0',
      primary: '#E2674A',
      onPrimary: '#10151C',
      accent: '#D9DDE2',
      line: '#1F6664',
      fonts: { display: 'Markazi Text', body: 'Almarai', latin: 'Libre Caslon Text' },
      radius: 'sm',
      density: 'regular',
      imageRatio: '1/1',
      motion: 'subtle',
    },
  }),
  L({
    id: 'dahab.giftbox',
    template: 'dahab',
    letter: 'C',
    skin: 'minimal',
    status: 'designed',
    name: { ar: 'علبة هدية', en: 'Gift box' },
    forWhom: {
      ar: 'لمشتري الهدايا اللي بيبدأ بمين وبكام.',
      en: 'For gift buyers who start with who and how much.',
    },
    idea: { ar: 'تسوّق حسب الشخص والميزانية.', en: 'Shop by recipient and budget.' },
    tokens: {
      page: '#FFFFFF',
      surface: '#F2C9C4',
      ink: '#16201C',
      muted: '#4E5A54',
      primary: '#0E5C46',
      onPrimary: '#FFFFFF',
      accent: '#7E5E27',
      line: '#E6E6E6',
      fonts: { display: 'Kufam', body: 'Tajawal', latin: 'Italiana' },
      radius: 'md',
      density: 'regular',
      imageRatio: '1/1',
      motion: 'subtle',
    },
  }),
];

export function getLook(id: string | null | undefined): LookDefinition | undefined {
  if (!id) return undefined;
  return LOOKS.find(l => l.id === id);
}
export function looksForTemplate(t: LookTemplate): LookDefinition[] {
  return LOOKS.filter(l => l.template === t);
}
```

`index.ts`: `export * from './types'; export * from './registry'; export * from './compose'; export * from './fonts';` (compose/fonts land in Tasks 3–4; until then export only types + registry).

- [ ] **Step 5: Run** — rebuild shared, run the test → PASS.
- [ ] **Step 6: Commit** — `git add packages/shared/src/looks/types.ts packages/shared/src/looks/registry.ts packages/shared/src/looks/index.ts packages/shared/src/index.ts tests/unit/looks-registry.test.ts && git commit -m "feat(shared): look registry with the 15 approved looks"`

### Task 2: Contrast + no-cream guard for every look

**Files:** Test: `tests/unit/looks-contrast.test.ts` (fixes go into `registry.ts` if a pair fails)

**Interfaces:** Consumes `LOOKS`, `contrastRatio(bg, fg)`, `parseColorToRgb` (color.ts).

- [ ] **Step 1: Write the test**

```ts
// tests/unit/looks-contrast.test.ts
import { describe, it, expect } from 'vitest';
import { LOOKS, contrastRatio } from '@ebda/shared';

const PAIRS: [string, (t: any) => [string, string]][] = [
  ['ink on page', t => [t.page, t.ink]],
  ['ink on surface', t => [t.surface, t.ink]],
  ['muted on page', t => [t.page, t.muted]],
  ['muted on surface', t => [t.surface, t.muted]],
  ['onPrimary on primary', t => [t.primary, t.onPrimary]],
  ['accent text on page', t => [t.page, t.accent]],
];

function hexToOklchLC(hex: string): { L: number; C: number; h: number } {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [lin((n >> 16) & 255), lin((n >> 8) & 255), lin(n & 255)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}

describe('every look meets AA', () => {
  for (const look of LOOKS)
    for (const [label, pick] of PAIRS)
      it(`${look.id}: ${label} ≥ 4.5`, () => {
        const [bg, fg] = pick(look.tokens);
        expect(contrastRatio(bg, fg)).toBeGreaterThanOrEqual(4.5);
      });
});

describe('no cream/sand page backgrounds', () => {
  for (const look of LOOKS)
    it(`${look.id} page is not in the cream band`, () => {
      const { L, C, h } = hexToOklchLC(look.tokens.page);
      const cream = L >= 0.84 && L <= 0.97 && C < 0.06 && h >= 40 && h <= 100;
      expect(cream).toBe(false);
    });
});
```

- [ ] **Step 2: Run** — `npx vitest run tests/unit/looks-contrast.test.ts`. Any failing pair: adjust ONLY that token in `registry.ts` toward the ink end (keep hue), re-run until green; list every adjusted value in the commit body.
- [ ] **Step 3: Commit** — `git add tests/unit/looks-contrast.test.ts packages/shared/src/looks/registry.ts && git commit -m "test(shared): aa contrast and no-cream guard for every look"`

### Task 3: New theme keys + `composeStoreTheme` used by every resolver site

**Files:**

- Modify: `packages/shared/src/types/store-theme.ts` (add to `StoreTheme`: `density?: Density; imageRatio?: ImageRatio; motion?: Motion;` and to `DEFAULT_THEME`: `density: 'regular', imageRatio: '1/1', motion: 'subtle'`; import the types from `../looks/types`)
- Create: `packages/shared/src/looks/compose.ts`
- Modify: `apps/web/src/lib/store-resolver.ts:383`, `:553`, `:887` (each `{ ...templateTheme, ...customTheme }` → `composeStoreTheme({ template, look: storeData.look, theme: customTheme })`); add `look` to the store select used by each site.
- Test: `tests/unit/looks-compose.test.ts`

**Interfaces:**

- Produces: `lookTheme(look: LookDefinition): Partial<StoreTheme>`; `composeStoreTheme(i: { template: TemplateId; look?: string | null; theme?: Record<string, unknown> | null }): StoreTheme`; `overriddenLookKeys(theme: Record<string, unknown> | null | undefined, look: LookDefinition): (typeof LOOK_TOKEN_KEYS)[number][]`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/looks-compose.test.ts
import { describe, it, expect } from 'vitest';
import {
  composeStoreTheme,
  getLook,
  lookTheme,
  overriddenLookKeys,
  hexToHsl,
  getTemplateTheme,
} from '@ebda/shared';

describe('composeStoreTheme', () => {
  const atelier = getLook('qamar.atelier')!;
  it('look tokens sit over the skin theme', () => {
    const t = composeStoreTheme({ template: 'minimal', look: 'qamar.atelier', theme: {} });
    expect(t.backgroundColor).toBe(hexToHsl('#FFFFFF'));
    expect(t.accentColor).toBe(hexToHsl(atelier.tokens.accent));
    expect(t.headingFont).toBe('Noto Naskh Arabic');
    expect(t.density).toBe('airy');
  });
  it('stored merchant values win over the look', () => {
    const t = composeStoreTheme({
      template: 'minimal',
      look: 'qamar.atelier',
      theme: { primaryColor: '1 2% 3%' },
    });
    expect(t.primaryColor).toBe('1 2% 3%');
  });
  it('unknown look id falls back to the skin theme, never throws', () => {
    const t = composeStoreTheme({ template: 'minimal', look: 'qamar.deleted', theme: {} });
    expect(t.primaryColor).toBe(getTemplateTheme('minimal').primaryColor);
  });
  it('null look = legacy store, unchanged behaviour', () => {
    expect(composeStoreTheme({ template: 'modern', look: null, theme: { x: 1 } as any })).toEqual({
      ...getTemplateTheme('modern'),
      x: 1,
    });
  });
  it('overriddenLookKeys lists only stored keys that differ from the look', () => {
    const lt = lookTheme(atelier);
    expect(
      overriddenLookKeys(
        { primaryColor: lt.primaryColor, accentColor: '0 0% 0%', showQuickAdd: true },
        atelier
      )
    ).toEqual(['accentColor']);
  });
});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**

```ts
// packages/shared/src/looks/compose.ts
import type { StoreTheme, TemplateId } from '../types/store-theme';
import { getTemplateTheme } from '../types/store-theme';
import { hexToHsl } from '../utils/color';
import { getLook } from './registry';
import { LOOK_TOKEN_KEYS, type LookDefinition } from './types';

export function lookTheme(look: LookDefinition): Partial<StoreTheme> {
  const t = look.tokens;
  const h = hexToHsl;
  return {
    backgroundColor: h(t.page),
    foregroundColor: h(t.ink),
    cardColor: h(t.surface),
    cardForeground: h(t.ink),
    popoverColor: h(t.surface),
    popoverForeground: h(t.ink),
    mutedColor: h(t.surface),
    mutedForeground: h(t.muted),
    secondaryColor: h(t.surface),
    secondaryForeground: h(t.ink),
    primaryColor: h(t.primary),
    primaryForeground: h(t.onPrimary),
    accentColor: h(t.accent),
    accentForeground: h(t.onPrimary),
    borderColor: h(t.line),
    inputColor: h(t.line),
    ringColor: h(t.primary),
    bgPage: t.page,
    bgSectionAlt: t.surface,
    headingFont: t.fonts.display,
    bodyFont: t.fonts.body,
    borderRadius: t.radius,
    density: t.density,
    imageRatio: t.imageRatio,
    motion: t.motion,
  } as Partial<StoreTheme>;
}

export function composeStoreTheme(i: {
  template: TemplateId;
  look?: string | null;
  theme?: Record<string, unknown> | null;
}): StoreTheme {
  const look = getLook(i.look);
  return {
    ...getTemplateTheme(i.template),
    ...(look ? lookTheme(look) : {}),
    ...((i.theme ?? {}) as Partial<StoreTheme>),
  } as StoreTheme;
}

export function overriddenLookKeys(
  theme: Record<string, unknown> | null | undefined,
  look: LookDefinition
): (typeof LOOK_TOKEN_KEYS)[number][] {
  if (!theme) return [];
  const base = lookTheme(look) as Record<string, unknown>;
  return LOOK_TOKEN_KEYS.filter(k => k in theme && theme[k] !== undefined && theme[k] !== base[k]);
}
```

Before editing `bgPage`/`bgSectionAlt`: check their stored format in `store-theme.ts` (hex vs triplet) and match it.

- [ ] **Step 4: Wire the resolver** — at each of the 3 sites replace the merge with `composeStoreTheme({ template: storeData.template || 'modern', look: storeData.look, theme: customTheme })`; add `look: true` to the Prisma select/definer projection feeding each site (grep `template: true` near each; if a definer `ebda_*` returns the row, add `look` to its SQL in Task 5's migration).
- [ ] **Step 5: Run** compose test + `npx vitest run tests/unit/builder-homepage-characterization.test.tsx` (must stay byte-identical: legacy stores have `look = null`).
- [ ] **Step 6: Commit** — `git commit -m "feat(shared): compose store theme from skin, look and merchant overrides"` (explicit paths).

### Task 4: Storefront consumes the new tokens + loads only the look's fonts

**Files:**

- Create: `packages/shared/src/looks/fonts.ts`
- Modify: `apps/web/src/lib/theme-css.ts` (emit vars), `apps/web/src/contexts/StoreContext.tsx` `themeToCssVars` (same vars — keep both in sync; add a test that they produce identical var sets), `apps/web/src/app/layout.tsx` (one `<link rel="stylesheet">` for the look's fonts when `look` set), `apps/web/src/styles/globals.css` (consumers)
- Test: `tests/unit/looks-fonts.test.ts`, extend `tests/unit/theme-css*.test.ts` if present (grep) else add `tests/unit/looks-css-vars.test.ts`

**Interfaces:** Produces `lookFontsHref(look: LookDefinition): string` and CSS vars `--font-display`, `--font-body`, `--font-latin`, `--space-unit`, `--image-ratio`, `--motion-duration`.

- [ ] **Step 1: Tests**

```ts
// tests/unit/looks-fonts.test.ts
import { describe, it, expect } from 'vitest';
import { LOOKS, lookFontsHref } from '@ebda/shared';
import { buildThemeStyleTag } from '../../apps/web/src/lib/theme-css';
import { composeStoreTheme } from '@ebda/shared';

describe('look fonts', () => {
  it('one Google Fonts css2 URL per look with exactly its 3 families, display=swap', () => {
    for (const l of LOOKS) {
      const u = new URL(lookFontsHref(l));
      expect(u.origin + u.pathname).toBe('https://fonts.googleapis.com/css2');
      expect(u.searchParams.getAll('family')).toHaveLength(
        new Set(Object.values(l.tokens.fonts)).size
      );
      expect(u.searchParams.get('display')).toBe('swap');
    }
  });
  it('display/body stacks always end in the platform Arabic + sans fallbacks', () => {
    const css = buildThemeStyleTag(
      composeStoreTheme({ template: 'minimal', look: 'qamar.atelier', theme: {} })
    );
    expect(css).toMatch(
      /--font-display:\s*"Noto Naskh Arabic", var\(--font-arabic\), var\(--font-sans\)/
    );
    expect(css).toMatch(
      /--font-body:\s*"IBM Plex Sans Arabic", var\(--font-arabic\), var\(--font-sans\)/
    );
  });
  it('density, ratio and motion become vars', () => {
    const css = buildThemeStyleTag(
      composeStoreTheme({ template: 'minimal', look: 'lamma.market', theme: {} })
    );
    expect(css).toContain('--space-unit: 0.875');
    expect(css).toContain('--image-ratio: 1 / 1');
    expect(css).toContain('--motion-duration: 280ms');
  });
});
```

- [ ] **Step 2: Implement `fonts.ts`**

```ts
// packages/shared/src/looks/fonts.ts
import type { LookDefinition } from './types';
/** Weights per family actually used by the looks (display 600/700, body 400/500/700). */
export const LOOK_FONT_SPECS: Record<string, string> = {
  'Noto Naskh Arabic': 'wght@400;700',
  'IBM Plex Sans Arabic': 'wght@400;500;600;700',
  'Cormorant Garamond': 'wght@600',
  Lalezar: '',
  Tajawal: 'wght@400;500;700',
  Archivo: 'wght@500;700',
  'Aref Ruqaa': 'wght@400;700',
  'Noto Sans Arabic': 'wght@400;500;600;700',
  'Playfair Display': 'wght@600',
  'IBM Plex Sans': 'wght@500;600',
  Changa: 'wght@600;700',
  Cairo: 'wght@400;600;700',
  Manrope: 'wght@600;700',
  Alexandria: 'wght@500;700',
  'Readex Pro': 'wght@400;500;600',
  'Inter Tight': 'wght@500;600',
  Amiri: 'wght@400;700',
  Fraunces: 'wght@600',
  Rubik: 'wght@500;700',
  'DM Sans': 'wght@500;700',
  Figtree: 'wght@500;600',
  'El Messiri': 'wght@600;700',
  Lora: 'wght@500;600',
  'Baloo Bhaijaan 2': 'wght@600;700',
  Almarai: 'wght@400;700;800',
  Nunito: 'wght@600;700;800',
  'Reem Kufi': 'wght@600',
  'Bodoni Moda': 'wght@600',
  'Markazi Text': 'wght@600',
  'Libre Caslon Text': 'wght@400;700',
  Kufam: 'wght@600',
  Italiana: '',
};
export function lookFontsHref(look: LookDefinition): string {
  const fams = [...new Set(Object.values(look.tokens.fonts))];
  const q = fams.map(f => {
    const spec = LOOK_FONT_SPECS[f];
    if (spec === undefined) throw new Error(`no font spec for ${f}`);
    return 'family=' + encodeURIComponent(f).replace(/%20/g, '+') + (spec ? ':' + spec : '');
  });
  return `https://fonts.googleapis.com/css2?${q.join('&')}&display=swap`;
}
```

- [ ] **Step 3: Emit vars** in `buildThemeStyleTag` and `themeToCssVars`: `--font-display: "<headingFont>", var(--font-arabic), var(--font-sans)` (only when `headingFont` set), same for `--font-body` from `bodyFont`; `--space-unit` = `{compact: 0.875, regular: 1, airy: 1.25}[density]`; `--image-ratio` = `imageRatio.replace('/', ' / ')`; `--motion-duration` = `{none: '0ms', subtle: '180ms', expressive: '280ms'}[motion]`.
- [ ] **Step 4: Consumers** in `globals.css`: `body { font-family: var(--font-body, var(--font-arabic), var(--font-sans)); }` scoped to `[data-look]` only (set `data-look={look}` on `<body>` in `layout.tsx` when a look is set — legacy stores untouched); `[data-look] h1,[data-look] h2,[data-look] h3 { font-family: var(--font-display); }`; product-card image wrappers use `aspect-ratio: var(--image-ratio)` under `[data-look]`; section padding multiplies by `--space-unit` under `[data-look]`; transition durations use `--motion-duration`, and `@media (prefers-reduced-motion: reduce) { [data-look] { --motion-duration: 0ms } }`.
- [ ] **Step 5: Font link** — in `layout.tsx`, when `getLook(store.look)` exists render `<link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />` + `<link rel="stylesheet" href={lookFontsHref(look)} />`. Check the storefront CSP (`apps/web/next.config.js` style-src/font-src) already allows fonts.googleapis.com / fonts.gstatic.com (it does at time of writing — re-verify).
- [ ] **Step 6: Run** the new tests + `tests/unit/builder-homepage-characterization.test.tsx` (legacy unchanged) → PASS. Commit (`feat(web): look tokens drive fonts, density, image ratio and motion`).

### Task 5: Migration — `stores.look` + `stores.is_demo`

**Files:** `packages/database/prisma/migrations/20261015000000_store_look_and_demo/migration.sql`, `packages/database/prisma/schema.prisma` (model Store: `look String? @map("look")`, `isDemo Boolean @default(false) @map("is_demo")`), definer functions that project store columns (grep `CREATE OR REPLACE FUNCTION ebda_` in migrations for ones returning `template`; add `look`, `is_demo` the same way in this migration).

- [ ] **Step 1: Migration SQL**

```sql
-- 20261015000000_store_look_and_demo: additive (Rulings LOOKS-2, LOOKS-4)
ALTER TABLE "stores" ADD COLUMN "look" TEXT;
ALTER TABLE "stores" ADD COLUMN "is_demo" BOOLEAN NOT NULL DEFAULT false;
-- look ids are validated in the API against the shared registry; a CHECK on format only:
ALTER TABLE "stores" ADD CONSTRAINT "stores_look_format" CHECK ("look" IS NULL OR "look" ~ '^(qamar|souq|jasmine|lamma|dahab)\.[a-z]+$');
```

Plus `CREATE OR REPLACE` for every definer that returns store identity columns, adding `look` and `is_demo` (copy each function's current body from its latest migration; change only the projection).

- [ ] **Step 2:** `npm run db:generate` then `npx prisma migrate diff` against a local Postgres (docker compose) to confirm no drift; run `tests/integration/rls-ebda-app.test.ts` (new columns on an RLS'd table need no policy change — prove it stays green).
- [ ] **Step 3: Commit** — `feat(database): stores.look and stores.is_demo`.

### Task 6: API — `applyLook`, `PUT /stores/:id/look`, theme key delete

**Files:** `apps/api/src/services/store.service.ts`, `apps/api/src/routes/store.routes.ts`, `apps/api/src/services/page-builder.service.ts` (reuse existing publish/draft functions — read their signatures first), Test: `tests/integration/store-look.test.ts`, `tests/unit/store-theme-null-delete.test.ts`

**Interfaces:**

- Produces: `StoreService.applyLook(storeId: string, lookId: string, opts: { design: 'keep' | 'reset' }): Promise<{ store: Store; builder: 'published' | 'draft' }>`; route `PUT /api/v1/stores/:id/look` body `{ lookId: string, design: 'keep'|'reset' }` → `200 { success: true, data: { look, template, builder } }`; `400 INVALID_LOOK`.
- Changes: `updateTheme` treats a `null` value as "delete this key" (needed for reset-one-override in Task 8).

- [ ] **Step 1: Tests first** (integration, real `ebda_app` client bound per request like `store-creation-tenant-guard.test.ts`):
  - `applyLook keep vs reset`: store with theme `{ primaryColor: 'X', showQuickAdd: true }` → keep: theme unchanged, `look` set, `template = look.skin`; reset: `primaryColor` removed, `showQuickAdd` kept (non-look key).
  - unknown look → 400 `INVALID_LOOK`, store unchanged.
  - empty store (no published home revision) → builder published with the look's family sections; store with a published revision → a draft is created and the published revision is untouched.
  - caches: assert `bustStoreCaches` called once with id/slug/domain (spy).
  - authz: another merchant's store id → 403/404 via `requireStoreAccess`.
  - `updateTheme({ accentColor: null })` removes the key.
- [ ] **Step 2: Implement**

```ts
// store.service.ts
static async applyLook(storeId: string, lookId: string, opts: { design: 'keep' | 'reset' }) {
  const look = getLook(lookId);
  if (!look) throw new AppError(400, 'INVALID_LOOK', 'Unknown look');
  const store = await this.getById(storeId);
  const theme = { ...((store.theme as Record<string, unknown>) || {}) };
  if (opts.design === 'reset') for (const k of LOOK_TOKEN_KEYS) delete theme[k];
  const updated = await withStore(storeId, tx =>
    tx.store.update({
      where: { id: storeId },
      data: { look: look.id, template: look.skin as StoreTemplate, theme: theme as Prisma.InputJsonValue },
    })
  );
  const builder = await PageBuilderService.applyFamilyForLook(storeId, look.template); // see Step 3
  await StoreService.invalidateCache(store);
  await bustStoreCaches(updated.id, updated.slug, updated.domain);
  return { store: updated, builder };
}
```

`updateTheme`: build `merged`, then `for (const [k, v] of Object.entries(theme)) if (v === null) delete merged[k];` — grep every `updateTheme`/`PUT …/theme` caller for intentional `null` writes first; if any exist, add an explicit `{ $delete: [...] }` field instead and document why.

- [ ] **Step 3: `PageBuilderService.applyFamilyForLook(storeId, family)`** — load the current home document (published, else the store's legacy-derived document the builder already builds on first open — reuse that function), `applyTemplateFamily(doc, family)`, then: no published revision → publish it (existing publish path, which back-writes `layout_settings` and busts caches); else save as draft (existing `PUT /draft` service path with the current `baseRev`). Return `'published' | 'draft'`.
- [ ] **Step 4: Route** — `router.put('/:id/look', authenticate, requireMfaEnrolled, authorize('store_admin','super_admin'), requireStoreAccess, validate(z.object({ lookId: z.string().max(40), design: z.enum(['keep','reset']).default('keep') })), handler)`, mirroring the `/template` route's middleware exactly.
- [ ] **Step 5:** `updateTemplate`'s valid list → keep for legacy skins, but when a store has a `look`, changing the bare template clears `look` (a merchant who picks a legacy skin leaves the looks system) — test it.
- [ ] **Step 6:** Run integration tests (`DATABASE_URL=<local pg> npx vitest run tests/integration/store-look.test.ts --retry=0`) → PASS. Commit (`feat(api): apply a look without losing content`).

### Task 7: Onboarding picks a look (single source of the template list)

**Files:** `apps/api/src/services/onboarding.service.ts:39`, `apps/api/src/routes/onboarding.routes.ts:59`, `apps/admin/src/app/onboarding/_components/{types.ts,TemplateStep.tsx}`, Create `apps/admin/src/components/looks/LookPicker.tsx` + `LookPicker.test.tsx`, look thumbnails `apps/admin/public/looks/<lookId>.webp` (generated from the marketing looks generator — add an `--thumbs` export mode in `apps/marketing/scripts/looks/export.py` writing 360px-wide first-screen crops), i18n ar/en.

**Interfaces:** Consumes `LOOKS`, `looksForTemplate`, `StoreService.applyLook`. `POST /onboarding/store` accepts `lookId?: string` (validated with `getLook`) — when present the service calls `applyLook(newStoreId, lookId, { design: 'reset' })` after provisioning; `SELF_SERVE_TEMPLATES` stays only for legacy callers. The admin TemplateStep calls `PUT /stores/:id/look` instead of `/template`.

- [ ] **Step 1: `LookPicker` test** — renders 5 template tabs (Dahab first), 3 looks each with name/forWhom/idea in the active locale; arrow keys move between tabs (role=tablist); selecting a look calls `onChange('qamar.lookbook')`; every thumbnail has alt text = look name; Arabic is RTL.
- [ ] **Step 2: Implement** `LookPicker` (props `{ value: LookId | null; onChange(id: LookId): void; locale: 'ar'|'en' }`), reusing admin's existing tab/radio-card components (grep `role="tablist"` in apps/admin for the house pattern).
- [ ] **Step 3:** Wire into TemplateStep (replaces the 5-skin grid) and the API route; integration test: onboarding with `lookId: 'dahab.worn'` → store has `look='dahab.worn'`, `template='minimal'`, published home with Dahab family sections.
- [ ] **Step 4:** Commit (`feat(admin): pick a look at onboarding`).

### Task 8: Switch look later + overrides with reset in the editor

**Files:** `apps/admin/src/app/stores/[id]/template/page.tsx` (replace the 6-skin list with `LookPicker` + a confirm dialog "Keep my colour and font changes / Start fresh with this look" defaulting to keep), builder `_components/ThemeSettingsPanel.tsx` (badge + reset), i18n.

- [ ] **Step 1: Tests** — template page: choosing a look opens the dialog; "keep" sends `{design:'keep'}`, "start fresh" sends `{design:'reset'}`; after success shows "Your home page draft is ready in the editor" when `builder === 'draft'` with a link to the builder. ThemeSettingsPanel: for each key in `overriddenLookKeys(storeTheme, look)` the field shows a "معدّل / Edited" badge and a reset button that PUTs `{ [key]: null }`; no badge when the store has no look.
- [ ] **Step 2: Implement**; the reset uses the existing theme save helper (single writer: the panel owns this write, per CLAUDE.md single-writer rule).
- [ ] **Step 3:** Commit (`feat(admin): switch looks and reset single overrides`).

### Task 9: Demo store — `?look=` preview, selector bar, checkout refused

**Files:** `apps/api/src/services/order.service.ts` (`assertOrderAllowed`), `apps/web/middleware.ts`, `apps/web/src/lib/store-resolver.ts`, Create `apps/web/src/components/demo/DemoLookBar.tsx`, `apps/web/src/app/layout.tsx`, Create `scripts/storedemo/seed.mjs`, Test: `tests/integration/demo-store.test.ts`, `apps/web/src/components/demo/DemoLookBar.test.tsx`

**Interfaces:** `assertOrderAllowed(storeId)` throws `AppError(403, 'DEMO_STORE', …)` when `is_demo`; web resolver accepts `previewLook?: string` applied ONLY when `store.isDemo && getLook(previewLook)?.status === 'built'`; middleware forwards `?look=` as request header `x-demo-look` (add to `MIDDLEWARE_ASSERTED_HEADERS` so a client-sent one is stripped) and sets `Cache-Control: private, no-store` on that response.

- [ ] **Step 1: Tests**
  - order on demo store via API → 403 `DEMO_STORE`; no `orders` row, no stock hold row (query both tables).
  - `?look=qamar.atelier` on a NON-demo store → page identical to no param, response keeps normal cache headers.
  - on the demo store with a `built` look → theme vars from that look, `Cache-Control: private, no-store`; with a `designed` look → ignored.
  - spoofed `x-demo-look` request header without `?look=` → stripped.
  - `DemoLookBar`: lists only `built` looks grouped by template; selecting navigates to `?look=<id>` preserving path; labelled "متجر تجريبي · Demo store"; checkout button area shows "ده متجر تجريبي — الطلب مقفول" instead of the pay action (render `DemoCheckoutNotice` where the checkout CTA renders; grep the checkout page CTA).
- [ ] **Step 2: Implement** as specified. **Step 3:** `scripts/storedemo/seed.mjs` creates (owner role, idempotent) store slug `storedemo`, `is_demo=true`, a demo catalogue per template from the looks generator's product lists, photos uploaded to R2 under `demo/`; it PRINTS the plan and refuses to run against production without `--yes-production` (Ahmad approves before that run).
- [ ] **Step 4:** Commit (`feat(web): demo store previews built looks; checkout refused`).

### Task 10: Docs + rulings

- [ ] Create `docs/ebda/templates/looks.md` (what a look is, the layering order, how to add a look: registry entry → contrast test → thumbnail → status `built` after review), update `docs/architecture/store-theme-flags.md` (new keys density/imageRatio/motion, composeStoreTheme, override semantics, null-delete), append Rulings LOOKS-1..5 to `docs/RULINGS.md`, update `docs/ebda/templates/dahab.md` header (old skin retired by TPL-2; Dahab looks live in the registry).
- [ ] Commit (`docs(config): looks system, theme layering and rulings`).

---

## Verification (finish line)

- **Must work:** onboarding with a look → store renders with that look's colours/fonts/density on `<slug>.ebda.app` (ar + en); switching look keeps products/text/images; "keep" preserves edited colours; reset-one-override works; demo store refuses orders.
- **Exercised:** unit + integration suites above; `npm run typecheck`, `lint`, `build`; Playwright smoke: onboarding → pick `dahab.worn` → storefront screenshot at 390/1280 ar/en; production after deploy: `/health` = merge SHA, read-only SQL shows `stores.look` column, one QA store switched to a look and screenshotted (ask Ahmad before switching the prod QA store).
- **Must not change:** checkout/pricing/inventory/permissions/tenant isolation; every legacy store (look = null) renders byte-identical (characterization snapshots).
- **Done when:** all green in CI, deployed, verified live, Ahmad reviews the look picker.

## Out of scope (Phase B / E)

Per-template skins and new section types (lookbook carousel, gift finder, routine steps, maker strip, occasion tiles, ingredient hero, engraving band, making steps, reorder row); flipping looks to `status: 'built'`; full editor redesign (Phase E); deleting Ebda Store skins.
