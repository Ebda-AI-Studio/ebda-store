# R-EBDA-001

> Section: 2026-10-03 — Ebda fork (R-EBDA-\*)

Ruling R-EBDA-001: the backend runs Ebda Store's Express API on Cloudflare Workers (`nodejs_compat` + `httpServerHandler`). Each request gets its own Prisma client (`@prisma/adapter-pg`, `engineType="client"`) over Hyperdrive (query cache OFF) to Neon, as a non-bypass role, with strict RLS on every tenant table and only transaction-local GUCs. No Hono rewrite. Cloudflare Containers is the fallback if the Stage 1 concurrency exit test fails. This decision was taken under Ahmad's "do not stop" instruction and awaits his review. Evidence: `docs/ebda/design/cloudflare-backend.md`; `spikes/workers-api/` (17/17 tests on workerd, 0 leaks through a transaction-mode pooler, mutation-checked). Cost if wrong: the Stage 1 port work is redone on Containers.
