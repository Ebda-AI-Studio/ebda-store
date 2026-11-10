# Store-miss limiter: a dead product or blog link inside a verified store is not a miss (Ruling LAUNCH-RL-MISS-3)

Date: 2026-11-10. Branch `fix/store-miss-counts-unverified-store-only`.

## Finish line

- Must work: 25 dead product links on a real store from one IP are all answered 404, the miss counter stays 0, no 429.
  21 unknown-store misses from one IP still end in a 429.
- Exercised: `GET /public/products/:slugOrId`, `GET /public/:storeId/blog/:slug`, every other row of the public route
  table (walk), on workerd with the built Worker and the real counter.
- Must not change: limit (20), window (60 s), key (client IP), 429 body, fail-open, the whole-router refusal at 20,
  every other route's counting.
- Done: unit + workerd tests green, four defence mutations KILLED, ruling filed, PR open, stopped for review.

## Problem

`storeMissLimiter` counts every 404 of the public router. A shopper (or the storefront's own server render) who opens
dead product links on a store that exists spends the 20 per minute per IP budget that is meant for store probing, and
at 20 the whole public router is refused for that IP.

## Design (fails closed)

Every 404 is counted by default. One exemption, three conditions, all required
(`apps/api/src/middleware/catalogue-miss.ts`, `isVerifiedCatalogueMiss`):

1. Flag: the resolver verified a store for this request (`resolvedStoreId(req)`, set only by `resolvePublicStoreId`
   after the active-store lookup by `X-Store-ID` or host). A path id that only passed the directory check is not proof.
2. List: the route that answered carries the marker `catalogueMissRoute(...)`, and its name is on
   `CATALOGUE_MISS_ROUTES`: product by slug or id, blog post by slug. Nothing else.
3. Same store: the route's own store id (the path `:storeId` when the route has one, else the resolved id) equals the
   id the resolver verified.

The limiter's `finish` callback gets one line: a 404 that passes `isVerifiedCatalogueMiss` is not written.

Storefront: the blog post server fetch sends no store header, so its misses would stay counted. It gets
`X-Store-ID: <storeId>`, the same header the product server fetch already sends.

## Counted, explicitly (unchanged)

Unknown store (slug, host, path id), unmatched route, `STORE_NOT_FOUND`, locations, pages, feed, orders, cart,
wishlist, wholesale, loyalty and every other public route. Blog post with no verified store or a path id that differs
from the verified one.

## Tests

- `tests/unit/store-miss-catalogue-exempt.test.ts`: one case per condition, the unverified-store count, source pins
  (the marker is on exactly the two routes; the list holds exactly the two names).
- `tests/unit/blog-post-miss-body.test.ts`: draft = other store's post = never existed, byte-equal 404 body.
- `apps/api/workers-test/failure-only-limiters.test.ts`: 25 dead product links (counter 0); 21 unknown-store misses
  (429, existing); blog exempt / id mismatch counted / no header counted; product draft = other store = never existed
  byte-equal; walk of every public row of `route-table.json` on an unknown store (every 404 counted) and on the real
  store (a 404 is uncounted only on the two listed routes; a 200 writes nothing); an unclassified route fails the walk.
- Defence mutations: flag dropped, list check dropped, id-equality dropped, unverified store exempted.

## Out of scope

Limit, window, key, 429 body, fail-open, refusal at 20. Forwarded-IP design for server renders. The `/en` manifest gap.
