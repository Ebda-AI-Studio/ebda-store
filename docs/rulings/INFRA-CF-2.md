# INFRA-CF-2

> Section: Lifecycle emails and referral attribution (2026-10-22, branch `feat/lifecycle-emails`)

Ruling INFRA-CF-2 (2026-10-24, Phase 0 task 0.2) - the StoreDO data layer uses Drizzle (`drizzle-orm/durable-sqlite`), not Prisma. Evidence (measured, local workerd): Prisma 6.19.3 has no Durable Object SQLite adapter and its only SQLite-on-Workers adapter (`@prisma/adapter-d1`) runs "transactions" as individual queries (`d1-worker.ts:195`), so an atomic stock/money section is impossible; bundle 798 KiB gzip vs Drizzle 34 KiB gzip (gate 300 KiB); per-request client p50 4.4/6.0 ms vs 2.8/3.0 ms (list/cart-add); Drizzle's DO wrapper is built once per DO and needs no wasm engine, so the #177 QueryCompiler leak class cannot recur. Detail: `spikes/store-do/orm/README.md`. Cost if wrong: a Drizzle schema must be kept in step with `schema.prisma` by the parity test (task 1.6) instead of being generated from it, which is extra maintenance, not a correctness risk.
