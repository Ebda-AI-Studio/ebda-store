# RLS Cutover Readiness Map — the earlier app role flip, line-by-line safety foundation (2026-07-16)

**Purpose:** the definitive, statically-computed gap list for flipping production
`DATABASE_URL` from the `neondb_owner` BYPASSRLS role to the non-bypass the earlier app role
login role, per `docs/plans/done/2026-07-02-rls-cutover.md` Phase 3. Under the earlier app role,
Postgres RLS starts enforcing. The flip is safe ONLY if every query either
(a) runs inside tenant context (`runInTenantContext` sets `app.current_store_id` →
RLS filters), (b) is an intentional `withRlsBypass` (cross-tenant by design), or
(c) hits a table whose the earlier app role policy + grant allow it. Any gap = deny-all
(feature breaks) or, for the ungoverned surfaces, a silent leak.

**Method:** read all 98 migration dirs in `packages/database/prisma/migrations/`
chronologically (22 touch RLS/GRANT), reconstructing cumulative per-table state;
read `apps/api/src/routes/index.ts` (all mounts) + `middleware/tenant-context.ts`
in full; grepped/verified all `withRlsBypass` (230) and `runInTenantContext` (215)
sites; cross-referenced the four prior audits below and re-verified their claims
against current code rather than trusting them.

**Cross-referenced (not re-derived — gaps filled, unified here):**

- `docs/audits/2026-07-15-rls-enforcement-audit.md` (DB/RLS layer, 5H/4M/6L)
- `docs/audits/2026-07-02-tenancy-rls-auth.md` (F1–F8; F2/F3 now largely fixed)
- `docs/audits/2026-07-15-api-tenant-scoping-idor-audit.md` (app-layer IDOR, 3C/2H)
- `docs/audits/2026-06-09-rls-async-writer-audit.md` (Inngest/webhook async context)
- `docs/audits/2026-07-15-MASTER-rls-and-logic-audit.md` (the consolidated master)

---

## 0. Executive answers (the four asks)

1. **Deny-all / flip-breaker set (migration fixes required before flip):**
   - `product_daily_views` — **INSERT + UPDATE + DELETE all deny-all** (policy typo
     `bypass_rls = 'on'` on I/U; no DELETE policy at all), and **SELECT is broken for
     any contextless/bypass read** (no `IS NULL` escape + the same `'on'` typo on its
     bypass branch → cron/analytics reads silently return 0 rows).
   - `store_staff` — **UPDATE deny-all** (SELECT/INSERT/DELETE policies exist, no
     `FOR UPDATE` policy ever created). Latent — grep confirms no current code path
     updates `store_staff`, but a new one would 42501 at cutover.

   Everything the plan named as a _suspect_ — `addresses`, `payments`,
   `return_items`, `wishlist_items`, `system_settings` — is **CONFIRMED CLOSED /
   OK** and is NOT a flip-breaker (evidence in §1). The plan's F3 list is stale;
   the only real remaining deny-alls are the two above.

2. **F2 router count (routers that set ZERO tenant context → no RLS backstop
   post-flip):** the ~26–32 originally-bare routers from the 2026-07-02 audit are
   **substantially fixed** (13 `INNER-PARAM-FIXED`, verified by
   `tests/unit/rls-router-context-invariant.test.ts`). What remains with **zero DB
   backstop** splits into three buckets (§2):
   - **Fully-bare, no context/bypass anywhere (7):** `payment-settings`,
     `store`, `recommendation`, `shipping-carrier`, `newsletter`,
     `wbs-integration`, `bot-analytics`. + `onesignal` (small) + `wa-bridge`
     (mounted outside `routes/index.ts`, own auth, active IDOR — §0.1 of the IDOR audit).
   - **Per-query self-wrapped (8, partial backstop):** `finance`, `smart-layer`,
     `insights`, `suppliers`, `purchase-orders`, `stock-adjustments`, `expenses`,
     `backorders` — call `runInTenantContext` _inside_ handlers, not per-request.
   - **Bypass-only (2):** `feature`, `notification` — services call `withRlsBypass`.
   - `admin` is intentionally context-less (super-admin cross-tenant, `:id` reused).

   All are SAFE TODAY (every current query carries explicit `where:{storeId}`), but
   have **no DB defense-in-depth** — a future missing `where` leaks all tenants. The
   only one that is BOTH unwired AND undocumented AND untested is
   **`payment-settings.routes.ts`** (holds encrypted provider secrets) — the sharpest
   residual.

3. **Grant gaps:** ALL grants live in ONE migration
   (`20260404000000_add_rls_policies:22-29`); no later migration issues any GRANT.
   Coverage of the 65+ tables created _after_ it relies entirely on
   `ALTER DEFAULT PRIVILEGES IN SCHEMA public ... TO the earlier app role` **with no `FOR ROLE`
   clause** → it only auto-grants on tables created by the _same role_ that ran that
   statement. This holds IF every migration ran via `prisma migrate deploy` on the
   owner `DIRECT_URL` (plan says it does; CI/Railway config confirms). **This is the
   one thing static analysis cannot certify** — it depends on live `pg_default_acl`
   catalog state. **A live pre-flip query is mandatory** (§5). No `SERIAL`/sequence
   objects exist (all UUID PKs), so no sequence-grant gaps.

4. **Total pre-flip change count: 9** — 2 migration fixes (product_daily_views,
   store_staff), 3 code fixes carried from audits (payment-settings context wrap,
   webhook `_tx` no-op + payment unique constraint, affiliate fire-and-forget race),
   2 verification gates (live grant query, live pg_policies drift check), 2 doc fixes
   (ENVIRONMENT.md, DB-BACKUP-RESTORE.md). Plus the always-implied Phase-2 staging
   soak. Full ordered checklist in §6.

**Migration-history caveat (load-bearing):** `20260530000000`'s header comment
references a migration `20260521000000_fix_rls_bypass_policies` that **does not exist
on disk**. Either a stale comment or evidence of an out-of-band policy change (manual
SQL / `prisma db push`) never captured as a migration. State prior to 2026-05-30 is
**not fully knowable from migrations alone** → a live `pg_policies` dump against prod
before flip is required to catch any drift this static pass cannot see (§5).

---

## 1. Per-table RLS state matrix (computed from all migrations)

**Predicate shapes** (all three are fail-OPEN on unset context — none is a deny-all;
they're three generations of the same idea):

- **OLD:** `current_store_id() IS NULL OR store_id = current_store_id()` (no explicit bypass branch)
- **NEW:** `store_id = current_setting('app.current_store_id',true) OR bypass_rls='true'` (**no null-escape → fail-CLOSED on contextless read**)
- **HYB:** `current_store_id() IS NULL OR bypass_rls='true' OR store_id=current_store_id()` (full 3-branch)
- **HYB-U:** HYB using `current_user_id()` (user-scoped)
- **TRUE:** `USING(true)` (intentional) · **BROKEN:** typo'd bypass literal · **N/A:** RLS never enabled

**Verdict:** OK · DENY-ALL (enabled+forced, 0 policy for a command) · NO-RLS · BROKEN.

96 tables total. **89 OK**, **2 flip-breakers** (`store_staff` UPDATE, `product_daily_views`), **7 NO-RLS** (1 by-design revert + 6 identity/global). Full matrix:

| table                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | enabled        | forced               | role  | S   | I     | U     | D     | predicate                                                                                            | verdict                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | -------------------- | ----- | --- | ----- | ----- | ----- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| customers, categories, products, inventory_history, tags, carts, orders, returns, store_features, notification_configs, notification_event_configs, push_subscriptions, notification_logs, abandoned_carts, abandoned_cart_configs, product_relations, frequently_bought_together, shipping_carrier_configs, shipments, affiliates, affiliate_referrals, affiliate_payouts, affiliate_configs, wishlists, coupons, shipping_zones, tax_rates, loyalty_points, loyalty_transactions, newsletter_subscribers, reviews, store_pages | ✓              | ✓                    | FA    | ✓   | ✓     | ✓     | ✓     | OLD                                                                                                  | OK                                                                                                                                                                                               |
| payment_configs, audit_logs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | ✓              | ✓                    | FA    | ✓   | ✓     | ✓     | ✓     | OLD (store_id-nullable)                                                                              | OK                                                                                                                                                                                               |
| product_faqs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | ✓              | ✓                    | FA    | ✓   | ✓     | ✓     | ✓     | EXISTS-OLD (join via products.store_id)                                                              | OK\*                                                                                                                                                                                             |
| accounts, journal_entries, journal_lines, sequences, suppliers, purchase_orders, purchase_order_items, stock_adjustments, stock_adjustment_items, reorder_rules, backorder_lines, expenses, reorder_suggestions, deadstock_flags, profit_anomalies, customer_cohort_snapshots, funnel_snapshots, customer_rfm_snapshots                                                                                                                                                                                                          | ✓              | ✓                    | PUB   | ✓   | ✓     | ✓     | ✓     | **NEW (fail-CLOSED, no null-escape)**                                                                | OK — see §4 note 2                                                                                                                                                                               |
| ai_usage, bulk_ai_jobs, ai_recommendation, blog_posts, store_faqs, store_howtos                                                                                                                                                                                                                                                                                                                                                                                                                                                  | ✓              | ✓                    | FA    | ✓   | ✓     | ✓     | ✓     | NEW                                                                                                  | OK                                                                                                                                                                                               |
| affiliate_events, bulk_import_jobs, payment_events, whatsapp_templates, cart_items, order_items, return_items, **payments**, product_images, product_options, product_categories, product_tags, product_variants, **wishlist_items**, product_option_values, product_variant_options, bank_statements, bank_transactions, count_sessions, count_lines, warehouses, warehouse_stock, store_locations, order_events                                                                                                                | ✓              | ✓                    | FA    | ✓   | ✓     | ✓     | ✓     | HYB (several via EXISTS join)                                                                        | **OK — payments/return_items/wishlist_items CONFIRMED closed by 20260609000000; plan's suspicion is stale**                                                                                      |
| shipping_area_rates                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | ✓              | ✓                    | FA    | ✓   | ✓     | ✓     | ✓     | OLD (no bypass branch, mirrors shipping_zones)                                                       | OK                                                                                                                                                                                               |
| fx_rate_entries                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | ✓              | ✓                    | PUB   | ✓   | ✓\*   | ✓     | ✓     | HYB + **RESTRICTIVE insert-only, no null-escape**                                                    | OK — see §4 note 1                                                                                                                                                                               |
| **addresses**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | ✓              | ✓                    | FA    | ✓   | ✓     | ✓     | ✓     | **HYB-U** (`current_user_id()`)                                                                      | **OK — 20260702170000 confirmed correct; F3 CLOSED**                                                                                                                                             |
| system_settings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | ✓              | ✓                    | FA    | ✓   | ✓     | ✓     | ✓     | TRUE                                                                                                 | OK (platform-global, intentional)                                                                                                                                                                |
| **store_staff**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | ✓              | ✓                    | mixed | ✓   | ✓     | **✗** | ✓     | SELECT=OLD(FA); INSERT/DELETE=HYB(PUB); **no UPDATE policy**                                         | **DENY-ALL on UPDATE**                                                                                                                                                                           |
| **product_daily_views**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | ✓              | **✗** (never forced) | PUB   | ⚠   | **✗** | **✗** | **✗** | SELECT=no-null-escape+`'on'` typo bypass; INSERT/UPDATE=`'on'` typo (always false); DELETE=no policy | **DENY-ALL on I/U/D; SELECT broken for bypass/contextless reads**                                                                                                                                |
| stores                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | ✓→**DISABLED** | NO FORCE (reverted)  | —     | —   | —     | —     | —     | n/a                                                                                                  | **NO-RLS by design** (20260609000000 — store resolution must be contextless)                                                                                                                     |
| users, refresh_tokens, verification_tokens, onesignal_subscriptions, customer_addresses                                                                                                                                                                                                                                                                                                                                                                                                                                          | never enabled  | —                    | —     | —   | —     | —     | —     | n/a                                                                                                  | NO-RLS (documented identity/account tables)                                                                                                                                                      |
| webhook_events                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | never enabled  | —                    | —     | —   | —     | —     | —     | n/a                                                                                                  | NO-RLS — **under-documented** (only its own migration comment; no `USING(true)` like system_settings). By design: `store_id` informational, all access via `withRlsBypass`. Flag for a doc line. |

`*` **product_faqs has RLS via a join to `products.store_id`**, but the app-layer IDOR
audit's C1 shows the CRUD handlers query by `productId` only — RLS _would_ backstop
cross-tenant FAQ access once the earlier app role is live (the join predicate filters), but the
app handler still needs the storeId check because `ProductFaq` itself is reachable
today under BYPASSRLS. Not a flip-breaker; noted for completeness.

---

## 2. Route → tenant-context map (every mount in apps/api/src/routes/index.ts)

`tenantContext` reads `req.params.storeId || req.params.id`; when falsy (or non-UUID)
it **silently `next()`s with no context set** (`middleware/tenant-context.ts:53-66`).
So a router only gets RLS filtering if `:storeId`/`:id` is in its mount path OR the
sub-router internally registers `router.param('storeId'|'id', tenantContext)`.

**Classification of every mount:**

| Class                                                                                | Routers                                                                                                                                                                                                                                                                                   | RLS backstop post-flip?                                         |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **MOUNT-PARAM** (param in mount path)                                                | products, categories, ai, typography, cart, orders (`/stores/:storeId/*`); customers (`/stores/:storeId`); reviews, analytics, returns; wa-templates, payment-links (`/stores/:id/*`); staff, payment-abandonments (`/stores/:storeId/*`); store-layout (`/admin/stores/:storeId/layout`) | **YES** — full per-request tx                                   |
| **INNER-PARAM-FIXED** (bare mount, sub-router registers `.param`) — 13, test-guarded | coupon, shipping, tax, loyalty, pwa, bulk, variant, abandoned-cart, affiliate, pages, blog, locations, warehouse                                                                                                                                                                          | **YES** — once its own `:storeId` route matches                 |
| **INTENTIONALLY-CONTEXTLESS**                                                        | public, publicStoreLayout, auth, mfa (pre-store); admin (super-admin cross-tenant, `:id` reused — uses `withRlsBypass`); wishlist + addresses (use `userContext(...)`, user-scoped)                                                                                                       | N/A by design                                                   |
| **F2-GAP — fully bare, ZERO context/bypass**                                         | **payment-settings**, **store**, **recommendation**, **shipping-carrier**, **newsletter**, **wbs-integration**, **bot-analytics**, **onesignal**                                                                                                                                          | **NO** — app-layer `where:{storeId}` is the only isolation      |
| **F2-GAP — per-query self-wrapped** (partial)                                        | finance, smart-layer, insights, suppliers, purchase-orders, stock-adjustments, expenses, backorders                                                                                                                                                                                       | Partial — `runInTenantContext` inside handlers, not per-request |
| **F2-GAP — bypass-only**                                                             | feature (`feature.service.readFromDb` → `withRlsBypass`), notification (`notification-config/dispatcher` → `withRlsBypass`), inventory (only `barcode-scan.reconcileCountSession` wraps; rest bare)                                                                                       | Partial                                                         |
| **Outside routes/index.ts**                                                          | wa-bridge (mounted `apps/api/src/index.ts:299`; own `waBridgeAuth`; no RLS wiring at all)                                                                                                                                                                                                 | **NO** + active IDOR (§3 / IDOR-audit C3/H1/M1)                 |

**Writes-per-F2-GAP-router (leak/break blast radius if the app-layer `where` is ever missed):**

- `payment-settings` → `PaymentConfig` (encrypted `apiKey`/`secretKey`/`webhookSecret`). **Highest sensitivity.**
- `store` → `stores` (8 route + 11 service writes; but `stores` is NO-RLS by design anyway, so RLS could never backstop it — app-layer is permanently the only guard here).
- `recommendation` → `product_recommendations`, `frequently_bought_together` (5 writes).
- `shipping-carrier` → `shipping_carrier_configs`, `shipments` (10 writes).
- `newsletter` → `newsletter_subscribers` (chunked Resend loop).
- `wbs-integration` → store WBS fields (3 writes).
- `bot-analytics` → read-heavy + external WBS fetch.
- `onesignal` → `push_subscriptions` (1 write, app-layer scoped).
- `inventory` → `inventory.service` (10 writes; only barcode reconcile wrapped).

**Test guard reality:** `tests/unit/rls-router-context-invariant.test.ts` asserts
13 fixed + 17 context-less = 30 routers "touched by PR #499", with `admin.routes.ts`
explicitly excluded. It does **NOT** cover `payment-settings.routes.ts`,
`onesignal.routes.ts`, or `wa-bridge.routes.ts` — these fell entirely outside the
guard's scope. Confirmed `grep` in `payment-settings.routes.ts`: **zero** hits for
`tenantContext`/`runInTenantContext`/`withRlsBypass`/`.param(`.

---

## 3. Every withRlsBypass + runInTenantContext(\_, public) site

- `withRlsBypass`: **230 sites / 41 files** · `runInTenantContext`: **215 sites**.
- **No `runInTenantContext('public', ...)` or `(null, ...)` call sites exist** — the
  only grep hit is an explanatory comment in `tenant-context.ts:44`. Clean.
- The 2026-07-15 audit reviewed 225 sites and found them essentially all correct
  (per-store-loop writes re-add loop `storeId`; membership checks use compound
  `{userId, storeId}`; super-admin surfaces gated `requireRole('super_admin')`).
  Re-verified: no new leak sites; the growth 225→230 is Inngest-adjacent helpers
  following the same bypass-for-background pattern.

**Flagged: `withRlsBypass(_tx => ...)` no-op wrappers (tx discarded).** Exactly **2**
sites, unchanged, confirmed at current line numbers **in this worktree**:

- `apps/api/src/routes/webhook.routes.ts:305` — `result = await withRlsBypass(_tx => PaymentService.handleWebhook(...))`
- `apps/api/src/lib/inngest/functions/payment-webhook-process.ts:173` — `return withRlsBypass(_tx => apply())`

Both discard `_tx` and never thread it; `handleWebhook` queries via the plain
ALS-proxied `prisma` export, which `withRlsBypass` does not populate (it opens its own
`$transaction` and calls `fn(tx)` directly, never `tenantStorage.run`). In the
`storeId`-undefined branch (webhook before store resolution) this is a genuine **no-op**
— mutating `payments`/`orders` queries run with neither bypass nor tenant GUC, "safe"
only because those policies are fail-open on unset context. Combined with a
**non-unique** `transactionId`/`invoiceId` `findFirst` with no `orderBy`
(`schema.prisma:1269-1285` — `@@index`, not `@@unique`), a collision could resolve to
the wrong store's payment. Latent, not confirmed-exploitable (per-store HMAC still
required), but a real cutover-adjacent hardening. A broad grep found **no other**
`withRlsBypass(_...)` discard sites — the class is confined to these two.

**Unlisted `withRlsBypass`/`runInTenantContext` files worth fresh eyes** (not in prior
audits' named allowlist): `email.service`, `push.service`, `sequence.service`,
`abandoned-cart.service`, `notification-config/dispatcher.service`,
`accounting/{account,bank-reconcile,deadstock-scan,journal,reorder-scan}.service`,
`inventory/low-stock-scan.service`, `barcode-scan.service`, `payment-confirm.service`,
`upload/order/payment.routes`. None looked suspicious on a quick read (all follow the
bypass-for-background / self-wrap-per-query pattern) but none has had dedicated review.

**Live-today race (not a flip-breaker but must ship with this set) —**
`order.service.ts:730-735`: fire-and-forget `affiliateService.linkOrderToReferral`
(`.catch(logger.error)`, not awaited) issues two bare `prisma.*` calls with no
self-wrap; it depends on the per-request tenant tx, which commits on `res.finish`. If
the response flushes first, the calls run on a closed tx, throw, get swallowed → the
referral is never marked `converted`, dropping affiliate commission with no
reconciliation sweep. Fix: `await` it, or self-wrap in `runInTenantContext` like
`order-status-changed.ts` does.

---

## 4. Policy predicate correctness

- **Bypass GUC value the code sets:** `'true'` at every call site
  (`packages/database/src/index.ts:295`, `store.service.ts:388`,
  `provisioning.service.ts:129`). Confirmed.
- **The ONLY literal mismatch in all 98 migrations:** `product_daily_views` INSERT
  (`20260622100000_product_daily_views/migration.sql:57-62`, `WITH CHECK (... = 'on')`)
  and UPDATE (`:65-70`, `USING (... = 'on')`), plus the same `'on'` on its SELECT
  bypass branch. Extracted every distinct RHS literal compared against
  `current_setting('app.bypass_rls', true)` across the whole history → only `'true'`
  (everywhere else) and `'on'` (these 3 occurrences). **No other typo exists.** No
  GUC-name typos either — only `app.current_store_id`, `app.current_user_id`,
  `app.bypass_rls` are ever referenced in executable SQL (a stray `app.current_client_id`
  appears only in a comment in `20260615000000`).
- **User-scoped tables needing a user-context predicate:**
  - `addresses` — **correct.** `rls_addresses_user`
    (`20260702170000_rls_close_denyall_tables:67-81`) reads the real per-request GUC
    via `current_user_id()` = `NULLIF(current_setting('app.current_user_id',true),'')`,
    3-branch hybrid. `tenantContext`/`userContext` set `app.current_user_id` from
    `req.user.userId`. Wired end-to-end.
  - `wishlist_items` / `wishlists` — store-scoped (HYB via `wishlists.store_id`), served
    by the bare `/wishlist` router through `userContext(customerUserId, headerStoreId)`.
    Correct.
  - `customer_addresses` — **NO RLS at all, by design** (documented exclusion,
    "account-level"). Unlike `addresses` it has zero DB backstop forever — if the
    app-layer scoping on customer-address endpoints ever slips (see IDOR-audit H1, the
    wa-bridge `customer-addresses` cross-tenant PII bug), nothing catches it. Follow-up
    ticket, out of scope for the flip.
  - `onesignal_subscriptions` — NO RLS, documented, user-scoped. No predicate.

**Two asymmetric-predicate notes (not flip-breakers, confirm before flip):**

1. `fx_rate_entries` has a `RESTRICTIVE FOR INSERT` policy
   (`20260615000000_add_journal_line_fx_fields:65-70`) with **no null-context branch**
   — a contextless INSERT is denied here even though it'd succeed on sibling accounting
   tables. Looks intentional; confirm the one write call site sets context or bypass.
2. The **18 NEW-pattern accounting/analytics tables** (accounts, journal\__, sequences,
   suppliers, purchase_order_, stock_adjustment*, reorder_rules, backorder_lines,
   expenses, reorder_suggestions, deadstock_flags, profit_anomalies, *\_snapshots) are
   **fail-CLOSED** (no null-escape). Any cross-store admin/reporting/export path that
   currently relies on "no context = allow" will start returning **empty results
   (not errors)** at cutover unless it explicitly calls `withRlsBypass()`. Verify these
   read paths in Phase-2 staging.

---

## 5. the earlier app role grants

- **All grants in ONE migration:** `20260404000000_add_rls_policies:23-29`:
  ```sql
  GRANT USAGE ON SCHEMA public TO the earlier app role;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO the earlier app role;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO the earlier app role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO the earlier app role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO the earlier app role;
  ```
  No later migration (of 98) issues any GRANT/REVOKE/ALTER DEFAULT PRIVILEGES.
- **The 65+ tables created after this migration have NO explicit per-table grant** —
  they rely entirely on `ALTER DEFAULT PRIVILEGES`, which has **no `FOR ROLE` clause**
  → defaults to `FOR ROLE <current_role>`, i.e. only auto-grants on tables created by
  the _same role_ that executed the statement. Safe IFF every subsequent `CREATE TABLE`
  ran as that same owner role via `prisma migrate deploy` on `DIRECT_URL`. The plan
  (`:92`) and CI/Railway config confirm migrations always run on the owner
  `DIRECT_URL`, both pre- and post-cutover — so this _should_ transitively cover
  everything. **But this is live-catalog state no `.sql` file can prove.**
- **No sequence-grant gap:** zero `SERIAL`/`nextval`/`CREATE SEQUENCE` in any migration
  (all UUID/text PKs with `gen_random_uuid()`). The `sequences` table is an
  application table, already covered by table grants.
- **MANDATORY live pre-flip queries** (run against prod as owner, read-only):
  ```sql
  -- (a) any public table the earlier app role is MISSING a grant on → 42501 at cutover
  SELECT t.table_name
  FROM information_schema.tables t
  WHERE t.table_schema='public' AND t.table_type='BASE TABLE'
    AND NOT EXISTS (
      SELECT 1 FROM information_schema.role_table_grants g
      WHERE g.grantee='the earlier app role' AND g.table_schema='public'
        AND g.table_name=t.table_name AND g.privilege_type='SELECT');
  -- (b) confirm default-ACL owner covers future tables
  SELECT n.nspname, r.rolname AS defaclrole, a.defaclacl
  FROM pg_default_acl a JOIN pg_namespace n ON n.oid=a.defaclnamespace
  JOIN pg_roles r ON r.oid=a.defaclrole WHERE n.nspname='public';
  -- (c) drift catch — full policy dump to compare against this static matrix
  SELECT schemaname, tablename, policyname, cmd, qual, with_check FROM pg_policies WHERE schemaname='public' ORDER BY tablename, cmd;
  -- (d) confirm the role we're flipping to is non-bypass
  SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname IN ('the earlier app role','neondb_owner');
  ```
  Query (a) returning any row = a genuine grant gap to fix before flip. Query (c) is the
  answer to the missing-`20260521000000`-migration caveat in §0.

---

## 6. The definitive pre-flip checklist (ordered)

**Migration fixes (must ship + apply before flip):**

1. **`product_daily_views`** — new idempotent migration: `DROP` the 2 broken policies,
   recreate INSERT `WITH CHECK` and UPDATE `USING` with the HYB predicate (`'true'`,
   plus `current_store_id() IS NULL` escape and `store_id = current_store_id()`); add a
   `FOR DELETE` policy; fix the SELECT bypass branch (`'on'`→`'true'`, add null-escape).
   Without this, view-tracking silently dies at cutover (the write path fail-open
   swallows the 42501 in `view-ingest.service.ts:99-114`). **[migration]**
2. **`store_staff`** — add a `FOR UPDATE` policy (HYB), OR confirm+document that no code
   path updates `store_staff` and leave it (latent). Recommend adding the policy for
   symmetry. **[migration]**

**Code fixes (ship as the same security batch — some are live bugs today):** 3. **`payment-settings.routes.ts`** — wrap the `:storeId` handlers in
`runInTenantContext(req.params.storeId, ...)` (or `router.param('storeId', tenantContext)`;
confirmed no external I/O in these handlers). Closes the one undocumented, untested
F2-GAP over `PaymentConfig` (encrypted secrets). **[code]** — _Audit A, new High._ 4. **webhook `_tx` no-op + payment uniqueness** — thread `tx` (or drop the misleading
wrapper) at `webhook.routes.ts:305` + `payment-webhook-process.ts:173`, AND add a DB
`@@unique` on `(provider, transactionId)` / `(provider, invoiceId)`. **[code + migration]**
— _Audit A, latent High._ 5. **affiliate fire-and-forget race** — `await` `linkOrderToReferral` or self-wrap it in
`runInTenantContext` (`order.service.ts:730`). Live commission-loss bug independent of
the flip; ship now. **[code]** — _Audit A, live High._

**Verification gates (block the flip until green):** 6. **Live grant sweep** — run §5 query (a); fix any returned table with an explicit
`GRANT ... TO the earlier app role`. **[verify]** 7. **Live policy/default-ACL drift check** — run §5 queries (b),(c),(d); reconcile the
`pg_policies` dump against §1's matrix to catch any pre-2026-05-30 out-of-band drift
(the missing-`20260521000000` caveat). **[verify]** 8. **Phase-2 staging soak on the earlier app role** — exercise checkout (`addresses`), payments,
refunds, every admin section, the fully-bare F2 routers, the 18 fail-closed NEW
accounting tables' cross-store reports (confirm they `withRlsBypass`), Inngest jobs +
crons, Orders PWA. Watch for `42501` / silent-empty regressions. **[verify]**

**Documentation (parity, same session):** 9. Add `ALLOW_BYPASSRLS_ROLE` to `docs/ENVIRONMENT.md` (load-bearing prod boot-guard env,
currently absent — confirmed); fix `docs/DB-BACKUP-RESTORE.md:137`'s nonexistent
`npm run db:rls` reference; add a NO-RLS doc line for `webhook_events`; correct the
stale `runInTenantContext` comments in the 8 bulk-AI Inngest fns + the
`bulk-ai-balance-descriptions.ts` "NOT RLS-protected" comment (F4/F7). **[docs]**

**Out of scope for the flip but tracked (app-layer IDORs, live under BYPASSRLS today —
fix in the parallel `fix/idor-tenant-scoping` branch, NOT gated on the flip):**

- Product FAQ CRUD unscoped by `storeId` (C1) — `ProductFaq` has no `storeId` column,
  RLS can never backstop it; needs a product-ownership check regardless of the flip.
- Smart-layer accept/clearance unscoped `findUnique` (C2) — flip _does_ backstop this
  (both writes run inside `runInTenantContext`).
- wa-bridge `meta-catalog-config` POST trusts body `storeId` (C3) + `customer-addresses`
  unscoped (H1) + config GET disclosure (M1) — the wa-bridge surface has no RLS wiring
  at all; must be fixed at the app layer (`req.bridgeStore.id`), the flip never helps here.
- `orders:refund` permission missing on staff refund routes (H2). onesignal F2-GAP (low).

**Not a blocker, cleanup ticket:** unify OLD/NEW/HYB predicate generations onto HYB so
every table has both the null-escape and the explicit bypass branch (§1 taxonomy).

---

## Appendix — status of every prior-audit RLS finding

| Finding                                          | Prior status     | Verified state now                                                                                        |
| ------------------------------------------------ | ---------------- | --------------------------------------------------------------------------------------------------------- |
| F1 — prod on BYPASSRLS owner                     | High, open       | Open (the flip itself) — code+comment confirmed at `index.ts:438-480`; live role needs 1-cmd psql confirm |
| F2 — ~26–32 bare routers no context              | High             | Substantially FIXED (13 inner-param, test-guarded); residual = §2 F2-GAP set                              |
| F3 — `addresses` deny-all                        | High latent      | FIXED — `20260702170000` adds ENABLE + HYB-U policy; CONFIRMED                                            |
| F3 siblings payments/return_items/wishlist_items | "still excluded" | STALE — already closed by `20260609000000`; all OK                                                        |
| F4/F7 — bulk-AI stale comments                   | Medium/Low       | Still present (comments only; code safe) — doc fix #9                                                     |
| product_daily_views `'on'` typo                  | High             | CONFIRMED — flip-breaker #1                                                                               |
| store_staff no UPDATE policy                     | Low              | CONFIRMED — flip-breaker #2 (latent)                                                                      |
| payment-settings zero RLS wiring                 | High, novel      | CONFIRMED — fix #3                                                                                        |
| affiliate fire-and-forget race                   | High, live       | CONFIRMED — fix #5                                                                                        |
| webhook `_tx` no-op + non-unique txn id          | High, latent     | CONFIRMED — fix #4                                                                                        |
| the earlier app role CI job covers ~6/~90 tables | Medium           | CONFIRMED residual — Phase-2 soak (#8) is the mitigation                                                  |
| ENVIRONMENT.md / DB-BACKUP-RESTORE.md gaps       | Low              | CONFIRMED — doc fix #9                                                                                    |
