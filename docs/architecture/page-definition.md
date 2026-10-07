# PageDefinition — the visual builder's page document

Status: Phase 1 (2026-10-07, branch `feat/builder-phase1`). Roadmap: `docs/plans/2026-10-07-ebda-visual-builder-roadmap.md`; file plan: `docs/plans/2026-10-07-builder-file-plan.md`. Rulings: `docs/RULINGS.md` → "Visual builder Phase 1 (BUILDER-\*)".

## Model (Shopify theme-editor shape)

A page is a **template** of ordered **sections**; each section holds ordered **blocks**; the header and footer are **section groups** shared by every page. Every section and block type declares a **settings schema** that the editor turns into its settings panel. Global **theme settings** (colours, typography, buttons, spacing) are a schema too, but their values live on the store theme, not in the page.

```jsonc
{
  "schemaVersion": 1,
  "pageKey": "home",
  "sectionGroups": {
    "header": [{ "id": "announcement", "type": "announcement", "settings": {} },
               { "id": "header", "type": "header", "settings": { "sticky": true } }],
    "footer": [{ "id": "footer", "type": "footer", "settings": {} }]
  },
  "sections": [
    { "id": "hero", "type": "hero", "hidden": false,
      "settings": { "mode": "slider", "autoplayMs": 5000 },
      "blocks": [{ "id": "slide-1", "type": "slide",
                   "settings": { "image": "https://…", "headline": "…", "headlineAr": "…" } }],
      "responsive": { "mobile": { "hidden": false }, "tablet": { "hidden": true } } },
    { "id": "categories", "type": "category-grid", "settings": { "layout": "grid" },
      "responsive": { "mobile": { "settings": { "layout": "horizontal" } } } },
    { "id": "extra-6f1c…", "type": "product-carousel",
      "settings": { "id": "6f1c…", "productSource": "category", "categorySlug": "dates" } }
  ],
  "siteSettings": { "sizing": {…}, "productCardDefaults": {…}, "productsPage": {…} },
  "legacy": { "sectionOrder": […], "absentSections": ["brandStory"] }
}
```

| Concept               | Rule                                                                                                                                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ids                   | `^[a-z0-9][a-z0-9-]{0,63}$`, unique across the document (blocks unique per section). Fixed legacy sections use the kebab key (`new-arrivals`); product carousels `extra-<slug of legacy id>`; slides `slide-<n>`. |
| Visibility            | `hidden` (everywhere) + `responsive.{desktop,tablet,mobile}.hidden`. Viewports: mobile < 768, tablet 768–1023, desktop ≥ 1024 (`VIEWPORT_RANGES`; preview widths 390 / 820 / 1280 — BUILDER-PREVIEW-1).           |
| Per-viewport settings | `responsive.<viewport>.settings`, only for settings the type declares responsive (v1: categories `layout` / `captionPosition` on mobile).                                                                         |
| Colours               | hex or `token:<brand>` references resolved against the store theme at render; the document never copies theme values.                                                                                             |
| Dynamic data          | by reference only (`category` slug, `product_list` ids), checked against the caller's store (warnings when not found — BUILDER-REFS-1). Price, stock and availability are never stored.                           |
| RTL                   | bilingual pairs (`title` / `titleAr`, declared `localized`), logical alignment only (`left`/`right` rejected), no stored direction.                                                                               |
| Limits                | ≤ 40 sections, ≤ 50 blocks per section, ≤ 256 KB per document (also a DB CHECK), ≤ 2 KB per string; link schemes per `isSafeUrl`; images http(s) or relative.                                                     |
| Unknown types         | an error on write (draft/publish); skipped, never thrown, on render (`renderableSections`).                                                                                                                       |

## Code map (Ebda-only paths, self-contained so they can be ported to FWB later)

| File                                                                             | Owns                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/builder/schema.ts`                                          | `pageDefinitionSchema` (envelope), limits, id rules                                                                                                                                                                                                                                         |
| `packages/shared/src/builder/settings-schema.ts`                                 | setting descriptor vocabulary (`text`, `image`, `url`, `color`, `select`, `range`, `checkbox`, `category`, `product_list`, `typography`, `dividers`), `THEME_SETTINGS_SCHEMA` (typed against `StoreTheme`)                                                                                  |
| `packages/shared/src/builder/registry.ts`                                        | `SECTION_REGISTRY`: 12 types (announcement, header, hero[+slide blocks], category-grid, new-arrivals, best-sellers, brand-story, blog-carousel, trust-strip, testimonials, product-carousel ×8, footer) with settings, blocks, presets, group, responsive capability, and the Zod validator |
| `packages/shared/src/builder/layout-schema.ts`                                   | the layout Zod schema (moved from the API route): ONE validator for the PUT and the registry                                                                                                                                                                                                |
| `packages/shared/src/builder/section-keys.ts`                                    | the single owner of the 8 orderable legacy keys and their render-order rule                                                                                                                                                                                                                 |
| `packages/shared/src/builder/adapter.ts`                                         | `layoutToDefinition` / `definitionToLayout` / `sectionFromPreset`                                                                                                                                                                                                                           |
| `packages/shared/src/builder/validate.ts`                                        | `validateDefinition` (async, catalogue refs) / `validateDefinitionSync` / `renderableSections`                                                                                                                                                                                              |
| `packages/shared/src/builder/template-families.ts`                               | the five families: Souq سوق, Dahab دهب, Qamar قمر, Lamma لمّة, Jasmine ياسمين                                                                                                                                                                                                               |
| `apps/web/src/builder/render/PageRenderer.tsx`                                   | renders a document with the existing template components                                                                                                                                                                                                                                    |
| `apps/api/src/services/page-builder.service.ts`, `routes/page-builder.routes.ts` | draft / publish / revisions / rollback                                                                                                                                                                                                                                                      |
| `apps/admin/src/lib/page-builder-save.ts`                                        | the existing page-builder Save → draft + publish                                                                                                                                                                                                                                            |

## Compatibility with `stores.layout_settings`

The adapter is lossless both ways for every resolved layout (golden fixtures × 5 templates + 500 generated layouts; documented exceptions in Ruling BUILDER-ADAPTER-1). The storefront renders the homepage body with `PageRenderer`; its output for existing stores is byte-identical to the pre-builder renderer (`tests/unit/builder-homepage-characterization.test.tsx`, 120 renders, snapshots committed before the refactor). The chrome (`ShopChrome`) still reads `layout`.

## Storage, publishing and caches

`store_page_revisions` (migration `20261007170000_store_page_revisions`): one row per revision; `rev` monotonic per (store, page) and the optimistic-concurrency token; at most one `draft` and one `published` row per page (partial unique indexes); strict RLS (R-EBDA-001), FK cascade on store delete; no FK on `created_by` (identity rows are user-keyed under RLS and erasure must not take page history).

| Call                                            | Behaviour                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/stores/:storeId/builder/pages/home` | `{ rev, definition, source: draft\|published\|layout, draftRev, publishedRev }`                                                                                                                                                                                                           |
| `PUT …/draft { baseRev, definition }`           | validate → 422 (JSON-pointer errors) · stale `baseRev` → 409 `REV_CONFLICT` + `details.latest` · else the one draft row gets rev = head + 1. No public cache is touched.                                                                                                                  |
| `POST …/publish { baseRev }`                    | promote draft (archive previous published) → back-write `layout_settings` (`definitionToLayout`) → audit → after COMMIT purge every layer with `bustStoreCaches` (Redis `public:store:*` id/slug/host/domain + generation, categories/products, CORS, storefront tag `layout:<storeId>`). |
| `GET …/revisions?cursor&limit`                  | newest first, metadata only, cursor = rev.                                                                                                                                                                                                                                                |
| `POST …/rollback { targetRev, baseRev }`        | publishes a NEW revision with the target's document (history is never rewritten); a working draft is archived and reported as `discardedDraftRev`.                                                                                                                                        |
| `PUT /admin/stores/:storeId/layout` (legacy)    | unchanged contract; its write also records a published revision, so history and `layout_settings` cannot diverge.                                                                                                                                                                         |
| `GET /public/stores/:storeId/layout`            | additive `definition` + `rev`: the published document when its projection equals `layout_settings`, else the layout-derived document (guards out-of-band writers). Drafts are never read here.                                                                                            |

Race losers fail on a row re-check or a unique index inside a SAVEPOINT, so the request transaction survives to answer 409 (`tests/integration/page-builder.test.ts`: 5 concurrent saves → 1 wins; 3 concurrent publishes → 1 published row).

## Not in Phase 1

The editor UI (Phase 2 spec in the PR body and the roadmap), new section types (`image-text`, `newsletter`), the five template-family presets, builder permissions (`builder:content|design|publish`), revision retention (keep-last-50 job), a Redis layer for the public layout route, and verification against production (nothing is deployed by this branch).
