# SUBDOMAIN-404-1

> Section: 2026-10-14 — Phase B0 platform commerce (B0-\*)

Ruling SUBDOMAIN-404-1 — unknown or non-store \*.ebda.app hosts render one Ebda-branded 404 page (HTTP 404, no redirect) with CTAs to ebda.app, WhatsApp when configured, and the demo store behind a default-off flag (Ahmad 2026-10-15). Evidence: `demostore.ebda.app` rendered the storefront's generic "Page not found" in the default-theme orange because the platform 404 (`PlatformNotFound`) was an unbranded white/orange page; it is replaced by `UnknownHostNotFound` using `BRAND` colours/fonts/logo, routed by `notFoundKind()`; a resolved store (including a suspended one) keeps its own 404/maintenance page. `tests/unit/unknown-store-not-found.test.tsx`, `tests/unit/platform-root-redirect.test.ts`. Cost if wrong: a shopper on a mistyped store URL sees Ebda's page instead of being redirected.
