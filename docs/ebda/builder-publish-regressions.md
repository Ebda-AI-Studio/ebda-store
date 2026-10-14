# Builder publication regression evidence

Publication and draft saves share one write queue. Each queued save reads the current editor document when it executes; publication drains that document and holds the queue through its POST. Conflict overwrite uses the same queue.

Two browser regressions failed before this correction:

- With an earlier save held, editing again during publication published an older queued snapshot. The test now checks the published document contains the latest edit.
- With publication held, a later edit autosaved first and advanced the revision, causing publication to conflict with its own save. The test now checks publication finishes before the later draft save.

Verification on 2026-10-10: both regressions passed, and the full builder suite passed 54 cases across Arabic/English and 390/820/1280 widths. The existing hook save-queue regression passed. These use the real admin editor with the fixture API and preview canvas; they do not establish production deployment or storefront rendering.

The fixture does not provide a notification WebSocket, so its connection errors remain test-environment noise. Host Node/Next deprecation and colour-environment warnings were also observed.

Live QA separately found an inactive store previewing as 404. That resolver/preview issue is fixed separately, see "Inactive store previewing as 404" below.

## Placeholder copy cannot be published (editor bug 10)

Origin: the Add-section picker and the template families insert the `image-text` preset 0, whose body is instructional starter text ("Tell customers what makes your products special." / "احكِ لعملائك ما يميز منتجاتك."). Drafts may hold it, but before this fix it could be published verbatim.

Decision: refuse, do not strip or auto-replace. A made-up sentence about the merchant's products would be a false claim published in their name; an empty field would silently change the layout. The merchant is told which section and field to fix.

- Predicate: `isPlaceholderCopy` in `packages/shared/src/builder/placeholder-copy.ts` (whole-string patterns, English + Arabic, plus the registry's own starter copy via `PLACEHOLDER_STARTER_COPY`, so the default and the refusal cannot drift). The bulk AI write guard (`apps/api/src/lib/ai/placeholder-guard.ts`) wraps the same predicate.
- Gate: `validatePublishReadiness` reports `PLACEHOLDER_COPY` (422 `INVALID_DEFINITION`, bilingual message, JSON-pointer path) for every visible section/block text setting still holding placeholder copy. Hidden sections are ignored.
- Paths: `publishDraft` and `rollbackToRevision` are gated. The legacy `PUT /layout` (`publishLegacyLayout`) skips the copy scan (Ruling PLACEHOLDER-1): it cannot author document-only section text, only carries it over, so gating it would reject unrelated theme saves.
- Editor: a banner under the top bar lists every blocking message (`builder.publishBlocked.title`); the selected section's own panel also shows its errors. The banner clears on the next successful autosave.

## Theme save went live without Publish; canvas stale (Ruling THEME-DRAFT-1)

Root cause: the visual editor's Theme tab (`ThemeSettingsPanel`) called `PUT /api/v1/stores/:id/theme`, which shallow-merges into `stores.theme` (`StoreService.updateTheme`) and immediately busts the public caches (`bustStoreCaches`: Redis `public:store:*`, the storefront Next data cache by `store-slug:` / `store-domain:` tags). That is the live column the storefront renders, so "Save theme" published at once. The canvas was stale for a separate reason: the iframe gets its theme CSS from the storefront's cached store resolve (`layout.tsx`, 15 s tagged fetch plus an 8 s in-memory layer), and the builder preview token only ever carried the page document, never a theme.

Fix: theme edits are a patch in the page document (`PageDefinition.theme`, editor-managed keys only; `packages/shared/src/builder/theme-draft.ts`).

- Save: `ThemeSettingsPanel` writes the patch into the draft through the normal autosave API (`PUT .../draft`). No `stores` write, no cache purge.
- Publish: `page-builder.service.ts` merges the patch over the live theme, read in the same transaction as the `layout_settings` back-write, in the one `stores` update; the existing post-commit `bustStoreCaches` purge (all layers) covers it. The published revision stores a snapshot of the editor-managed keys.
- Rollback: re-applies the target revision's snapshot through the same path. A revision without `theme` (published before this change, or by the legacy layout PUT) leaves the live theme alone.
- Canvas: `GET .../builder-preview` returns the draft document, whose `theme` the storefront paints (`HomePageBody` server `<style>` plus client `PreviewThemeOverride`), and the editor sends the document to the canvas live. After a published-only state the editor never re-opens a published theme snapshot as a pending edit (`getPageState` strips it).
- Compatibility: no data migration. Stores with a theme only in `stores.theme` render unchanged; the first draft seeds from it.

Sibling surfaces: the classic builder (Save is its Publish), the Branding tab and the Categories toggles remain live writes because they have no draft/Publish model. Cache path: every write to the storefront-read theme from the builder now goes through `applyPublishedLayout`, which schedules `bustStoreCaches` after commit; the legacy `PUT /theme` keeps its own purge.

Tests (written, not run in this session): `tests/unit/page-builder-theme-draft.test.ts`, `tests/unit/builder-theme-draft.test.ts`.

## Fresh store showed empty sections (editor bug 6)

Root cause: provisioning writes no layout, so a new store renders the default 8-section document with no products, reviews, posts or description. The data sections (categories, new arrivals, best sellers, testimonials) already skipped their own `<section>`, but the shells around them did not: `PageRenderer` still drew each section's divider above a section that was not there, brand story and blog drew a divider with nothing under it, an `image-text` section with no content drew a grey placeholder box, and in the editor canvas an empty data section left no trace at all, so the merchant could not see or select it.

Fix (hide, never seed): nothing is invented for a new store. On the public storefront a section with nothing to show renders nothing, divider included (`PageRenderer` visibility flags, `HomeBlogCarousel` `before`, `ImageTextSection` empty guard, no grey image box without an image). In the editor canvas (`editorMode`) an enabled-but-empty section shows a dashed `EmptySectionHint` ("Add products and your newest ones will appear here.", EN + Egyptian AR in `LanguageContext` `translations`). A section the merchant switched off shows neither. This protects every existing store, not only new ones.

Not changed: the hero (built from the store name). The trust strip's fixed copy was replaced by merchant-written items, see the next section. Tests: `tests/unit/builder-fresh-store-empty-sections.test.tsx` (written, not run locally).

### Trust strip: merchant-written, off by default (Ahmad 2026-10-14)

The strip used to show three fixed lines ("Fast Delivery", "Quality Guarantee", "24/7 Support") on every store: claims the merchant never wrote. Items are now the merchant's own: `trustStrip.items` (icon, title, subtitle, EN + AR) edited in the visual builder as `item` blocks, so add, remove and reorder reuse the hero-slide block machinery (`adapter.ts` `BLOCK_FIELDS`, registry `blocks`, `layout-schema.ts`).

Discriminator, migration-free: `items` ABSENT = a store that predates this, keeps the three fixed defaults exactly as before; `items` PRESENT, even `[]` = merchant-owned, only their items render and none hides the strip (editor canvas shows the empty-section hint). New stores get `NEW_STORE_LAYOUT_SETTINGS` (`trustStrip.items: []`) in `stores.layout_settings` from `ProvisioningService.provisionStore` and `StoreService.create`. It is safe because an existing store's column either is `{}` or has a strip without `items`, and no code path ever wrote `items` before. Consequences: (1) a legacy store that deletes all its blocks gets `[]` and the strip hides, which is the merchant's intent; (2) a new store loses the template baseline's `trustStrip.bgColor` (raw strip wins wholesale in `resolveLayoutSettings`), so it uses the page background until a colour is picked; (3) the admin content-tab notice for `trust-strip` now says to add items under the section and no longer links to the classic builder.

## Inactive store previewing as 404 (fixed, 2026-10-14)

Root cause: the canvas loads `https://<store-host>/?_preview=N&_builder=<token>`. The storefront resolves the store from the Host via `GET /public/store/resolve`, which only returns active/suspended stores, and `getStoreOrNotFound()` (`apps/web/src/lib/store-resolver.ts`, called from `app/page.tsx`) calls `notFound()` on the miss before the token is ever consulted (the token was only checked later, by `/public/stores/:id/builder-preview`).

Fix: middleware forwards `?_builder=` (only inside `?_preview`; any client-sent copy is stripped) as the request header `x-builder-preview-token`, and the resolver passes it to `/public/store/resolve` on a `no-store` fetch that skips the per-instance store map. The API (`resolveBuilderPreviewStoreId` in `apps/api/src/routes/public.routes.ts`) verifies it server-side: host -> store id (any status), then the Redis entry `builder-preview:<storeId>:<token>` must exist, so a token for store A cannot unlock store B and expired/forged tokens fail. Only then is the inactive store returned, bypassing `getCached`, with `Cache-Control: private, no-store` and `X-Robots-Tag: noindex`. No token or an invalid one keeps the unchanged public behaviour (inactive = 404).

Not changed: `GET /public/stores/:storeId/layout` and the product/category endpoints the canvas may call stay active-only, so on an inactive store the legacy layout falls back to defaults and live-data sections render empty; the builder document itself comes from the token-authorized `builder-preview` endpoint. Tests: `tests/unit/builder-preview-inactive-store-resolve.test.ts`, `tests/unit/web-builder-preview-token.test.ts` (written, not yet run; CI runs them).

Live QA separately found an inactive store previewing as 404. That resolver/preview issue is under investigation and is not fixed by this queue correction.

## Editor mobile overflow (bug 7)

At 390px the top bar (logo, Structure/Settings toggles, viewport switch, undo/redo, Publish) was wider than the screen and pushed the document into horizontal scroll in both locales. Below `md` the bar now wraps: the viewport switch moves to its own full-width second row (`order-last`), undo is pushed to the logical end (`max-md:ms-auto`) so Publish stays reachable; `md+` is unchanged (fixed `h-14`, `flex-nowrap`, switch centred). The image field in the settings panel gained `min-w-0` so the two-column Arabic/English image grid cannot widen the drawer. Guard: `EDITOR-MOBILE-1` in `tests/builder-e2e/builder.e2e.ts` asserts `scrollWidth <= clientWidth` for the top bar and every panel (runs in the existing ar/en x 390/820/1280 projects). Not yet verified in a browser; CI runs the suite.

## Classic save vs a pending visual draft; header/footer content in the visual editor (bug 3)

### E2: the classic builder's Save and an unpublished visual draft (Ruling CLASSIC-SAVE-DRAFT-1)

Traced: the classic Save is `PUT /layout` -> `publishLegacyLayout` -> a new PUBLISHED revision (its Save is its Publish, unchanged). The code never deleted the draft row, but it left it stale: the draft kept the pre-save values, its rev fell behind the new head so the next Publish of it answered 409, and once it was saved again and published it silently reverted the classic edit. In addition the new revision copied document-only sections (image-text, newsletter) from `draft ?? published`, so a section that existed only in the unpublished draft went LIVE through the classic Save.

Fix: the classic Save still publishes what it edited, and now MERGES that edit into the pending draft (`rebaseDraftOntoLive`, `packages/shared/src/builder/rebase-draft.ts`) in the same savepoint as the new revision: per section id and per field, only what the save changed (`previous live` -> `new live`) is applied; every other visual edit, the draft `theme` and `chrome` patches and draft-only sections are kept. The draft moves to `rev = newHead + 1, baseRev = newHead`, so it stays publishable. Document-only sections are carried over from the LIVE document only. If the merged draft would not validate, the draft is left as it was and the event is logged (never discarded). Edge: a section the draft deleted stays deleted; a classic reorder reorders the shared sections and keeps draft-only ones after them.

### E3: header menu and footer links editable in the visual editor (Ruling CHROME-DRAFT-1)

The header menu, the top utility bar and the footer link columns are not in `layout_settings`; the classic builder writes them to `stores.settings.navMenu / utilityBar / footerLinks` through `PUT /stores/:id`, which is live at once. The visual editor now edits the SAME shapes but into the draft: `PageDefinition.chrome` (`packages/shared/src/builder/chrome-draft.ts`), a patch of those three keys, following the THEME-DRAFT-1 lifecycle:

- Save: Content tab of the Header / Footer section (`ChromeContentPanel`): add / remove / reorder, label EN + AR, link. Autosaved into the draft; no `stores` write, no cache purge.
- Links: every href goes through `isSafeUrl` (relative path or http / https / mailto / tel; `javascript:`, `data:`, `vbscript:` and tab-split variants rejected) in the panel (never dispatched) AND in the API schema (422). The storefront also still runs `sanitizeUrl` at render.
- Publish: `applyChromePatch` merges the patch over the live `stores.settings` read in the same transaction, in the one `stores` update with `layout_settings`; the existing post-commit purge covers every cache layer. Other settings keys and legacy footer keys (`bottomBar`) survive; blank rows are dropped and an all-blank menu is ignored (same as the classic editor).
- Rollback: re-applies the target revision's patch; a revision without `chrome` leaves live settings alone. A rollback restores the keys that revision's patch carried (not a full snapshot, unlike theme).
- Canvas: the draft's patch is shown through the `draftSettings` channel `ShopChrome` already prefers (`PreviewThemeOverride`), live as the editor sends the document. After a publish the editor reloads so it never re-sends a stale patch.
- Notice: the "content lives elsewhere" notice is gone for header/footer; the logo link to Branding remains.

Not done, deliberately: the LOGO and social links. The classic page builder does not edit them either: the logo is a `stores.logo` column owned by the Branding tab (upload pipeline, its own cache path) and social links a separate column. They stay live writes there; the header panel links to Branding. Residual: `isSafeUrl` accepts protocol-relative `//host` as "relative" (existing helper behaviour, not changed here).

Tests: `tests/unit/page-builder-chrome-draft.test.ts` (draft save writes nothing live, unsafe hrefs 422, publish merges + purges, rollback, canvas, classic save keeps/merges the draft), `tests/unit/builder-chrome-draft.test.ts` (schema, merge, re-base), `SettingsPanel.header-footer-content.test.tsx` (panel). Integration (Postgres) runs in CI only.
