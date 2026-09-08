# RLS request-transaction 30s-budget audit — 2026-07-15

Read-only audit. Root cause confirmed by a live production incident: `PUT
/stores/:id/orders/:id/status` → `OrderService.updateStatus` →
`OrderService.applyRefundEffects` exceeded 30s (per-item `FOR UPDATE`
inventory loop + coupon + affiliate reversal + 2 loyalty reversals +
backorder `updateMany` + Redis cache busts) → P2028 "Transaction already
closed" → 500.

**Lens:** `apps/api/src/middleware/tenant-context.ts` wraps every
tenant-scoped request in ONE Prisma interactive `$transaction` with a
30-second timeout (`packages/database/src/index.ts` `runInTenantContext`,
`{maxWait:10000, timeout:30000}`). The transaction is held open for the
**entire** request — it only commits on `res.on('finish')`. Anything the
handler does while that transaction is open (Redis, HTTP, per-row loops, long
service chains) eats into the same 30-second clock, regardless of whether
the slow work touches the database at all.

> **Correction, 2026-09-08 (not a rewrite — the finding above was accurate when written).**
> `tenant-context.ts` no longer commits on `res.on('finish')` for buffered
> responses. The lifecycle moved to `apps/api/src/middleware/request-transaction.ts`,
> which COMMITS BEFORE THE RESPONSE IS SENT on the buffered lane (every JSON /
> redirect / `res.send(buffer)` reply) and keeps the old commit-on-finish
> semantics only for the escalated STREAMING lane (`res.write` / `res.download` /
> `res.sendFile` / `res.flushHeaders` / `pipe(res)`). The 30-second transaction
> budget this audit is about is UNCHANGED — the transaction is still held for
> the whole handler, so every conclusion below about slow work inside it still
> stands; only the moment of COMMIT moved, and it moved EARLIER (the commit is
> now inside the response's critical path rather than after it).

Governing rule this class violates:
`feedback-redis-io-inside-rls-transaction-timeout.md` — "an interactive
transaction is a budget… put nothing slow in it." That rule was applied to
Inngest cron scans (`withRlsBypass`, audited 2026-06-09) but never audited
across the HTTP request path. This audit is that sweep.

---

## The mechanism that makes this worse than it looks

`packages/database/src/index.ts:79-113` — the `prisma` export is an
`AsyncLocalStorage`-backed `Proxy`. `PROXIED_PRISMA_METHODS` only routes
model accessors (`prisma.order`, `prisma.product`, …) and
`$queryRaw*`/`$executeRaw*` to the active tenant transaction.
**`$transaction` is not in that set** (`isProxiedProp` rejects any prop
starting with `$`), so every `withMoneyTx(prisma, …)`, `withRlsBypass(…)`,
or nested `runInTenantContext(…)` call made _inside_ an already-wrapped
request opens a **second, independent** `basePrisma.$transaction` on a
**separate pooled connection** — it does not nest onto the outer transaction.

Two consequences, both confirmed against the codebase:

1. **Nesting is not a mitigation.** The outer request transaction's 30s
   wall-clock timer keeps running no matter which connection the "protected"
   work uses. `applyRefundEffects`'s `withMoneyTx` block, `PaymentService`'s
   nested `runInTenantContext` calls, `withRlsBypass` feature-flag lookups —
   none of them buy back time from the outer budget. Comments in the
   codebase (e.g. `order.service.ts`'s "deliberately avoid network I/O
   within the Prisma tx") show the team correctly applied this rule to the
   _inner_ transaction but didn't realize the _outer_ per-request transaction
   has the identical property and is always present on every wrapped route.
2. **Every such nesting doubles pool pressure.** The request holds 2+
   connections simultaneously from an already-contended pool (`packages/
database/src/index.ts:36-43` documents a prior P2028 incident that forced
   `connection_limit` from 5→15). This is a correctness/capacity risk
   independent of the timeout risk.

`apps/api/src/routes/index.ts` shows the team already used this exact
reasoning to keep several routers **deliberately unwrapped**
(`storeRoutes`, `inventoryRoutes`, `notificationRoutes`,
`recommendationRoutes`, `shippingCarrierRoutes`, `newsletterRoutes`,
`wbsIntegrationRoutes`, `financeRoutes`, `smartLayerRoutes`,
`insightsRoutes`, `suppliersRoutes`, `purchaseOrdersRoutes`,
`stockAdjustmentsRoutes`, `expensesRoutes`, `backordersRoutes`,
`botAnalyticsRoutes`, `feature.routes.ts` at `/admin`+`/stores`) — each with
a comment citing this precise mechanism. That prior work is correct and is
**not** re-flagged here. This audit covers the routers that **are** wrapped
(mounted with `:storeId`/`:id` in the mount path, or `router.param('storeId',
tenantContext)` inside the file) and still contain the same defect class.

---

## Tally

- **Critical: 5** (4 new entry points into the already-known bug + 2 new
  structurally-identical bugs)
- **High: 8**
- **Medium: 5**
- **Low: 4**
- **Cross-referenced (already fixed / correctly out of scope): 3 categories**

---

## CRITICAL — same class as the confirmed 500, realistically trips in prod today

### C0. `OrderService.applyRefundEffects` is reachable from FOUR routes, not one

`apps/api/src/services/order.service.ts:1110-1292`. The confirmed incident
reached it via `updateStatus`. It is **also** reachable from three more
wrapped routes, each of which additionally front-loads an HTTP call before
ever reaching the loop — worse than the original incident, not equivalent:

| Route                                                         | Path in                                                                                                                        | Extra load before the loop                                                                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `PUT /stores/:storeId/orders/:id/status`                      | `order.routes.ts:505-539` → `updateStatus` (order.service.ts:895)                                                              | none (the original incident)                                                                                                            |
| `POST /stores/:storeId/orders/:orderId/refund-via-provider`   | `order.routes.ts:1178-1318` → `PaymentService.refund` (`payment.factory.ts:634-774`)                                           | DB claim → **HTTP `provider.refund()`** → DB `$transaction` → Redis `invalidateCustomersCache` → DB order lookup → `applyRefundEffects` |
| `POST /stores/:storeId/returns/admin/:id/complete`            | `return.routes.ts:342-388` → `ReturnService.complete` (`return.service.ts:393-432`) → same `PaymentService.refund` chain above | same as above                                                                                                                           |
| `POST /stores/:storeId/orders/:orderId/refresh-refund-status` | `order.routes.ts:1040-1107`                                                                                                    | nested `runInTenantContext` wrapping **HTTP `PaymentService.getRefundStatus`**, then conditionally `applyRefundEffects`                 |

CONFIRMED (all four call sites read directly). Fix direction: move the
FOR-UPDATE inventory loop + reversal chain out of the request path entirely
(Inngest step after the order/payment row transitions), or at minimum chunk
the per-item loop and move coupon/affiliate/loyalty reversals to fire after
the tx commits (mirroring the pattern already used correctly for
`bustProductCaches`).

### C1. `VariantService.generateVariants` — unbounded sequential per-row loop, structurally identical to the incident

`apps/api/src/services/variant.service.ts:597-615`:

```
for (const combo of newCombinations) {
  await prisma.productVariant.create(...)
}
```

No chunking, no cap on `newCombinations` found. Reachable from `POST
/stores/:storeId/products/:productId/variants/generate`
(`variant.routes.ts:370-389`). A product with 3 options × 10 values each =
1,000 combinations → 1,000 sequential `create` calls inside the outer 30s
tx. CONFIRMED. This is the closest structural match in the entire codebase
to the confirmed bug — same shape (sequential per-row DB write with no
chunk boundary), different table. Fix: chunk into bounded batches (same
`SCAN_CHUNK_SIZE`/`MATCH_CHUNK_SIZE` pattern already used in
`reorder-scan.service.ts` and `bank-reconcile.service.ts`), or `createMany`.

### C2. `wa-templates.routes.ts POST /sync` — chains a 60s-timeout HTTP call into a 30s-timeout HTTP call, inside a 30s transaction

`wa-templates.routes.ts:339-344` → `resolveHeaderHandle`
(`resolveHeaderHandle.ts:55-63`): `fetch(...)` with
`signal: AbortSignal.timeout(60_000)` — **the client itself permits this
single call to run twice as long as the entire outer transaction's hard
ceiling.** Immediately followed by `wa-templates.routes.ts:377-385`:
another `fetch(...)` with `AbortSignal.timeout(30_000)`, then per-row
`updateMany` loops at `:209-233` and `:417-428`. CONFIRMED. Near-certain to
trip under any real-world WBS backend latency, not a tail-risk edge case —
the code's own configured timeout for the first call alone exceeds the
transaction's budget. Fix: resolve/validate everything DB-side, close the
tenant tx, then make both HTTP calls outside any transaction (mirrors the
rationale already used to keep `wbsIntegrationRoutes`/`shippingCarrierRoutes`
unwrapped in `routes/index.ts`).

### C3. `payment-links.routes.ts POST /` — 8s + 20s external calls (28s combined) inside the outer tx

`payment-links.routes.ts:75-466`: ~6 sequential DB lookups (store, template,
product, customer, order create), then `PaymentService.createPayment`
(`:313`) → MyFatoorah `fetch` with `AbortSignal.timeout(8000)`
(`myfatoorah.provider.ts:127-137`), then `:370-384` → WBS `fetch` with
`AbortSignal.timeout(20_000)`. CONFIRMED. Combined worst-case HTTP wait
alone leaves almost no margin against the 30s ceiling before counting the
preceding DB work. Fix: same direction as C2 — split the DB setup and the
external calls across the tx boundary, or move template-send off the
request entirely via Inngest.

### C4. `feedback-redis-io-inside-rls-transaction-timeout.md`'s own sibling, `bank-reconcile.service.ts::runAutoMatch` — VERIFIED ALREADY FIXED, not re-flagged

Cross-reference: `docs/audits/2026-07-02-scaling-perf.md` Finding 2 flagged
this as CRITICAL (unchunked per-row loop inside `withRlsBypass`). Current
code (`bank-reconcile.service.ts:200-240`) shows `MATCH_CHUNK_SIZE = 50`
chunking with a code comment documenting the exact fix. Also: `finance.routes.ts`
has no internal `router.param('storeId', tenantContext)`, so it is genuinely
CONTEXT-LESS — this path was never reachable via the outer request tx this
audit is scoped to. Listed only to close the loop, not counted in the tally.

---

## HIGH — realistic to exceed 30s under real-world latency/load, not yet observed in prod

### H1. `ai.routes.ts` — 9 synchronous Gemini+Redis endpoints inside the outer tx

Mounted at `/stores/:storeId/ai`, wrapped. All of the following are awaited
directly in the handler (not the `/bulk/*` Inngest-enqueue endpoints, which
are correctly excluded):

| Route                                       | Service call                                                                                                             | Pattern  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------- |
| `POST /translate`                           | `AIService.translate` (`ai.service.ts:206-270`): `redis.get` → `model.generateContent()` → `redis.set`                   | #1+#2    |
| `POST /section-content`                     | `AIService.suggestSectionContent` (`:370-475`), same shape                                                               | #1+#2    |
| `POST /seo`                                 | `AIService.suggestSeo` (`:276-361`), same shape                                                                          | #1+#2    |
| `POST /product-meta-aeo`                    | `generateProductMetaAeo` — Gemini call inline, no cache                                                                  | #2       |
| `POST /suggest-categories`                  | `AIService.suggestCategories` (`:587-673`), redis+Gemini                                                                 | #1+#2    |
| `POST /palette-from-logo`                   | `AIService.extractPaletteFromLogo` (`:487-580`): outbound `fetch` of a merchant-controlled URL + `sharp` + Gemini Vision | #2       |
| `POST /product-faqs/draft`                  | `generateProductFaqs` — Gemini call inline                                                                               | #2       |
| `POST /products/:id/ai/reset-field`         | `fillProductFields` (`ai-autofill.service.ts:69-258`) — up to 5 serially-awaited Gemini+Redis calls chained              | #1+#2+#4 |
| `POST /products/:id/ai/balance-description` | `balanceProductLanguages` — 2 serial Gemini calls                                                                        | #1+#2    |

CONFIRMED (all 9, code read). No explicit per-call timeout visible on the
Gemini SDK calls themselves. Fix: move to the existing Inngest bulk-job
pattern already used elsewhere in this same file (`bulkAiJob.create` +
`inngest.send`), even for single-entity generation — poll from the client
like the `/bulk/:jobId` endpoints already do.

### H2. `order.routes.ts` payment-status/refund-status refresh — HTTP + Redis + 4-step chain

- `POST /:orderId/refresh-payment-status` (`:883-987`): `PaymentService.getPaymentStatus`
  (HTTP) → `confirmPaymentFromProviderStatus` → DB `$transaction` → Redis
  `invalidateCustomersCache` → `recordPaymentEvent` → `auditLog`. CONFIRMED,
  patterns #1+#2+#4.
- `POST /:orderId/refresh-refund-status` (`:1003-1177`): see C0 table above —
  nested `runInTenantContext` wrapping an HTTP call. CONFIRMED, #2+#4.

### H3. `order.routes.ts POST /:orderId/payment-link` — direct unwrapped HTTP call

`:1477-1502` awaits `PaymentService.createPayment` → MyFatoorah HTTP call,
sitting directly inside the outer tx with no isolation at all. CONFIRMED, #2.

### H4. `review.routes.ts` draft-response / product-summary — Gemini HTTP + hardcoded sleep, zero throttling

`apps/api/src/lib/ai/review-tools.ts`: `throttle()` does
`await new Promise(r => setTimeout(r, AI_BULK_THROTTLE_MS))` (default
2500ms) unconditionally, then `getModel().generateContent(prompt)`. Called
from `POST /reviews/admin/:id/draft-response` and `POST
/reviews/admin/products/:productId/summary` (review.routes.ts:366-403) —
**neither has `writeLimiter`**, unlike every AI endpoint in `ai.routes.ts`.
CONFIRMED, #2 plus non-DB blocking sleep. Most exposed AI endpoint in the
codebase on this specific axis (no rate limiter, no tx isolation at all).

### H5. `shipping.routes.ts` bulk area-rate upsert/import — up to 300-400 sequential upserts in an unprotected separate tx

`PUT /:storeId/shipping/area-rates/bulk` (`:646-706`) and `POST
/:storeId/shipping/area-rates/import` (`:716-866`): both build
`prisma.$transaction(rates.map(rate => prisma.shippingAreaRate.upsert(...)))`
— per the mechanism above, this is a **second, unprotected** transaction on
a separate connection, holding up to 300-400 statements' worth of wall time
while the outer tx is still open. The import path additionally does
CPU-bound XLSX/CSV row parsing before the transaction even starts. CONFIRMED,
#3. Fix: chunk (same pattern as C1/C4).

### H6. `staff.routes.ts POST /` — 5 serial nested transactions plus bcrypt

Every route on this router first runs `requireFeature('staff_accounts')` →
Redis GET, and on a cache miss, a `withRlsBypass` transaction
(`feature.service.ts:110`) — a second transaction before the handler body
even starts. `POST /` (`:96-152`) then itself serially awaits `withRlsBypass`
**four more times** (`tx.user.findFirst` → `bcrypt.hash(password, 12)` →
optional `tx.user.create` → `tx.storeStaff.findUnique` → `tx.storeStaff.create`)
plus `auditLog`. CONFIRMED, #4 + repeated nesting. Low risk of tripping 30s
alone, but real pool-pressure risk (up to 6 concurrent transactions per
request) and worth chunking to 1-2 nested calls.

### H7. Customers/orders `export.xlsx` — cross-referenced, re-flagged under THIS lens

`docs/audits/2026-07-02-scaling-perf.md` Finding 3 already flagged
`GET /stores/:storeId/customers/export.xlsx` (`customers.routes.ts:292`) and
`GET /stores/:storeId/orders/export.xlsx` (`order.routes.ts:75`) as
synchronous, unbounded-latency work (up to 20,000 orders, multi-sheet
ExcelJS build) — but under a rate-limiting/CPU lens, not this one. Both
routers **are** wrapped by the outer tenant-context transaction
(`customersRoutes` at `/stores/:storeId`, `orderRoutes` at
`/stores/:storeId/orders`), so a near-cap export is a legitimate transaction-
timeout risk in addition to the CPU/rate-limit risk already documented. Not
re-counted as a new finding — flagged here so the two audits' severities
compose correctly (this is now a two-reason fix, not one).

### H8. `product.routes.ts POST /bulk-update` — up to 25 sequential chunks inside the outer tx

`ProductService.bulkUpdate` (`product.service.ts:896-1056`): for
`price.adjustPct`/`inventory.adjust` modes, `runChunked(simpleProducts, 20,
fn)` runs up to 25 sequential chunks of 20 (500-product cap), each chunk
awaiting `Promise.all` of individual updates, followed by the 6-op Redis
cache bust (M1 below). CONFIRMED, #3 (bounded/chunked, still sequential
chunk-by-chunk). Lower risk than C1/H5 because it's chunked, but the same
shape scaled up.

---

## MEDIUM

### M1. Systemic — `ProductService.invalidateStoreProductCache` runs 6 sequential Redis round-trips on every product write

`product.service.ts:533-548`: 2× `redis.delete`, 3× `redis.deleteByPattern`
(SCAN+UNLINK sweep via `invalidateStoreProductCaches`), 1× `invalidateCached`
— called from `create`, `update` (after its own nested `withMoneyTx` — nesting
doesn't help, see mechanism section), `delete`, and
`bulkSetLowStockThreshold`. Each round-trip is individually fast (Redis
SCAN+UNLINK, non-blocking per the 2026-07-13 cache-stampede audit), but this
is the single highest-frequency violation of "nothing slow in the tx" in the
codebase — it fires on essentially every catalogue write. Not a standalone
500 risk at current Redis latency, but zero headroom if Redis ever degrades,
and the root architectural cause enabling everything else in the Medium/Low
tier below. Fix: pipeline the 3 `deleteByPattern` sweeps into one
`redis.pipeline()` call (mirrors the fix already applied to the low-stock
sentinel scan per `feedback-redis-io-inside-rls-transaction-timeout.md`).

### M2. `cart.service.ts::addItems` — up to 100-item sequential loop on the post-login cart-merge path

`cart.service.ts:249-315`: `for (const item of items) { await
tx.cartItem.update/create(...) }`, capped at 100 items
(`cart.routes.ts:31`), inside a nested `withMoneyTx`. Reachable from `POST
/stores/:storeId/cart/sync` — fires on every guest-cart-merge-at-login, a
common path, not a rare admin action. CONFIRMED, #3. Lower severity than
C1/H5 because 100 is a hard cap and cart-item writes are cheap single-column
touches, but the shape is identical to the confirmed bug's loop.

### M3. `payment-abandonments.routes.ts` — double-nested `runInTenantContext` for plain reads

`GET /` (`:93`) and `GET /stats` (`:221`) each call `runInTenantContext(storeId,
…)` again inside a request that is **already** wrapped (this router is
mounted with `:storeId` directly in the path). Pure architecture bug per the
mechanism section — 2 connections held for a request doing nothing but
paginated `findMany`/`count`. CONFIRMED. Not a realistic timeout risk on its
own (no loop/HTTP), but should be deleted (the outer `prisma` proxy already
routes these calls correctly without any nested wrapper).

### M4. Feature-gate middleware opens a second transaction on every request to 3 wrapped routers

`requireFeature(...)` → `feature.service.ts:110` `withRlsBypass` on a Redis
cache miss — present on `staff.routes.ts`, `payment-abandonments.routes.ts`,
and `wa-templates.routes.ts`, all three genuinely wrapped routers. Same
mechanism as M3 (extra connection, not itself slow). CONFIRMED, low severity
individually, but structural — every request to these 3 routers pays this
cost whenever the 300s feature cache is cold.

### M5. `variant.routes.ts POST /variants/bulk-inventory` — up to ~200 concurrent round-trips via `Promise.all`

`VariantService.bulkUpdateInventory` (`variant.service.ts:627-664`):
`Promise.all(updates.map(async u => { await findFirst; await update; }))`,
capped at 100 items. Parallel, not serial, so it's a weaker match for
sub-pattern #3 than C1 — flagged as PLAUSIBLE rather than a clean hit,
since concurrency (not accumulating wall-clock) is the exposure, and it's
bounded by the connection pool's own concurrency limit rather than
accumulating linearly toward 30s.

---

## LOW

- **L1.** `category.routes.ts` (every POST/PUT/DELETE), `typography.routes.ts
PUT /`, `store-layout.routes.ts POST /preview` — single `invalidateCached`/
  `redis.set` calls per mutation. Same root cause as M1, negligible
  individually (one round-trip, not a sweep).
- **L2.** `product.routes.ts PUT /new-arrivals|best-sellers/reorder`,
  `category.routes.ts` reorder endpoints — `prisma.$transaction(array)` (not
  proxied — separate connection per the mechanism section) over small
  arrays (tens of rows), plus one Redis call after. Pool-pressure note only.
- **L3.** `affiliate.service.ts::createPayout`, `loyalty.service.ts::
awardBonusPoints` — bounded 2-3-statement nested transactions. Negligible.
- **L4.** `OrderService.createAdminOrder` (`order.service.ts:1382-1518`) —
  4 serially-awaited DB-only service calls (product lookup → tax rates →
  `ShippingService.calculateShipping` → `CouponService.getByCode`), each a
  single indexed query. PLAUSIBLE #4, low risk — every step is cheap.

---

## Confirmed clean (audited, no findings)

`coupon.routes.ts`, `tax.routes.ts` (loop is pure in-memory math, no
per-iteration `await`), `loyalty.routes.ts` route handlers themselves
(the per-customer-loop-shaped `loyalty-automation.service.ts` is a
background cron, never called from any route — out of scope), `pwa.routes.ts`
(`push.service.ts`'s real `webpush.sendNotification` HTTP loop exists but is
never imported by `pwa.routes.ts` — only `notification.routes.ts`, which is
deliberately CONTEXT-LESS), `abandoned-cart.routes.ts` admin handlers
(the Redis/notification code lives in a `setInterval` cron path, not request-
reachable), `affiliate.routes.ts` admin handlers (`recordAffiliateEvent`
calls are all fire-and-forget, not awaited), `warehouse.routes.ts`
(explicitly confirmed safe by an in-code comment — no per-item loop),
`pages.routes.ts`, `blog.routes.ts`, `locations.routes.ts`, `customers.routes.ts`
(GET-only; the one Redis touch is a correct single cache-aside GET/SET),
`analytics.routes.ts` (GET-only, parallel `Promise.all`/cache-aside, no
loops or HTTP), `bulk.routes.ts` (the heavy per-row import loop runs inside
the Inngest function, not inline in the route — correctly offloaded).

`admin.routes.ts` and `feature.routes.ts` — confirmed `tenantContext` never
actually activates for either (bare `/admin`/`/stores` mount, no `:id`/
`:storeId` token in the mount path, no internal `router.param` registration).
Neither opens the outer transaction at all, so neither is in scope for this
defect class — `feature.routes.ts`'s exclusion is a **deliberate, already-
documented** prior fix for this exact class (see the comment in
`routes/index.ts`), not an oversight.

---

## Cross-reference to existing docs/audits/ (per instructions — not re-reported)

- `docs/audits/2026-06-09-rls-async-writer-audit.md` — different defect class
  (missing RLS _context_, not transaction-_budget_ exhaustion). No overlap.
- `docs/audits/2026-07-02-scaling-perf.md` Finding 2
  (`bank-reconcile.service.ts::runAutoMatch`) — same general class, verified
  **already fixed** in current code (chunked at `MATCH_CHUNK_SIZE = 50`).
  Also out of this audit's exact scope (`finance.routes.ts` is genuinely
  context-less, never reaches the outer request tx).
- `docs/audits/2026-07-02-scaling-perf.md` Finding 3 (customers/orders XLSX
  export) — re-flagged above as H7 under this specific lens (transaction-
  timeout, not just rate-limit/CPU).
- `docs/audits/2026-07-13-cache-stampede.md` — confirms `invalidateCachedPrefix`
  uses non-blocking SCAN+UNLINK (not blocking KEYS+DEL), which is why M1/L1's
  individual round-trips are fast rather than catastrophic; doesn't address
  the "still runs inside an open 30s tx" angle this audit covers.

---

## Summary for Ahmad

The confirmed refund-bug incident undersells its own blast radius:
`applyRefundEffects` is reachable from **four** routes, not one
(`updateStatus`, `refund-via-provider`, `returns/admin/:id/complete`,
`refresh-refund-status`), and three of those four front-load a real HTTP
call to the payment gateway before ever reaching the loop. The single
biggest structural fact underlying almost every other finding here:
**`$transaction` is not proxied by the tenant-context ALS wrapper**, so
every "safe" nested `withMoneyTx`/`withRlsBypass`/`runInTenantContext` call
inside a wrapped route is actually a second, independent transaction on a
second pooled connection — it protects nothing against the outer request
transaction's 30-second wall clock, and doubles connection-pool pressure on
top.

The two **new** findings structurally identical to the confirmed incident
(unbounded sequential per-row loop inside the tx, no chunking) are
`VariantService.generateVariants` (C1) and the shipping area-rate bulk
upsert/import (H5) — both are one `runChunked`/`MATCH_CHUNK_SIZE`-style fix
away from being safe, using a pattern this codebase has already proven out
twice (`reorder-scan.service.ts`, `bank-reconcile.service.ts`).

The two findings most likely to reproduce a P2028 under **normal** (not
edge-case) load are `wa-templates.routes.ts POST /sync` (C2 — its own
configured HTTP timeout for one call is literally double the transaction's
ceiling) and `payment-links.routes.ts POST /` (C3 — 28s of allowed HTTP
wait against a 30s budget). Both need the external call moved outside the
tenant-context transaction's scope entirely — the same fix pattern this
codebase already applied correctly to `storeRoutes`, `shippingCarrierRoutes`,
and `wbsIntegrationRoutes` at the router level; these two just need it
applied at the individual-route level since the rest of their respective
routers are otherwise safe to keep wrapped.
