# Storefront English at its own URL (audit M-168, SEO-9)

Status: PLAN ONLY. Not built in the P15 branch: it changes the public URL space of every merchant store and ships through the
tenant-routing canary (`docs/runbooks/tenant-routing-canary.md`), which needs the three `STOREFRONT_TENANT_ROUTING*` secrets
on `ebda-web` and a production verification pass. Nothing here is a decision yet.

## Today (VERIFIED by the audit)

- `storedemo.ebda.app` is `<html lang=ar>` with no `rel=alternate hreflang`; `/en` and `/en/products` are 404; `?lang=en` and
  `Accept-Language: en` still answer Arabic. English is a cookie (`force-language`), so it has no URL and cannot be indexed.
- A dark-launched tree exists: `apps/web/src/app/tenant-store/[tenant]/[locale]/` behind `STOREFRONT_TENANT_ROUTING`
  (+ `_ROUTES`, `_STORES`), unset in every environment (`docs/ENVIRONMENT.md`).

## Proposal

1. The store's default language keeps the unprefixed URL (Arabic stores: `/products`). The other language lives under a
   prefix (`/en/products`). Only stores that enabled a second language get the prefix routes; others stay 404 on `/en`.
2. Every page of a two-language store emits reciprocal `hreflang` (ar, en, x-default = the default language) and a canonical
   in its own language. The sitemap carries `xhtml:link` alternates, like ebda.app's own.
3. The language switcher links to the sibling URL instead of setting the cookie; the cookie only remembers the choice for `/`.
4. `Accept-Language` is NOT used to redirect (crawlers and caches would split); a banner offers the switch.
5. Product, category and blog JSON-LD `url`/`inLanguage` follow the page language (`structured-data.ts` already takes `locale`).

## Rollout

Canary per the runbook, one demo store first (`demo-boutique`), routes `home,about,faq,products`, then widen. Roll back by
unsetting the master switch (inert when unset).

## Tests needed

- hreflang reciprocity: for every page of a two-language store, A names B and B names A, and both name themselves.
- Canonical equals the page's own URL in its own language; no canonical points across languages.
- `/en/...` is 404 on a one-language store.
- Cache: the two languages never share a cache key (the cookie-less default-language case in the runbook's Verify section).

## Cost if wrong

A wrong canonical or a one-sided hreflang de-indexes a merchant's pages; that is why this goes through the canary and not a
plain merge.
