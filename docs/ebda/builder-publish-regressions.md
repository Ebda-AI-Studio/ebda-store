# Builder publication regression evidence

Publication and draft saves share one write queue. Each queued save reads the current editor document when it executes; publication drains that document and holds the queue through its POST. Conflict overwrite uses the same queue.

Two browser regressions failed before this correction:

- With an earlier save held, editing again during publication published an older queued snapshot. The test now checks the published document contains the latest edit.
- With publication held, a later edit autosaved first and advanced the revision, causing publication to conflict with its own save. The test now checks publication finishes before the later draft save.

Verification on 2026-10-10: both regressions passed, and the full builder suite passed 54 cases across Arabic/English and 390/820/1280 widths. The existing hook save-queue regression passed. These use the real admin editor with the fixture API and preview canvas; they do not establish production deployment or storefront rendering.

The fixture does not provide a notification WebSocket, so its connection errors remain test-environment noise. Host Node/Next deprecation and colour-environment warnings were also observed.

Live QA separately found an inactive store previewing as 404. That resolver/preview issue is under investigation and is not fixed by this queue correction.
