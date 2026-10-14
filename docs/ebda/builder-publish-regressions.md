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
