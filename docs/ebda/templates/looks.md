# Looks

A **look** is a named design direction: colour roles, fonts, radius, density, image ratio and motion, plus a section mix for the home page. Every store has at most one (`stores.look`, nullable `TEXT`); a store with `look = null` is a legacy store and renders exactly as it did before looks existed (see "Legacy stores"). There are 15 looks, 3 per template (Rulings TPL-1, TPL-2, LOOKS-1..5 in `docs/RULINGS.md`).

Looks are **data**, not code: they live in `@force/shared` (`packages/shared/src/looks/`) over the shared section registry and token set, and never fork commerce components (Ruling LOOKS-1).

| File          | Owns                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------- |
| `types.ts`    | `LookId`, `LookTokens`, `LookDefinition`, `LOOK_TOKEN_KEYS` (the StoreTheme keys a look owns) |
| `registry.ts` | the 15 `LOOKS`, `getLook`, `looksForTemplate`                                                 |
| `compose.ts`  | `lookTheme`, `composeStoreTheme`, `overriddenLookKeys`                                        |
| `fonts.ts`    | `LOOK_FONT_SPECS`, `lookFontsHref` (the Google Fonts link for a look)                         |

## The 15 looks

All 15 are `status: 'designed'` today: tokens and section mix exist, no per-template skin yet, every look renders on `skin: 'minimal'`. The showroom lists and previews only `built` looks, so nothing is visible there until Phase B flips them after Ahmad's review.

| Id                   | Template | Name (ar)    | Name (en)        | Status   |
| -------------------- | -------- | ------------ | ---------------- | -------- |
| `qamar.atelier`      | qamar    | أتيليه       | Atelier          | designed |
| `qamar.lookbook`     | qamar    | لوك بوك      | Lookbook         | designed |
| `qamar.vitrine`      | qamar    | فاترينة      | Vitrine          | designed |
| `souq.catalogue`     | souq     | كتالوج       | Catalogue        | designed |
| `souq.night`         | souq     | سوق الليل    | Night souq       | designed |
| `souq.showroom`      | souq     | شو روم       | Showroom         | designed |
| `jasmine.apothecary` | jasmine  | عطارة        | Apothecary       | designed |
| `jasmine.bloom`      | jasmine  | بلوم         | Bloom            | designed |
| `jasmine.clinic`     | jasmine  | عيادة        | Clinic           | designed |
| `lamma.table`        | lamma    | سفرة العيلة  | Family table     | designed |
| `lamma.notebook`     | lamma    | كشكول المطبخ | Kitchen notebook | designed |
| `lamma.market`       | lamma    | سوق طازة     | Fresh market     | designed |
| `dahab.worn`         | dahab    | على الإيد    | Worn             | designed |
| `dahab.workshop`     | dahab    | الورشة       | Workshop         | designed |
| `dahab.giftbox`      | dahab    | علبة هدية    | Gift box         | designed |

The design intent of each direction is in `docs/ebda/templates/2026-10-14-directions.md`. The template ids qamar/souq/jasmine/lamma are `LookTemplate` values only; they are not `TemplateId`/`stores.template` enum values until Phase B (Ruling LOOKS-5). `LookDefinition.skin` is the skin that actually renders.

## Theme layering

One function, `composeStoreTheme({ template, look, theme })`, used by every resolver site (store resolver, builder preview, demo preview):

```
DEFAULT_THEME  <  TEMPLATE_THEMES[skin]  <  look tokens (lookTheme)  <  stores.theme
```

The merchant always wins: any key present in `stores.theme` overrides the look. An unknown or null `look` contributes nothing (skin + stored theme only), so a look id that has been renamed or removed never 500s the storefront.

`DEFAULT_THEME` deliberately gains no `density` / `imageRatio` / `motion` (Ruling LOOKS-6): those keys stay optional and are set only by a look.

## Token to CSS variable map

`themeToCssVars(theme, lookId)` (shared, SSR) and its client mirror in `StoreContext.tsx` emit the look variables, and only when `lookId` names a registered look. Values are validated by an allowlist in `apps/web/src/lib/theme-css.ts`.

| Variable              | Source                                                                                              | Value                                                                                                                                                                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--font-display`      | `headingFont` if loadable (else the look's display)                                                 | `"<Family>", var(--font-arabic), var(--font-sans)`                                                                                                                                                                                                                                  |
| `--look-font-display` | same as `--font-display`                                                                            | same string, under a name no skin rule redefines (the dahab skin sets `--font-display` on `<body>`; the `[data-look][data-pack='dahab']` rule restores the look's face and only matters for a legacy dahab-skin store that is given a look, since every look has `skin: 'minimal'`) |
| `--font-body`         | `bodyFont` if loadable (else the look's body)                                                       | `"<Family>", var(--font-arabic), var(--font-sans)`                                                                                                                                                                                                                                  |
| `--font-latin`        | the look's Latin display face, or the merchant's `headingFont` when it overrides the look's display | `"<Family>", var(--font-sans)`; used first for headings when `lang="en"`                                                                                                                                                                                                            |
| `--space-unit`        | `density`                                                                                           | `compact` 0.875, `regular` 1, `airy` 1.25                                                                                                                                                                                                                                           |
| `--image-ratio`       | `imageRatio`                                                                                        | `1/1`, `4/5`, `3/4` or `4/3` written as `4 / 5`                                                                                                                                                                                                                                     |
| `--motion-duration`   | `motion`                                                                                            | `none` 0ms, `subtle` 180ms, `expressive` 280ms                                                                                                                                                                                                                                      |

Consumers (all scoped under `[data-look]`, which the root layout sets on `<body>` only for a store with a valid look; `globals.css`):

- Headings and `.font-display` use `--font-display`; English locale uses `--font-latin` first with the Arabic display stack as fallback. Body uses `--font-body`. The fallback chain ends in the platform Arabic face, never a serif default.
- Section padding scales by `--space-unit`, but only for sections whose spacing is **unset** (`sectionSpacingClasses` adds `sp-top-default` / `sp-bottom-default` for look stores). An explicit merchant spacing preset, even "normal", is never scaled.
- Product card media uses `aspect-[var(--image-ratio,4/5)]` (`apps/web/src/templates/shared/card-size.ts`): a look store without the variable falls back to 4/5; a legacy store keeps its existing aspect classes.
- `a` and `button` transitions use `--motion-duration` (150ms fallback). Under `prefers-reduced-motion: reduce` the variable is forced to `0ms`.

A look store whose merchant cleared `headingFont`/`bodyFont` still gets the look's font (the variables fall back to the look's own faces).

**Merchant font overrides** (`resolveLookFonts` in `fonts.ts`, Ruling LOOKS-3: the merchant wins). A stored `headingFont` / `bodyFont` replaces the look's face only when it is a family in `LOOK_FONT_SPECS`; the layout's Google Fonts link (`lookFontsHref(look, theme)`) then loads it instead of the look's face. Any other family (for example a legacy store's old font carried through a `design: 'keep'` switch) is ignored for the look variables and the link, so the CSS never names a family nothing loads; the look's face paints instead. A heading override also replaces `--font-latin`, so English headings use the merchant's face too. Font-family values are allow-listed in `LOOK_VAR_PATTERNS` (letters, digits, spaces, hyphens, apostrophes; quotes, backslashes, `;`, braces, angle brackets and parentheses are refused).

Fonts load through `lookHead(lookId, theme)` (`apps/web/src/lib/look-head.ts`), which returns `{ dataLook, fontsHref }` or `null`.

## Legacy stores stay byte-identical

A store with `look = null` (or an unknown look id) gets no `data-look` attribute, no look font link, no look CSS variables and no card aspect class; `DEFAULT_THEME` carries no look keys. The `[data-look]` rules never match, so the rendered markup and CSS are unchanged. This is the Phase S finish line and is pinned by characterization tests (`tests/unit/looks-css-vars.test.ts`, `looks-root-layout-render.test.tsx`, `looks-page-renderer-spacing.test.tsx`, `apps/web/src/templates/shared/looks-card-aspect-render.test.tsx`).

## Applying a look: `StoreService.applyLook`

`PUT /stores/:id/look` with `{ look, design: 'keep' | 'reset' }`. It sets `stores.look` and `stores.template` (= the look's skin), reshapes the home page to the look's template family, and purges storefront caches after the request commits.

- **Content is always kept** (Ruling LOOKS-3). Switching never deletes products, text or images.
- **`design: 'keep'`** leaves every key in `stores.theme`; the merchant's edited colours still win and show as overrides.
- **`design: 'reset'`** deletes every `LOOK_TOKEN_KEYS` key from `stores.theme` and from the draft/builder theme, so the new look's tokens show.
- **Builder first.** `applyFamilyForLook` runs before any store write because it can refuse (409/422). A refusal throws before `stores` is touched. Routes under `/stores/:id` run in `storeScopeContext`, where each query is its own transaction, so the builder step and the store update are **not atomic**: if the store update fails after a publish, a retry converges (the store is no longer fresh, so it takes the draft path).
- **Publish vs draft.** Only a genuinely fresh store publishes: `layout_settings` null/empty/equal to `NEW_STORE_LAYOUT_SETTINGS` and no draft revision exists. Sections that fail `validatePublishReadiness` (placeholder copy, a hero slide without an image) are dropped first, the rest goes live, and the merchant adds the dropped ones in the editor. If no section survives the drop, nothing is published: the whole family is saved as a draft (an empty live home is never published). Every other store gets the new family as a **draft** and presses publish. If a fresh store's publish is still refused, it stays a draft with a logged warning rather than failing the switch (Rulings LOOKS-8..10).
- **Demo stores.** `applyLook` has no demo-specific branch. A demo store (`is_demo`) is a showroom: it previews looks via `?look=` and refuses every order (`403 DEMO_STORE` from `assertOrderAllowed`); see `docs/ebda/templates/demo-store.md`.

Onboarding chooses a look through the same service (`onboarding.service.ts`), with `design: 'reset'` (a new store has no overrides to keep).

## Brand surfaces outside the storefront

Store emails, invoices (printable and email), campaign mail and the setup guide read the brand through `storeBrandTheme({ template, look, theme })` (`apps/api/src/lib/store-brand-theme.ts`, Ruling LOOKS-14). A look store is composed with `composeStoreTheme`, so it gets the look's primary unless the merchant stored their own; a legacy store reads its stored theme exactly as before. The setup guide's brand step is complete for a store with a logo, a registered look, or a stored `primaryColor`.

## Override badges and reset

`overriddenLookKeys(theme, look)` returns the look-owned keys the merchant has stored with a value that differs from the look. The builder's `ThemeSettingsPanel` shows an "edited" badge on each and a reset button. Reset is **draft-first** (Ruling LOOKS-11): flush pending autosave, remove the key from the draft theme (omit it, never `null`) via `replaceDocument` + `saveDraftNow`, then `PUT /stores/:id/theme { key: null }` to remove it from live only if live holds it. Resetting only live would be undone on the next publish; resetting only the draft would leave live untouched until then.

`PUT /stores/:id/theme` treats `null` as "delete this key" (see `docs/architecture/store-theme-flags.md`). It also refuses (400) any `density`, `imageRatio` or `motion` value outside `LOOK_DENSITIES` / `LOOK_IMAGE_RATIOS` / `LOOK_MOTIONS` (`packages/shared/src/looks/types.ts`); `null` still deletes the key.

## Demo preview

Full flow and caching in `docs/ebda/templates/demo-store.md`; the contract:

- `?look=<id>` applies only when the store is `is_demo` AND the look is `built`. Anything else renders exactly as without the param.
- Middleware forwards a well-formed `?look=` as request header `x-demo-look` (a client-sent copy is stripped) and the response is `private, no-store` (Ruling LOOKS-12). It never takes the shared full-route-cache rewrite.
- The preview recomposes skin + look with no merchant overrides, per request, after the cached store fetch; the base store caches never hold a previewed look.
- `DemoLookBar` (`apps/web/src/components/demo/`) lists built looks and navigates to `?look=<id>` as a full document load.
- `scripts/storedemo/seed.mjs` seeds the showroom (idempotent; refuses a non-loopback database without `--yes-production`).

## Adding or changing a look

1. **Registry entry.** Add or edit the `LookDefinition` in `packages/shared/src/looks/registry.ts` (id `<template>.<name>`, matching `^(qamar|souq|jasmine|lamma|dahab)\.[a-z]+$` and the `stores_look_format` CHECK; bilingual `name`/`forWhom`/`idea`; tokens as hex; `skin`; `status: 'designed'`). Fonts must be in `LOOK_FONT_SPECS` (`fonts.ts`) so `lookFontsHref` can load them.
2. **Contrast test.** `tests/unit/looks-contrast.test.ts` runs over every registry entry: every text pair >= 4.5:1, nothing under 12px, no cream/sand page background. `looks-registry.test.ts` checks completeness (ar + en strings, A/B/C unique per template) and that `Object.keys(lookTheme(l))` equals `LOOK_TOKEN_KEYS`. Run `npx vitest run tests/unit/looks-*.test.ts`.
3. **Thumbnail.** `node apps/admin/scripts/look-thumbs.mjs [lookId ...]` renders `apps/admin/public/looks/<lookId>.webp` for the admin `LookPicker` from the marketing fragments (needs macOS Chrome, `sips`, `cwebp`).
4. **Status `built`.** Flip `status` to `'built'` only after Ahmad has reviewed the look in a browser and its skin/sections ship. That is what makes the showroom list and preview it.
5. **Docs.** Update the table above in the same change.

Do not add a look to a `Record<TemplateId, ...>` map; the four new template ids join `TemplateId` in Phase B with their skins (Ruling LOOKS-5).
