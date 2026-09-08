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

Migrations: `packages/database/prisma/migrations/*_rls_*` (`add_rls_policies`, `rls_for_8_missing_tables`, `force_rls_enforcement`, `fix_ai_usage_rls_bypass`, `complete_force_rls_coverage`).

## Complete FORCE coverage (2026-06-09)

A coverage audit found that, of the public tables, only a subset had RLS `ENABLE`'d and fewer were `FORCE`'d. `ENABLE`-without-`FORCE` is acceptable for the live app _today_ (it connects as the non-owner `force_app` role, for which `ENABLE` already applies) but it is NOT defense-in-depth: any owner/superuser connection (a stray `psql`, a Neon owner query, a future role change) skips non-`FORCE`'d RLS entirely. Migration `20260609000000_complete_force_rls_coverage` closes the gap:

- **Newly protected (had NO RLS):** 16 tenant tables — 4 with a direct `store_id` (`affiliate_events`, `bulk_import_jobs`, `payment_events`, `whatsapp_templates`) and 12 child tables isolated through a parent FK via an `EXISTS` join (`cart_items`→carts, `order_items`/`payments`→orders, `return_items`→returns, `wishlist_items`→wishlists, `product_images`/`product_options`/`product_categories`/`product_tags`/`product_variants`→products, plus 2-hop `product_option_values`→options→products and `product_variant_options`→variants→products).
- **Newly FORCE'd (were ENABLE-only):** the remaining tenant tables — including the 4 that the earlier `force_rls_enforcement` migration _missed because it listed non-existent table names_ (`anomalies`→`profit_anomalies`, `dead_stock_flags`→`deadstock_flags`, `inventory_logs`→`inventory_history`, `notifications` [no such table]).
- **Intentionally LEFT without tenant RLS (documented in the migration):**
  - _User/identity-scoped, isolated at the auth layer not the store boundary_ — `users` (store_id is NULL for admins; auth lookups are contextless), `addresses`, `customer_addresses`, `refresh_tokens`, `verification_tokens`, `onesignal_subscriptions`. A store predicate here would 0-row auth. Same precedent the codebase set for `onesignal_subscriptions` in `rls_for_8_missing_tables`.
  - _Global / tenant-root_ — `stores` (resolved by slug/domain in `store-access.ts` _before_ any tenant GUC is set — a store predicate would break store resolution + login; the migration also `DISABLE`s the inert FORCE the prior migration left on it), `system_settings` (platform-global config, no store_id).

### Policy idiom — hybrid (superset of both historical generations)

FWB accumulated two policy shapes: the **old** `current_store_id() IS NULL OR store_id = current_store_id()` and the **new** `store_id = current_setting('app.current_store_id', true) OR current_setting('app.bypass_rls', true) = 'true'`. `withRlsBypass()` sets BOTH `app.bypass_rls='true'` AND `app.current_store_id=''`, so it satisfies both. New policies use the **hybrid** predicate so they are safe across every access pattern:

```
current_store_id() IS NULL                          -- no tenant ctx (webhook, super-admin)
OR current_setting('app.bypass_rls', true) = 'true' -- explicit bypass (Inngest/cron)
OR store_id = current_store_id()                    -- tenant match
```

**Contextless-read caveat (load-bearing):** the payment webhook at `/api/v1/webhooks` reads/updates `orders` and `payments` _without_ a `:storeId` and _without_ `withRlsBypass` — it relies on the old idiom's "context unset ⇒ allow" escape (`current_store_id()` is NULL when the GUC is unset). The hybrid predicate's first branch preserves this, so adding FORCE'd RLS to `payments` does NOT 0-row live payment confirmation. The regression test `tests/integration/tenant-isolation.test.ts` ("contextless read (payment webhook) still sees payments") guards this property.

> **Role-scoping note:** all FWB policies are `FOR ALL TO force_app`, so a table _owner_/superuser still bypasses them even under FORCE. This is intentional — prod connects as `force_app`. The integration test issues `SET LOCAL ROLE force_app` to exercise the policies on the CI superuser connection.

## Consequences

- Every tenant-scoped query MUST run within `runInTenantContext` (the middleware guarantees this for HTTP routes). A query outside the tenant context returns zero rows **by design** — that is the safety property, not a bug.
- **A statement error inside the request transaction poisons the whole request.** Because the middleware puts the entire request in ONE interactive transaction, Postgres aborts that transaction on the first statement error, and every later statement — including any in-place recovery query — fails with SQLSTATE `25P02` ("current transaction is aborted"). So the ordinary `try { create() } catch (P2002) { findFirst() }` idiom is INOPERATIVE inside a request: it turns a recoverable unique race into a 500. Any write that can lose a unique race must be wrapped in `withSavepoint()` (`apps/api/src/lib/savepoint.ts`), which brackets it in a Postgres SAVEPOINT so the failure rolls back only that statement. `services/accounting/journal.service.ts` carries the same fix inline (it receives an explicit `tx` rather than the ambient proxy). Regression guard: `tests/integration/cart-session-race.test.ts`.
- **`tenantContext` commits on `res.on('finish')` — AFTER the response is flushed.** A client's next request can therefore begin before the previous request's writes are visible, so read-then-create paths race even for a strictly sequential caller. Measured at ~1 in 30 sequential add-then-read pairs on a developer machine; far more on a loaded CI runner.
- A regression guard test asserts cross-store reads return zero rows under tenant context.
- After any Neon snapshot restore, RLS policy state must be re-verified (the runtime depends on the policy shape being intact).

## Related

- WBS targets this same pattern (see `whatsapp-broadcaster` ADR 0001 + the RLS refactor plan); it currently enforces isolation at the application layer.
- CRM is single-org and intentionally uses role-based authz instead (see `Force-Media-CRM` ADR 0001).
