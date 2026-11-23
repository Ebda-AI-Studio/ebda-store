# Storefront English at its own URL (audit M-168, SEO-9)

Status: BUILT, dark (Ruling LOCALE-PATHS-1, Ahmad 2026-10-26: language in the URL before launch, both `/ar` and `/en`).
Behind `STOREFRONT_LOCALE_PATHS` + `STOREFRONT_LOCALE_PATHS_STORES` (`docs/ENVIRONMENT.md`); rolled out through
`docs/runbooks/locale-paths-canary.md`. Code: `apps/web/src/lib/locale-paths.ts` (rules), `apps/web/middleware.ts` (redirect + rewrite),
`lib/seo/locale-alternates.ts` + `localized-metadata.ts` (canonical + hreflang), `sitemap.ts`, `LanguageContext.tsx` (switcher).

## Today (VERIFIED by the audit)

- `storedemo.ebda.app` is `<html lang=ar>` with no `rel=alternate hreflang`; `/en` and `/en/products` are 404; `?lang=en` and
  `Accept-Language: en` still answer Arabic. English is a cookie (`force-language`), so it has no URL and cannot be indexed.
- A dark-launched tree exists: `apps/web/src/app/tenant-store/[tenant]/[locale]/` behind `STOREFRONT_TENANT_ROUTING`
  (+ `_ROUTES`, `_STORES`), unset in every environment (`docs/ENVIRONMENT.md`).

## What was built (decision LOCALE-PATHS-1 changed the proposal: BOTH languages are prefixed)

1. A store that opts in serves its public indexable routes at `/ar/...` and `/en/...` (home, products, categories, blog, about, faq,
   contact, locations, how-to-guides, privacy, terms, returns, shipping). Cart, checkout, account, auth, search and file routes keep
   their URLs; their language stays the `force-language` cookie, which the middleware keeps in step with the URL.
2. Old URLs redirect to the store's default language (permanent, never cached). The middleware has no store, so it only marks the
   request `x-locale-pending`; the ROOT LAYOUT, which has the store, issues the redirect from the store's own
   `settings.defaultLanguage` (read at request time: no per-store language to configure, nothing that can disagree). A visitor whose
   cookie names the OTHER language gets a temporary redirect to it, so a returning English visitor to an Arabic store is not bounced.
   The permanent one is Next's 308 (same SEO signal as a 301). `/ar/cart` 301s to `/cart` from the middleware. POST, the admin
   preview iframe and the demo-look preview are untouched.
3. Every prefixed page carries a canonical in its own language and reciprocal `hreflang` (ar, en, x-default = the default language);
   `/sitemap.xml` lists each page in both languages with `xhtml:link` alternates. `<html lang>` and `dir` follow the URL.
4. The language switcher goes to the sibling URL; it no longer reloads the same one.
5. `Accept-Language` is NOT used to redirect (crawlers and caches would split); the cookie is the only preference signal.

6. One link helper: every storefront component imports `Link` from `components/StoreLink` (a guard test fails on a direct `next/link`
   import), `useStoreUrl()` and the few programmatic navigations localize through the same `localizeHref`, and `JsonLd` (plus the
   root layout's Organization block and the blog post's) moves every URL on the store's own origin to the prefix. A prefixed page
   therefore has no unprefixed internal link, so no click costs a redirect (`tests/unit/web-locale-paths-links.test.tsx`).

## Known follow-ups (not built)

- DONE 2026-11-23 (Amelia QA, register row 238): `/llms.txt` and `/feeds/*` list the canonical prefixed URLs, and `/ar|/en/llms.txt` and `/ar|/en/feeds/{products.json,google.xml,meta.xml,tiktok.csv}` now answer in their own language (middleware decision `machine`, language on `x-locale-path`, no cookie) instead of a 301 to the unprefixed file, which kept the store default. Other prefixed non-routes still redirect.
- Merchant-facing: Search Console needs the new sitemap re-submitted per store.

## Rollout

One demo store first, per `docs/runbooks/locale-paths-canary.md`, then widen store by store. Roll back by deleting the master switch
(inert when unset). `qa-walk-store-1010` is never touched and no store is deleted without Ahmad's word for that store.

## Tests needed

- hreflang reciprocity: for every page of a two-language store, A names B and B names A, and both name themselves.
- Canonical equals the page's own URL in its own language; no canonical points across languages.
- `/en/...` is 404 on a one-language store.
- Cache: the two languages never share a cache key (the cookie-less default-language case in the runbook's Verify section).

## Cost if wrong

A wrong canonical or a one-sided hreflang de-indexes a merchant's pages; that is why this goes through the canary and not a
plain merge.
