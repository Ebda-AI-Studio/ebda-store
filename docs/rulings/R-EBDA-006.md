# R-EBDA-006

> Section: 2026-10-07 — Tenant defence: code-level guard + RLS on everything (R-EBDA-003..008)

Ruling R-EBDA-006 — the two RLS proofs stay independent of each other. `tests/integration/rls-ebda-app.test.ts` binds an ebda_app client built WITHOUT the guard (it issues deliberately unscoped queries to prove the DATABASE answers zero rows; through the guard they would never reach Postgres), and `tests/integration/tenant-guard-ebda-app.test.ts` proves the guard (including on an RLS-bypassing role). The integration test process's own `prisma` is the owner-role client (fixtures), installed by `tests/setup-e2e.ts`; the API server those suites call runs the guarded app client as `ebda_app`, so every HTTP flow is proven under both layers. Cost if wrong: code exercised in-process by an integration test (not over HTTP) runs unguarded there, and the API server runs Inngest functions as dry-run; so the store-row class (the one a pre-push review caught four times: contextless `prisma.store.*` in on-demand Inngest handlers and services) is also held by a static gate, `tests/unit/store-reads-are-scoped.test.ts`, which fails on any `prisma.store.*` call in lib/services/mcp/middleware/utils that is not lexically inside a scope call. Tenant-model calls in those paths rely on the call-site sweep and the runtime guard.

---

> Section: 2026-10-07 — Shipping carriers on the provider catalog (branch `feat/shipping-batch`)

Ruling R-EBDA-006 — the `cache-agent-docs-not-cookie-resolved` mutation spec is dropped: the sticky `x-store-slug` cookie resolution it removed no longer exists in apps/web/middleware.ts (main removed the cookie path entirely; the spec scored ERROR "stale" on main too), so there is no defence left to mutate. Record regenerated on a local Postgres, tier=all: 196/196 killed. Cost if wrong: a re-introduced cookie resolver on a shared-cacheable path would have no mutation proof until a new spec is written.
