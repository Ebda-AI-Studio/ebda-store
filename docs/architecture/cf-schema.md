# Cloudflare schema (`packages/cf-schema`)

Source of the Cloudflare-only migration (Ruling INFRA-CF-1, plan `docs/plans/done/2026-10-28-store-on-cloudflare.md`, phase 1). Rulings CF-SCHEMA-1 to 5 in `docs/RULINGS.md`.

- **What it is:** SQLite DDL for the per-store Durable Object (`migrations/store/*.sql`, 122 tables) and the D1 `ebda-platform` database (`migrations/platform/*.sql`, 25 tables), plus Drizzle table definitions (`src/{store,platform}/schema.generated.ts`). Generated from `packages/database/prisma/schema.prisma` and the raw Postgres migrations by `node packages/cf-schema/scripts/generate.mjs` (`--check` for CI).
- **Where each model goes:** `model-split.json` (147 models: 23 D1, 113 StoreDO, 6 analytics, 1 dropped, 4 identity owned by the identity track). A new Prisma model fails `model-split.test.ts` until classified.
- **Store split:** `scripts/store-split.mjs` (105 columns over the 100-column limit, so D1 directory + DO `store_profile` + `store_config`).
- **Added on purpose:** `scripts/cf-additions.mjs` (CI-1 capture fields, buyer key, outbox, entity index, `do_flags`).
- **Hand-written invariants:** `migrations/*/0002_invariants.sql` (row-guard triggers). Everything else that was a Postgres function is a repo method, mapped in `docs/cf/fn-map.json`.
- **Limits to remember:** 100 columns per table and 100 bound parameters per query (chunk every `IN (...)` and bulk insert), 10 GB per DO.
- **The StoreDO applies them (PR C, Ruling CF-DO-SCHEMA-1).** `generate.mjs` also emits `src/store/migrations.generated.ts` (both SQL files as TS, because the Worker bundle has no `.sql` rule); `apps/api/src/cf/store-do/migrations.ts` applies them on every DO start, each step in one transaction with its `_migrations` row, and drops the Phase 0 thin spike tables on a spike-era DO. A DO binds to one store (`_identity`). Backups list tables from the live schema. Customer erasure/export refuses (`ERASURE_REGISTRY_INCOMPLETE`) until `cf/erasure/registry.ts` is generated from `erasure-classification.json` (G10 follow-up, cutover blocker).
- **Nothing reads these tables in production yet.** No store has `storage_backend = 'do'`; the StoreDO backend stays behind the per-store flag until the phase 2 and 3 slices land.
- **Importing these packages from `apps/api`:** the API's tsc (NodeNext/CommonJS) cannot load their ESM sources, so the Worker imports them as `@ebda-src/repo`, `@ebda-src/cf-schema`, `@ebda-src/prisma-meta`, typed by `apps/api/src/cf/repo-modules.d.ts` and wired in `wrangler.jsonc` `alias`, `vitest.shared.ts` and `vitest.workers-do.config.mts`. `tests/unit/cf-repo-modules-shim.test.ts` keeps the three in step.
- **Tests:** `npx vitest run packages/cf-schema` (needs `node:sqlite`, Node >= 22.13).
