# IDX-4

> Section: 2026-10-01 — Missing indexes / order search (`perf/missing-indexes`, issue #2405)

**Ruling IDX-4 — plain `CREATE INDEX` in the migration, no CONCURRENTLY pre-build.** Production on
2026-10-01 holds orders 188 rows, users 15, ai_usage 25k and cart_bundles 0. The builds take
milliseconds (0.7 s even at 100k orders), so the SHARE lock is negligible, and every statement is
`IF NOT EXISTS`. Cost if wrong: writes to `orders`/`users`/`ai_usage` wait for the build during
the pre-deploy step, a sub-second window at today's sizes.
