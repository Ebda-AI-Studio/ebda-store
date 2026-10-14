# Storefront 500s during the 2026-09-15 ZAP scan — investigation (Phase 1)

Status: **Phase 1 complete. No code fix shipped.** The reported defect's suspected cause is
falsified; the real mechanism is proven; every remaining fix is a policy decision (see §5).

## 1. Report being investigated

- ZAP Baseline run `34939427461` (self-hosted runner `fwb-ci6`, 06:59:01–07:02:31Z, target
  `https://store.force-ai.co`, 757 URLs) listed **12 product pages as `500 Internal Server Error`**,
  e.g. `pecannbee/products/almond-plain`, `…/cashew-salted`, `wady-aljuz/products/cocoa-powder`,
  `…/palestinian-qazha`.
- `~/.claude/scripts/checkout-monitor.sh` failed at ~07:01Z for both stores:
  `catalogue/store-resolve FAILED (no product from /public/products)`.
- Suspected cause: the Prisma wasm QueryCompiler `RangeError: Invalid array buffer length`
  under concurrency.

## 2. The suspected cause does not apply to FWB

That class was recorded on **gcc-horse-market** (Prisma in workerd, client built per request).
FWB does not have that shape:

| Surface                   | Runtime                                                      | Prisma?                                                           | Evidence                                                                                |
| ------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `store.force-ai.co` (web) | Cloudflare Worker `force-web-cf-preview`                     | **none**                                                          | `grep @ebda/database\|@prisma apps/web` → no imports; data comes over HTTP from the API |
| `api.force-ai.co`         | Railway, Node (`x-railway-*` headers, deployment `d65adc78`) | `prisma-client-js` 6.19 native engine, **module-scope singleton** | `packages/database/src/index.ts` (`globalForPrisma.prisma ?? new PrismaClient(...)`)    |

API logs for 06:50–07:15Z hold **6 error lines, all one Axiom ingest error** (dataset column limit),
and no Prisma, pool or 5xx lines.

## 3. What actually happened (proven from production logs)

API request log (`railway logs --json`, `message: "request"`), per minute:

```
06:59 {200: 8}
07:00 {200: 140, 404: 3, 403: 3}
07:01 {200: 186, 429: 811}      <- ZAP spider burst
07:02 {200: 8}
```

The 07:01 429s cover the exact slugs ZAP reported as 500, e.g. `GET /products/almond-plain`,
`/products/cashew-salted`, `/products/cocoa-powder`, `/products/palestinian-qazha` at 07:01:14–15Z.
The previous night's scan (run `34817562917`, 07:22Z) shows the same thing: 07:25 `{200: 303, 429: 251}`,
07:26 `{429: 387, 404: 106}`.

Chain:

1. `apps/api/src/routes/public.routes.ts` mounts `publicLimiter` (300 req/min, keyed on `req.ip`)
   on the whole public router.
2. Storefront SSR calls the API from the Worker. **Those subrequests are counted under the visiting
   client's IP** (measurement in §4).
3. ZAP ran on `fwb-ci6`, a VM on the MacBook Pro that also runs the checkout monitor. Both use the
   same public egress IP. The scan used up that IP's 300/min bucket.
4. `fetchInitialProduct` (`apps/web/src/app/products/[slug]/ProductDetailBody.tsx`) does
   `if (!response.ok) throw new Error('product fetch failed: <status>')`. An upstream **429 therefore
   renders as a 500**, but only when the fetch is _blocking_, i.e. there is no cached entry or the
   `products:<storeId>` tag was purged. Pages with a stale cached entry are served stale and
   revalidate in the background, so most of the 757 URLs stayed 200.
5. The checkout monitor ran at 07:01Z from the same IP, got 429 on `/public/products?limit=1`, and
   reported "store-resolve FAILED". The monitor discards the HTTP status, so a rate-limit response
   is indistinguishable from an outage.

## 4. Measurements (production, GET-only, 2026-09-15 ~11:14–11:25Z)

The limiter bucket was read through `GET /api/v1/public/reviews/can-submit`. That route is guarded
**only** by `publicLimiter` and returns 400 at zod validation before any DB access. On the public
router, the tenant limiter (6000/min) overwrites the `RateLimit-*` headers, so they cannot be read
there.

| Test                                                                                                                                                  | Result                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idle control, 20 s, probes only                                                                                                                       | remaining 298 → 296 (1 probe + 1 background request from this IP)                                                                                                                                              |
| 20 uncached `wady-aljuz` product pages through the Worker, sequential                                                                                 | remaining 296 → 261: **34 decrements from 20 page loads** (~1.7 API calls per page)                                                                                                                            |
| Conclusion                                                                                                                                            | Worker SSR subrequests are rate-limited under **the shopper's own IP**, not one shared Worker bucket. One scanner cannot 429 other shoppers.                                                                   |
| Minimal repro: 320 GETs (20 concurrent) to drain this IP's bucket, then 2 uncached product pages, with `wrangler tail force-web-cf-preview --ip self` | 150 × 400 then 170 × 429 (bucket drained). Both pages **200** (1.5–2.1 s); the tail showed 2 events, `outcome: ok`, no exceptions. The 500 did **not** reproduce, because OpenNext served cached product data. |
| Sequential page timings                                                                                                                               | 0.9–2.4 s per product page (uncached SSR)                                                                                                                                                                      |
| Current `/health`                                                                                                                                     | `commit 6af9aa42…`, `deploymentId d65adc78…` = `main`                                                                                                                                                          |

No k6 run was made. A k6 run from this IP would only drain this IP's own bucket, which the
repro above already did at lower cost. It could not show anything about other shoppers.

## 5. Findings that remain, and options (decision required)

**F1 — an upstream 429 renders as a 500 on blocking PDP fetches** (`ProductDetailBody.tsx:139`).
The 500 is wrong: it reads as a server fault in DAST, Sentry and uptime checks.

- Option A: map 429 (and 503) to a retryable error page with `Retry-After`/503 semantics, and keep
  real 5xx as 500. Cost: App Router server components cannot set a status directly, so this needs a
  route-level error boundary or middleware; roughly a small PR plus a test.
- Option B: leave it as is and accept that a client that exceeds its own rate limit sees a 500.

**F2 — a 429 on `/public/store/resolve` renders as a 404 "store not found".**
`fetchStoreByDomain`/`fetchStoreBySlug` return `null` on any non-OK response, and
`getStoreByTenantParam` then calls `notFound()`. `storeResolveLimiter` is **30/min per IP**.
In the last 24 h there were `/store/resolve` 429 bursts that are **not** the ZAP run:
09-14 15:1x (206), 09-15 02:4x (5), 06:3x (109), 10:2x (131), 10:3x (72).

- **Not attributed.** Railway's HTTP log API (`railway logs --http`) returned
  `Problem processing request` for every query, so client IP and user agent could not be read.
  Callers on the web side are page SSR (`store-resolver.ts`, 15 s fetch cache), `sitemap.ts`,
  `llms.txt`, `feeds/products.json` and `agent-store-resolver.ts`, so crawlers are the likely
  source. Mobile-carrier CGNAT (many Kuwaiti shoppers behind one IP) is the case that would make
  this customer-facing, and it is unverified.
- To settle: read Cloudflare zone analytics or Workers Observability for `api.force-ai.co`
  `/api/v1/public/store/resolve` 429s at 10:21Z (client IP, ASN, UA); or add the client IP/UA to the
  API's 429 log line.
- Option: treat a 429 from resolve as transient (throw → error page, never a cached 404). This is
  the same class as F1 and should be fixed in the same pass if F1 is taken.

**F3 — the DAST scanner and the checkout monitor share one egress IP**, so every nightly scan fails
the monitor and trips the limiter.

- Options: throttle ZAP (`-z "-config spider.threadCount=2"` / a request delay); run ZAP on
  `ubuntu-latest` (different IP); or make the monitor record the HTTP status and report a 429 as
  "rate-limited", not "store down". A limiter bypass header does not help: the Worker does not
  forward `x-load-test-token` to its subrequests.

**F4 — the monitor hides the status code** (`curl … 2>/dev/null` + a JSON parse). Same fix as F3's
last option. The script lives outside this repo (`~/.claude/scripts/checkout-monitor.sh`).

## 6. Rulings

> **Ruling S1 — no code change on the strength of this incident.** The reported 500s are a correctly
> working per-IP rate limiter applied to the scanner's own IP, rendered with the wrong status. No
> other shopper was affected (§4 attribution test). Changing limiter policy or error-status mapping
> is a product/security decision, not a proven defect fix. Cost if wrong: if F2's unattributed
> `/store/resolve` bursts are real shoppers behind CGNAT, some are seeing a "store not found" 404
> today, and that stays unfixed until someone reads the edge logs.

## 7. Not verified, and why

- **The Worker's exact exception text during the 07:01Z burst.** `wrangler tail` is live-only, and
  the reproduction was served from cache. The text `product fetch failed: 429` is inferred from the
  code plus the API's 429 lines, not observed in a Worker log.
- **Who caused the non-ZAP `/store/resolve` 429 bursts.** The Railway HTTP log API failed, and the
  app log carries no IP or UA.
- **Whether Railway runs more than one API replica.** The limiter uses a shared Redis store, so the
  count is global either way.
