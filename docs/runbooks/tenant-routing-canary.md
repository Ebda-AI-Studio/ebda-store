# Tenant routing canary (demo-boutique first)

Scope: turning on the tenant-cacheable storefront rewrite for ONE store on the shared Worker
`ebda-web`. One Worker serves demo-boutique (`store.ebda.app/demo-boutique`), `demo-store.example` and
`demo-merchant.com`, so the flag alone is Worker-wide. Three secrets scope it (Rulings TRC-1, TRC-5, TRC-6):

| Secret                             | Meaning                                                             | Bad state           |
| ---------------------------------- | ------------------------------------------------------------------- | ------------------- |
| `STOREFRONT_TENANT_ROUTING`        | master switch, literal `true`                                       | anything else = off |
| `STOREFRONT_TENANT_ROUTING_ROUTES` | route roots, e.g. `about,faq` (`all` = every Track-A route)         | routes nothing      |
| `STOREFRONT_TENANT_ROUTING_STORES` | stores, e.g. `demo-boutique:ar` (no `all`); `:ar`/`:en` = default language | routes no store     |

The rewrite applies only when all three hold. Set the two scoping secrets BEFORE the master switch, so the
switch is never on with a wider scope than intended. Run `wrangler` from an EMPTY directory (a project
`wrangler.jsonc` account_id overrides `CLOUDFLARE_ACCOUNT_ID`).

## Before

1. `CLOUDFLARE_ACCOUNT_ID=9f70414f9a626137f1004fa2f4add904 npx wrangler secret list --name ebda-web`
   Expect only `REVALIDATE_SECRET`. Anything else was set outside git; record it first.
2. Capture a baseline of demo-store and demo-merchant, which must NOT change: for each of `/`, `/about`, `/faq`
   on `https://demo-store.example` and `https://demo-merchant.com`, save the status, `cache-control`, `x-store-domain`
   and a hash of the body.
3. Read the canary store's default language and record it: the admin Language setting for that store
   (`settings.defaultLanguage`; unset = `en`). The store token carries it (`demo-boutique:ar` for an
   Arabic-default store, bare `demo-boutique` for English). A token that disagrees with the store keys cookie-less visitors
   to the wrong language (Ruling TRC-7).
4. Confirm `/health` commit equals the tip of `main` and the deploy that carries `STOREFRONT_TENANT_ROUTING_STORES`
   has finished (a merge is not a deploy).

## Flip (demo-boutique only, `/about` and `/faq`)

Use `demo-boutique:ar` when demo-boutique's default language is Arabic, bare `demo-boutique` when English (step 3 above).

```
cd "$(mktemp -d)"
export CLOUDFLARE_ACCOUNT_ID=9f70414f9a626137f1004fa2f4add904
printf 'demo-boutique:ar'  | npx wrangler secret put STOREFRONT_TENANT_ROUTING_STORES --name ebda-web
printf 'about,faq'  | npx wrangler secret put STOREFRONT_TENANT_ROUTING_ROUTES  --name ebda-web
printf 'true'       | npx wrangler secret put STOREFRONT_TENANT_ROUTING         --name ebda-web
```

## Verify

- demo-boutique `/demo-boutique/about` and `/demo-boutique/faq` render, in both locales (`force-language=ar` and `force-language=en`
  cookies), and show the store's chrome exactly once.
- A request with NO `force-language` cookie (`curl -s https://store.ebda.app/demo-boutique/about`, no `-b`): `<html lang>`,
  `<title>`, `<meta name="description">` and `og:locale` all agree and equal the store's default language recorded in
  step 3. A cookie-only check cannot see the case where a cookie-less visitor gets the other language (issue 2419).
  Repeat with `-b force-language=en` on an Arabic-default store: everything must be English.
- Every other demo-boutique route (`/demo-boutique`, `/demo-boutique/products`, cart, checkout) behaves as before.
- demo-store.example and demo-merchant.com `/`, `/about`, `/faq`: compare to the step-2 baseline. Any difference
  is a stop-and-roll-back.
- Say what was NOT verified (for example, no cache-hit gain is expected until the root-layout decomposition).

## Roll back

Delete the master switch; unset is inert and no redeploy is needed:

```
cd "$(mktemp -d)"
CLOUDFLARE_ACCOUNT_ID=9f70414f9a626137f1004fa2f4add904 npx wrangler secret delete STOREFRONT_TENANT_ROUTING --name ebda-web
```

Then `wrangler secret list` again to confirm. Deleting `STOREFRONT_TENANT_ROUTING_STORES` alone also turns
routing off for every store (a missing list routes nothing).

## Widening

Add another store by naming it: a platform slug, or the exact custom-domain hostname (a slug never matches a
custom domain). There is no wildcard; widening is always an explicit edit and its own baseline.
