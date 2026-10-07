# Ruling R-EBDA-001 — backend runtime (draft; moves into `docs/RULINGS.md` on `main` in SP4)

**Date:** 2026-10-03. **Decided by:** Claude (SP3), under Ahmad's standing instruction "do not stop and continue everything in the plan". **Review:** Ahmad, after the fact. Overturning it before SP4 Stage 1 costs nothing; after that, it costs the Stage 1 work.

**Ruling:** Ebda's API is FWB's Express app running on Cloudflare Workers (`nodejs_compat` + `httpServerHandler`). Each request gets its own Prisma client (`@prisma/adapter-pg`, `engineType="client"`) over Hyperdrive (query cache OFF) to Neon, as a non-bypass role, with **strict** RLS on every tenant table and only transaction-local GUCs. No Hono rewrite. Cloudflare Containers is the named fallback if the Stage 1 concurrency exit test fails.

**Evidence:** `docs/design/cloudflare-backend.md`, `spikes/workers-api/README.md` (17/17 tests, 0 leaks, mutation-checked), `docs/design/express-on-workerd-experiment.md`.

**Binding consequences:**

1. Session-level `SET` / `set_config(..., false)` is forbidden. It leaks across tenants through a transaction pooler, and the spike demonstrated the leak.
2. Hyperdrive query caching stays disabled unless a cross-tenant test proves a cached path safe.
3. Unknown host → 404; reserved labels never resolve; cache keys include the host.
4. External calls never run inside the request transaction.
5. Security-relevant state (token denylist, lockout, MFA) lives in Durable Objects, never in KV.
