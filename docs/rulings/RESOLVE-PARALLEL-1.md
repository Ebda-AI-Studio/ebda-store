# Ruling RESOLVE-PARALLEL-1 - the public store payload is filled concurrently (2026-11-17)

Evidence (measured, Workers Logpush objects in R2 `ebda-logs`, read with `ebda-logs`, window 2026-11-15 15:40-16:30Z): `GET /public/store/resolve` on `ebda-api` had p50 0.72 s, p90 5.07 s, p99 7.2 s, max 8.2 s over 204 calls. Warm calls (the cached payload) answer in about 0.4-0.7 s; a cache miss took 3-8 s. The storefront page waits on that call before it starts its layout, categories and products calls (each 1.0-1.7 s), so a miss plus the second wave exceeded the status probe's 8 s deadline: every `ebda-web` request that ended `canceled` in the window was a probe the Worker had not answered in time (9 of 9). The incident clusters line up with API/web deploys (15:49/15:50Z) and with the probe cadence (every 5 min, longer than the 120 s cache entry, so each probe is a miss).

Cause: on a miss the fill awaited eight independent Durable Object / D1 reads one after another (features, FAQ/how-to/CMS extras, tax rate, SMS, cart email, WhatsApp opt-in, footer locations), so the cost was their SUM on a cold Durable Object.

Decision: those reads depend only on the store row and run in one `Promise.all` in both fills (`/store/resolve` and `/stores/:slugOrId`). The miss now costs the slowest single read. Pinned by `tests/unit/store-resolve-parallel-fill.test.ts` (structural; the route file is too large to mount).

Not verified: the production p90 after deploy (needs the deploy and 24 h of `ebda-logs` / status data). Cost if wrong: a pool of concurrent reads per miss instead of a sequence (bounded: seven reads, a 15-connection pool, DO stores use no Postgres connection).
