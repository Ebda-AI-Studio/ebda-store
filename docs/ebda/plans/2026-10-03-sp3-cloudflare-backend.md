# SP3 — Cloudflare backend design + spike (task plan, 2026-10-03)

**Goal:** decide how FWB's Express API (`apps/api`, ~143k lines TS, 74 route files, 65 Inngest functions) runs on Cloudflare for Ebda, and prove the riskiest part — Prisma pg adapter on workerd via Hyperdrive with per-transaction RLS GUCs — on three real routes, with buy-flow parity.

**Budget:** $35. Opus: design doc + Ruling. Sonnet: dependency inventory, spike code, harness wiring.

**Inputs already known (from FWB `docs/migration/backend-cf-migration-plan.md`, 2026-06-26):**
- Frontends (admin/web/orders) already run on Workers via OpenNext; only the API is on Railway.
- Blockers on Workers: ioredis (TCP; single wrapper `services/redis.service.ts`), Socket.io (2 files), sharp (5), imapflow (1), `@sentry/node`/OpenTelemetry node SDK, multer (5), Express itself.
- HARD-STOP: RLS relies on `SET LOCAL` GUCs inside ONE per-request interactive transaction (`middleware/tenant-context.ts`, `request-transaction.ts`). Must prove Hyperdrive keeps the tx on one connection and that no session-level `SET` leaks across tenants.

## Tasks

1. **Dependency inventory** (Sonnet, read-only) → `docs/design/cloudflare-backend-inventory.md`: every runtime dependency and Node API the API uses, files that use it, and its Workers status (works with `nodejs_compat` / needs swap / needs rewrite). Includes Redis call sites by command, `setInterval`/in-process state, request-transaction lifecycle hooks (`res.on('finish')`, streaming), file uploads, crons.
2. **Design** (Opus) → `docs/design/cloudflare-backend.md`: options (A) Express on workerd via `nodejs_compat` + `httpServerHandler`, (B) Hono rewrite, (C) Cloudflare Containers running Express as-is; per-dependency mapping with consistency stated; host routing for `<slug>.ebda.app` + CF-for-SaaS; tenancy under Hyperdrive; observability; recommendation.
3. **Spike** (Sonnet) in `spikes/workers-api/` on this branch: a Worker (wrangler, Node ≥22) with Prisma 6 + `@prisma/adapter-pg`, running against local Postgres 16 through `wrangler dev` (Hyperdrive `localConnectionString`). Routes: public catalogue read, cart write, payment webhook (HMAC verify + idempotent inbox). Tests on workerd (`@cloudflare/vitest-pool-workers`), including: GUC isolation under concurrent requests for two stores; a tenant-A request can never read tenant-B rows as the `force_app` role; unknown host → 404.
4. **Parity**: run FWB's `scripts/buy-flow-parity` against local Postgres/Redis (`--pg-url/--redis-url`) for the spike-covered scenarios; read `result.json`.
5. **Ruling** in `docs/RULINGS.md` (created in SP4's `main`; drafted here as `docs/design/ruling-draft-sp3.md`).

## Done when
Design + spike committed to PR, spike tests green on workerd (mutation-checked), parity `result.json` read, Ruling drafted. Ahmad told the gate decision taken under his "do not stop" instruction, for after-the-fact review.
