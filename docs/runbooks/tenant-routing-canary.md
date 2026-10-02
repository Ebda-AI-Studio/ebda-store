# Tenant routing canary (palora first)

Scope: turning on the tenant-cacheable storefront rewrite for ONE store on the shared Worker
`force-web-cf-preview`. One Worker serves palora (`store.force-ai.co/palora`), `pecannbee.com.kw` and
`wadyaljuz.com`, so the flag alone is Worker-wide. Three secrets scope it (Rulings TRC-1, TRC-5, TRC-6):

| Secret                             | Meaning                                                     | Bad state           |
| ---------------------------------- | ----------------------------------------------------------- | ------------------- |
| `STOREFRONT_TENANT_ROUTING`        | master switch, literal `true`                               | anything else = off |
| `STOREFRONT_TENANT_ROUTING_ROUTES` | route roots, e.g. `about,faq` (`all` = every Track-A route) | routes nothing      |
| `STOREFRONT_TENANT_ROUTING_STORES` | stores, e.g. `palora` (no `all`)                            | routes no store     |

The rewrite applies only when all three hold. Set the two scoping secrets BEFORE the master switch, so the
switch is never on with a wider scope than intended. Run `wrangler` from an EMPTY directory (a project
`wrangler.jsonc` account_id overrides `CLOUDFLARE_ACCOUNT_ID`).

## Before

1. `CLOUDFLARE_ACCOUNT_ID=9f70414f9a626137f1004fa2f4add904 npx wrangler secret list --name force-web-cf-preview`
   Expect only `REVALIDATE_SECRET`. Anything else was set outside git; record it first.
2. Capture a baseline of pecannbee and wadyaljuz, which must NOT change: for each of `/`, `/about`, `/faq`
   on `https://pecannbee.com.kw` and `https://wadyaljuz.com`, save the status, `cache-control`, `x-store-domain`
   and a hash of the body.
3. Confirm `/health` commit equals the tip of `main` and the deploy that carries `STOREFRONT_TENANT_ROUTING_STORES`
   has finished (a merge is not a deploy).

## Flip (palora only, `/about` and `/faq`)

```
cd "$(mktemp -d)"
export CLOUDFLARE_ACCOUNT_ID=9f70414f9a626137f1004fa2f4add904
printf 'palora'     | npx wrangler secret put STOREFRONT_TENANT_ROUTING_STORES --name force-web-cf-preview
printf 'about,faq'  | npx wrangler secret put STOREFRONT_TENANT_ROUTING_ROUTES  --name force-web-cf-preview
printf 'true'       | npx wrangler secret put STOREFRONT_TENANT_ROUTING         --name force-web-cf-preview
```

## Verify

- palora `/palora/about` and `/palora/faq` render, in both locales (`force-language=ar` cookie), and show the
  store's chrome exactly once.
- Every other palora route (`/palora`, `/palora/products`, cart, checkout) behaves as before.
- pecannbee.com.kw and wadyaljuz.com `/`, `/about`, `/faq`: compare to the step-2 baseline. Any difference
  is a stop-and-roll-back.
- Say what was NOT verified (for example, no cache-hit gain is expected until the root-layout decomposition).

## Roll back

Delete the master switch; unset is inert and no redeploy is needed:

```
cd "$(mktemp -d)"
CLOUDFLARE_ACCOUNT_ID=9f70414f9a626137f1004fa2f4add904 npx wrangler secret delete STOREFRONT_TENANT_ROUTING --name force-web-cf-preview
```

Then `wrangler secret list` again to confirm. Deleting `STOREFRONT_TENANT_ROUTING_STORES` alone also turns
routing off for every store (a missing list routes nothing).

## Widening

Add another store by naming it: a platform slug, or the exact custom-domain hostname (a slug never matches a
custom domain). There is no wildcard; widening is always an explicit edit and its own baseline.
