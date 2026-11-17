# RLS Cutover Plan — Option B (make the database backstop real)

**Decision:** Move Ebda Store from app-layer-only tenant isolation to **enforced Postgres RLS** under a non-bypass the earlier app role. Security is non-negotiable, so we want the database itself to block cross-tenant access even if application code ever forgets a `where: { storeId }`.

**Governing principle — "nothing changes until it's proven":** Production keeps connecting as the `neondb_owner` `BYPASSRLS` role through Phases 1–2. On that role, **every** policy is ignored, so all the groundwork we ship is behaviorally inert in prod — same results, zero risk. The single behavioral change is Phase 3: flipping `DATABASE_URL` to the earlier app role. That flip is one env var, gated on a green the earlier app role test suite + staging soak, and reversible in one step.

Source of the problem: `docs/audits/2026-07-02-tenancy-rls-auth.md` (F1/F2/F3) + `docs/audits/2026-06-09-rls-async-writer-audit.md`.

---

## Current state (verified from migrations + code)

- **Role:** prod connects as `neondb_owner` (`rolbypassrls = true`). Boot guard `apps/api/src/lib/database-role-guard.ts` (awaited before `listen()`, FIX-003) keeps serving with a loud warning while `ALLOW_BYPASSRLS_ROLE=true`. → RLS is **inert in prod today**.
- **the earlier app role** already exists and is granted DML + sequence usage + default privileges (`.../20260404000000_add_rls_policies/migration.sql:16-29`). Policies are written `FOR ALL TO the earlier app role`.
- **Policy predicate is "allow-contextless" / hybrid** (`.../20260609000000_complete_force_rls_coverage/migration.sql:16-34`):
  `current_store_id() IS NULL OR app.bypass_rls='true' OR store_id = current_store_id()`.
  → A query with **no context set returns ALL tenants' rows**. This is fail-open by design (safe during the half-migration) but means the backstop only bites when context is actually set.
- **Context is set** by `runInTenantContext(storeId, fn)` (`packages/database/src/index.ts`) via `SET LOCAL app.current_store_id`. `withRlsBypass(fn)` sets `app.bypass_rls='true'`.
- **CI runs tests as the `test` superuser** (`ci.yml` `POSTGRES_USER: test`, `DATABASE_URL` as the `test` user). → CI does **not** exercise RLS as the earlier app role today. This is the biggest gap: we cannot prove the cutover safe without it.

### The three blockers that break at cutover (must fix in Phase 1)

- **F2 — ~26 store-scoped routers never set context.** `tenantContext` reads `req.params.storeId || req.params.id`, but Express only populates `req.params` for params declared in the **mount path**. Routers mounted at bare `/stores`, `/`, `/admin` (coupon, shipping, tax, loyalty, pwa, inventory, bulk, variant, notification, abandoned-cart, recommendation, shipping-carrier, affiliate, newsletter, wbs-integration, finance, smart-layer, insights, suppliers, purchase-orders, stock-adjustments, warehouse, expenses, backorders, bot-analytics, pages, blog, locations, admin, feature) hit `if (!storeId) next()` and never call `runInTenantContext`. Under allow-contextless, post-cutover these get **zero DB filtering** → a missing `where` there leaks all tenants. (`apps/api/src/routes/index.ts` mount table; `middleware/tenant-context.ts:37-53`.)
- **F3 — tables that are RLS-enabled but have NO the earlier app role policy = deny-all at cutover.** The `20260404…` migration explicitly excluded `payments, return_items, system_settings, addresses, wishlist_items` from policies (line 150), and `20260530…_force_rls_enforcement` FORCE-RLS'd `addresses`. `FORCE`/`ENABLE` + no policy = **deny-all for a non-owner role**. At cutover, `addresses` (and any sibling in the same state) breaks **checkout + saved addresses platform-wide**. Works today only because the owner role bypasses.
- **No the earlier app role test coverage** (CI runs as superuser) → we'd be flipping blind.

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
   HAVING COUNT(p.polname)=0;   -- every row here is deny-all for the earlier app role
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

### 1b. Add the missing the earlier app role policies (F3) — migration, idempotent

- New migration `packages/database/prisma/migrations/<ts>_rls_close_denyall_tables/migration.sql`:
  - For each table found in Phase 0's deny-all query, `CREATE POLICY … FOR ALL TO the earlier app role USING (<predicate>) WITH CHECK (<predicate>)` per the decision in Phase 0.3.
  - If choosing B-user, also add `current_user_id()` SQL function mirroring `current_store_id()`, and wire `SET LOCAL app.current_user_id` into `runInTenantContext` (from `req.user.id` threaded through) — additive, defaults to NULL (allow-contextless), so still inert on the bypass role.
  - Guard every statement with `IF NOT EXISTS` / `DO $$ … $$` blocks (migrations apply on API boot; must be safe to re-run).
- **Why it's inert in prod:** owner role bypasses these policies; they only matter under the earlier app role.

### 1c. Make CI exercise RLS as the earlier app role — the proof harness

- In `ci.yml`, after migrations run on the ephemeral Postgres, create the the earlier app role in the container (the migration already does `CREATE ROLE the earlier app role` idempotently — verify it runs) and add a **second integration job** (or a tagged subset) whose `DATABASE_URL` connects **as the earlier app role**, not the `test` superuser. This is the job that actually enforces RLS.
- Green here = "every code path works under RLS with context set, and cross-tenant access is denied." Add explicit cross-tenant negative tests: as the earlier app role with store A's context, assert store B's rows are invisible for each formerly-deny-all table + a sample of store-scoped tables.

Ship 1a/1b/1c as **one or two PRs**. Prod is still on the owner role → users see no change. Merge only when the new the earlier app role CI job is green.

---

## Phase 2 — Staging soak (still no prod change)

**SUPERSEDED (#1975, 2026-09-26) — staging itself is retired.** `ci.yml`
retired the `TEST_DATABASE_URL` path that pointed at the `ep-spring-dew`
preview branch "with staging" (see that file's comment on the integration-test
DB setup), so there is no standing staging `DATABASE_URL` left to point at
the earlier app role. Its replacement is the **CI the earlier app role integration job** (added in
the same PR series as the RLS-S1..S5 rulings below): it runs the built API as
the earlier app role against a real (ephemeral, per-job) Postgres and the **RLS Payload
Parity** job diffs owner-vs-the earlier app role storefront payloads. That substitute is
narrower than the staging soak this section originally specified, on three
axes:

1. **Inngest/cron writers are unexercised.** The CI job sets
   `INNGEST_DRY_RUN: 'true'`, which no-ops every Inngest function — so the
   "Inngest jobs + crons... confirm each still bypasses correctly" bullet
   below has never actually been run under the earlier app role in CI (#1974).
2. **No sustained/real traffic volume.** A CI job proves correctness on a
   fixed, small fixture set once; it says nothing about behavior under the
   concurrency and data volume of the three live stores.
3. **No p95 measurement.** The "load-test... confirm... doesn't regress p95"
   bullet has no CI equivalent at all.

The bullets immediately below are kept as the CHECKLIST of what a staging
soak was meant to exercise — useful for judging what the CI substitute does
and does not cover, and for planning a one-off soak against a restored
production copy (see "Before a second attempt" further down) — not as
instructions to point a `DATABASE_URL` at a staging environment that no
longer exists.

- Point a **staging** environment's `DATABASE_URL` at the earlier app role (staging DB, non-owner). Run the full app: checkout (exercises `addresses`), payments, refunds, every admin section, the formerly-bare routers, the Inngest jobs + crons (these use `withRlsBypass` — confirm each still bypasses correctly), the Orders PWA.
- Watch for `permission denied` / empty-result regressions. Any table that 42501s or silently returns empty = a missing policy or a missing context set → back to Phase 1.
- Load-test one storefront + admin under the earlier app role to confirm the extra interactive-tx wrapping on the newly-wired routers doesn't regress p95.

Exit criteria (ORIGINAL, unexecutable — no staging environment exists):
full staging pass on the earlier app role, zero permission errors, p95 within budget.

Exit criteria (CURRENT substitute, #1975): the CI the earlier app role integration job
and the RLS Payload Parity job both green on `main`; the "Before a second
attempt" checklist below run at least once against a restored production
copy; Inngest/cron coverage and p95 remain OPEN GAPS to be closed or
explicitly accepted as a residual before Phase 3, not silently assumed
covered by a green CI run.

---

## Phase 3 — Production flip (the one behavioral change; Ahmad executes, reversible)

1. **Backup first** (the standing daily pg_dump already runs; take an on-demand one).
2. Set prod `DATABASE_URL` to the the earlier app role login role (same host/db, different role+password). Keep `DIRECT_URL` as owner for migrations.
3. Remove `ALLOW_BYPASSRLS_ROLE` (or set false) so the boot guard now _enforces_ that we're on a non-bypass role (turn the warning into the intended assertion).
4. Deploy. Smoke: checkout, admin load, one formerly-bare router, one cross-tenant probe.
5. **Rollback (one step):** set `DATABASE_URL` back to the owner role + re-add `ALLOW_BYPASSRLS_ROLE=true`, redeploy. Instant return to today's behavior.
6. Post-flip: run the Phase-0 confirm query in prod to assert `current_user = the earlier app role` and `rolbypassrls = false`.

---

## Work breakdown / PR sequence

| PR       | Phase | Content                                                                                   | Prod impact           | Gate                                                          |
| -------- | ----- | ----------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------- |
| this doc | plan  | the plan                                                                                  | none                  | review                                                        |
| RLS-1    | 1a    | remount ~26 routers with `:storeId`; router-mount assertion test                          | none (inert on owner) | full integration suite green                                  |
| RLS-2    | 1b    | migration adding the earlier app role policies for deny-all tables (+ user GUC if B-user) | none (inert on owner) | migration applies clean; schema query shows 0 deny-all tables |
| RLS-3    | 1c    | CI the earlier app role integration job + cross-tenant negative tests                     | none                  | new job green                                                 |
| —        | 2     | staging soak on the earlier app role                                                      | none (staging only)   | full staging pass                                             |
| —        | 3     | prod `DATABASE_URL`→the earlier app role + drop ALLOW_BYPASSRLS_ROLE                      | **the cutover**       | Ahmad, after Phase 2                                          |

## Risks & mitigations

- **Missed deny-all table** → checkout/feature breaks at flip. _Mitigation:_ Phase-0 schema query is exhaustive; Phase-1c cross-tenant tests cover each; Phase-2 staging exercises real flows.
- **A `withRlsBypass` job that should be tenant-scoped** (or vice-versa) → wrong data under enforcement. _Mitigation:_ the 2026-06-09 async-writer audit + Phase-2 job runs.
- **Interactive-tx wrapping regresses latency** on newly-wired routers. _Mitigation:_ Phase-2 load test; these routers already should have been wrapped.
- **Doc drift** — CLAUDE.md/tenant-context.ts comments claim RLS is a live backstop. _Fix in RLS-1:_ correct the comments to say "enforced only after the the earlier app role cutover; inert on the owner role" until Phase 3, then update to "enforced."

## Definition of done

Prod `current_user = the earlier app role`, `rolbypassrls = false`; the Phase-0 schema query returns **zero** RLS-enabled-without-policy tables; the CI the earlier app role job (incl. cross-tenant negative tests) is green; checkout + admin + jobs verified on staging then prod; `ALLOW_BYPASSRLS_ROLE` removed; docs corrected.

---

## 2026-09-25 — first Phase 3 attempt, rolled back (13:21–13:25)

**What broke.** Minutes after production's API switched to the earlier app role, the public store payloads (`GET /public/stores/:slugOrId`, `GET /public/store/resolve`) returned `faqs: []` / `howtos: []` (demo-store has 24/9 active, wady-aljuz 8/3). No error anywhere. Rolled back to the owner role.

**The class.** The policies come in two shapes, and this plan only described one:

- **allow-contextless** — `current_store_id() IS NULL OR … OR store_id = current_store_id()`. A query with no context sees every row. 74 tables.
- **STRICT** — `store_id = current_setting('app.current_store_id', true) OR current_setting('app.bypass_rls', true) = 'true'`. A query with no context sees **zero** rows and a write is **rejected**. 24 tables: `accounts, ai_recommendation, ai_usage, backorder_lines, blog_posts, bulk_ai_jobs, customer_cohort_snapshots, customer_rfm_snapshots, deadstock_flags, expenses, funnel_snapshots, journal_entries, journal_lines, profit_anomalies, purchase_order_items, purchase_orders, reorder_rules, reorder_suggestions, sequences, stock_adjustment_items, stock_adjustments, store_faqs, store_howtos, suppliers`. Pinned by the `RLS policy registry` test in `tests/integration/rls-ebda-app.test.ts`.

Every contextless reader of a strict table fails silently under the earlier app role. The CI integration suite already ran the API as the earlier app role and passed, because nothing compared what came back.

**Paths found (all fixed in `fix/rls-strict-policy-contextless-reads`):**

| Path                                                                                                                                                                                 | Strict table                                                                                 | Symptom under the earlier app role                                      | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /public/stores/:slugOrId`, `GET /public/store/resolve` (nested `store.faqs/howtos`)                                                                                             | store_faqs, store_howtos                                                                     | `[]`                                                                    | read in the resolved store's context (`readInStoreContext`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `GET /public/:storeId/products/:productId/recommendations`                                                                                                                           | ai_recommendation                                                                            | AI cross-sell gone, silent FBT fallback                                 | same                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Admin `/stores/:id/faqs*`, `/stores/:id/howtos*` (store.routes is context-less)                                                                                                      | store_faqs, store_howtos                                                                     | list empty, create rejected, edit/delete 404                            | route-level `tenantContext`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Every `withMoneyTx` / `prisma.$transaction` opened inside a context (stock-adjustment post, PO receive, backorder cancel, bulk-AI recommendation persist, ai-autofill-cleanup batch) | backorder_lines, stock_adjustments, purchase_orders, purchase_order_items, ai_recommendation | reads empty, updates hit 0 rows, PO receive 404s                        | the proxy's `$transaction` now starts with the ambient `SET LOCAL`s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Public checkout `OrderService.create` (no ambient context)                                                                                                                           | backorder_lines                                                                              | insert rejected, whole order rolled back when a line is backordered     | `setTenantGucs(tx, { storeId })` at the top of the transaction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| All 12 bulk-AI Inngest jobs (wrapper removed in #461 on the belief they touch no RLS table)                                                                                          | bulk_ai_jobs, ai_usage, ai_recommendation, store_faqs, store_howtos                          | first `bulkAiJob.update` → P2025; quota never counts                    | `runInStoreScope(storeId, …)` — per-query tenant tx, no 30s tx                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Insights narration (sibling of the route's `runInTenantContext`)                                                                                                                     | customer_cohort/rfm, funnel snapshots                                                        | narration always null                                                   | `runInStoreScope` in the service                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `deleteR2ObjectIfOrphan` reference check                                                                                                                                             | blog_posts (+ cross-store visibility on every table)                                         | a still-used image reads as orphaned and is **deleted from R2**         | `withRlsBypass` — "referenced anywhere" is a cross-store question                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `scripts/r2-orphan-audit.ts` (manual; deletes with `--apply` — issue 2251) and the `r2-orphan-sweep` Inngest cron (deletes when `R2_ORPHAN_SWEEP_APPLY=true`)                        | blog_posts, expenses, stock_adjustments, store_howtos                                        | every image those rows use reads as orphaned and is **deleted from R2** | RLS bypass (`rlsBypassRunner` / `withRlsBypass`) + `assertStrictTablesVisible` (`lib/r2-references.ts`, issue 2288): refuses when a STRICT table reads 0 rows while the catalog — after an `ANALYZE` — says it has rows, OR cannot say (`reltuples` -1, e.g. a never-analyzed branch/restore) AND the runner did not prove `app.bypass_rls = 'true'`. After this cutover the earlier app role does not own these tables, so its ANALYZE is skipped; the positive bypass proof (issue 2354) is what lets a never-populated STRICT table pass. No ownership grant is needed for the guard; if the bypass is ever removed from the runner, the guard refuses (fails closed). Runs before any orphan is REPORTED, so a dry-run/report is validated too; the sweep refuses to delete and marks its report untrustworthy |

**The gate.** `scripts/rls-payload-parity.mjs` + CI job **RLS Payload Parity (owner vs the earlier app role)**: boots the built API twice on one database (owner, the earlier app role), calls the storefront endpoints for every store, deep-diffs the JSON, fails on any shrunk array / missing field. On `main` it reproduces the FAQ loss (8 of 111 comparisons); on the fix branch 111/111 match.

**Before a second attempt:**

1. The parity job and the RLS registry test green on `main`.
2. Run the parity script against a **restored copy of production** (Neon branch, `PARITY_ALLOW_REMOTE=1`) — the fixtures cover the shapes, real stores cover the data.
3. Admin + Inngest paths are NOT covered by the parity gate (it only drives public endpoints). A **staging soak** was the plan's original answer, but staging itself is retired (#1975 — see Phase 2's superseded note above); there is no environment left to run one against. Until a replacement exists (a scripted the earlier app role run against a restored production copy, or a CI job that invokes the cron/sweep entrypoints directly under the earlier app role per #1974's fix idea), this checklist has to be exercised BY HAND against the restored-production-copy parity run in step 2: bulk-AI jobs, FAQ/how-to admin, stock adjustments post, PO receive, backorder cancel, insights narration, a checkout with a backordered line. (The backordered-line checkout is now also a CI gate: `tests/integration/backorder-checkout-rls.test.ts` drives `POST /public/orders` against the the earlier app role API and goes red — a 500 — if `setTenantGucs` is removed from `OrderService.create`; issue 2044.) For bulk-AI also confirm the GLOBAL cap counts other stores: run a sweep on store A and check `assertAiQuota` still sees store B's `ai_usage` (automated for the daily cap by the "must NOT be scoped" block in `tests/integration/rls-ebda-app.test.ts`, issue 2040 / Ruling CL-2).
4. Watch for P2025 / "violates row-level security policy" / empty-array regressions in Sentry for the first hour after the flip.
