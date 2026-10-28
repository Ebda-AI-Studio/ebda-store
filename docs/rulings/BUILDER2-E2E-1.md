# BUILDER2-E2E-1

> Section: 2026-10-07 — Visual builder Phase 2: the editor (branch `feat/builder-phase2`, BUILDER2-\*)

Ruling BUILDER2-E2E-1 — the editor E2E runs against an in-memory API with the real contracts (`tests/builder-e2e/mock-api.mjs`: envelope, rev/409, validation through the shared validator) and a CONTRACT FAKE of the canvas (`fake-canvas.html`), not the real storefront: booting web + API + Postgres inside the E2E would test the stack, not the editor. The real overlay is covered by unit tests (origin list, exact-match inline edit, unions) and the real draft API by `tests/integration/page-builder.test.ts`. CI: main lane (`builder-e2e`, like `test-e2e`) per the PR-lane budget. Cost if wrong: an overlay/editor protocol drift that the fake hides; mitigated by both sides importing the SAME Zod protocol schemas from `@ebda/shared`.
