# LEGAL-5-DIST

> Section: 2026-10-07 — Legal pages v1.0 (branch `docs/legal-pages`)

Ruling LEGAL-5-DIST — the API and its integration tests import `@ebda/shared` from its BUILT dist (only the `/brand` and `/legal` subpaths are aliased to source in `vitest.shared.ts`), so a defence that lives in `packages/shared` is registered with `test:defence-mutations` against a unit test that imports the SOURCE (`tests/unit/legal-notice-eligibility.test.ts`, entry `consent-legal-ack-material-only`); the HTTP twin (I3 case in `legal-notices.test.ts`) was proven red by hand with a rebuilt dist. Cost if wrong: a src-only mutation of a shared guard looks "survived" against an integration test, or a stale local dist hides a real regression until CI rebuilds it.
