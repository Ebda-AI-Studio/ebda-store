# BUILDER2-CSP-1

> Section: 2026-10-07 — Visual builder Phase 2: the editor (branch `feat/builder-phase2`, BUILDER2-\*)

Ruling BUILDER2-CSP-1 — the admin's preview CSP rule (`frame-src https:`) now covers `/stores/:id/builder` as well as `/stores/:id/page-builder`. Evidence: the builder canvas embeds a merchant's custom domain, which the catch-all `https://*.ebda.app` list blocks (the same defect class that cost Storefront its preview); `tests/unit/admin-page-builder-preview-csp.test.ts` extended (match matrix, served headers). The storefront's `frame-ancestors` remains the real control. Cost if wrong: the builder route may embed any https origin — the admin itself still cannot be framed (`frame-ancestors 'none'`).
