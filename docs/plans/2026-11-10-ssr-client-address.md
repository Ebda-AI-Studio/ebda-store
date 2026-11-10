# SSR client address (Ruling RL-SSR-IP-6)

**Problem (measured 2026-11-10, production):** the storefront Worker (`ebda-web`) fetches the API during
server rendering with its own egress address, so the API's per-address public limiters (300/min
`publicLimiter`, the store-miss budget, `storeResolveLimiter`) charge every shopper's server render to
one shared bucket. Probe: two storefront renders of unknown hosts charged the caller 0 of 2 misses;
one direct API miss charged 1 of 1.

**Finish line:** a storefront render is charged to the shopper's address; nothing on the internet can
choose the address the API counts; every limit, window and 429 body is unchanged; no new secret or binding.

## Design

1. **Storefront, one choke point** — `apps/web/ssr-client-address.ts`, installed by
   `sentry-worker-entry.ts`: the incoming `cf-connecting-ip` is held in AsyncLocalStorage for the life of the
   request; a `globalThis.fetch` wrapper adds, only for URLs whose origin equals the API origin,
   `x-ebda-client-ip: <ip>` and `x-ebda-ssr-auth: hex(HMAC-SHA256(REVALIDATE_SECRET, "ebda-ssr-client-ip.v1\n"+ip))`
   (computed once per request). No address or no secret: neither header (today's behaviour).
2. **API, before Express** — `apps/api/src/cf/ssr-client-ip.ts`, called first in `worker.ts`: always strips both
   headers; honours the address only when the HMAC verifies (constant time), the value parses as an IP, and the
   request is GET/HEAD on the explicit storefront render list (`SSR_FORWARD_ROUTES`; a test fails on an
   unclassified `GET` in `public.routes.ts` / `public-store-layout.routes.ts`). Then `X-Forwarded-For` = that
   address and `floodGuard` keys on it. No `cf-connecting-ip` and no valid forward: the caller's
   `X-Forwarded-For` is deleted. No `REVALIDATE_SECRET` on the API: never trusted, one loud log per isolate.
3. **Limiters** — `publicLimiter` and `storeResolveLimiter` get an explicit key + the `noClientIp` skip, so no
   address never pools into one bucket.

## Verify

Unit tests (each shown red once by a mutation), the propagation proof on a local OpenNext preview
(workerd), and after deploy the BEFORE probe re-run: SSR misses are charged to the caller.
