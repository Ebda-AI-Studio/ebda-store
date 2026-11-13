# Spike: StoreDO (SQLite Durable Object per store), Ruling INFRA-CF-1 Phase 0

Plan: `docs/plans/done/2026-10-28-store-on-cloudflare.md` (tasks 0.1 to 0.7). Everything here is spike-only: its own
`package.json` and Worker (`ebda-store-do-spike`), never the production `ebda-api` Worker. Demo store used for all
live measurement: `storedemo-souq` (`09b5dbd1-1774-49b5-b781-e06d0ee7b0fe`), never `qa-walk-store-1010`.

## Numbers to beat (Task 0.1, measured 2026-10-24 from the Gulf (cf-ray colo KWI), client network floor about 310 ms per cold curl)

Source: `results/baseline-2026-10-24.json` (200 requests per endpoint, concurrency 4, first 10 discarded).

| Endpoint (today: Worker + Hyperdrive + Neon) | n ok              | p50 ms | p95 ms | p99 ms | non-2xx                                    |
| -------------------------------------------- | ----------------- | ------ | ------ | ------ | ------------------------------------------ |
| GET /api/v1/public/products?limit=24         | 190               | 436    | 547    | 2294   | 0                                          |
| POST /api/v1/public/cart/items (guest cart)  | 159               | 5337   | 6795   | 11038  | 31 (HTTP 429 from `cartLimiter`, excluded) |
| POST /api/v1/public/orders (COD)             | not measured live |        |        |        |                                            |

Why order-create is not baselined live: demo stores refuse orders server-side (Ruling LOOKS-4) and a spike must
not exercise production money paths. The order-create comparison is made on a local like-for-like transaction
(Task 0.5) and is reported as such, not as a production number.

Cold run (`results/baseline-cold-2026-10-24.json`): first request after 7 minutes of client silence (not 10; production
receives other traffic, so the Worker isolate was probably warm anyway): products list 443 ms. Cart-add cold was NOT
measured (HTTP 429 from the guest cart limiter, whose window my 200-request run had filled). Treat cold as INCONCLUSIVE.

Cart-add p50 of 5.3 s is the current serial-hop cost (Worker to Hyperdrive to Neon, several statements in one
request transaction); it is the number the DO path must beat, and the likeliest place for a large win.

Re-run: `node bench/baseline.mjs --store-id <uuid> --n 200 --c 4` (add `--cold` after 10 idle minutes).

## Frozen evidence (2026-10-28)

`src/repo.ts` and `src/schema.ts` are the Phase 0 ORM-decision snapshots. They used to be guarded by `tests/unit/store-do-spike-drift.test.ts` against the shipped StoreDO copy; PR C replaced that copy (full cf-schema, real money core), so the guard is removed and these files no longer track production code.
