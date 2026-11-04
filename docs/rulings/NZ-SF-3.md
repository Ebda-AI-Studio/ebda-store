# NZ-SF-3

> Section: NEON-ZERO storefront + cart (2026-11-04)

**Ruling NZ-SF-3 - the Postgres-unreachable storefront harness starts with the store's feature map in the cache, and the
checkout quote is a documented `it.fails` until N-10a / N-10b.** FeatureService serves a store's feature map from the cache (5 min,
`features:store:v3:<id>`, never-stale on every write via `invalidateCache`); its COLD read is the platform feature tables
(`store_features`, N-10b, not started) plus the plan entitlement (`plans` / `store_subscriptions`, N-10a, served by D1 only after
its cutover marker). Those reads are not this PR's (Ruling NEON-ZERO-2: a table family moves reads and writes together), so the
harness seeds the warm state and proves every storefront and cart route answers 2xx from the DO, D1 and KV with Postgres at a dead
port. The checkout quote also needs the uncached entitlement (`assertOrderAllowed`) and the uncached `b2b.wholesale` override
(`wholesaleEntitledUncached`); with both stubbed in a local experiment the quote answered 200 with Postgres dead, so nothing
else on that path touches it. `Store.plan` for a DO store now comes from the DO record (`lib/store-plan.ts`), which both services
need whatever D1 family serves the rest. Evidence: `apps/api/workers-test/pg-unreachable.test.ts` (13 pass, quote expected-fail).
Cost if wrong: on a cold feature cache (first request after a 5 min idle, or an invalidation) a DO store's storefront reads
Postgres for the feature map and returns 500 while Postgres is down, until N-10b lands.
