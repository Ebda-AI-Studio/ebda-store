# RLS enforcement audit — 2026-07-15

**Scope:** DB/RLS layer only, read-only. Multi-tenant Postgres (Neon) + Prisma.
Tenancy enforced by Postgres RLS (`FORCE ROW LEVEL SECURITY`) reading
`app.current_store_id` / `app.current_user_id` GUCs set via `SET LOCAL` inside
a Prisma interactive transaction opened by `runInTenantContext` /
`withRlsBypass` (`packages/database/src/index.ts`), entered per-request by
`apps/api/src/middleware/tenant-context.ts` and stored in AsyncLocalStorage.

**Method:** read every RLS-bearing migration (23 files, `packages/database/prisma/migrations/`)
in chronological order to reconstruct final per-table policy state; grepped
and read all 225 `withRlsBypass` call sites across 41 files; traced async
boundaries (fire-and-forget promises, `setTimeout`, event emitters, Inngest
retries) reachable from a tenant-context-wrapped request; cross-referenced
`docs/audits/2026-06-09-rls-async-writer-audit.md` and
`docs/audits/2026-07-02-tenancy-rls-auth.md` and re-verified every one of
their findings against current code rather than trusting them. Three
parallel research passes fed this synthesis (migration/policy enumeration;
`withRlsBypass` site audit; ALS/async-boundary audit), each independently
cross-checked against the source by the author of this doc.

**Headline:** No confirmed cross-tenant data leak. The prior audit's three
High findings (F1 BYPASSRLS owner, F2 bare-mount routers, F3 `addresses`
deny-all) are: F1 still open (confirmed), F2 substantially fixed
(2026-07-12, commit `b483518a`), F3 fixed (`20260702170000_rls_close_denyall_tables`).
This audit found **two new, previously unreported gaps** that fell through
every prior sweep — a payment-settings router with zero RLS wiring of any
kind, and a fire-and-forget affiliate-commission write that races its own
transaction's commit and is a **live bug today, independent of the RLS
cutover** — plus a confirmed policy typo that will silently break product-view
tracking the moment the earlier app role goes live.

---

## Q1 — Policy-per-command coverage

Enumerated from all 23 RLS migrations, final state as of `20260711120000` (no
migration since `20260702170000` creates a new table). **Two gaps found:**

- **`product_daily_views`** (`20260622100000_product_daily_views/migration.sql:44-70`) —
  SELECT policy correct. **INSERT and UPDATE policies check
  `current_setting('app.bypass_rls', true) = 'on'` with no store-scoped
  fallback branch at all** (every other table in the schema uses `'true'` and
  always OR's in a `store_id = current_store_id()` branch). Confirmed via
  `grep -rn "bypass_rls.*=.*'" apps/api/src packages/database/src`: every
  call site (`packages/database/src/index.ts:295`, `store.service.ts:388`,
  `provisioning.service.ts:129`) sets `'true'`, never `'on'`. Under
  the earlier app role, INSERT/UPDATE on this table are **unconditionally denied**.
  The only write path, `apps/api/src/services/view-ingest.service.ts:99-114`,
  wraps the upsert in `withRlsBypass` and fail-open swallows the resulting
  42501 in a `catch` (`view-ingest.service.ts:109-114`) — product-view
  tracking goes dark with zero surfaced errors. No DELETE policy either
  (rows are FK-cascade-deleted, so likely inconsequential). Table was also
  never `FORCE`'d by any migration (confirmed by grepping every
  `ROW LEVEL SECURITY` statement repo-wide).
- **`store_staff`** — SELECT/INSERT/DELETE policies exist
  (`20260615010000`, `20260616210000`, `20260621060000`), **no UPDATE policy
  was ever created**. Latent: grep confirms no app code path calls
  `.update()`/`.upsert()` on `storeStaff` today.

Every other RLS-governed table (~85) carries `FOR ALL` (all 4 commands) with
matching `WITH CHECK`. `accounts`/`journal_entries`/`sequences`/`journal_lines`
were `USING`-only until `20260629120000_accounting_rls_explicit_with_check`
made the (already-implicit, byte-identical) `WITH CHECK` explicit — a no-op
hardening, not a gap.

**Verdict: CONFIRMED** (read every migration). Two real gaps, ranked High
(`product_daily_views`, availability-breaking) and Low (`store_staff`,
unreachable).

---

## Q2 — FORCE RLS coverage

Every tenant table that has `ENABLE ROW LEVEL SECURITY` also ends up
`FORCE`'d in the final migration state, **with one exception:
`product_daily_views`** (ENABLE-only, forever — see Q1). `stores` is **fully
`DISABLE`d**, not merely un-forced (`20260609000000_complete_force_rls_coverage/migration.sql:409-412`:
`ALTER TABLE stores NO FORCE ROW LEVEL SECURITY; ALTER TABLE stores DISABLE ROW LEVEL SECURITY;`) —
documented and intentional: `stores` is resolved by slug/domain in
`store-access.ts` before any tenant GUC exists; a predicate here would break
login/store-resolution. `users`, `refresh_tokens`, `verification_tokens`,
`customer_addresses`, `onesignal_subscriptions` never had RLS enabled at all
(documented, auth/identity tables read contextlessly during login/refresh).

**Historical drift, already self-corrected** (flagging as a process lesson,
not a live gap): `20260530000000_force_rls_enforcement`'s hardcoded
table-name array (`dead_stock_flags`, `anomalies`, `inventory_logs`,
`notifications`) had **4 wrong/nonexistent names** for tables that actually
existed as `deadstock_flags`, `profit_anomalies`, `inventory_history`, and (no
such table). Each mismatch silently no-op'd via the migration's own
`to_regclass` guard, leaving those tables `ENABLE`-but-not-`FORCE`
(owner-bypassable) for the ~3 weeks between `2026-05-30` and `2026-06-09`,
when `20260609000000` re-`FORCE`'d them under the correct names (its own
header comment documents this). This is exactly the migration-drift failure
mode this audit was commissioned to watch for, and it already happened once —
worth a standing CI check (the Phase-0 discovery query already written in
`docs/plans/done/2026-07-02-rls-cutover.md` — `SELECT relname ... HAVING
COUNT(policyname)=0`) run against every migration, not just at cutover time,
so a hardcoded array typo fails CI instead of silently landing.

**Verdict: CONFIRMED.** One live gap (`product_daily_views`, same item as
Q1). Historical drift already remediated.

---

## Q3 — `withRlsBypass` site audit

225 call sites across 41 files. **No confirmed cross-tenant leak.** Every
per-store-loop write correctly re-adds its loop-variable `storeId`; every
membership/staff check uses a compound key `{userId, storeId}`; every
super-admin surface (`admin.routes.ts`, 16 sites) is gated by
`requireRole('super_admin')` and is cross-tenant-by-design.

**Two SAFE-BUT-RISKY sites, same defect class — ranked High (latent, not a
confirmed leak):**

`apps/api/src/routes/webhook.routes.ts:305` and
`apps/api/src/lib/inngest/functions/payment-webhook-process.ts:173` both do:

```ts
result = await withRlsBypass(_tx =>
  PaymentService.handleWebhook(provider, payload, signature, storeId, rawBody)
);
```

The `tx` parameter is discarded (`_tx`) and never threaded through.
`handleWebhook` (`apps/api/src/services/payment-providers/payment.factory.ts:854-863`)
queries via the plain ALS-proxied `prisma` export, which `withRlsBypass`
never populates (it opens its own `basePrisma.$transaction` and calls
`fn(tx)` directly — it does **not** call `tenantStorage.run(...)`). So in the
`storeId`-undefined branch (webhook arrives before store resolution), the
mutating `payments`/`orders` queries run on `basePrisma` with **no** bypass
GUC and **no** tenant GUC — the wrapper is a no-op. It "works" only because
`payments`/`orders` policies are fail-open on unset context
(`current_store_id() IS NULL OR store_id = current_store_id()`). Payment
row resolution then falls to
`prisma.payment.findFirst({ where: { OR: [{ transactionId }, { invoiceId }] } })`
with **no `orderBy`**, and `schema.prisma:1269-1285` shows `transactionId`/
`invoiceId` are only `@@index`, **not `@@unique`**. A collision (recycled
sandbox ID, provider ID reuse, or crafted payload) sent with valid HMAC
signature from store A could resolve to store B's existing payment row when
`storeId` hasn't been resolved yet. Not Critical: money mutations still
require a valid per-store HMAC signature, provider IDs are unique in
practice, and the code has a defense-in-depth `storeId` re-check
(`payment.factory.ts:888-898`) — but that check is itself gated
`if (storeId && ...)`, a no-op in exactly this branch. **Fix direction:**
add a real DB unique constraint on `(provider, transactionId)` /
`(provider, invoiceId)`, and either thread `tx` through or drop the
misleading wrapper.

**Low, not a leak:** `staff.routes.ts:96` — a store_admin's staff-invite flow
does a `withRlsBypass` global (`storeId: null`) lookup by email, which is
correct (staff accounts are platform-global), but lets a store_admin probe
whether an arbitrary email is already a staff/admin account anywhere
(existence/role side-channel, not tenant data). Product-decision fix
(generic "invite sent" response), not a scoping bug.

**Doc-drift only:** `warehouse.service.ts:602-608`'s docstring claims
`withRlsBypass` usage the function doesn't have (it correctly rides the
caller's ambient tenant tx instead). `AuthService.eraseAccount`
(`auth.service.ts:899`) never opts into either helper — safe today via
explicit `customerId`/`userId` filters, zero RLS backstop.

**Verdict: CONFIRMED**, 225/225 sites reviewed. No Critical.

---

## Q4 — ALS propagation correctness

The AsyncLocalStorage mechanism itself is sound — `tenantStorage.run(tx, fn)`
correctly propagates through native `await`/`Promise.all`/`.catch` chains
inside the same continuation. The real bug class found is **Prisma
transaction-lifecycle**, not ALS: `tenant-context.ts:74-80` commits the
per-request tx on `res.on('finish')`, which fires as soon as the HTTP
response flushes — independent of any unawaited background promise still in
flight.

> **Correction, 2026-09-08.** `tenant-context.ts` now commits BEFORE the
> response is sent for buffered responses (`apps/api/src/middleware/request-transaction.ts`);
> commit-on-`res.on('finish')` survives only on the escalated streaming lane.
> The affiliate finding below was FIXED by awaiting `linkOrderToReferral`
> (`order.service.ts`) and remains fixed; the systemic "detached `void` work
> races the tx close" class it describes is narrowed by roughly one event-loop
> turn but NOT eliminated — see the header of `request-transaction.ts` for the
> current site list.

**New finding, ranked High — live today, independent of the RLS cutover:**

`apps/api/src/services/order.service.ts:730-735`, inside `OrderService.create`
(called from `POST /stores/:storeId/orders`, wrapped in `tenantContext`):

```ts
// Link order to affiliate referral (fire-and-forget)
if (referralCode) {
  affiliateService
    .linkOrderToReferral(storeId, order.id, referralCode)
    .catch(err => logger.error({ err }, 'Affiliate referral link failed'));
}
```

Not awaited. `affiliate.service.ts:437-461`'s `linkOrderToReferral` issues
**two sequential** bare `prisma.*` calls (`findFirst` then `update`) with no
internal `runInTenantContext`/`withRlsBypass` self-wrap — it depends entirely
on the ambient per-request tenant tx. The route handler proceeds to
`bustProductCaches` and `res.status(201).json(...)` immediately after. If the
two DB round-trips haven't completed by the time the response flushes and
the outer tx commits, the calls run against an already-closed Prisma
transaction, throw, and are silently swallowed by the `.catch(logger.error)`
— **the referral is never marked `converted`, dropping affiliate commission
attribution with no error surfaced and no reconciliation sweep** (grep
confirms no Inngest job ever re-processes stuck `status:'clicked'`
referrals). This is a genuine race with no forcing function to prevent
it — the correct pattern already exists elsewhere in the same codebase
(`order-status-changed.ts` self-wraps every DB call in a fresh
`runInTenantContext` specifically because "in Inngest there's no HTTP request
ALS scope, so each writer MUST set the tenant GUC itself" — `affiliateService.linkOrderToReferral`
should follow the same self-wrapping discipline, or be awaited before the
handler returns).

**Systemic, ranked Medium:** the ~17 routers routes/index.ts documents as
"CONTEXT-LESS (Phase 2 candidate)" (`notification`, `recommendation`,
`shipping-carrier`, `newsletter`, `wbs-integration`, `finance`,
`smart-layer`, `insights`, `suppliers`, `purchase-orders`,
`stock-adjustments`, `expenses`, `backorders`, `bot-analytics`, `store`,
`inventory`, `feature`) provide **zero RLS defense-in-depth**, both today and
after cutover — verified safe only because every current query explicitly
filters `where: { storeId }` and the hybrid policies allow-contextless.
Spot-verified `finance.routes.ts`/`smart-layer.routes.ts`: wrapping is real
but happens at the **route handler**, not uniformly "inside the service" as
the comments claim — e.g. `account.service.ts`'s `createChildAccount`,
`setAccountActive`, `listAccountsTree` and `purchase-order.service.ts`'s
`createPoFromSuggestion` use the plain `prisma` proxy with no internal wrap
at all, safe only because every current caller happens to be an
already-wrapped route handler. A future direct caller (new Inngest job,
admin script, bulk-migration tool) invoking these would run with no tenant
GUC set at all. Not a live bug — a structural trap for the next contributor.

**Verified safe (no action needed):**

- `recommendation.routes.ts:126`'s fire-and-forget `recalculateFBT` is safe
  _because_ the router is genuinely context-less (no ambient tx exists to
  race — enforced by `tests/unit/rls-router-context-invariant.test.ts:161-188`).
  Different from the affiliate bug: no tx is open, so nothing closes under it.
- `socket.service.ts:213-238`'s `subscribe:store` WebSocket handler runs a
  bare `prisma.store.findFirst({ id, ownerId })` — genuinely outside any HTTP
  ALS context (WebSocket event, not a request continuation) and correctly
  scoped by `ownerId`; `stores` has RLS fully disabled anyway (Q2). Confirmed
  the only DB-touching `.on(...)` handler in the codebase outside Express/Redis
  plumbing (grepped all non-router `.on(` call sites).
- Inngest `step.run` retries: each retry opens a **fresh** `runInTenantContext`
  transaction; Prisma auto-rolls-back a failed step's tx before Inngest
  retries, so no stale-tx reuse or double-timeout-charging.

**Verdict: CONFIRMED** for the affiliate-referral finding (read the exact
code path) and the context-less-router pattern; **PLAUSIBLE-but-verified-safe**
for the ALS mechanism itself under retries/event emitters.

---

## Q5 — GUC read-path vs. bypass-only

Overwhelming majority pattern is correct: policies read
`current_setting('app.current_store_id', true)` (via the `current_store_id()`
wrapper) or `current_setting('app.current_user_id', true)` at evaluation
time — genuine runtime reads, matching the actual GUCs set per-request by
`runInTenantContext`/`tenant-context.ts`, not a hardcoded value and not
gated exclusively on `bypass_rls`. `addresses`' user-scoped predicate
(`current_user_id() IS NULL OR bypass_rls='true' OR user_id=current_user_id()`)
correctly reads the real per-request `app.current_user_id` GUC — this is the
"safe" shape, not the known runtime-read-vs-bypass-only bug class from
`salam-erp`.

**One confirmed exception, same item as Q1/Q2:** `product_daily_views`'
INSERT/UPDATE policies check **only** `bypass_rls = 'on'` (never satisfied,
typo) with no store-scoped fallback branch — the mirror-image failure (a
bypass-only gate whose bypass check is itself broken, so it's not
bypass-_permissive_, it's simply broken/deny-all).

`shipping_area_rates` uses the older 2-branch idiom
(`current_store_id() IS NULL OR store_id=current_store_id()`, no explicit
`bypass_rls` branch) — not a functional gap (`current_store_id()` also
returns NULL when `withRlsBypass()` resets the GUC to `''`), but a style
inconsistency versus every sibling table shipped the same week.

**Verdict: CONFIRMED.** GUC read-path is correct platform-wide except the one
already-flagged `product_daily_views` typo.

---

## Q6 — Migration drift

**No drift in the current window.** The 4 migrations after
`20260702170000_rls_close_denyall_tables` (`add_catalogue_sweep_job_kinds`,
`add_product_excerpt`, `add_bulk_ai_job_resume_fields`, `loyalty_earn_unique`)
are column/enum/index-only changes to already-RLS'd tables — confirmed via
`grep -n "CREATE TABLE"` across every migration dated after 2026-07-02
(zero hits).

**Historical drift, already caught and fixed** — same item documented under
Q2: the `20260530000000` hardcoded table-name array left 4 tables
`ENABLE`-but-not-`FORCE` for ~3 weeks due to name typos, silently masked by
the `to_regclass` guard rather than failing loud. This is the exact failure
mode a hardcoded-array approach to RLS enforcement produces, and the fix
(`20260609000000`) was a manual audit catch, not an automated one. Recommend
converting the Phase-0 discovery query (already written in
`docs/plans/done/2026-07-02-rls-cutover.md`) into a standing CI assertion so any
future migration that silently drifts fails the build instead of waiting for
the next manual audit.

**Verdict: CONFIRMED clean** for the current window; the one historical
instance is already remediated.

---

## New finding — `payment-settings.routes.ts` has zero RLS wiring of any kind

**Severity: High** · **Verdict: CONFIRMED, novel** (not in
`docs/audits/2026-06-09-rls-async-writer-audit.md`,
`docs/audits/2026-07-02-tenancy-rls-auth.md`,
`docs/plans/done/2026-07-02-rls-cutover.md`, or
`tests/unit/rls-router-context-invariant.test.ts`)

`apps/api/src/routes/index.ts:75`: `router.use('/payment-settings',
paymentSettingsRoutes);` — mounted bare, **no `tenantContext` argument at
all** (every other bare-mounted router in this file at least passes
`tenantContext` for documentation/consistency, even where it's a documented
no-op). `grep -n "router.param\|runInTenantContext\|withRlsBypass\|tenantContext"
apps/api/src/routes/payment-settings.routes.ts` returns **zero hits**. The
`GET/POST/PUT/DELETE /payment-settings/store/:storeId[/:provider]` handlers
(`payment-settings.routes.ts:695-1060`) read/write `PaymentConfig` — a table
holding **encrypted provider API keys/secrets** (`apiKey`, `secretKey`,
`webhookSecret`) — via plain `prisma.paymentConfig.*` calls scoped only by an
explicit `where: { storeId }`, with no RLS GUC ever set. App-layer
authorization is solid (`authenticate → authorize('store_admin','super_admin')
→ requireStoreAccess → requirePermission('store:settings')` plus an inline
`store.ownerId !== user.userId` belt-and-suspenders check) — this is **not**
a live leak — but it means `PaymentConfig` gets **no DB backstop whatsoever**,
unlike every sibling tenant-data router, which either gets
`router.param('storeId', tenantContext)` inside the sub-router or explicit
per-callsite `runInTenantContext` (as `payment.routes.ts` and
`upload.routes.ts` both correctly do). `payment-settings.routes.ts` fell
through the whole F2 remediation effort because it's mounted at its own bare
`/payment-settings` prefix rather than `/stores`/`/`/`/admin`, which is
exactly the pattern the original F2 audit's search matched against — this
router was simply never in scope for that audit, the cutover plan, or the
regression-guard test (which explicitly accounts for "every router touched
by PR #499" — 30 routers — and does not include this file).

**Fix direction:** wrap `payment-settings.routes.ts`'s `:storeId` routes the
same way `finance.routes.ts` et al. do (explicit
`runInTenantContext(req.params.storeId, ...)` per handler, or a
`router.param('storeId', tenantContext)` registration if no external I/O
sits inside these handlers — confirmed none does).

---

## Verified safe (checked, not re-flagged)

- F2 (bare-mount routers never setting tenant context) — **fixed 2026-07-12**,
  commit `b483518a`, via `router.param('storeId'|'id', tenantContext)`
  registered inside each affected sub-router; enforced by
  `tests/unit/rls-router-context-invariant.test.ts`.
- F3 (`addresses` FORCE-with-no-policy) — **fixed**,
  `20260702170000_rls_close_denyall_tables` adds `ENABLE` + a real
  user-scoped policy atomically. Correction to F3's original framing: the
  pre-fix state was "wide open" (FORCE set, ENABLE never set, so FORCE had
  no effect), not "deny-all" as originally characterized — same practical
  outcome (no isolation), different mechanism.
- `payments`/`return_items`/`wishlist_items` — F3 named these as still
  excluded as of 2026-07-02; they were actually already closed a month
  earlier by `20260609000000_complete_force_rls_coverage`. F3's
  characterization was stale by the time it was written.
- `system_settings` — intentionally permissive `USING(true)`, platform-global
  config, no tenant meaning, documented.
- Phase 1c CI proof job (`test-rls-ebda-app` in `.github/workflows/ci.yml`,
  `tests/integration/rls-ebda-app.test.ts`) genuinely authenticates as
  the earlier app role (non-bypass role) and exercises real cross-tenant denial —
  **but only covers ~6 tables** (products, addresses, payments, return_items,
  system_settings, wishlist_items) out of ~90 RLS-governed tables. Not a
  finding on its own (matches the plan's "a sample of store-scoped tables"
  intent), but flagged as residual coverage risk: most of the schema has
  never been proven under real the earlier app role enforcement in CI.
- `withRlsBypass` mechanics (`packages/database/src/index.ts:290-308`) —
  correctly resets both `app.bypass_rls='true'` and `app.current_store_id=''`
  inside its own transaction, satisfying both policy generations.
- `store-access.ts`'s two `withRlsBypass` staff-membership checks — correctly
  scoped by compound key `{userId, storeId}`.
- `feature.service.ts:110-118`'s `readFromDb` — correctly scoped `where: {
storeId }` inside its bypass, matches prior audit's verified-safe call.

---

## Tally

| Severity     | Count | Items                                                                                                                                                                                                                                                                                                                                                         |
| ------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Critical** | 0     | —                                                                                                                                                                                                                                                                                                                                                             |
| **High**     | 5     | F1 (BYPASSRLS owner, still open) · `payment-settings.routes.ts` zero RLS wiring (new) · fire-and-forget affiliate-referral race (new, live today) · `product_daily_views` INSERT/UPDATE policy typo (breaks at cutover) · webhook `withRlsBypass(_tx=>)` no-op + non-unique `transactionId`/`invoiceId` (latent)                                              |
| **Medium**   | 4     | Bulk-AI Inngest functions run bare RLS under stale comments (F4, still present) · the earlier app role CI proof job covers only ~6/~90 tables · ~17 context-less routers + several service functions have zero RLS backstop by caller-coincidence, not structural guarantee · historical FORCE-array name-typo drift (already remediated, process lesson)     |
| **Low**      | 6     | `store_staff` missing UPDATE policy (unreachable) · `staff.routes.ts` cross-tenant staff-email side-channel · `warehouse.service.ts` stale bypass docstring · `AuthService.eraseAccount` no RLS wrap (safe today) · `ALLOW_BYPASSRLS_ROLE` undocumented in `docs/ENVIRONMENT.md` · `docs/DB-BACKUP-RESTORE.md` references nonexistent `npm run db:rls` script |

## Ranked top findings

| #   | Severity | Verdict                         | Finding                                                                                                                                                                                                                                                    | Location                                                                                   |
| --- | -------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | High     | CONFIRMED (carried, still true) | Prod connects as BYPASSRLS `neondb_owner`; every RLS policy inert; isolation is 100% app-layer today                                                                                                                                                       | `apps/api/src/index.ts:438-480`                                                            |
| 2   | High     | CONFIRMED, novel                | `payment-settings.routes.ts` never sets RLS context anywhere — router-level or per-callsite — for `PaymentConfig` (holds encrypted secrets); missed by the entire F2 remediation + regression test                                                         | `apps/api/src/routes/payment-settings.routes.ts`; `routes/index.ts:75`                     |
| 3   | High     | CONFIRMED, novel, live today    | Fire-and-forget `affiliateService.linkOrderToReferral` races the per-request tenant tx's commit-on-`res.finish`; silent commission-attribution loss, no reconciliation sweep — independent of RLS/the earlier app role status                              | `apps/api/src/services/order.service.ts:730-735`; `affiliate.service.ts:437-461`           |
| 4   | High     | CONFIRMED                       | `product_daily_views` INSERT/UPDATE RLS policies check `bypass_rls='on'` (app only ever sets `'true'`) with no store fallback; never `FORCE`'d; will silently kill view-tracking at the earlier app role cutover (fail-open `catch`)                       | `20260622100000_product_daily_views/migration.sql:57-70`; `view-ingest.service.ts:99-114`  |
| 5   | High     | CONFIRMED, latent               | `webhook.routes.ts`/`payment-webhook-process.ts` `withRlsBypass(_tx=>...)` discards `tx` (no-op wrapper); relies on fail-open RLS + non-unique `transactionId`/`invoiceId` `findFirst` with no `orderBy` — theoretical cross-tenant payment mis-resolution | `webhook.routes.ts:305`; `payment-webhook-process.ts:173`; `payment.factory.ts:854-863`    |
| 6   | Medium   | CONFIRMED (carried, still true) | 8 bulk-AI Inngest functions run with bare RLS context under stale "end runInTenantContext" comments                                                                                                                                                        | `lib/inngest/functions/bulk-ai-*.ts` (verified `bulk-ai-translate.ts:534` still stale)     |
| 7   | Medium   | CONFIRMED                       | the earlier app role CI proof job exercises only ~6 of ~90 RLS-governed tables — most of the schema has never been proven under real RLS enforcement                                                                                                       | `.github/workflows/ci.yml` `test-rls-ebda-app`; `tests/integration/rls-ebda-app.test.ts`   |
| 8   | Medium   | CONFIRMED                       | ~17 "Phase 2 candidate" routers + several accounting-service functions have zero RLS defense-in-depth, safe only by every-current-caller coincidence                                                                                                       | `routes/index.ts` CONTEXT-LESS comments; `account.service.ts`, `purchase-order.service.ts` |
| 9   | Medium   | CONFIRMED, remediated           | `20260530000000` FORCE-array had 4 wrong table names → 3-week ENABLE-not-FORCE window, self-caught by `20260609000000`; no CI check would catch a repeat                                                                                                   | `20260530000000_force_rls_enforcement/migration.sql:23-32`                                 |
| 10  | Low      | CONFIRMED                       | `store_staff` has no UPDATE policy (unreachable — no code calls `.update()` on it)                                                                                                                                                                         | `20260615010000`/`20260616210000`/`20260621060000`                                         |
| 11  | Low      | CONFIRMED                       | `staff.routes.ts` staff-email lookup is a cross-tenant existence/role side-channel (product decision, not a scoping bug)                                                                                                                                   | `staff.routes.ts:96`                                                                       |
| 12  | Low      | CONFIRMED                       | `warehouse.service.ts` docstring claims `withRlsBypass` usage the code doesn't have                                                                                                                                                                        | `warehouse.service.ts:602-608`                                                             |
| 13  | Low      | CONFIRMED                       | `ALLOW_BYPASSRLS_ROLE` (load-bearing prod boot-guard env var) absent from `docs/ENVIRONMENT.md`                                                                                                                                                            | `apps/api/src/index.ts:458`; `docs/ENVIRONMENT.md`                                         |
| 14  | Low      | CONFIRMED                       | `docs/DB-BACKUP-RESTORE.md` names a nonexistent `npm run db:rls` script (no such script exists; actual mechanism is `prisma migrate deploy`)                                                                                                               | `docs/DB-BACKUP-RESTORE.md:137`                                                            |

No Critical findings — no confirmed live cross-tenant data leak and no
command found to be _always_ silently broken (item 3, the closest candidate,
is a race that can lose, not a guaranteed failure). Items 1-5 (High) should
be closed as a set: 2-5 are cheap, surgical, mechanical fixes (route wrap,
`await`, policy string fix, `tx` threading + unique constraint); 1 is the
tracked the earlier app role cutover already gated behind items 2-9 per
`docs/plans/done/2026-07-02-rls-cutover.md`.
