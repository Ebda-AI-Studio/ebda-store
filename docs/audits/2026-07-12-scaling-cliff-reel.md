# FWB Scaling-Cliff Audit — 2026-07-12

Source: a reel on the "scaling cliff" (works at 100 users, dies at 10,000).
Scope: `apps/api` (Express+TS on Railway), `apps/web`/`admin`/`orders` (Next.js
on Cloudflare Workers), `packages/database` (Prisma+Neon). This audit does
**not** repeat findings already closed by `docs/audits/2026-07-02-scaling-perf.md`
(customers-route caching, bank-reconcile tx chunking, xlsx rate-limiting) —
it picks up from the current state of the code and follows one of those fixes
to a gap left behind.

## The 5-pillar lens

1. **Caching (Redis)** — are hot/expensive reads cached, or recomputed every request?
2. **Async jobs (queue)** — is heavy/3rd-party work off the request path via Inngest?
3. **Fast DB queries** — indexes on hot WHERE/ORDER BY, targeted `select`, cursor pagination, no N+1.
4. **Load testing (k6)** — is there `loadtests/` coverage with a documented p95 ceiling?
5. **Horizontal scaling** — if the API runs >1 instance, what breaks or double-fires?

---

## Findings

### 1. CRITICAL — Pillar 1 (Caching) — `GET /public/store/resolve` has no Redis cache; its only cache layer is a Cache-Control header nothing in the current stack honors

**Resolution: Fixed** (commit-to-be). Wrapped the domain lookup + feature
keys + disabled-CMS-pages query in `getCached('public:store:resolve:<domain>',
120, ...)`, mirroring `/stores/:slugOrId` exactly
(`apps/api/src/routes/public.routes.ts`). Invalidation wired at every known
write path: `StoreService`'s `bustStoreCaches()` helper (called from all 11
store-mutation sites) now busts the domain-keyed entry too
(`apps/api/src/services/store.service.ts`), and `PUT /stores/:id/domain`
(`apps/api/src/routes/store.routes.ts`) — the one path that bypasses
`StoreService.update` when clearing a domain — got its own explicit
invalidation for both the old and new domain. `setEdgeCache` was left
untouched per instructions. `(DECISION)` still open for Ahmad: whether to
keep `setEdgeCache` now that there's no CDN in the Railway→Workers path to
honor it, or wire a real Cloudflare-side cache in front of the Workers
apps' outbound calls. `(DECISION)` noted in code: on a domain CHANGE via a
generic `bustStoreCaches()` call site, only the NEW domain is known there —
the OLD domain's cache entry is left to expire on its own 120s TTL
(bounded staleness); only the dedicated `PUT /stores/:id/domain` route
explicitly busts both directions.

**File:** `apps/api/src/routes/public.routes.ts:1279-1416` (route `/store/resolve`)
**Also:** `apps/api/src/lib/edge-cache.ts:1-38`, `apps/web/src/lib/store-resolver.ts:173-223`, `apps/web/wrangler.jsonc`, `apps/web/open-next.config.ts`

`/store/resolve` is the domain→store lookup every storefront page load
depends on (the Next.js middleware/store-resolver calls it to know which
tenant is being served). Every _sibling_ public read in this file goes
through the Redis-backed `getCached()` helper (`/products`, `/products/:slugOrId`,
`/categories`, `/search/suggest`, `/stores/:slugOrId`) — but `/store/resolve`
only calls `setEdgeCache(res, { sMaxAge: 120, staleWhileRevalidate: 600 })`
and hits `prisma.store.findFirst(...)` directly.

`setEdgeCache`'s doc comment (`edge-cache.ts:4,18,35`) says the header is
there "so Vercel's edge caches" the response. Per this repo's own
`CLAUDE.md`, Vercel was cancelled 2026-07 — the API now runs on Railway's
raw `api-production-c058.up.railway.app` domain (not proxied through
Cloudflare), and the callers are Next.js apps on Cloudflare Workers making
server-side `fetch()` calls straight to that Railway URL. There is no CDN
in that path left to honor `Cache-Control: public, s-maxage=...` — the
header is dead weight from the pre-migration architecture.

The caller-side mitigation (`store-resolver.ts:174-182,213-217`) layers its
own `next: { revalidate: 15, tags: [...] }` Next.js Data Cache plus an 8s
in-memory `Map`. But `apps/web/open-next.config.ts` is
`defineCloudflareConfig({})` — no R2/KV binding — and `wrangler.jsonc` has
no `r2_buckets`/`kv_namespaces` entry, so OpenNext-for-Cloudflare has
nothing durable to back the Next Data Cache with. Worker isolates are
short-lived, so both the Data Cache and the in-memory `Map` are, in
practice, request/isolate-scoped, not durable — meaning the origin
(`/store/resolve` → Postgres) gets hit far more often than the 15s
`revalidate` window implies.

Net effect: the single hottest, first-touched endpoint in the whole
storefront request path has **no working cache at any layer** — not Redis,
not a real CDN, and not a durable Worker cache.

**Fix:** wrap the query in `getCached()` the same way `/stores/:slugOrId`
already does (key by normalized domain, 120s TTL, same `store.select` shape),
and invalidate on the same write paths that already call
`invalidateCached('public:store:${storeId|slug}')` in `store.service.ts`,
`typography.routes.ts`, `store-layout.routes.ts` (add the domain-keyed
variant there too). Separately — `(DECISION)` whether to keep `setEdgeCache`
at all now that there's no CDN to read it, or to wire an actual edge cache
(Cloudflare Cache API / KV) in front of the Workers apps' outbound API calls.

---

### 2. MEDIUM — Pillar 1 (Caching) — `customers-agg` cache has a cache-buster function that is never called

**Resolution: Fixed** (commit-to-be). `customersCacheKey` / `invalidateCustomersCache`
moved from `routes/customers.routes.ts` into `lib/public-cache.ts` (services
can't import from `routes/` — see that module's own doc comment) and
re-exported from `customers.routes.ts` for backward compat. Wired at every
call site that flips an order's status or paymentStatus and would move it
in/out of the aggregation's totals: `OrderService.updateStatus`
(`apps/api/src/services/order.service.ts`), both transitions in
`confirmPaymentFromProviderStatus` (`apps/api/src/services/payment-confirm.service.ts`
— the admin "Refresh payment" + guest verify-on-return pull-side paths),
and all three `Order.paymentStatus` mutation sites in `PaymentService`
(`apps/api/src/services/payment-providers/payment.factory.ts`: the
provider-refund transaction, the out-of-band-refund webhook detector, and
the main `handleWebhook` provider-status transition — the canonical push
path).

**File:** `apps/api/src/routes/customers.routes.ts:26-34`

The aggregated-customers snapshot (built from a full order-table scan, per
`docs/audits/2026-07-02-scaling-perf.md` finding #1) is now correctly
wrapped in `getCached(customersCacheKey(storeId), 300, ...)` — that prior
finding was fixed in commit `8c3923ae`. But the fix's own comment admits
the other half was never finished:

```
/**
 * Invalidate the cached aggregation for a store. Exported so order-mutation
 * paths (status changes, payment updates, cancellations) can bust the cache
 * instead of waiting out the TTL. Currently unused elsewhere in this repo —
 * safe no-op call sites can adopt it as those flows are touched.
 */
export async function invalidateCustomersCache(storeId: string): Promise<void> {
```

`grep -rn "invalidateCustomersCache" apps/api/src` returns only this
definition — zero call sites. An order status change, payment update, or
cancellation does not bust this cache; the admin customers list can show a
stale total-spent/order-count/last-order-date for up to 300s after any of
those mutations. Bounded staleness (not unbounded), so Medium not Critical.

**Fix:** call `invalidateCustomersCache(storeId)` from
`OrderService.updateStatus` and wherever payment status flips
(`payment-event.service.ts` / `payment.service.ts` webhook-driven updates),
matching the pattern already used for `public:categories:*` in
`category.routes.ts`.

---

### 3. MEDIUM — Pillar 2 (Async) — `/public/contact` blocks the response on an inline third-party email send, inconsistent with its own file's fire-and-forget pattern

**Resolution: Fixed** (commit-to-be). `POST /contact`
(`apps/api/src/routes/public.routes.ts`) no longer awaits
`EmailService.sendContactForm(...)` — it fires the call and responds `200`
immediately, matching the newsletter-signup handler's
`.catch(err => logger.warn(...))` pattern in the same file. Did not add
Inngest or a persistence table for the submission (out of scope for the
"at minimum" fix requested); noted as a follow-up if Ahmad wants the
stronger guarantee.

**File:** `apps/api/src/routes/public.routes.ts:1679-1704`, `apps/api/src/services/email.service.ts:928-950`

```ts
router.post('/contact', writeLimiter, async (req, res, next) => {
  ...
  await EmailService.sendContactForm({ ... });   // <-- awaited, blocks the response
  res.json({ success: true, data: { message: 'Message sent successfully' } });
});
```

`sendContactForm` calls `sendPlatform`, a direct Resend/SMTP network call —
not queued via Inngest, not wrapped in `.catch()`. Two problems: (a) it's
inline 3rd-party I/O on a public write path with no queue, and (b) if
`sendPlatform` throws (SMTP hiccup, Resend rate limit), the whole request
500s even though the visitor's message content is not itself persisted
anywhere — a transient email-provider blip loses the submission outright.
This is directly inconsistent with the newsletter-signup handler earlier
in the same file (`public.routes.ts:1489-1496`), which fires its
welcome email with `.catch(err => logger.warn(...))` specifically so SMTP
problems "don't keep the customer staring at a spinner."

**Fix:** either move to Inngest (`inngest.send({ name: 'contact/submitted', data })`

- a new function under `lib/inngest/functions/`) or, at minimum, match the
  newsletter pattern: fire-and-forget with `.catch()` logging, and persist
  the submission to a table first so a failed email isn't a lost message.

---

### 4. MEDIUM/HIGH — Pillar 3 (DB) — `OrderService.list` has no cursor-pagination path; deep admin/Orders-PWA order lists page via `OFFSET`

**Resolution: Fixed-additive** (commit-to-be). `OrderService.list`
(`apps/api/src/services/order.service.ts`) now accepts an optional
`cursor` param and, when present, uses the same
`cursor: { id }, skip: 1, take: limit + 1` keyset pattern
`ProductService.listPublic` already uses (`product.service.ts:1338`),
returning `meta.nextCursor` and `meta.page`/`meta.totalPages` as
`undefined` in the cursor branch (matching the sibling). The existing
offset path is untouched and remains the default — no caller (admin,
Orders PWA) was changed to pass `cursor`, so this is purely additive
per instructions. The lower-priority `skip`-only siblings the audit
also flagged (`review.service.ts`, `return.service.ts`,
`affiliate.service.ts`, `loyalty.service.ts`, `inventory.service.ts`,
`shipping.service.ts`, `warehouse.service.ts`) were left as-is —
out of scope for this pass, same shape fix available when they're
touched next. A companion k6 scenario (finding #6, also fixed this
pass) measures the offset cost curve this fix targets.

**File:** `apps/api/src/services/order.service.ts:90-160`

```ts
const page = Math.max(1, options.page || 1);
const limit = Math.min(100, Math.max(1, options.limit || 20));
const skip = (page - 1) * limit;
...
prisma.order.findMany({ where, skip, take: limit, include: { customer: {...}, items: true, payments: {...}, _count: {...} } })
```

`Order` is denoted as a hot/big table in the audit brief for good reason —
it's the highest-write-volume table in the schema and the one every
merchant's admin dashboard and the Orders PWA page through constantly.
Unlike `ProductService.getAll` (`product.service.ts:1338`, which already
supports a `cursor ? {...} : {skip}` hybrid — cursor pagination shipped
there), `OrderService.list` has `take` capped at 100 (good — no unbounded
read) but no cursor option at all: a merchant with 20k+ orders paging to
"page 200" issues `OFFSET 19900` on every request, which Postgres must
walk past even with the `storeId, createdAt(sort: Desc)` composite index
in place — cost grows linearly with page depth instead of staying flat.

The same `skip`-only pattern (no cursor) recurs at lower volume/priority in
`review.service.ts:67,171`, `return.service.ts:65,470`,
`affiliate.service.ts:264,604,631`, `loyalty.service.ts:1030,1077`,
`inventory.service.ts:639,695`, `shipping.service.ts:142`,
`warehouse.service.ts:442` — same fix shape, lower priority than Order
given table size/growth rate.

**Fix:** add the same `cursor`/`orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]`
hybrid `ProductService.getAll` already uses, defaulting to offset for
shallow admin pages (page 1-5, where `OFFSET` cost is negligible) and
requiring cursor beyond that — or just switch the Orders PWA / deep-paging
admin UI to cursor outright.

---

### 5. MEDIUM/HIGH — Pillar 5 (Horizontal scaling) — the WBS bridge rate limiter is the one limiter in the codebase still on `MemoryStore`, multiplying its cap by replica count

**Resolution: Fixed** (commit-to-be). `bridgeRateLimit`
(`apps/api/src/routes/wa-bridge.routes.ts`) now passes
`store: makeRateLimitStore(redis.getClient(), 'wa-bridge')`, matching
every other limiter in `middleware/security.ts`.

**File:** `apps/api/src/routes/wa-bridge.routes.ts:53-67`

Every other rate limiter in the API explicitly builds a Redis-backed store
via the documented `makeRateLimitStore` helper in `middleware/security.ts:206-221`,
whose own comment states the reason precisely:

```ts
/**
 * Build a RedisStore for express-rate-limit so limits are shared across all API
 * replicas. The default in-memory MemoryStore counts per-process, letting a
 * client multiply its allowance by the replica count under horizontal scale
 * (F8). Returns `undefined` when Redis is unavailable...
 */
```

`authLimiter`, `writeLimiter`, `paymentLimiter`, `publicLimiter`,
`storeResolveLimiter`, `cartLimiter`, `newsletterLimiter`,
`couponValidateLimiter`, `viewIngestLimiter`, and the global limiter in
`index.ts:212` all pass `store: makeRateLimitStore(redis.getClient(), '<prefix>')`.
`bridgeRateLimit` in `wa-bridge.routes.ts:53` does not:

```ts
const bridgeRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator: req => (req.headers['x-wbs-api-key'] as string) || ipKeyGenerator(req.ip ?? '') || 'anonymous',
  ...
  // no `store:` — falls back to express-rate-limit's default in-memory MemoryStore
});
```

This is exactly the "F8" hazard the sibling comment describes: on N Railway
replicas, a single WBS API key (or an attacker who obtains one) gets N×120
req/min instead of 120/min, because each replica counts independently.
The route comment even states the intent — "contain a buggy WBS
state-machine retry loop from overwhelming FWB" — which the current
implementation only achieves per-replica, not per-integration.

**Fix:** one-line change — `store: makeRateLimitStore(redis.getClient(), 'wa-bridge')`,
matching every other limiter in the codebase.

---

### 6. LOW — Pillar 4 (k6) — no load-test scenario exercises an authenticated path (admin or `/auth/login`)

**Resolution: Fixed** (commit-to-be). Added
`loadtests/scenarios/lens-scaling-admin-auth.js`, modeled on
`lens-n-medium-traffic.js`'s structure/conventions: `setup()` logs in
once (`POST /auth/login`) and shares the JWT across VUs (avoids tripping
`authLimiter`'s 15-req/15min/IP+email cap), then each iteration hits
`GET /stores/:storeId/orders` at a few page depths (default
`page=1,25,100` at `limit=50`) to exercise finding #4's OFFSET cost
curve, with a per-depth `Trend` metric and a documented p95 threshold
(hard-failing on the shallow page, informational on deeper ones since
growing latency with depth is the expected, pre-cursor-adoption
behavior being measured). Wired into `loadtests/run.sh` (usage line,
required-env validation, excluded from `all` like `checkout-flow`) and
documented in `loadtests/README.md` (scenario table row + a full
"Authenticated admin order-list cost curve" section mirroring the
Lens N section's style).

**File:** `loadtests/scenarios/*.js`, `loadtests/README.md`

The six scenarios (`storefront-browse`, `api-bursts`, `checkout-flow`,
`multi-store-storm`, `multi-store-checkout-storm`, `lens-n-medium-traffic`)
give thorough, well-documented coverage of the **public/guest** storefront
surface — product list, PDP, categories, layout, guest cart→checkout, and
cross-tenant RLS contention — with a documented p95 ceiling
(`docs/perf/loadtest-2026-05.md`) per the audit brief's pillar-4 ask. None
of them exercise `/auth/login`, an authenticated admin session, or the
Orders PWA's authenticated order-list endpoint (finding #4 above). Given
`authLimiter` intentionally caps auth at 15 req/15min/IP+email, a full k6
ramp isn't the right tool for that endpoint specifically, but the admin/
Orders-PWA authenticated read paths (which finding #4 shows have an offset-
pagination cost curve) have no measured headroom the way the guest paths do.

**Fix:** low priority — add a small authenticated-admin scenario (login once,
reuse the JWT, hit `/admin/stores/:id/orders?page=N` at a few page depths)
so the cost curve found in finding #4 is measured, not just reasoned about.

---

## Severity tally

| Severity | Count                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------- |
| Critical | 1                                                                                                             |
| High     | 0 (two MEDIUM/HIGH findings above are recorded as Medium/High; treated as Medium for the tally, High-leaning) |
| Medium   | 4                                                                                                             |
| Low      | 1                                                                                                             |

Straight count by the severity written on each finding:

| Severity    | Findings |
| ----------- | -------- |
| Critical    | #1       |
| Medium/High | #4, #5   |
| Medium      | #2, #3   |
| Low         | #6       |

---

## What FWB already does well (so this audit reads balanced)

- **Caching infra is mature and correctly layered where it's used**: `public-cache.ts`'s `getCached()` does Redis-primary + bounded in-memory fallback + **in-process single-flight** (collapses a thundering herd at a TTL boundary to one query per pod, not one per request) + `invalidateCached`/`invalidateCachedPrefix` write-side busting. `/products`, `/products/:slugOrId`, `/categories`, `/search/suggest`, `/stores/:slugOrId` all use it correctly, all at the 120s TTL floor the project enforces via an ESLint rule (`cacheTtlSelectors`, referenced in `customers.routes.ts:339`).
- **Async/Inngest coverage is extensive**: 54 Inngest functions cover bulk AI, accounting journals, order-lifecycle fanout, abandoned carts, payment-webhook processing (with a durable inbox row + inline fallback if `inngest.send` itself fails — `webhook.routes.ts:213-257`), review requests, deadstock/reorder scans, and more. The payment-webhook path specifically moved off the shared Prisma pool to avoid starving auth under a webhook storm (`WebhookEvent` doc comment, `schema.prisma:1351-1364`).
- **Indexing is thorough and intentional** on every hot table checked (`Product`, `Order`, `OrderItem`, `Payment`, `PaymentEvent`, `AiUsage`, `ProductDailyView`) — composite indexes match real query shapes (`storeId, status`, `storeId, createdAt desc`, `storeId, isNew, newArrivalPosition`), with migration-dated comments explaining why each was added.
- **`ProductService.getAll` already has cursor pagination** (`product.service.ts:1338`) with a `skipCapped` safety flag — the pattern finding #4 wants applied to `Order` already exists elsewhere in the codebase as a reference implementation.
- **Horizontal-scaling hazards are, with one exception (#5), already closed**: every module-level cron (`abandoned-cart`, `shipping-carrier` tracking, `loyalty-automation`, `recommendation` FBT, the refresh-token cleanup in `index.ts`) is guarded by either `withLeaderLock` (Redis `SET NX`) or a dedicated `redis.acquireLock`/`releaseLock` pair — confirmed by reading each cron's start function. The two crons that aren't lock-guarded (`view-ingest.service.ts`'s debounce-map cleanup, `middleware/security.ts`'s CSRF-memory cleanup) are pure local-memory hygiene with no cross-instance correctness requirement, so that's correct, not an oversight. Socket.io already has `@socket.io/redis-adapter` wired with a graceful degrade + explicit warning log if Redis is absent (`socket.service.ts:82-105`). Every `multer` instance uses `memoryStorage()` — no local-filesystem write assumes a single host.
- **k6 coverage is unusually good for this project's stage**: six scenarios, a documented p95 ceiling per metric with the _reasoning_ written down (not just a number), a load-test-bypass-token mechanism for honest measurements, and a purpose-built `lens-n-medium-traffic.js` scenario that explicitly closes a "reasoned not measured" headroom gap across ~80 tenants.
