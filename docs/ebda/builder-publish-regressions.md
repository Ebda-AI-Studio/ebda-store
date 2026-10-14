# Builder publication regression evidence

Publication and draft saves share one write queue. Each queued save reads the current editor document when it executes; publication drains that document and holds the queue through its POST. Conflict overwrite uses the same queue.

Two browser regressions failed before this correction:

- With an earlier save held, editing again during publication published an older queued snapshot. The test now checks the published document contains the latest edit.
- With publication held, a later edit autosaved first and advanced the revision, causing publication to conflict with its own save. The test now checks publication finishes before the later draft save.

Verification on 2026-10-10: both regressions passed, and the full builder suite passed 54 cases across Arabic/English and 390/820/1280 widths. The existing hook save-queue regression passed. These use the real admin editor with the fixture API and preview canvas; they do not establish production deployment or storefront rendering.

The fixture does not provide a notification WebSocket, so its connection errors remain test-environment noise. Host Node/Next deprecation and colour-environment warnings were also observed.

Live QA separately found an inactive store previewing as 404. That resolver/preview issue is under investigation and is not fixed by this queue correction.

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
