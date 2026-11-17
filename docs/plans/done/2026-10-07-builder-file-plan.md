# Ebda visual builder — file-by-file plan, phases 1–5

Date: 2026-10-07. Input: `2026-10-07-builder-phase0-gap-matrix.md` (gap numbers `#n` refer to it). Plan only: no implementation code. Each phase still needs its own task-level plan (failing test first) before execution, per the program plan. Constraints held throughout: Cloudflare Workers + Neon (no D1), Arabic/RTL first, EGP, no paid services, no new runtime dependency unless named below, Webstudio and Plasmic `platform/` = concepts only (AGPL); Plasmic outside `platform/` (MIT) and Next.js Commerce (MIT) may be reused with notices (Ruling BUILDER-LICENSE-1, superseding the earlier "concepts only" line), existing stores keep their current rendering.

## Principles that shape every phase

- **One document, one renderer.** `PageDefinition` (JSON) → shared registry → the storefront's existing section components. The editor canvas is the real storefront in an iframe, so there is no second style path.
- **Additive first.** Phase 1 changes no stored data: the document is _derived_ from `stores.layout_settings` by an adapter. Storage moves only in Phase 3, behind a dual-read.
- **One layer owns each write.** The builder API owns document writes; `PUT /admin/stores/:id/layout` becomes a thin adapter caller, then is frozen. Never form-and-page both.
- **Cache staleness classes** (global rule): layout/CMS = BOUNDED-stale but publish must purge every layer (Phase 3 table); price/stock/availability = NEVER-stale and the document never stores them.
- **Every new table has strict RLS** in the same migration (`store_id = nullif(current_setting('app.current_store_id', true), '')`, ENABLE+FORCE); `tests/integration/rls-ebda-app.test.ts` enumerates `store_id` tables and fails if the policy is missing.

## Phase 0.5 — standalone cache fix (recommended before Phase 1; own PR)

Closes gap #19 independent of the builder.

| File                                                      | Change                                                                                                                                                                                                                              |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/routes/store-layout.routes.ts` (PUT, ~L822) | Replace the single `invalidateCached('public:store:<id>')` with `bustStoreCachesById(storeId)` (`store.service.ts:57-96`) so slug/host/domain keys and `revalidateStorefront` fire; call after commit via `deferAfterTenantCommit`. |
| `apps/web/src/app/HomePageBody.tsx` (L257)                | Tag the layout fetch (`next: { revalidate: 60, tags: ['layout:<storeId>'] }`).                                                                                                                                                      |
| `apps/api/src/routes/store-layout.routes.ts`              | Also pass `tags: ['layout:<storeId>']` to `revalidateStorefront`.                                                                                                                                                                   |
| `tests/unit/layout-put-purges-storefront.test.ts` (new)   | Asserts PUT triggers every key + tag. Mutation: delete the purge call → red.                                                                                                                                                        |
| Verify live                                               | After deploy: `curl /health` commit == main tip; change a layout; time until storefront reflects it; report what could not be verified.                                                                                             |

## Phase 1 — Registry and compatibility (no data migration)

**Goal (roadmap):** shared section registry, validated/versioned document, existing-layout adapter, shared renderer; existing fixtures render equivalently.

### New files

| File                                                                              | Purpose                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/builder/schema.ts`                                           | `PageDefinition` Zod: `schemaVersion: 1`, `sections[]` of `{id, type, props, hidden?, responsive?}`. Limits: ≤40 sections, id `^[a-z0-9-]{1,40}$` unique, doc ≤256 KB, string props ≤2 KB, URL props via `sanitizeUrl`, image props must be R2 host.                                                                       |
| `packages/shared/src/builder/registry.ts`                                         | `SectionDefinition`: `type`, `labelEn/labelAr`, `propsSchema`, `defaults`, `rendererKey`, `cardinality` (`one`/`many`, e.g. header/footer `one`), `placement` (`chrome-top`/`body`/`chrome-bottom`), `slots` (empty in v1), `editableIn` (`content`/`design` per prop), `responsive` capabilities.                         |
| `packages/shared/src/builder/sections/*.ts`                                       | One file per type, mapped onto existing components first: `announcement`, `header`, `hero`, `category-grid`, `product-grid` (collection-bound), `image-text`, `testimonials`, `newsletter`, `footer`, plus legacy `trust-strip`, `brand-story`, `blog-carousel`. `image-text` and `newsletter` are the only new renderers. |
| `packages/shared/src/builder/adapter.ts`                                          | `layoutToDefinition(layoutSettings, templateId)` and `definitionToLayout(def)` (lossless for fields the adapter owns; unknown extras preserved in `props.__legacy`). Section ids derived deterministically (`hero-1`, `extra-<id>`).                                                                                       |
| `packages/shared/src/builder/validate.ts`                                         | `validateDefinition(def, { storeId, ownsCollection })` → typed errors with JSON-pointer paths (actionable messages in en/ar). Unknown type → `warn + skip at render`, never throw on public read.                                                                                                                          |
| `packages/shared/src/builder/index.ts` + export in `packages/shared/src/index.ts` | Public surface.                                                                                                                                                                                                                                                                                                            |
| `apps/web/src/builder/render/SectionRenderer.tsx`                                 | Maps `rendererKey` → existing template components (`getHomepageTemplate`, `templates/shared/*`). No editor imports.                                                                                                                                                                                                        |
| `apps/web/src/builder/render/PageRenderer.tsx`                                    | Ordered render with per-section `SectionErrorBoundary` (already in `components`), spacing/bg/typography via existing `section-spacing.ts`, `section-bg.ts`, `section-typography.ts`.                                                                                                                                       |
| `tests/fixtures/builder/*.json`                                                   | Golden layouts: default, Storefront-flow, fully customised, legacy hero-only, malformed. Captured from current code first (characterization).                                                                                                                                                                              |

### Changed files

| File                                                           | Change                                                                                                                                                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/types/store-layout.ts`                    | `sectionOrder` union and `ALL_SECTION_KEYS` derived from the registry (deletes the 3-way duplicate: `SL:963`, `HPC:309`, `PB:3948-3958`).                                                                     |
| `apps/web/src/app/HomePageContent.tsx`                         | Replace the hard-coded section sequence (L296-~830) with `PageRenderer` fed by `layoutToDefinition`. Output for existing fixtures must be byte-equivalent HTML.                                               |
| `apps/api/src/routes/public-store-layout.routes.ts`            | Additive: response also carries `definition` (`schemaVersion` 1). Old `layout` field unchanged so deployed storefront/admin keep working across the Worker/Railway deploy gap (multi-service env drift rule). |
| `apps/api/src/routes/store-layout.routes.ts`                   | `layoutSchema` composed from registry prop schemas where sections overlap; parity guard extended to registry keys.                                                                                            |
| `docs/architecture/store-theme-flags.md`, `docs/TWIN-PATHS.md` | Document registry as the owner of section keys; mark `apps/web/src/builder/` and `packages/shared/src/builder/` as Ebda-only paths (Ebda Store twin does not get them).                                       |

### Data model / migration

None. `layout_settings` stays authoritative. (Deliberate: the adapter is the compatibility proof.)

### API

`GET /public/stores/:id/layout` gains `definition`. Nothing else.

### Tests

- Unit: schema limits, id uniqueness, URL schemes (`javascript:`, `data:`), unknown type skipped, adapter round trip `def == layoutToDefinition(definitionToLayout(def))` over fixtures and a property-based generator.
- Characterization (written against _current_ code first): two stores × 5 templates render snapshots; save/reload round trip for `PUT /layout`; two-tenant isolation (store A cannot read/save B's layout, collection id from B rejected). These produce the roadmap's Phase 0 evidence.
- Existing guards stay green: `layout-schema-parity`, `store-layout-resolve`, `store-update-persists-every-accepted-field`, `mass-assignment-prohibited-fields`.
- Bundle: assert nothing under `apps/web/src/builder/` imports `@dnd-kit/*` or `apps/admin`.

### Mutation-check targets (delete the guard, name the test that reddens, restore byte-identical)

1. `sanitizeUrl` call in `schema.ts` URL props → URL-scheme test.
2. `ownsCollection` check in `validate.ts` → cross-store collection test.
3. Unique-id refinement → duplicate-id test.
4. Section-count / doc-size limit → limits test.
5. Adapter `__legacy` passthrough → round-trip fixture "fully customised".
6. Unknown-type skip (make it throw) → malformed fixture render test.

## Phase 2 — Visual editor

**Goal:** canvas/tree selection, typed properties, constrained slots, reorder/duplicate/hide/remove, responsive preview, undo/redo, onboarding handoff, preset selector. Keep `page-builder/` live until the new route reaches parity; remove it in a later PR (never silently delete — gap #1–#5 consumers).

### New files (admin)

| File                                                                         | Purpose                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/admin/src/app/stores/[id]/builder/page.tsx`                            | Route entry; loads definition via builder API (Phase 1 adapter output until Phase 3).                                                                                                                                                                   |
| `.../builder/BuilderShell.tsx`                                               | 3-pane desktop (tree / canvas / properties), drawers below `lg`; RTL-mirrored with logical CSS.                                                                                                                                                         |
| `.../builder/state/documentReducer.ts`, `state/history.ts`                   | Pure reducer: add/remove/duplicate/move/hide/setProp; history ring buffer (100), redo cleared on new edit, coalesced text edits.                                                                                                                        |
| `.../builder/canvas/Canvas.tsx`, `canvas/protocol.ts`                        | iframe to storefront preview route; `ebda-builder:v1` messages (`select`, `hover`, `patch-text`, `ready`); strict `event.origin` + `event.source` checks, schema-validated payloads.                                                                    |
| `.../builder/tree/SectionTree.tsx`                                           | dnd-kit sortable (reuse existing dependency) + buttons (move up/down, duplicate, hide, delete) + `Alt+Arrow` keyboard move.                                                                                                                             |
| `.../builder/panels/PropertiesPanel.tsx`, `panels/fields/*`                  | Controls **generated from registry `propsSchema`**: bilingual text (en/ar side by side), image (media picker), link, select, number, toggle, color-token, collection picker. Content mode shows `editableIn:'content'` only; design mode adds the rest. |
| `.../builder/AddSectionDialog.tsx`, `ViewportToggle.tsx`, `PresetPicker.tsx` | Add by registry type (cardinality enforced); 390/820/1280 frames; family picker (see template shortlist).                                                                                                                                               |
| `apps/admin/src/i18n/messages/{en,ar}.json` keys                             | Required by `admin-i18n-no-hardcoded-strings` and `admin-i18n-keys-resolve`.                                                                                                                                                                            |

### New files (web / api)

| File                                                                                                                                             | Purpose                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/builder/overlay/EditorOverlay.tsx` (+ preview route)                                                                               | Selection outlines + inline text. Loaded with `dynamic(..., {ssr:false})` **only** when the request carries a valid preview token; never in the public bundle.                                                                                                                                                   |
| `apps/api/src/routes/builder-preview.routes.ts`                                                                                                  | `POST /admin/stores/:storeId/builder/preview` — **Zod-validates** the definition (closes #8: today's preview payload is unvalidated), HMAC-signed token, Redis TTL ≥120s (Redis TTL floor rule), `crypto.randomBytes` token as today.                                                                            |
| `apps/api/src/routes/builder-media.routes.ts` + migration `store_media`                                                                          | `GET` list/search (per-store, cursor-paginated), `POST` register on upload, usage count. Table `store_media(id, store_id, url, kind, bytes, width, height, alt, alt_ar, created_at)`, RLS strict, index `(store_id, created_at desc)`. Reuses `upload.routes.ts` pipeline and `r2-cleanup.service` (closes #15). |
| Onboarding handoff: `apps/admin/src/app/onboarding/_components/OnboardingFlow.tsx` (existing; merchant-UI plan `2026-10-05-ebda-merchant-ui.md`) | Guided entry → opens the same builder with a preset applied. Idempotent (resume, no duplicate stores).                                                                                                                                                                                                           |

### Changed files

`apps/admin/.../page-builder/page.tsx` — link banner "Try the new builder"; no behavior change. `apps/api/src/routes/index.ts` — mount new routers under `tenantContext`. Admin sidebar entry. `apps/api/src/middleware/rbac.ts` — add permissions in Phase 3 (not here).

### Tests

- Unit: reducer (every action, invariants: ids unique, cardinality), history (cap, redo cleared, coalescing), protocol validators (reject foreign origin, malformed payload).
- Component: PropertiesPanel renders exactly the registry's fields; content mode hides design props.
- E2E (Playwright, **both `ar` RTL and `en`**, at 390/820/1280): add, reorder by drag AND by keyboard AND by buttons, duplicate, hide, delete, edit text inline, undo/redo through all of those, preview == storefront render for the same definition; failed upload; empty catalogue.
- A11y: axe on shell; focus order in RTL.
- Bundle: web public build contains no `EditorOverlay` chunk reference (size/grep assertion).

### Mutation-check targets

1. `event.origin` check in `Canvas.tsx` → foreign-origin message test.
2. History cap → cap test (101st edit drops the oldest).
3. Cardinality guard for header/footer → add-second-header test.
4. Preview Zod validation → invalid-definition 400 test.
5. `dir` mirroring (force `ltr`) → RTL E2E snapshot/ordering test.
6. Media list `store_id` scoping (RLS test, plus app-level filter removed once → isolation test).

## Phase 3 — Safe publication

**Goal:** drafts, revision conflicts, publish/restore, cache invalidation on Cloudflare, safe template switching.

### Migration `packages/database/prisma/migrations/<ts>_store_page_revisions/`

```
store_page_revisions
  id uuid pk, store_id uuid fk(stores) on delete cascade,
  page_key text            -- 'home' now; CMS page slug in Phase 4+
  rev int                  -- monotonic per (store_id,page_key), optimistic-concurrency token
  status text check in ('draft','published','archived')
  schema_version int, document jsonb, doc_bytes int,
  base_rev int null, note text null,
  created_by uuid null, created_at timestamptz, published_at timestamptz null
UNIQUE (store_id, page_key, rev)
UNIQUE partial (store_id, page_key) WHERE status='published'
UNIQUE partial (store_id, page_key) WHERE status='draft'      -- one working draft per page
INDEX (store_id, page_key, created_at desc)
RLS: ENABLE+FORCE, strict store_id policy (same text as 20261004000000_ebda_strict_rls)
```

Backfill: none required — absence of a published row means "derive from `layout_settings` via adapter" (dual-read). First publish writes row `rev=1` AND back-writes `layout_settings` through `definitionToLayout` so every legacy consumer (admin preview, any `store-layout`-reading code, Ebda Store twin fixtures) keeps working. Rollback of the migration is a drop table (nothing else depends on it) — note in `docs/ROLLBACK.md`. New FK on a tenant table → run the `information_schema.referential_constraints` NO ACTION sweep and check delete/cascade handlers (store delete, erasure).

### API (`apps/api/src/routes/builder.routes.ts`, all `authenticate → authorize → requireStoreAccess` under `tenantContext`)

| Route                                                   | Behavior                                                                                                                                                                                                                         |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET  /admin/stores/:storeId/builder/pages/:key`        | Working draft if any else published else adapter-derived; returns `rev`.                                                                                                                                                         |
| `PUT  .../draft` (`If-Match: <rev>`)                    | Validate (registry + `ownsCollection`); `409 REV_CONFLICT` with latest document if stale (no silent overwrite); inside `withSavepoint` for the unique race. Does not touch public caches.                                        |
| `POST .../publish` (`If-Match`)                         | One transaction: validate → archive previous published → promote draft → back-write `layout_settings`; `auditLog`; then `deferAfterTenantCommit` purge (below). 503 + P1 alert if purge enqueue fails (fail-fast, never silent). |
| `GET  .../revisions`, `POST .../revisions/:rev/restore` | List (cursor); restore = copy into new draft (never mutates history).                                                                                                                                                            |
| `DELETE .../draft`                                      | Discard working draft.                                                                                                                                                                                                           |
| `GET /public/stores/:storeId/layout`                    | Reads **published only** (never the draft table); response also carries `rev` for provenance. Preview stays token-based (Phase 2).                                                                                               |
| Retention                                               | Inngest function keeps last 50 revisions/page; prune never touches `published`.                                                                                                                                                  |

Permissions (`rbac.ts`): add `builder:content`, `builder:design`, `builder:publish`; `store_admin` gets all, `staff` gets `builder:content` only; enforced in the route (design-only props rejected for content-only callers — API enforces, not just hidden buttons).

### Cache invalidation on publish — every layer

| #   | Layer                                                                                                  | Today                                          | On publish                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Redis `public:store:<id>`, `public:store:<slug>`, `public:store:resolve:<host>` / `<domain>`           | layout PUT clears `<id>` only (`SLR:822`)      | `bustStoreCachesById` (`store.service.ts:57-96`)                                                                                                                                 |
| 2   | New Redis `public:layout:<storeId>` (only if the public route gets a Redis layer; TTL ≥120s)           | n/a (route reads DB each time)                 | `invalidateCached` in the same helper. Decide in Phase 3 whether to add this layer at all (route is cheap; adding a layer adds a staleness class to maintain).                   |
| 3   | Storefront Next data cache tag `layout:<storeId>` + `store-slug:`/`store-domain:` tags                 | untagged `revalidate:60` (`HPB:257`)           | `revalidateStorefront({slug, domain, tags:['layout:<id>']})` (`apps/api/src/lib/revalidate-storefront.ts`); outcome checked, `rejected`/`failed` escalates (existing behaviour). |
| 4   | OpenNext incremental cache (`OPENNEXT_CACHE` R2/KV binding, see `scripts/assert-cf-cache-bindings.sh`) | UNVERIFIED whether the homepage is page-cached | Verify in Phase 3 which routes it caches; ensure the tag purge reaches it; add to the live proof.                                                                                |
| 5   | Cloudflare edge for the API response (`s-maxage=120`)                                                  | inert (`cf-cache-status: DYNAMIC`)             | Drop `s-maxage` on the layout route or make it `no-store` to avoid an accidental future cache rule serving stale published docs; document in `edge-cache.ts`.                    |
| 6   | Browser `max-age=60` on public layout                                                                  | present (`PSL:86`)                             | Reduce to `max-age=0, must-revalidate` (storefront server-fetches; browsers do not need it).                                                                                     |
| 7   | Preview tokens `layout-preview:*`                                                                      | 1h Redis                                       | Untouched; drafts never public.                                                                                                                                                  |
| 8   | Sitemap / OG / JSON-LD derived from page content (`apps/web/src/app/sitemap.ts`)                       | store-level only                               | Re-check once Phase 4 adds pages; out of scope for `home`.                                                                                                                       |

An `invalidate*` with zero call sites is the same bug inverted: a test greps that the publish handler references each helper.

### Template switching

`PresetPicker` apply → creates a **draft** from preset definition + keeps products/settings (data lives outside the document); previous published revision untouched; "Restore" = Phase 3 restore.

### Tests

- Integration (real Postgres, `ebda_app` role): two-tenant isolation for every route; draft invisible on public route (publicly fetch while draft exists → still old published); conflict test with two clients — loser gets 409 + latest, nothing lost; publish → public GET shows new within purge; restore creates new draft; retention keeps published; RLS enumeration test passes for the new table.
- Live proof script (reuse the `/health` commit check): publish on a test store, poll storefront until new content, report time; Cloudflare runtime verified separately from Railway.
- E2E: draft→publish→sandbox checkout on the resulting storefront (sandbox only; no real orders without Ahmad's go).
- Load: k6 on `GET /public/stores/:id/layout` (p95 < 500 ms; no per-request revision-table scans — index covers the published lookup).
- Permissions: staff content-only write OK, design-prop write 403, publish 403.

### Mutation-check targets

1. `If-Match` comparison → conflict test.
2. Public route reading the draft status → draft-invisible test.
3. Publish without `revalidateStorefront` tag → purge-contract test.
4. Remove `bustStoreCachesById` → purge-contract test.
5. RLS policy on `store_page_revisions` → `rls-ebda-app` enumeration.
6. Permission check for `builder:publish` → permission test.
7. Partial unique index (two published rows) → promote-race test.

## Phase 4 — Commerce blocks (only with working backends)

| Block / change                                                                                | Files                                                                                                                                                                                                                                                                                                               | Gate before shipping                                                                                                                                                         |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `product-grid` bound to collection (columns 2–5, card style, price/add-to-cart visibility)    | `packages/shared/src/builder/sections/product-grid.ts`, `apps/web/src/builder/render/ProductGridSection.tsx` using existing product list route + `invalidateStoreProductCaches`, existing 8 product-card render paths (CLAUDE.md platform rule: all 5 templates + shared + carousel)                                | Loading/empty/error states; long Arabic names and EGP prices fit at 360px; price/stock authority stays in the API (document has **no** price field — validator rejects one). |
| `collection-list`, `featured-product`, `reviews` (existing `testimonials` endpoint `PSL:103`) | registry + renderers                                                                                                                                                                                                                                                                                                | Real data; hide on empty.                                                                                                                                                    |
| `newsletter`                                                                                  | Section posts to existing newsletter flow (`apps/api/src/routes/newsletter.routes.ts`, `campaign-public.routes.ts`)                                                                                                                                                                                                 | Consent text + one-click unsubscribe path proven (consent gate rule); if consent flow is not complete, do not advertise the block.                                           |
| `whatsapp-button`                                                                             | Uses existing wa-bot settings (`apps/admin/.../wa-bot`, `whatsapp`) — requires a verified provider contract first                                                                                                                                                                                                   | Provider sandbox proof; otherwise deferred (roadmap).                                                                                                                        |
| CMS pages on the registry (closes #17)                                                        | Migration: `store_pages.document jsonb null` additive (`StorePage` `schema.prisma:656`), adapter from `contentBlocks` → `rich-text`/`image`/`button` sections; page_key = slug in `store_page_revisions`; per-page SEO columns `meta_title(_ar)`, `meta_description(_ar)`, `og_image` on `store_pages` (closes #16) | Existing 6-block pages render unchanged; sitemap/OG updated; redirect on slug change reuses `SlugRedirect`.                                                                  |
| Tracking / recommendations / flash-sale                                                       | Out of scope until each has a backend contract; tracking must not reveal another customer's order.                                                                                                                                                                                                                  | —                                                                                                                                                                            |

Tests: per-block render fixtures (loading/empty/error), two-store collection ownership, price-authority negative test, newsletter consent E2E, mobile 360px Arabic overflow screenshot checks. Mutation: let `props.price` flow through → authority test red; drop collection ownership → isolation test red; remove consent checkbox requirement → consent test red.

## Phase 5 — AI editing (reviewable patches only)

> **Status 2026-10-26: BUILT** as Ruling AIPATCH-1 (`docs/RULINGS.md`, `docs/architecture/visual-editor.md` § Ask AI). Deviation from the table below: the patch is a closed set of 7 ops applied through the editor reducer (`ai-patch.ts`), not a JSON-Patch subset (`patch.ts`); propose lives in `ai.routes.ts` (`POST /stores/:id/ai/builder-patch`), apply in `page-builder.routes.ts`; the panel is `AiPatchPane.tsx`. Phase 3 versioned publish already existed; its gap (who published) is PUBLISH-WHO-1.

| File                                                                 | Purpose                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/builder/patch.ts`                               | Patch format = restricted JSON-Patch subset (`add`/`replace`/`remove`/`move`) over `sections[*]` only; `applyPatch` is pure and re-runs `validateDefinition`.                                                                                                          |
| `apps/api/src/routes/builder-ai.routes.ts` (+ Inngest fn if >300 ms) | `POST /admin/stores/:storeId/builder/ai/patch {instruction, definition, locale}` → Gemini `gemini-flash-lite-latest` alias, structured JSON output; per-store quota (`lib/ai-quota.ts`); under `storeScopeContext` per the slow-third-party rule, not `tenantContext`. |
| `apps/admin/.../builder/panels/AiPatchReview.tsx`                    | Shows a diff of the patch against the draft; Apply pushes one history entry (undoable); never auto-publishes.                                                                                                                                                          |

Guards: registry-validated props only (unknown type/prop → reject whole patch); collection/product ids must belong to the store; no HTML/JS/URL schemes outside allowlist; treat product names/descriptions as untrusted prompt input (injection). Tests: golden bad-patch corpus (unknown block, cross-store id, `javascript:` link, oversized), patch undoable, no network call executes generated content. Mutation: skip `validateDefinition` after patch → bad-patch test red; skip the collection ownership check → red; auto-publish path added → "never publishes" test red.

## Cross-cutting

- **Docs parity (same session as each phase):** `docs/architecture/store-theme-flags.md` (registry owns section keys, new write owner), `docs/ENVIRONMENT.md` if any env, `docs/ROLLBACK.md` (migration drops), `docs/TWIN-PATHS.md`, admin + web i18n catalogues (en + ar).
- **Brand tokens:** `BRAND` in `packages/shared/src/brand/` (night `#0A0B0C`, gold `#B08D57`/`#CBA873`, Geist) is the source for any Ebda-owned preset colors; storefront still loads Plus Jakarta Sans + IBM Plex Sans Arabic (`apps/web/src/app/layout.tsx:4,42`). Decide in Phase 2 whether presets switch the Latin face to Geist (token change + font-loading budget), rather than discovering it during preset implementation.
- **Rollout:** each phase ships behind `store.theme` flag-style default OFF for visual features (UI rule 2); existing stores unchanged until they opt in via the new editor.
- **Verification after every deploy (rule F):** `/health` commit == main tip for the API; `cf-deploy` run success covering the tip for admin and web; then measure the changed path live; report what could not be verified (e.g. real provider behavior, Arabic locale switch on the storefront).
- **Phase 1 sizing (relative, unmeasured):** registry+schema M, adapter M, renderer S–M, characterization tests M. No dates asserted.

## Recommended Phase 1 scope (cut line)

In: Phase 0.5 cache fix · characterization tests against current code · `PageDefinition` v1 + registry for the 8 existing sections + `announcement/header/footer` descriptors · adapter both ways · `PageRenderer` replacing the hard-coded sequence in `HomePageContent` with byte-equivalent output · additive `definition` field on the public layout response.
Out (deliberately): any editor UI, new sections (`image-text`, `newsletter`), storage migration, presets, desktop/tablet preview, AI.
Why: it is the only slice that removes a live bug class (silent-strip, three-way key duplication), produces the roadmap's missing baseline evidence, changes no stored data, and unblocks every later phase.
