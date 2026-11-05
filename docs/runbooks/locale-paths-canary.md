# Language-in-the-URL canary (Ruling LOCALE-PATHS-1)

Scope: turning on `/ar/...` and `/en/...` for ONE demo store on the shared Worker `ebda-web`, checking it, then widening.
Never touch `qa-walk-store-1010`; never delete a store (deletion is only on Ahmad's word, per store). Plan:
`docs/plans/2026-10-26-storefront-locale-paths.md`. Secrets (set the store list BEFORE the flag):

| Secret                           | Meaning                                               | Bad state           |
| -------------------------------- | ----------------------------------------------------- | ------------------- |
| `STOREFRONT_LOCALE_PATHS_STORES` | store keys, e.g. `demo-boutique` (no language suffix) | routes no store     |
| `STOREFRONT_LOCALE_PATHS`        | master switch, literal `true`                         | anything else = off |

There is nothing to configure per language: the default language is the store's own `settings.defaultLanguage`, read at request
time. Run `wrangler` from an EMPTY directory.

## Before

1. The deploy that carries this code has finished: `curl https://api.ebda.app/health` is not the web Worker; compare the web
   Worker's `deploymentId` / latest version (`wrangler deployments list --name ebda-web`) to the tip of `main`.
2. `wrangler secret list --name ebda-web`: record what is set; neither secret above should exist yet.
3. Baseline of the canary store AND of two stores that must NOT change (another demo store, a custom-domain demo): for `/`, `/products`,
   `/about`, `/cart`, `/sitemap.xml`, `/robots.txt` save status, `location`, `cache-control`, a body hash.

## Flip (one demo store)

```
cd "$(mktemp -d)"
export CLOUDFLARE_ACCOUNT_ID=9f70414f9a626137f1004fa2f4add904
printf 'demo-boutique' | npx wrangler secret put STOREFRONT_LOCALE_PATHS_STORES --name ebda-web
printf 'true'             | npx wrangler secret put STOREFRONT_LOCALE_PATHS        --name ebda-web
```

## Verify (every line is a measurement; say what was NOT verified)

- `curl -sI https://demo-boutique.ebda.app/products` -> a PERMANENT redirect (308, issued by the root layout once it has the store)
  to the store's default language, e.g. `location: /ar/products`, never cached. With `-H 'cookie: force-language=en'` on an
  Arabic-default store -> a temporary redirect to `/en/products`. Change the store's default language in the admin and re-run:
  the redirect target and the `x-default` hreflang follow it with no env change.
- `curl -s https://demo-boutique.ebda.app/ar/products` and `/en/products`: 200; `<html lang>` and `dir` match the URL;
  `<link rel=canonical>` is the page's own prefixed URL; `hreflang` ar, en and x-default (= the default) are all present and
  each page names the other; `og:locale` matches. Repeat for `/ar`, `/en/about`, `/ar/products/<slug>`, `/en/blog/<slug>`.
- No internal link on a prefixed page points at an unprefixed indexable URL (grep the HTML: no `href="/products"`, `href="/"`,
  `href="/about"`...); JSON-LD `url` and breadcrumb `item` carry the prefix. `/ar/cart` -> 301 `/cart`; `/cart`, `/checkout`, `/account`, `/search` answer as before (no prefix, no redirect).
- `/sitemap.xml` lists every page twice (ar, en) with `xhtml:link` alternates; nothing unprefixed except bundles.
- The language switcher on `/ar/products` lands on `/en/products` (headless browser), and the cart then opens in English.
- The two baseline stores: byte-identical to the baseline (a difference is a stop-and-roll-back).
- Arabic store in the Arabic locale, English in English: read the rendered page, not just the headers.

## Roll back

Delete the master switch (unset is inert, no redeploy): `wrangler secret delete STOREFRONT_LOCALE_PATHS --name ebda-web`.
The permanent redirects were `private, no-store`, so no browser or edge cache keeps a stale one.

## Widening

Name another store (slug or exact custom-domain hostname). There is no wildcard. Each widening is its own baseline. Before a merchant-owned store goes on, tell the merchant: their old
links keep working through the 301, and Search Console should be asked to re-crawl the sitemap.

## Every store (Ruling LOCALE-PATHS-2)

`cf-web-deploy.yml` now passes `STOREFRONT_LOCALE_PATHS=true` and `STOREFRONT_LOCALE_PATHS_STORES=all` as plain Worker vars on every
deploy (a lone `all`; mixed with a name it is unparseable). Repo variables of the same names override them. If a Worker SECRET
of the same name still exists from a canary, delete it first (`wrangler secret delete ... --name ebda-web`) or the deploy's var
and the secret collide. Roll back everywhere: set the repo variable `STOREFRONT_LOCALE_PATHS=false` and re-run the web deploy
(or narrow `STOREFRONT_LOCALE_PATHS_STORES` to named stores). Verify after the deploy with the "Verify" list above on two stores.
