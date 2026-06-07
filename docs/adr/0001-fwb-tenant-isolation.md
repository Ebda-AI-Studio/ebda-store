# ADR 0001 — FWB tenant isolation: Postgres Row-Level Security

Status: Accepted (2026-06-07)

## Context

Force Website Builder is a multi-tenant storefront platform — every merchant ("store") shares one database and must never see another store's data.

## Decision

Tenant isolation is enforced at the **database layer** with PostgreSQL Row-Level Security, on top of application-layer `where: { storeId }` scoping (defense in depth):

- A dedicated **non-owner role (`force_app`)** that the application connects as, so RLS is not bypassed (table owners bypass non-`FORCE` RLS).
- `runInTenantContext(storeId, fn)` (`packages/database`) opens a transaction and runs `SET LOCAL app.current_store_id = '<uuid>'` before any query; the per-request middleware `apps/api/src/middleware/tenant-context.ts` wraps every tenant-scoped route in it.
- RLS policies on all tenant tables compare `store_id::text = current_setting('app.current_store_id', true)`.
- Super-admin / cross-tenant operations use an explicit bypass (`runWithBypassRls`) that sets `app.bypass_rls`.
- UUID format is validated before being interpolated into `SET LOCAL`.

Migrations: `packages/database/prisma/migrations/*_rls_*` (`add_rls_policies`, `rls_for_8_missing_tables`, `force_rls_enforcement`, `fix_ai_usage_rls_bypass`).

## Consequences

- Every tenant-scoped query MUST run within `runInTenantContext` (the middleware guarantees this for HTTP routes). A query outside the tenant context returns zero rows **by design** — that is the safety property, not a bug.
- A regression guard test asserts cross-store reads return zero rows under tenant context.
- After any Neon snapshot restore, RLS policy state must be re-verified (the runtime depends on the policy shape being intact).

## Related

- WBS targets this same pattern (see `whatsapp-broadcaster` ADR 0001 + the RLS refactor plan); it currently enforces isolation at the application layer.
- CRM is single-org and intentionally uses role-based authz instead (see `Force-Media-CRM` ADR 0001).
