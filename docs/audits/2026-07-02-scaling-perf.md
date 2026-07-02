# FWB Scaling & Performance Audit — 2026-07-02

Read-only audit. Lens: "works at 100, dies at 1000" — N+1 queries, index
coverage, pagination, caching correctness, rate limiting, sync-vs-async work,
select/over-fetch. Worktree HEAD: `2332c4d5` (origin/main).

Prior context verified against current code (not re-derived from memory alone):

- `feedback-multistore-loadtest-results.md` — 100 VUs / 20 stores, p95 273ms,
  0 errors on the storefront **read** path. The memory file itself flags this
  as the optimistic case (warm edge cache, only 20 stores) and explicitly
  states the checkout / write-heavy path and cold-cache-stampede scenarios
  were **not** exercised. Still true as of this audit — no new load-test
  artifacts found in `loadtests/` beyond what that memory describes.
- `feedback-redis-io-inside-rls-transaction-timeout.md` — the documented fix
  (keep `withRlsBypass` interactive transactions to bounded DB reads/writes
  only; do classification + external I/O outside/chunked) is correctly
  applied in `low-stock-scan.service.ts`, `deadstock-scan.service.ts`, and
  `reorder-scan.service.ts` (verified: reorder-scan chunks at 25
  products/tx, deadstock-scan's per-product loop is pure in-memory work
  after one grouped query). **The same defect class recurs, unfixed, in
  `bank-reconcile.service.ts`** — see Finding 2.
- `feedback-fwb-public-api-variant-include-gap.md` — verified still fixed:
  `listPublic`/`advancedSearch` in `product.service.ts` include `variants`
  with a narrow `select`.
- `feedback-fwb-api-shape-mismatch-silent-cap.md` — not a scaling defect,
  out of this lens's scope; not re-checked.

Index coverage (`packages/database/prisma/schema.prisma`, 3487 lines) is
thorough: every hot list table (`Order`, `Product`, `Customer`, `Cart`,
`PaymentEvent`, `AuditLog`, `AffiliateEvent`, `JournalEntry`, etc.) has
composite indexes matching its actual `WHERE`/`ORDER BY` shape
(`storeId+status`, `storeId+createdAt DESC`, etc.). No JSONB-path columns are
indexed (none needed — `phone`/`email` are plain `String` columns
everywhere). This area is in good shape; no findings below repeat it.

---

## Findings

### 1. HIGH (CONFIRMED) — `GET /customers` and `/customers/export.xlsx` re-scan the entire order history on every request, with zero caching

`apps/api/src/routes/customers.routes.ts:129-285` (`aggregateCustomers`) is
called fresh, with no cache layer, from:

- `GET /stores/:storeId/customers` (line 664) — the admin Customers page,
  including every keystroke of the in-UI search (server-side `search` filter
  runs AFTER the full aggregation, not as part of the DB query).
- `GET /stores/:storeId/customers/export.xlsx` (line 292) — the export
  button.

Both calls trigger `prisma.order.findMany({ where: { storeId, deletedAt:
null }, include items+payments+customer, take: 20001 })` — the whole order
table (up to the 20k cap) is pulled with every order's line items and
payments, then aggregated in-memory via a `Map` (dedupe by
customer/email/phone key, per-order stat rollup), then sorted by
`totalSpent`. This repeats on **every single request** — there is no
`getCached`/Redis wrapper anywhere in this file (contrast with
`product.service.ts::listPublic`, which has a 30s Redis cache + `MAX_SKIP`
guard for the equivalent public read).

**Load scenario:** a store with 15-20k orders (order.routes.ts's own
`MAX_ORDERS_SCANNED` comment treats this as a realistic "large store" size)
averaging 2-3 line items each → 30-60k `OrderItem` rows + up to 20k `Payment`
rows transferred from Postgres and materialized in Node on every page view of
the Customers tab. The Map-build + sort is synchronous, blocking the event
loop for the whole store's dataset on every request — with concurrent admin
sessions (super_admin browsing multiple stores, or one merchant's staff
paging through search) this repeats per request, compounding query volume
and CPU time under concurrent admin load rather than a single shared
snapshot.

**Contrast:** `OrderService.list` (`apps/api/src/services/order.service.ts:72`)
does real DB-level `skip`/`take` pagination and returns only the requested
page. The customer listing is architecturally the odd one out — it has no
materialized/denormalized customer aggregate, so every read replays the full
order scan.

### 1b. HIGH (CONFIRMED) — `GET /customers/:customerKey` has no `take` cap at all

`apps/api/src/routes/customers.routes.ts:850` — `prisma.order.findMany({
where: { storeId, deletedAt: null, OR: [...] }, include: {...} })` for the
customer-detail view has **no `take`**, unlike every other order query in the
codebase (the list endpoint caps at 100, the export caps at 20001). A repeat
B2B or long-tenure customer with thousands of orders triggers a fully
unbounded fetch of every order + every line item + every payment for that
customer in one request/response.

**Load scenario:** at 1,000+ orders for a single customer (plausible for a
wholesale/repeat account after a couple of years), this endpoint returns an
unbounded payload and does unbounded in-memory aggregation — no crash today
at typical volumes, but it is the one query in this router family that was
never given the cap the sibling endpoints already have.

### 1c. MEDIUM (CONFIRMED) — none of the 4 `customers.routes.ts` endpoints is rate-limited

`list` / `search` / `:customerKey` / `export.xlsx` all sit behind
`adminMiddleware` (auth + role + store-access) only — no `writeLimiter` or
equivalent. Compare `ai.routes.ts` and `bulk.routes.ts`, where every
expensive POST carries `writeLimiter`. `export.xlsx` is the most expensive
call in the file (full aggregation + `ExcelJS` workbook build across 3
sheets) and has no throttle — a compromised or scripted staff session can
fire it repeatedly, each call doing the full uncached scan from Finding 1.

### 2. CRITICAL (CONFIRMED) — `bank-reconcile.service.ts::runAutoMatch` repeats the exact "loop-in-an-interactive-tx" defect already fixed elsewhere

`apps/api/src/services/accounting/bank-reconcile.service.ts:215-300`
(`runAutoMatch`, called from the bank-statement-import flow) wraps its
entire body in one `withRlsBypass(async tx => {...})` interactive
transaction, then does, **per unmatched `BankTransaction` row, with no
chunking**:

1. `tx.bankTransaction.findMany({ where: { storeId, matchStatus: {in:
['auto_matched','manual_matched']}, ... } })` — refetches the **entire**
   set of previously-matched transactions for the store from scratch, on
   every loop iteration. The only thing that changes per iteration is the
   in-memory `claimedEntries` Set already being tracked locally — this DB
   round-trip is redundant on every iteration after the first.
2. `tx.journalLine.findMany(...)` — candidate journal-line search.
3. Conditionally `tx.bankTransaction.update(...)`.

That's up to 3 sequential Prisma round-trips per row, all inside a single
interactive transaction, unbounded by row count. This is the identical shape
to the incident documented in
`feedback-redis-io-inside-rls-transaction-timeout.md` (2026-06-30,
`low-stock-scan.service.ts`/`deadstock-scan.service.ts`, "Transaction API
error: ... timeout for this transaction was 30000ms, however 39532ms
passed"), and the same file's own comments in `reorder-scan.service.ts`
explicitly document that fix pattern (chunk into `SCAN_CHUNK_SIZE = 25`
sub-transactions) as the cure for this exact class. `bank-reconcile.service.ts`
was not swept when that fix landed.

**Load scenario:** a bank statement covering a quarter or year for an
active merchant plausibly has 300-2,000 transactions
(`bank-reconcile.service.ts:140-168`'s own import loop — a sibling, slightly
lower-risk per-row upsert loop in the same file/transaction pattern —
confirms statements of that size are the expected input shape). At even
15-20ms per round-trip against pooled Neon, 2 findMany + conditional update
per row × 500 rows ≈ 15-20s; at 1,000+ rows this exceeds the 30s interactive
transaction ceiling and reproduces the exact P1 (`Transaction already
closed`) the team already hit and fixed for the inventory scans. Any Inngest
retry loop wrapping this call would repeat the all-day failure-spam pattern
from the prior incident.

### 3. MEDIUM (CONFIRMED) — heavy XLSX exports run synchronously in the request path and are not rate-limited

`GET /stores/:storeId/customers/export.xlsx` and `GET
/stores/:storeId/orders/export.xlsx` (`apps/api/src/routes/order.routes.ts:75`)
both do the full DB fetch (capped at `MAX_ORDERS_SCANNED = 20000`) +
build a multi-sheet `ExcelJS` workbook + `writeBuffer()`, entirely inline in
the HTTP request/response cycle — never offloaded to Inngest. Both are
correctly capped in row count (good — prevents unbounded memory), and the
code comments show real prior scaling attention (buffering the whole
workbook before touching `res` so the tenant-context transaction isn't held
open across a slow client download). But per the project's own standing
rule ("anything >300ms or 3rd-party goes through Inngest"), a near-cap
export (20k orders, 40-60k line items, 3 worksheets) is very plausibly a
multi-second synchronous CPU+DB operation on the shared Railway API
instance, and — per Finding 1c — carries no rate limiter on either route.

**Load scenario:** two admins of two different large stores exporting
simultaneously (or one admin double-clicking a slow export) both pin
CPU + hold a DB connection from the shared pool for the full scan+build
window with no queueing, no offload, no throttle.

### 4. LOW (PLAUSIBLE — documented tradeoff, unverified at horizontal scale) — `invalidateCachedPrefix` only clears the local in-memory cache, not Redis

`apps/api/src/lib/public-cache.ts:81-85` — `invalidateCachedPrefix(prefix)`
iterates the process-local `BoundedMap` only; the docstring explicitly
states Redis entries for that prefix are left to expire on their own TTL
("acceptable for product list caches keyed by varying query suffixes"). This
is the invalidation path used for `public:products:<storeId>:*` on every
product create/update/delete (`product.service.ts:488-489`,
`product.routes.ts:400,484`, `store.service.ts:30`) — the single
highest-cardinality, highest-traffic public cache key in the system (one
entry per distinct page/sort/filter/search combination).

At a single effective API instance this only reproduces the already-accepted
~30s TTL staleness window. It has **not** been validated against horizontal
scale-out: if Railway runs multiple API replicas (the architecture supports
it and the rate-limiter code already had to be made Redis-backed for exactly
this reason — `middleware/security.ts:206-219`, "F8"), a write on replica A
clears only replica A's local map; replicas B/C keep serving their own
locally-cached (and Redis-cached, since Redis itself isn't touched here at
all for the prefix case) stale product list for the full TTL after a
merchant edit, which is consistent with — not worse than — today's
single-TTL guarantee, but was never re-verified once the fix for F8 (the
rate limiter) established that multi-replica really is a deployment target
for this API. Flagging as a gap to verify, not a proven regression: no
evidence in `loadtests/` that a bulk-edit-then-immediate-read scenario across
replicas has been exercised.

---

## Severity Table

| #   | Severity | Status    | Defect                                                                                                                                                                                      | File:Line                                                                               |
| --- | -------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | HIGH     | CONFIRMED | Full order-table rescan + in-memory aggregation, no cache, on every `GET /customers` and `/customers/export.xlsx` call                                                                      | `apps/api/src/routes/customers.routes.ts:129-285`                                       |
| 1b  | HIGH     | CONFIRMED | `GET /customers/:customerKey` order query has no `take` cap (unbounded)                                                                                                                     | `apps/api/src/routes/customers.routes.ts:850`                                           |
| 1c  | MEDIUM   | CONFIRMED | No rate limiter on any of the 4 customer endpoints, incl. the heaviest (`export.xlsx`)                                                                                                      | `apps/api/src/routes/customers.routes.ts` (whole file)                                  |
| 2   | CRITICAL | CONFIRMED | Per-row N+1 query loop (up to 3 round-trips/row incl. a redundant re-fetch) inside one unchunked `withRlsBypass` interactive tx — same class as the 2026-06-30 30s-timeout P1, unswept here | `apps/api/src/services/accounting/bank-reconcile.service.ts:215-300` (`runAutoMatch`)   |
| 3   | MEDIUM   | CONFIRMED | Heavy XLSX exports (up to 20k orders) run synchronously in the request path, not Inngest-offloaded, not rate-limited                                                                        | `apps/api/src/routes/customers.routes.ts:292`, `apps/api/src/routes/order.routes.ts:75` |
| 4   | LOW      | PLAUSIBLE | `invalidateCachedPrefix` clears local memory only, not Redis, for the highest-traffic public cache key; documented as acceptable at current scale, unverified at multi-replica scale        | `apps/api/src/lib/public-cache.ts:81-85`                                                |

**Counts:** 1 CRITICAL · 3 HIGH · 2 MEDIUM · 1 LOW — 7 findings total (6 CONFIRMED, 1 PLAUSIBLE).

## Areas checked and found solid (not repeated as findings)

- Prisma schema index coverage across all hot tables.
- `product.service.ts::listPublic`/`advancedSearch` — Redis-cached, `MAX_SKIP`
  guard against deep-offset abuse, capped `take`, narrow `variants` select.
- `OrderService.list` — proper DB-level pagination with a 100-row cap.
- `low-stock-scan.service.ts`, `deadstock-scan.service.ts`,
  `reorder-scan.service.ts` — all correctly keep interactive
  `withRlsBypass` transactions to bounded/chunked DB work only, per the
  documented 2026-06-30 fix.
- `OrderService.createOrder` — the `withMoneyTx` transaction does DB-only
  work (per-item inventory decrement, coupon reservation, order create,
  ledger write); notifications/Inngest/socket events correctly fire after
  the transaction commits, not inside it.
- Rate limiting is Redis-backed (`RedisStore` via `rate-limit-redis`),
  correctly shared across replicas (not per-process `MemoryStore`).
