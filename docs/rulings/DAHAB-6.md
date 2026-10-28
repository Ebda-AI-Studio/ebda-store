# DAHAB-6

> Section: 2026-10-07 — Dahab template, builder Phase 3 pilot (branch `feat/template-dahab`)

Ruling DAHAB-6 — the storefront CSP `connect-src` admits a non-production API origin derived from `NEXT_PUBLIC_API_URL` (empty for production's `api.ebda.app`), the same rule the admin CSP already applies. Evidence: without it every client-side fetch of the preview storefront was refused by the CSP; `tests/unit/storefront-csp-google-ads.test.ts` and `storefront-frame-ancestors-prod.test.ts` still pass. Cost if wrong: a build with a wrong `NEXT_PUBLIC_API_URL` would allow that origin — the build already sends every API call there.
