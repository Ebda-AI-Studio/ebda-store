# Looks

A **look** is a named design direction: colour roles, fonts, radius, density, image ratio and motion, plus a section mix for the home page. Every store has at most one (`stores.look`, nullable `TEXT`); a store with `look = null` is a legacy store and renders exactly as it did before looks existed (see "Legacy stores"). The five inherited Force skins are deleted: a store row that still holds one of those names renders as its mapped Ebda template at read time (`normalizeLegacyTemplate`, Rulings SKIN-DEL-1 and SKIN-DEL-8), never a crash and never a write. There are 15 looks, 3 per template (Rulings TPL-1, TPL-2, LOOKS-1..5 in `docs/RULINGS.md`).

Looks are **data**, not code: they live in `@ebda/shared` (`packages/shared/src/looks/`) over the shared section registry and token set, and never fork commerce components (Ruling LOOKS-1).

| File          | Owns                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`    | `LookId`, `LookTokens`, `LookDefinition`, `LOOK_TOKEN_KEYS` (the StoreTheme keys every look sets), `LOOK_UI_TOKEN_KEYS` (optional UI tokens: `wordmarkSize`, `overPhotoChrome`, `receiptStyle`, and the W2b card tokens `cardCta`, `cardHover`, `cardBadge`; set only by looks that need them, Rulings B1-47 and B1-60). `LookTokens.onAccent` (optional) is the text on the accent fill; absent = `onPrimary` (Vitrine sets ink on its dusty rose, Ruling B1-52) |
| `registry.ts` | the 15 `LOOKS`, `getLook`, `looksForTemplate`                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `compose.ts`  | `lookTheme`, `composeStoreTheme`, `overriddenLookKeys`                                                                                                                                                                                                                                                                                                                                                                                                            |
| `fonts.ts`    | `LOOK_FONT_SPECS`, `lookFontsHref` (the Google Fonts link for a look)                                                                                                                                                                                                                                                                                                                                                                                             |

## The 15 looks

15 of the 15 are `status: 'built'` (Phase B5 flipped the last three, the Dahab looks, in Task 6; `LOOK_TEMPLATES` keeps Dahab LAST so Qamar stays the signup default, Ruling B5-25). Earlier text: 12 of the 15 were built (the three Qamar looks, flipped in Phase B1 Task 10, the three Souq looks, flipped in Phase B2 Task 7, the three Jasmine looks, flipped in Phase B3 Task 5, and the three Lamma looks, flipped in Phase B4 Task 7, each after the independent audits; Ahmad's STOP rounds were withdrawn 2026-10-21); the other 3 (Dahab) are `designed`. The Qamar looks render on the `qamar` skin (Ruling B1-1); the Souq looks on the `souq` skin (Ruling B2-1); the Jasmine looks on the `jasmine` skin (Ruling B3-1); the Lamma looks on the `lamma` skin (Ruling B4-1); the three Dahab looks still render on `skin: 'minimal'`. The showroom lists and previews only `built` looks, so today it offers the three Qamar, the three Souq, the three Jasmine and the three Lamma looks (each template on its own demo host, Rulings B2-7, B3-8, B4-10). The admin `LookPicker` shows all 15 and, with no look chosen, opens on the first template that has a built look (Qamar; Ruling B1-19).

| Id                   | Template | Name (ar)    | Name (en)        | Status |
| -------------------- | -------- | ------------ | ---------------- | ------ |
| `qamar.atelier`      | qamar    | أتيليه       | Atelier          | built  |
| `qamar.lookbook`     | qamar    | لوك بوك      | Lookbook         | built  |
| `qamar.vitrine`      | qamar    | فاترينة      | Vitrine          | built  |
| `souq.catalogue`     | souq     | كتالوج       | Catalogue        | built  |
| `souq.night`         | souq     | سوق الليل    | Night souq       | built  |
| `souq.showroom`      | souq     | شو روم       | Showroom         | built  |
| `jasmine.apothecary` | jasmine  | عطارة        | Apothecary       | built  |
| `jasmine.bloom`      | jasmine  | بلوم         | Bloom            | built  |
| `jasmine.clinic`     | jasmine  | عيادة        | Clinic           | built  |
| `lamma.table`        | lamma    | سفرة العيلة  | Family table     | built  |
| `lamma.notebook`     | lamma    | كشكول المطبخ | Kitchen notebook | built  |
| `lamma.market`       | lamma    | سوق طازة     | Fresh market     | built  |
| `dahab.worn`         | dahab    | على الإيد    | Worn             | built  |
| `dahab.workshop`     | dahab    | الورشة       | Workshop         | built  |
| `dahab.giftbox`      | dahab    | علبة هدية    | Gift box         | built  |

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

| Variable              | Source                                                                                              | Value                                                                                                                                                                                                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--font-display`      | `headingFont` if loadable (else the look's display)                                                 | `"<Family>", var(--font-arabic), var(--font-sans)`                                                                                                                                                                                                                             |
| `--look-font-display` | same as `--font-display`                                                                            | same string, under a name no skin rule redefines (the dahab skin sets `--font-display` on `<body>`; the `[data-look][data-pack='dahab']` rule restores the look's face and only matters for a legacy dahab-skin store that is given a look, since no look uses the dahab skin) |
| `--font-body`         | `bodyFont` if loadable (else the look's body)                                                       | `"<Family>", var(--font-arabic), var(--font-sans)`                                                                                                                                                                                                                             |
| `--font-latin`        | the look's Latin display face, or the merchant's `headingFont` when it overrides the look's display | `"<Family>", var(--font-sans)`; used first for headings when `lang="en"`                                                                                                                                                                                                       |
| `--space-unit`        | `density`                                                                                           | `compact` 0.875, `regular` 1, `airy` 1.25                                                                                                                                                                                                                                      |
| `--image-ratio`       | `imageRatio`                                                                                        | `1/1`, `4/5`, `3/4` or `4/3` written as `4 / 5`                                                                                                                                                                                                                                |
| `--motion-duration`   | `motion`                                                                                            | `none` 0ms, `subtle` 180ms, `expressive` 280ms                                                                                                                                                                                                                                 |

Consumers (all scoped under `[data-look]`, which the root layout sets on `<body>` only for a store with a valid look; `globals.css`):

- Headings and `.font-display` use `--font-display`; English locale uses `--font-latin` first with the Arabic display stack as fallback. Body uses `--font-body`. The fallback chain ends in the platform Arabic face, never a serif default.
- Section padding scales by `--space-unit`, but only for sections whose spacing is **unset** (`sectionSpacingClasses` adds `sp-top-default` / `sp-bottom-default` for look stores). An explicit merchant spacing preset, even "normal", is never scaled.
- Product card media uses `aspect-[var(--image-ratio,4/5)]` (`apps/web/src/templates/shared/card-size.ts`): a look store without the variable falls back to 4/5; a legacy store keeps its existing aspect classes. The look's ratio is the DEFAULT: the skin's layout baseline contributes no product-card `cardShape`/`cardAspect` on a look store (`resolveLayoutSettings(input, template, look)`, Ruling LOOKS-15), so only a shape or aspect the merchant saved beats it.
- `a` and `button` transitions use `--motion-duration` (150ms fallback). Under `prefers-reduced-motion: reduce` the variable is forced to `0ms`.

A look store whose merchant cleared `headingFont`/`bodyFont` still gets the look's font (the variables fall back to the look's own faces). `LanguageProvider` writes no inline `body` font-family on a look store (an inline style would beat the `[data-look]` rule); a legacy store keeps its locale inline font.

**Merchant font overrides** (`resolveLookFonts` in `fonts.ts`, Ruling LOOKS-3: the merchant wins). A stored `headingFont` / `bodyFont` replaces the look's face only when it is a family in `LOOK_FONT_SPECS`; the layout's Google Fonts link (`lookFontsHref(look, theme)`) then loads it instead of the look's face. Any other family (for example a legacy store's old font carried through a `design: 'keep'` switch) is ignored for the look variables and the link, so the CSS never names a family nothing loads; the look's face paints instead. A heading override also replaces `--font-latin`, so English headings use the merchant's face too. Font-family values are allow-listed in `LOOK_VAR_PATTERNS` (letters, digits, spaces, hyphens, apostrophes; quotes, backslashes, `;`, braces, angle brackets and parentheses are refused).

Fonts load through `lookHead(lookId, theme)` (`apps/web/src/lib/look-head.ts`), which returns `{ dataLook, fontsHref }` or `null`.

## Legacy stores stay byte-identical

A store with `look = null` (or an unknown look id) gets no `data-look` attribute, no look font link, no look CSS variables and no card aspect class; `DEFAULT_THEME` carries no look keys. The `[data-look]` rules never match, so the rendered markup and CSS are unchanged. This is the Phase S finish line and is pinned by characterization tests (`tests/unit/looks-css-vars.test.ts`, `looks-root-layout-render.test.tsx`, `looks-page-renderer-spacing.test.tsx`, `apps/web/src/templates/shared/looks-card-aspect-render.test.tsx`).

## Applying a look: `StoreService.applyLook`

`PUT /stores/:id/look` with `{ look, design: 'keep' | 'reset' }`. It sets `stores.look` and `stores.template` (= the look's skin), reshapes the home page to the look's section mix (or, for a look with no mix, its template family's), and purges storefront caches after the request commits.

- **Section mix (Ruling B1-3).** A look may carry `sections: [{ type, design?, preset? }]` (`LookDefinition.sections`). `applyTemplateFamily(current, family, look, { from, design, fromSkin, toSkin })` uses the mix's order; `preset` seeds only a section the store does not have; `design` keys (`LOOK_DESIGN_KEYS`: layout, variant, columns, background, spacing, never content; hero `mode` is content and no look sets it) apply to existing sections too. A key the OUTGOING look's mix set and the incoming look does not set returns to the section default, so no look's layout leaks into the next (plan amendment C6). With `design: 'keep'` a section field the merchant changed from what the outgoing look set (or, for a key it did not set, from the section default) stays as the merchant has it; with `reset` the incoming look applies whole (C8, TPL-1). The default of a layout-backed section is the skin's own layout baseline (`resolveLayoutSettings({}, skin, look)`), not the registry preset; page-only sections use their first preset. The outgoing look is the document's `appliedLook`, which every switch writes, else `stores.look`. Text, images, product refs and blocks are never touched. A section type the new mix does not use is dropped from the DRAFT only; the published page and revision history keep it.
- **Look-tagged sections (C10).** A section with `lookTag: '<look id>'` renders only under that look when the look has a mix (`documentForLook`); untagged sections render under every look. One page can hold one hero per look (the demo showroom).
- **Chrome (Ruling B1-4).** `LookDefinition.chrome.header.logoPlacement` (`'start' | 'centre'`) is look data the look's skin reads; it is not a merchant setting yet. Jasmine sets `header: { logoPlacement: 'start', search: 'icon' }` on every look (B3-1) and `category-grid.source` (`'categories' | 'tags'`) is a look-owned design key (B3-5). Souq adds `header.search` (`'prominent' | 'icon'`, B2-1), `plp: 'autoFill'` (the listing grid fills its column, `repeat(auto-fill, minmax(11.5rem, 1fr))` from `lg`) and `listing: 'ground'` (the listing pages keep the look's ground instead of the dark-look inverse band; Night souq mattes its photos instead, B2-24).

- **Content is always kept** (Ruling LOOKS-3). Switching never deletes products, text or images.
- **`design: 'keep'`** leaves every key in `stores.theme`; the merchant's edited colours still win and show as overrides.
- **`design: 'reset'`** deletes every `LOOK_OWNED_THEME_KEYS` key (`LOOK_TOKEN_KEYS` + `LOOK_UI_TOKEN_KEYS` + `HEADER_CHROME_OVERRIDE_KEYS`, the merchant's `headerLogoPlacement` and `headerSearch`, Ruling EP-4) from `stores.theme` and from the draft/builder theme, so the new look's tokens and header chrome show.
- **Builder first.** `applyFamilyForLook` runs before any store write because it can refuse (409/422). A refusal throws before `stores` is touched. Routes under `/stores/:id` run in `storeScopeContext`, where each query is its own transaction, so the builder step and the store update are **not atomic**: if the store update fails after a publish, a retry converges (the store is no longer fresh, so it takes the draft path).
- **Publish vs draft.** Only a genuinely fresh store publishes: `layout_settings` null/empty/equal to `NEW_STORE_LAYOUT_SETTINGS` and no draft revision exists. Sections that fail `validatePublishReadiness` (placeholder copy, a hero slide without an image) are dropped first, the rest goes live, and the merchant adds the dropped ones in the editor. If no section survives the drop, nothing is published: the whole family is saved as a draft (an empty live home is never published). Every other store gets the new family as a **draft** and presses publish. If a fresh store's publish is still refused, it stays a draft with a logged warning rather than failing the switch (Rulings LOOKS-8..10).
- **Demo stores.** `applyLook` has no demo-specific branch. A demo store (`is_demo`) is a showroom: it previews looks via `?look=` and refuses every order (`403 DEMO_STORE` from `assertOrderAllowed`); see `docs/ebda/templates/demo-store.md`.

Onboarding chooses a look through the same service (`onboarding.service.ts`), with `design: 'reset'` (a new store has no overrides to keep).

## Known residual (Phase S)

The skin baseline still paints its brand-colour section bands on a look store, so a dark-primary look shows near-black bands and the shared base's category caption is faint on them (Ruling LOOKS-16). Each look's skin decides its section colours in Phase B.

## Brand surfaces outside the storefront

Store emails, invoices (printable and email), campaign mail and the setup guide read the brand through `storeBrandTheme({ template, look, theme })` (`apps/api/src/lib/store-brand-theme.ts`, Ruling LOOKS-14). A look store is composed with `composeStoreTheme`, so it gets the look's primary unless the merchant stored their own; a legacy store reads its stored theme exactly as before. The setup guide's brand step is complete for a store with a logo, a registered look, or a stored `primaryColor`.

## Override badges and reset

`overriddenLookKeys(theme, look)` returns the look-owned keys the merchant has stored with a value that differs from the look. The builder's `ThemeSettingsPanel` shows an "edited" badge on each and a reset button. Reset is **draft-first** (Ruling LOOKS-11): flush pending autosave, remove the key from the draft theme (omit it, never `null`) via `replaceDocument` + `saveDraftNow`, then `PUT /stores/:id/theme { key: null }` to remove it from live only if live holds it. Resetting only live would be undone on the next publish; resetting only the draft would leave live untouched until then.

`PUT /stores/:id/theme` treats `null` as "delete this key" (see `docs/architecture/store-theme-flags.md`). It also refuses (400) any `density`, `imageRatio`, `motion`, `wordmarkSize`, `overPhotoChrome` or `receiptStyle` value outside `LOOK_DENSITIES` / `LOOK_IMAGE_RATIOS` / `LOOK_MOTIONS` / `LOOK_WORDMARK_SIZES` / `LOOK_OVER_PHOTO_CHROMES` / `LOOK_RECEIPT_STYLES` (`packages/shared/src/looks/types.ts`); `null` still deletes the key.

## Demo preview

Full flow and caching in `docs/ebda/templates/demo-store.md`; the contract:

- `?look=<id>` applies only when the store is `is_demo` AND the look is `built`. Anything else renders exactly as without the param.
- Middleware forwards a well-formed `?look=` as request header `x-demo-look` (a client-sent copy is stripped) and the response is `private, no-store` (Ruling LOOKS-12). It never takes the shared full-route-cache rewrite.
- The preview recomposes skin + look with no merchant overrides, per request, after the cached store fetch; the base store caches never hold a previewed look.
- `DemoLookBar` (`apps/web/src/components/demo/`) lists built looks and navigates to `?look=<id>` as a full document load.
- `scripts/storedemo/seed.mjs` seeds the showroom (idempotent; refuses a non-loopback database without `--yes-production`).

## Adding or changing a look

1. **Registry entry.** Add or edit the `LookDefinition` in `packages/shared/src/looks/registry.ts` (id `<template>.<name>`, matching `^(qamar|souq|jasmine|lamma|dahab)\.[a-z]+$` and the `stores_look_format` CHECK; bilingual `name`/`forWhom`/`idea`; tokens as hex; `skin`; `status: 'designed'`). Fonts must be in `LOOK_FONT_SPECS` (`fonts.ts`) so `lookFontsHref` can load them.
2. **Contrast test.** `tests/unit/looks-contrast.test.ts` runs over every registry entry: every text pair >= 4.5:1, nothing under 12px, no cream/sand page background. `looks-registry.test.ts` checks completeness (ar + en strings, A/B/C unique per template) and that `Object.keys(lookTheme(l))` equals `LOOK_TOKEN_KEYS` plus the UI tokens the look declares (`looks-compose.test.ts`). Run `npx vitest run tests/unit/looks-*.test.ts`.
3. **Thumbnail.** `node apps/admin/scripts/look-thumbs.mjs [lookId ...]` renders `apps/admin/public/looks/<lookId>.webp` for the admin `LookPicker` from the marketing fragments (needs macOS Chrome, `sips`, `cwebp`).
4. **Status `built`.** Flip `status` to `'built'` only after Ahmad has reviewed the look in a browser and its skin/sections ship, AND the look carries a `sections` mix and a `chrome` block (`tests/unit/looks-built-qamar.test.ts` fails a built look without them, or whose `skin` is not its own template), AND an independent audit has cleared `quality-bar.md` § 10. That is what makes the showroom list and preview it.
5. **Docs.** Update the table above in the same change.

The Qamar looks' design record (tokens, section mixes, what was left out) is `docs/ebda/templates/qamar.md`.

Do not add a look to a `Record<TemplateId, ...>` map; the four new template ids join `TemplateId` in Phase B with their skins (Ruling LOOKS-5).

## What a new store may start on (2026-10-28)

Signup, onboarding, the admin look switcher and the API offer only looks with `status: 'built'` in `packages/shared/src/looks/registry.ts` (helpers: `builtLooks`, `builtLookTemplates`, `builtSkins`, `isBuiltSkin`, `defaultNewStoreLook`). There is no second list: flip a look to `built` and its template appears everywhere. The five legacy Force skins (modern, elegant, classic, minimal, bold) are never offered and the API refuses to create a store on one (`TEMPLATE_NOT_AVAILABLE`, Zod at `POST /onboarding/store`, and `ProvisioningService`). The default for a new store is Qamar with its first built look (`stores.template` DB default `qamar`, migration `20261029000200`). Existing stores keep their skin; the admin template page still shows a legacy skin but cannot switch into one (`PUT /stores/:id/template` only re-saves the current skin; moving is `PUT /stores/:id/look`, built looks only).

## Lamma section mixes (Phase B4)

| Look                              | Chrome                                                                   | Mix (page order)                                                                                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Family table `lamma.table`        | logo start, `cartBar: 'total'`, `cardStepper: 'inline'`                  | full-bleed hero, "order again" row, `featured-collection` as a **menu** (category tabs, 24 dishes), `maker-profile` strip, trust strip                                                                                          |
| Kitchen notebook `lamma.notebook` | logo centre, cart bar, stepper                                           | `maker-profile` **lead** first (no hero), "order again" row, `featured-collection` 2-across on the light band (`token:inverse`, the merchant's dish photos are shot on white, quality bar § 9 rule 1), brand story, trust strip |
| Fresh market `lamma.market`       | logo start, cart bar, stepper, `aisles` (herb, crimson, aubergine, aqua) | `category-grid` **tiles** with `tint: 'aisles'` (three across on a phone), "order again" row, `on_sale` deals row, dense `featured-collection` (5 across / 2 on a phone), trust strip                                           |

The "order again" row is a `product-carousel` with `productSource: 'reorder'` (Ruling B4-8): per customer, it renders nothing for an anonymous or first-time shopper. `tint`, `tabs` and `variant` are look design keys (`LOOK_DESIGN_KEYS`), so a look switch resets them like any other design field and `design: 'keep'` preserves a merchant's change. The registry colours are re-derived from the directions (Ruling B4-2); the per-look token tables with measured ratios are in `lamma.md`.

## Moving a legacy Dahab store (Phase B5, Ruling B5-3)

A store with `template = 'dahab'` and `look IS NULL` is on the retired night + gold + arch skin. It cannot crash and it does not stay night: the `dahab` skin theme is now a neutral base (white page, ink primary), so such a row renders plain until it is moved. **Production has none**: the read-only count `select count(*) filter (where template='dahab'), count(*) filter (where look like 'dahab.%'), count(*) from stores` returned `0 / 0 / 1` on 2026-10-21 (the one store is `modern`); re-run it at merge time. The script is a safety net for a future import or a restored backup.

```bash
DATABASE_URL=<owner-role url> npx tsx scripts/dahab-demo/migrate-legacy-dahab.mjs            # dry run (default)
DATABASE_URL=<owner-role url> npx tsx scripts/dahab-demo/migrate-legacy-dahab.mjs --apply --look dahab.worn
```

- **Dry run first.** It prints every legacy store and, per store, the look-owned theme keys the merchant still has stored (the keep-diff: under `design: 'keep'` they stay as overrides on top of the new look, so a store that kept the night background keeps it until reset).
- **`--apply`** calls `StoreService.applyLook(id, look, { design: 'keep' })`, the real merchant path (SQL cannot do the field-level keep-diff or the cache purge). A store that already has a builder revision gets a **draft**, never a live change; the merchant publishes it from the admin.
- **Idempotent**: a store already on any `dahab.*` look is not selected. Refuses a non-loopback database without `--yes-production` (Ahmad approves that run, an agent never does).
- **Content is the oracle** (`tests/integration/dahab-apply-look.test.ts`, real Postgres, ebda_app + tenant guard): Worn -> Workshop -> Gift box -> Worn leaves every product row, personalisation config, category photo, logo and hero text (AR + EN) identical; a saved page document with `tileShape: 'arch'` still validates and renders as a rectangle; `reset` drops the stored night/gold keys and keeps non-look keys.

## Switching a look in the editor, with a preview (Task 9, Ruling EP-3)

The editor's top bar has a **Look** button. It opens the look picker in the right pane; choosing a look and **Preview** posts to `POST /stores/:id/look/preview`, which returns the proposed home document, a plain change report and a revision token without writing anything. The proposal renders in the SAME canvas (read-only: nothing the canvas sends edits the real page), the report lists what stays (every kept section keeps its content), what moves into the draft or leaves it, which design fields change and which look-owned theme keys reset, and a bar over the canvas offers **Apply look** or **Keep editing**. Apply sends the token: if the page moved since (another tab saved) the server answers 409 `DRAFT_MOVED`, nothing is written and the editor asks for a new preview. The preview shows the sections and their design in the current skin; a skin change (header, cards, buttons) and the new theme appear only after Apply, and the pane says so. `/template` keeps its dialog for onboarding and links to the editor.
