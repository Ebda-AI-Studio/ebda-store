# Cloudflare schema (`packages/cf-schema`)

Source of the Cloudflare-only migration (Ruling INFRA-CF-1, plan `docs/plans/2026-10-28-store-on-cloudflare.md`, phase 1). Rulings CF-SCHEMA-1 to 5 in `docs/RULINGS.md`.

- **What it is:** SQLite DDL for the per-store Durable Object (`migrations/store/*.sql`, 118 tables) and the D1 `ebda-platform` database (`migrations/platform/*.sql`, 23 tables), plus Drizzle table definitions (`src/{store,platform}/schema.generated.ts`). Generated from `packages/database/prisma/schema.prisma` and the raw Postgres migrations by `node packages/cf-schema/scripts/generate.mjs` (`--check` for CI).
- **Where each model goes:** `model-split.json` (145 models: 21 D1, 113 StoreDO, 6 analytics, 1 dropped, 4 identity owned by the identity track). A new Prisma model fails `model-split.test.ts` until classified.
- **Store split:** `scripts/store-split.mjs` (105 columns over the 100-column limit, so D1 directory + DO `store_profile` + `store_config`).
- **Added on purpose:** `scripts/cf-additions.mjs` (CI-1 capture fields, buyer key, outbox, entity index, `do_flags`).
- **Hand-written invariants:** `migrations/*/0002_invariants.sql` (row-guard triggers). Everything else that was a Postgres function is a repo method, mapped in `docs/cf/fn-map.json`.
- **Limits to remember:** 100 columns per table and 100 bound parameters per query (chunk every `IN (...)` and bulk insert), 10 GB per DO.
- **Nothing reads these tables in production yet.** The StoreDO backend stays behind `STORE_DO_ENABLED_IDS` until the phase 2 and 3 slices land.
- **Tests:** `npx vitest run packages/cf-schema` (needs `node:sqlite`, Node >= 22.13).
