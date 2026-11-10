# RL-SSR-IP-6

> Section: 2026-11-10 — SSR client address (branch `fix/ssr-client-address`, plan `docs/plans/2026-11-10-ssr-client-address.md`)

**Ruling RL-SSR-IP-6 — a storefront server render is charged to the shopper's address: the storefront Worker
forwards the shopper's `cf-connecting-ip` signed with `REVALIDATE_SECRET`, and the API believes it only on
GET/HEAD of an explicit list of anonymous storefront reads; nothing else on the internet can choose the
address the API counts.**

Evidence (measured on production 2026-11-10T12:15Z, api 6c00eaa1e / web 926ee0cdb): two storefront renders of
unknown hosts charged the caller 0 of 2 store-miss budget units, one direct API miss charged 1 of 1 — every
shopper's renders shared the storefront Worker's bucket (`publicLimiter` 300/min, the store-miss budget,
`storeResolveLimiter`). Propagation proven on workerd (local OpenNext preview of this branch): home, `/products`
and `/llms.txt` renders sent `x-ebda-client-ip` = the request's `cf-connecting-ip` with the matching HMAC on every
API fetch. Design:

- Storefront: one choke point, `apps/web/ssr-client-address.ts` (AsyncLocalStorage + one `globalThis.fetch`
  wrapper, API origin only), no call-site edits. No address or no secret = neither header.
- API: `apps/api/src/cf/ssr-client-ip.ts`, before Express: both headers always stripped; HMAC verified with
  WebCrypto `verify` (constant time); value must be an IP literal; route must be `forward` in
  `SSR_FORWARD_ROUTES` (a unit test fails on an unclassified GET in `public.routes.ts` /
  `public-store-layout.routes.ts`). X-Forwarded-For = that address, else `cf-connecting-ip`, else DELETED (the
  old code kept a typed X-Forwarded-For when `cf-connecting-ip` was absent). `floodGuard` keys on the same address.
  No `REVALIDATE_SECRET` on the API = nothing trusted, one `console.error` per isolate.
- `publicLimiter` and `storeResolveLimiter` key explicitly on the address and skip a request with none
  (`noClientIp`), instead of pooling it. Every limit, window and 429 body is unchanged; no new secret or binding.
- Residual: storefront reads outside the two render routers (`/stores/public/*` manifest + bundles, wholesale,
  campaign / SMS unsubscribe pages) keep the Worker's address. A captured signed pair can be replayed only for
  that same address on the same read list (server-to-server, never exposed to a browser).

Cost if wrong: if the HMAC check or the read list were too loose, anyone could pick the address the per-IP
limiters count and dodge them; if the forward silently stopped working, every shopper's renders would share one
300/min bucket again and one busy store could throttle every store's server rendering.
