# RLS Cutover Plan — Option B (make the database backstop real)

**Decision:** Move FWB from app-layer-only tenant isolation to **enforced Postgres RLS** under a non-bypass `force_app` role. Security is non-negotiable, so we want the database itself to block cross-tenant access even if application code ever forgets a `where: { storeId }`.

**Governing principle — "nothing changes until it's proven":** Production keeps connecting as the `neondb_owner` `BYPASSRLS` role through Phases 1–2. On that role, **every** policy is ignored, so all the groundwork we ship is behaviorally inert in prod — same results, zero risk. The single behavioral change is Phase 3: flipping `DATABASE_URL` to `force_app`. That flip is one env var, gated on a green force_app test suite + staging soak, and reversible in one step.

Source of the problem: `docs/audits/2026-07-02-tenancy-rls-auth.md` (F1/F2/F3) + `docs/audits/2026-06-09-rls-async-writer-audit.md`.

---

## Current state (verified from migrations + code)

- **Role:** prod connects as `neondb_owner` (`rolbypassrls = true`). Boot guard `apps/api/src/index.ts:438-480` keeps serving with a loud warning while `ALLOW_BYPASSRLS_ROLE=true`. → RLS is **inert in prod today**.
- **`force_app` role** already exists and is granted DML + sequence usage + default privileges (`.../20260404000000_add_rls_policies/migration.sql:16-29`). Policies are written `FOR ALL TO force_app`.
- **Policy predicate is "allow-contextless" / hybrid** (`.../20260609000000_complete_force_rls_coverage/migration.sql:16-34`):
  `current_store_id() IS NULL OR app.bypass_rls='true' OR store_id = current_store_id()`.
  → A query with **no context set returns ALL tenants' rows**. This is fail-open by design (safe during the half-migration) but means the backstop only bites when context is actually set.
- **Context is set** by `runInTenantContext(storeId, fn)` (`packages/database/src/index.ts`) via `SET LOCAL app.current_store_id`. `withRlsBypass(fn)` sets `app.bypass_rls='true'`.
- **CI runs tests as the `test` superuser** (`ci.yml` `POSTGRES_USER: test`, `DATABASE_URL: postgresql://test:test@…`). → CI does **not** exercise RLS as `force_app` today. This is the biggest gap: we cannot prove the cutover safe without it.

### The three blockers that break at cutover (must fix in Phase 1)

- **F2 — ~26 store-scoped routers never set context.** `tenantContext` reads `req.params.storeId || req.params.id`, but Express only populates `req.params` for params declared in the **mount path**. Routers mounted at bare `/stores`, `/`, `/admin` (coupon, shipping, tax, loyalty, pwa, inventory, bulk, variant, notification, abandoned-cart, recommendation, shipping-carrier, affiliate, newsletter, wbs-integration, finance, smart-layer, insights, suppliers, purchase-orders, stock-adjustments, warehouse, expenses, backorders, bot-analytics, pages, blog, locations, admin, feature) hit `if (!storeId) next()` and never call `runInTenantContext`. Under allow-contextless, post-cutover these get **zero DB filtering** → a missing `where` there leaks all tenants. (`apps/api/src/routes/index.ts` mount table; `middleware/tenant-context.ts:37-53`.)
- **F3 — tables that are RLS-enabled but have NO `force_app` policy = deny-all at cutover.** The `20260404…` migration explicitly excluded `payments, return_items, system_settings, addresses, wishlist_items` from policies (line 150), and `20260530…_force_rls_enforcement` FORCE-RLS'd `addresses`. `FORCE`/`ENABLE` + no policy = **deny-all for a non-owner role**. At cutover, `addresses` (and any sibling in the same state) breaks **checkout + saved addresses platform-wide**. Works today only because the owner role bypasses.
- **No force_app test coverage** (CI runs as superuser) → we'd be flipping blind.

---

## Phase 0 — Discovery & guardrails (no behavior change, ship first)

1. **Enumerate the real deny-all set.** Don't trust the audit's single named table — find the class. Run against a copy of the schema (a throwaway container seeded with all migrations, connected as a non-owner):
   ```sql
   SELECT c.relname,
          c.relrowsecurity  AS enabled,
          c.relforcerowsecurity AS forced,
          COUNT(p.polname)  AS policies
   FROM pg_class c
   JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
   LEFT JOIN pg_policy p ON p.polrelid=c.oid
   WHERE c.relkind='r' AND c.relrowsecurity
   GROUP BY 1,2,3
   HAVING COUNT(p.polname)=0;   -- every row here is deny-all for force_app
   ```
   Expected hits: `addresses` + whichever of `payments/return_items/system_settings/wishlist_items` are enabled/forced without a policy. This list drives the Phase-1b migration.
2. **Confirm the prod role** (read-only): `railway run -- psql "$DATABASE_URL" -c "SELECT current_user, (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user)"`. Confirms we're on the bypass owner today.
3. **Decide the addresses/wishlist predicate.** These are **user-scoped** (FK `user_id → users`), no `store_id`. Two options:
   - **B-user (preferred):** introduce a user-context GUC `app.current_user_id`, set alongside the store GUC in the request path, and give user-scoped tables the policy `current_user_id() IS NULL OR bypass OR user_id = current_user_id()`. Real per-user DB backstop.
   - **B-lite (fallback):** give user-scoped tables a permissive contextless policy (`USING (current_store_id() IS NULL OR bypass OR true)`) so they don't deny-all, and keep user isolation in the app layer only. Faster, but no DB backstop for those tables.
     Recommendation: **B-user** for `addresses` (checkout PII) + `wishlist_items`; `payments/return_items` are reachable via their order's store, so give them a store-derived policy (`EXISTS (SELECT 1 FROM orders o WHERE o.id = order_id AND o.store_id = current_store_id())`) matching the pattern used for other child tables; `system_settings` is platform-global → `USING (true)` (intentionally not tenant-scoped) or restrict to bypass-only.

---

## Phase 1 — Make RLS correct-but-inert (ship on the bypass role → zero prod behavior change)

### 1a. Fix context on the ~26 bare-mount routers (F2) — code only, no migration

- For every store-scoped router currently mounted at bare `/stores`, change the mount to carry the param: `router.use('/stores/:storeId/coupons', tenantContext, couponRoutes)` **or** convert each sub-router to `Router({ mergeParams: true })` and re-apply `tenantContext` inside it after `:storeId` is parsed. Prefer the mount-path param form (smaller, matches the already-wired routers like `/stores/:storeId/products`).
- The `/` (pages, blog, locations) and `/admin` (admin, feature) routers resolve store by slug/host, not `:storeId` — audit each: either derive the storeId and call `runInTenantContext` explicitly, or confirm they only touch non-tenant/global tables and document why they're exempt.
- **Why it's inert in prod:** on the bypass role, setting context changes nothing (policies ignored). It does wrap those requests in `runInTenantContext`'s interactive tx (as the already-wired routers already are) — so this must pass the full integration suite, but results are identical.
- **Test:** add an assertion (unit or a lint) that every store-scoped router is mounted with `:storeId` in its path; and integration tests hitting one route per formerly-bare router.

### 1b. Add the missing `force_app` policies (F3) — migration, idempotent

- New migration `packages/database/prisma/migrations/<ts>_rls_close_denyall_tables/migration.sql`:
  - For each table found in Phase 0's deny-all query, `CREATE POLICY … FOR ALL TO force_app USING (<predicate>) WITH CHECK (<predicate>)` per the decision in Phase 0.3.
  - If choosing B-user, also add `current_user_id()` SQL function mirroring `current_store_id()`, and wire `SET LOCAL app.current_user_id` into `runInTenantContext` (from `req.user.id` threaded through) — additive, defaults to NULL (allow-contextless), so still inert on the bypass role.
  - Guard every statement with `IF NOT EXISTS` / `DO $$ … $$` blocks (migrations apply on API boot; must be safe to re-run).
- **Why it's inert in prod:** owner role bypasses these policies; they only matter under force_app.

### 1c. Make CI exercise RLS as force_app — the proof harness

- In `ci.yml`, after migrations run on the ephemeral Postgres, create the `force_app` role in the container (the migration already does `CREATE ROLE force_app` idempotently — verify it runs) and add a **second integration job** (or a tagged subset) whose `DATABASE_URL` connects **as force_app**, not the `test` superuser. This is the job that actually enforces RLS.
- Green here = "every code path works under RLS with context set, and cross-tenant access is denied." Add explicit cross-tenant negative tests: as force_app with store A's context, assert store B's rows are invisible for each formerly-deny-all table + a sample of store-scoped tables.

Ship 1a/1b/1c as **one or two PRs**. Prod is still on the owner role → users see no change. Merge only when the new force_app CI job is green.

---

## Phase 2 — Staging soak (still no prod change)

- Point a **staging** environment's `DATABASE_URL` at `force_app` (staging DB, non-owner). Run the full app: checkout (exercises `addresses`), payments, refunds, every admin section, the formerly-bare routers, the Inngest jobs + crons (these use `withRlsBypass` — confirm each still bypasses correctly), the Orders PWA.
- Watch for `permission denied` / empty-result regressions. Any table that 42501s or silently returns empty = a missing policy or a missing context set → back to Phase 1.
- Load-test one storefront + admin under force_app to confirm the extra interactive-tx wrapping on the newly-wired routers doesn't regress p95.

Exit criteria: full staging pass on force_app, zero permission errors, p95 within budget.

---

## Phase 3 — Production flip (the one behavioral change; Ahmad executes, reversible)

1. **Backup first** (the standing daily pg_dump already runs; take an on-demand one).
2. Set prod `DATABASE_URL` to the `force_app` login role (same host/db, different role+password). Keep `DIRECT_URL` as owner for migrations.
3. Remove `ALLOW_BYPASSRLS_ROLE` (or set false) so the boot guard now _enforces_ that we're on a non-bypass role (turn the warning into the intended assertion).
4. Deploy. Smoke: checkout, admin load, one formerly-bare router, one cross-tenant probe.
5. **Rollback (one step):** set `DATABASE_URL` back to the owner role + re-add `ALLOW_BYPASSRLS_ROLE=true`, redeploy. Instant return to today's behavior.
6. Post-flip: run the Phase-0 confirm query in prod to assert `current_user = force_app` and `rolbypassrls = false`.

---

## Work breakdown / PR sequence

| PR       | Phase | Content                                                                        | Prod impact           | Gate                                                          |
| -------- | ----- | ------------------------------------------------------------------------------ | --------------------- | ------------------------------------------------------------- |
| this doc | plan  | the plan                                                                       | none                  | review                                                        |
| RLS-1    | 1a    | remount ~26 routers with `:storeId`; router-mount assertion test               | none (inert on owner) | full integration suite green                                  |
| RLS-2    | 1b    | migration adding force_app policies for deny-all tables (+ user GUC if B-user) | none (inert on owner) | migration applies clean; schema query shows 0 deny-all tables |
| RLS-3    | 1c    | CI force_app integration job + cross-tenant negative tests                     | none                  | new job green                                                 |
| —        | 2     | staging soak on force_app                                                      | none (staging only)   | full staging pass                                             |
| —        | 3     | prod `DATABASE_URL`→force_app + drop ALLOW_BYPASSRLS_ROLE                      | **the cutover**       | Ahmad, after Phase 2                                          |

## Risks & mitigations

- **Missed deny-all table** → checkout/feature breaks at flip. _Mitigation:_ Phase-0 schema query is exhaustive; Phase-1c cross-tenant tests cover each; Phase-2 staging exercises real flows.
- **A `withRlsBypass` job that should be tenant-scoped** (or vice-versa) → wrong data under enforcement. _Mitigation:_ the 2026-06-09 async-writer audit + Phase-2 job runs.
- **Interactive-tx wrapping regresses latency** on newly-wired routers. _Mitigation:_ Phase-2 load test; these routers already should have been wrapped.
- **Doc drift** — CLAUDE.md/tenant-context.ts comments claim RLS is a live backstop. _Fix in RLS-1:_ correct the comments to say "enforced only after the force_app cutover; inert on the owner role" until Phase 3, then update to "enforced."

## Definition of done

Prod `current_user = force_app`, `rolbypassrls = false`; the Phase-0 schema query returns **zero** RLS-enabled-without-policy tables; the CI force_app job (incl. cross-tenant negative tests) is green; checkout + admin + jobs verified on staging then prod; `ALLOW_BYPASSRLS_ROLE` removed; docs corrected.
