# TRC-7

> Section: 2026-10-02 — SMS consent follow-ups (branch `fix/backlog-followups10`, issues 2423–2426)

**Ruling TRC-7 — a cookie-less visitor to an Arabic-default store gets the store default in the
route/cache key, declared on the store token (issue 2419, 2026-10-02).** The rewrite used to key a
visitor with no `force-language` cookie as `en`, while the root layout renders the store's
`defaultLanguage`. Middleware is synchronous and has no store lookup (TRC-6), so the default is
declared where the store is already named: `STOREFRONT_TENANT_ROUTING_STORES` accepts an optional
`:en` or `:ar` suffix per token (`demo-boutique:ar`, `demo-merchant.com:ar`); a bare token means `en`. The
locale baked into the rewrite is now: cookie when it is `en` or `ar` (as the root layout does), else
the token's default. Any other suffix, or a second colon, makes the WHOLE list unparseable, so a
typo routes no store (fail-closed, as TRC-6). Document metadata was already correct on an
Arabic-default store (TRC-5: the tenant layout emits none, the root resolves cookie then store
default); this closes the remaining half, the cache key, which Phase 4 needed. Evidence: 11 middleware
cases in `tests/unit/web-middleware-tenant-routing.test.ts` and the three required metadata cases in
`tests/unit/web-tenant-tree-store-chrome-render.test.tsx` (AR-default no cookie: key `ar`, Arabic
`og:locale`; AR-default `en` cookie: key `en`, English; EN-default no cookie: key `en`, English).
Mutants, both restored byte-identical: default ignored (6 red), cookie ignored (4 red). Parity of the
new middleware against `origin/main`'s, 960 host x path x cookie cases per environment: main flag unset,
`false`, on with no store list, and on with bare tokens all identical in 960 of 960; with `:ar` tokens
108 differ, every one only in the locale segment (`en` to `ar`) of a rewrite for a cookie-less (or
junk-cookie) request. Not verified: nothing was set or deployed; no live request was made. Accepted
residual: the declared default can drift from the store's real `settings.defaultLanguage`; the runbook
reads the store's language into the step-2 baseline and requires a cookie-less request in Verify, which
is the check that catches a drift. Cost if wrong: if an operator declares `demo-boutique:ar` for a store whose
default is `en`, cookie-less visitors get Arabic cache keys over English content until the token is
corrected.
