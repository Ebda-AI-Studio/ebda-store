# Tenancy / RLS / Auth deep audit — 2026-07-02

**Scope:** multi-tenant isolation, RLS enforcement, auth/access middleware coverage.
**Repo state:** worktree at `origin/main` HEAD `2332c4d5`.
**Method:** read-only. Reviewed `packages/database/src/index.ts` (RLS helpers),
`apps/api/src/middleware/{auth,store-access,tenant-context,rbac,security}.ts`,
`apps/api/src/routes/index.ts` mount table, all 60 route files (fan-out), the RLS
migration history in `packages/database/prisma/migrations`, the newer Inngest
functions not covered by the 2026-06-09 async-writer audit, and storefront
`localStorage`/`sessionStorage` namespacing. Builds on
`docs/audits/2026-06-09-rls-async-writer-audit.md` (do not re-report items fixed there).

**Headline:** The application-layer authorization (`requireStoreAccess` + explicit
`where:{storeId}` / check-then-act) is consistently strong — **no confirmed live
cross-tenant IDOR was found**. The systemic risk is that the _database_ backstop
(RLS) that the codebase documents as "isolation even if application code misses a
WHERE filter" is **currently inert in production** and, even after the planned
`force_app` cutover, is not wired for a large fraction of routers. Isolation today
rests entirely on the app layer; a single forgotten `storeId` filter would leak
cross-tenant with no second line of defense.

---

## How isolation is _supposed_ to work

- `packages/database/src/index.ts`: `runInTenantContext(storeId, fn)` opens an
  interactive tx, runs `SET LOCAL app.current_store_id = '<uuid>'`, and routes all
  proxied prisma calls through the tx (AsyncLocalStorage). `withRlsBypass(fn)` sets
  `app.bypass_rls='true'` for cross-tenant work.
- Policies use a **HYBRID / allow-contextless** predicate
  (`packages/database/prisma/migrations/20260609000000_complete_force_rls_coverage/migration.sql:16-34`):
  `current_store_id() IS NULL OR app.bypass_rls='true' OR store_id = current_store_id()`.
  Critical property: **a query run with NO context set returns ALL tenants' rows** —
  RLS filters nothing unless context is explicitly set.
- `apps/api/src/middleware/tenant-context.ts` is meant to set that context per HTTP
  request from `:storeId`/`:id`.

---

## Findings

### F1 — Production runs with RLS entirely disabled (BYPASSRLS owner role); isolation is app-layer-only

**Severity: High** · **Verdict: CONFIRMED (code + dated in-repo comment); prod DB role needs a 1-command runtime confirm**
`apps/api/src/index.ts:438-480`

The boot guard's own comment (annotated "Verified 2026-06-27") states: _"Production
currently connects as `neondb_owner` (a BYPASSRLS role)… `ALLOW_BYPASSRLS_ROLE=true`
keeps the API serving (loud warning, not exit)."_ A role with `rolbypassrls=true`
**skips every RLS policy regardless of ENABLE/FORCE**. So in production today, every
policy, every `FORCE ROW LEVEL SECURITY`, the hybrid predicate, and every
`runInTenantContext`/`withRlsBypass` wrapper is a **no-op**. The _only_ tenant
isolation actually operating in prod is the application layer (`requireStoreAccess`

- explicit `where:{storeId}`).

**Failure scenario:** any handler that issues a tenant-table query missing its
`storeId` filter returns/writes across ALL tenants — there is no DB backstop to
catch it. This inverts the risk model the codebase assumes: every gap in F2/F4 and
any future missing-`WHERE` bug is a _live_ cross-tenant leak now, not merely
"defense-in-depth degraded."

**Fix:** complete the tracked cutover — point production `DATABASE_URL` at the
non-owner `force_app` login role (granted DML in
`.../20260404000000_add_rls_policies/migration.sql:22-29`) and remove
`ALLOW_BYPASSRLS_ROLE`. Verify with `railway run -- psql "$DATABASE_URL" -c "SELECT current_user, (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user)"`.
Gate F2 and F3 _before_ cutting over (they break at cutover).

---

### F2 — RLS tenant context is never set for ~32 routers mounted at bare `/stores`, `/`, `/admin`

**Severity: High** · **Verdict: CONFIRMED**
`apps/api/src/routes/index.ts:81,89,90,93,111-197,124-134` · `apps/api/src/middleware/tenant-context.ts:37-53`

`tenantContext` reads `req.params.storeId || req.params.id`, but Express only
populates `req.params` for params declared **in the mount path**. Routers mounted as
`router.use('/stores', tenantContext, xRoutes)` (coupon, shipping, tax, loyalty,
pwa, inventory, bulk, variant, notification, abandoned-cart, recommendation,
shipping-carrier, affiliate, newsletter, wbs-integration, finance, smart-layer,
insights, suppliers, purchase-orders, stock-adjustments, warehouse, expenses,
backorders, bot-analytics), plus `router.use('/', …)` (pages, blog, locations) and
`router.use('/admin', …)` (admin, feature), declare no param at the mount. So when
`tenantContext` runs, `req.params` is empty → it hits `if (!storeId){ next(); return; }`
and **never calls `runInTenantContext`**. The inner router parses `:storeId` only
afterward. Under the allow-contextless policy, these routers get zero DB filtering.

Contrast — RLS _is_ wired (param in mount path): `/stores/:storeId/products|categories|ai|typography|cart|orders|reviews|analytics|returns|staff|payment-abandonments`,
`/stores/:storeId` (customers), `/stores/:id/wa-templates|payment-links`,
`/admin/stores/:storeId/layout`.

**Failure scenario:** post-`force_app`-cutover (F1), these routers still receive no
context → allow-contextless → any handler missing `where:{storeId}` leaks all
tenants. The `tenant-context.ts` doc comment ("the database enforces tenant
isolation even if application code misses a WHERE filter") is **false** for them.

**Fix:** mount each store-scoped router with the param in the path
(`router.use('/stores/:storeId/coupons', tenantContext, couponRoutes)`), or re-apply
`tenantContext` inside each sub-router (`Router({mergeParams:true})`) after
`:storeId` is parsed. Add a test asserting every mutating query on these routers
carries a `storeId` filter until the mount is fixed.

---

### F3 — `addresses` table is FORCE-RLS'd with NO policy → deny-all for `force_app` at cutover (checkout + saved addresses break platform-wide)

**Severity: High** · **Verdict: CONFIRMED (latent; triggers at the F1 cutover)**
`.../20260530000000_force_rls_enforcement/migration.sql:26` (FORCE list includes `addresses`) · `.../20260404000000_add_rls_policies/migration.sql:146-151` (addresses explicitly excluded from policies) · `.../20260609000000_complete_force_rls_coverage/migration.sql:388-398` (documents addresses as user-scoped, but does **not** add a policy or `NO FORCE`)

`addresses` (user-scoped, no `store_id` column) was included in the blanket
`FORCE ROW LEVEL SECURITY` array but was never given any RLS policy, and unlike
`stores` (which got an explicit `NO FORCE` at line 411-412) it was never un-forced.
`FORCE` + zero policies = **deny-all** for any non-owner role. It works today only
because prod connects as the BYPASSRLS owner (F1). The moment `DATABASE_URL` cuts
over to `force_app`, every `addresses` SELECT/INSERT/UPDATE returns 0 rows / is
rejected. `force_app` holds DML grants (`.../20260404…:24`), so it's a policy gap,
not a grant gap.

**Failure scenario:** at RLS cutover, storefront checkout's address step and the
account "saved addresses" surface break for every store simultaneously — a
platform-wide P0 the moment the F1 follow-up ships.

**Fix:** before cutover, either add a user-scoped policy
(`USING (user_id = current_setting('app.current_user_id', true) OR current_store_id() IS NULL OR app.bypass_rls)`)
or, matching the intent that addresses are auth-layer-scoped and read contextlessly,
`ALTER TABLE addresses NO FORCE ROW LEVEL SECURITY; ALTER TABLE addresses DISABLE ROW LEVEL SECURITY;`
(same treatment `stores` received). Audit the rest of the 20260530 FORCE array the
same way (`inventory_logs`, `wishlists`, `wishlist_items` — confirm each has a
matching policy).

---

### F4 — Bulk-AI Inngest functions run in bare RLS context under false `runInTenantContext` comments

**Severity: Medium** · **Verdict: CONFIRMED**
`bulk-ai-translate.ts:53,409` · `bulk-ai-seo.ts:71,379` · `bulk-ai-aeo.ts:232,486,754,1149` · `bulk-ai-geo.ts:269,489,688` · `bulk-ai-product-faqs.ts:268` · `bulk-ai-recommendations.ts:512` (all under `apps/api/src/lib/inngest/functions/`)

None of the 8 bulk-AI functions import or call `runInTenantContext`; each uses a bare
`(async () => {…})()` and runs every prisma query with **no** tenant GUC and no
bypass. The wrapper was correctly removed to fix the 30s interactive-tx timeout when
Gemini calls sit inside a tx — but the code still carries comments like
`// end runInTenantContext` and "All DB reads/writes run inside runInTenantContext",
which are now false. Every current query is explicitly `where:{storeId}`-scoped (incl.
the dangerous `bulk-ai-aeo.ts:331 storeFaq.deleteMany where {storeId,manuallyEdited:false}`),
so **there is no leak today**. The 2026-06-09 audit doc's claim that these "wrap the
entire function body in runInTenantContext" is also now stale.

**Failure scenario:** a future edit adds a query trusting the comment (e.g. a
`storeFaq.deleteMany` variant that drops `storeId`); with bare context and no RLS
backstop it reads/deletes across ALL tenants — e.g. wiping every store's FAQs.

**Fix:** delete the false comments; add a one-line invariant per function ("BARE RLS
context — every query MUST carry `where:{storeId}`; no RLS backstop"). Correct the
2026-06-09 audit doc. (Keep the honest tx-timeout note already present in
`bulk-ai-balance-descriptions.ts:53`.)

---

### F5 — PLP compare-list reads the un-namespaced legacy `compareProducts` key → functional desync + cross-store bleed

**Severity: Medium** · **Verdict: CONFIRMED**
`apps/web/src/app/products/ProductsClient.tsx:273` (reads flat `localStorage.getItem('compareProducts')`) vs `apps/web/src/lib/compare.ts:10,20` (`compareStorageKey()` → per-store `compareProducts:<storeId>`)

The compare system was migrated to the per-store key `compareProducts:<storeId>`, but
the PLP compare-highlight sync on mount still reads the flat legacy `compareProducts`
key that nothing writes anymore. Two effects: (a) functional desync — PLP compare
checkmarks read a key with no writer, so they don't reflect the real list; (b) genuine
cross-store bleed for any shopper holding stale flat-key data from before the
namespacing fix — store A's compared product IDs highlight on store B in the same
browser (shared platform origin `store.forcemediakw.com/<slug>`).

**Fix:** change line 273 to read `compareStorageKey()` (import from `lib/compare`),
matching every other call site.

---

### F5b — Static, un-namespaced storefront storage keys bleed UX/PII state between stores

**Severity: Low** · **Verdict: CONFIRMED**
`apps/web/src/components/PushNotificationPrompt.tsx:9-10` (`push-dismissed`/`push-subscribed`) · `apps/web/src/.../WaTokenHydrator.tsx:44,120` + `CheckoutClient.tsx:318` (`fwb.wa-customer-phone`, `fwb.wa-cart-redeemed`)

On the shared platform origin, these static keys carry over between stores: dismissing
the push prompt on store A suppresses it on store B; a WhatsApp phone number entered at
store A's checkout is readable at store B's checkout within the same tab session (minor
PII bleed, sessionStorage clears on tab close). Most storefront keys ARE namespaced
(`cartStorageKey`, `compareStorageKey()`, `storageKey(storeId)`, `checkoutStorageKey`,
`promoStorageKey`, `force-promo-${store.id}`, `lastListingKeyFor(storeId)`). The static
`accessToken`/`refreshToken`/`csrfToken`/`sessionId` keys are un-namespaced too but are
**safe by design** — auth is server-validated and the guest cart lookup is keyed
server-side by `(storeId, sessionId)`.

**Fix:** namespace `push-dismissed`/`push-subscribed`/`fwb.wa-*` by `store.id` like the
cart/compare/checkout keys already are. Same class as
`feedback-per-store-localstorage-namespacing.md`.

---

### F6 — Public wishlist is disclosed by `userId` with no share/consent flag

**Severity: Low** · **Verdict: PLAUSIBLE (likely an intentional shareable-wishlist feature; flag for confirmation)**
`apps/api/src/routes/public.routes.ts:855-895`

`GET /public/:storeId/wishlist/:userId` returns a user's full wishlist (their saved
product interests) with no auth. It validates UUID _format_ (blocks sequential
enumeration) and store-active, but queries `where:{userId,storeId}` with **no**
`isPublic`/opt-in check — anyone holding a customer's UUID (which surfaces in other
responses/URLs) can read what they saved.

**Failure scenario:** a customer's product-interest history is readable by anyone who
learns their UUID, without the customer ever opting into sharing.

**Fix:** gate on an explicit per-wishlist "public/shareable" flag, or require the
owning customer's auth.

---

### F7 — `bulk-ai-balance-descriptions.ts` comment misstates that `products`/`bulk_ai_jobs` are "NOT RLS-protected"

**Severity: Low** · **Verdict: CONFIRMED**
`apps/api/src/lib/inngest/functions/bulk-ai-balance-descriptions.ts:~52`

`products` has ENABLE+policy (`.../20260404…:35`) and `bulk_ai_jobs` has a tenant
policy + ENABLE + FORCE (`.../20260609…`). The comment's rationale ("no tenant context
needed because no RLS") is wrong and reinforces the false mental model behind F4. Code
is safe (explicit `storeId` scoping); only the comment is misleading.

**Fix:** correct the comment to note both tables ARE RLS-protected but the hybrid
policy allows contextless queries, so safety depends on every query scoping by
`storeId`, not on the (absent) wrapper.

---

### F8 — Custom `domain` string can be claimed without DNS-ownership verification

**Severity: Low** · **Verdict: CONFIRMED**
`apps/api/src/routes/store.routes.ts:1173` · `apps/api/src/services/store.service.ts:240`

`PUT /:id/domain` is properly gated (`authenticate → requireMfaEnrolled →
authorize('store_admin','super_admin') → requireStoreAccess`) and enforces `@unique`
domain, so a store_admin can only edit their **own** store's domain and cannot claim a
domain another store already holds. But there is **no DNS-TXT ownership proof** before
persisting the string, so a store_admin can reserve `competitor-brand.com` on their own
store. They cannot serve traffic there (they don't control that domain's DNS/CNAME to
the Force origin) — so this is **not** a data-isolation issue — but they can squat the
string so the rightful owner gets `DOMAIN_TAKEN` (denial-of-attachment nuisance).

**Fix:** require a DNS TXT verification token proving control before persisting a custom
`domain`, or restrict domain attach to super_admin.

---

## Verified safe (checked, not findings)

- **Custom-domain resolution is exact-match, no catch-all** (`public.routes.ts:1296-1301`,
  `store.service.ts:531-533`): `where:{domain}` with status/deletedAt guards; a
  non-matching host 404s — no fallback-to-default-store leak.
- **Payment webhook order-scoping is per-store** (`payment.factory.ts:746,753,819`;
  `webhook.routes.ts:32-51,385-424,613-620`): signature verified with the **per-store**
  AES-decrypted secret (not a shared platform secret); store resolved from the
  invoice/txn id → matching `payment` row → its `storeId`, and the payment lookup is
  additionally scoped `{order:{storeId}}`; both entrypoints 401 on missing signature +
  idempotency-guarded. A store_admin cannot forge/replay a webhook against another
  store's order without that store's HMAC secret.
- **super_admin surface** (`admin.routes.ts:33,40,46,97,136,245,287,348,422,494`):
  global `authenticate`+`requireMfaEnrolled`; `requireRole('super_admin')` on
  management/write; the one mixed list route returns "all stores" scope only for
  super_admin via an explicit per-role filter helper. Not accidentally reachable by
  store_admin.

- **No confirmed entity-`:id` IDOR.** Bare `where:{id}` mutations in
  `coupon.service.ts:210`, `blog.service.ts:174,194`, `variant.service.ts:228,360,535`,
  `account.service.ts:246`, `affiliate.service.ts:393` are each preceded by a
  `storeId`-scoped `findFirst`/`getById`/`this.getById(storeId,id)` ownership check
  (check-then-act). Safe even with RLS inert.
- **`upload.routes.ts`** — every `x-store-id`/`?storeId` path runs `checkStoreAccess`
  before trusting the value as an R2 prefix (`resolveFolderAndStore` :104-150; delete
  :405-435; font :532). No forged-header cross-tenant delete/upload.
- **`payment.routes.ts`** — `/create` (:190-230) verifies order ownership
  (customer→customerId, guest→customerId:null + unguessable v4 orderId) then wraps
  writes in `runInTenantContext(order.storeId)`; `/status`, `/:id/events`, `/refund`
  do explicit order→store ownership checks. No IDOR.
- **`admin.routes.ts`** — `requireRole(...)`; store_admin/staff paths scoped via
  `ownerScopeForReq` + explicit 403; staff membership via `withRlsBypass` `storeStaff`
  lookup. Correctly scoped.
- **`getStoreIdFromRequest`** (`utils/store-helpers.ts:29-54`) trusts
  `x-store-id`/`x-store-domain` but validates the store is active and only exposes the
  named store's **public** data — expected storefront behavior, not forgery; no silent
  fallback to a default store (that leak was previously fixed).
- **`Store.domain` is `@unique`** (schema:173) and `StoreService.update` enforces
  uniqueness with a 409 (`store.service.ts:183-190,238-245`) — a store_admin cannot
  claim another store's domain. (Residual: domains are set without an ownership-of-DNS
  verification step, but uniqueness prevents cross-tenant hijack; the domain only
  becomes CORS-allowlisted for that store's own origin, gated by the CSRF-token
  verifier in `security.ts:115-182`.)
- **All `withRlsBypass` call sites** (grep across `apps/api/src`: `store-access.ts:106,175`,
  `webhook.routes.ts`, `staff.routes.ts`, `admin.routes.ts`, accounting/notification/
  push/abandoned-cart/view-ingest/warehouse/provisioning services) are justified —
  storeId genuinely unknown pre-resolution, or cross-tenant cron/super-admin
  enumeration; each carries explicit `where` scoping inside the bypass.
- **Low-stock cron I/O-in-tx fix intact** (`stock-low-stock-alert.ts` +
  `low-stock-scan.service.ts`): DB reads inside `withRlsBypass`, all Redis/email I/O
  outside the tx. No regression of `feedback-redis-io-inside-rls-transaction-timeout.md`.
- **Webhook async-writer RLS** (payment-webhook-process/-stuck-sweep, order-\*-sweep):
  cross-tenant enumeration in `withRlsBypass`, per-store mutation re-wrapped in
  `runInTenantContext(order.storeId)`, external pushes outside the tx. Correct.

---

## Ranked top findings

| #   | Severity   | Verdict            | Finding                                                                                                                          | Location                                                        |
| --- | ---------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| F1  | **High**   | CONFIRMED\*        | Prod connects as BYPASSRLS owner (`ALLOW_BYPASSRLS_ROLE=true`) → RLS entirely inert; isolation is app-layer-only                 | `apps/api/src/index.ts:438-480`                                 |
| F2  | **High**   | CONFIRMED          | `tenantContext` never sets RLS context for ~32 routers on bare `/stores` `/` `/admin` mounts (param not in mount path)           | `routes/index.ts:111-197`; `middleware/tenant-context.ts:37-53` |
| F3  | **High**   | CONFIRMED (latent) | `addresses` is FORCE-RLS'd with no policy → deny-all for `force_app`; checkout + saved addresses break at cutover                | migrations `20260530…:26`, `20260404…:146`, `20260609…:388`     |
| F4  | **Medium** | CONFIRMED          | 8 bulk-AI Inngest fns run bare (no RLS) under false `runInTenantContext` comments; no backstop if a future query drops `storeId` | `lib/inngest/functions/bulk-ai-*.ts`                            |
| F5  | **Medium** | CONFIRMED          | PLP reads legacy flat `compareProducts` key → compare desync + cross-store bleed of compared IDs                                 | `app/products/ProductsClient.tsx:273`                           |
| F5b | **Low**    | CONFIRMED          | Static push/wa-phone storage keys bleed UX/PII across stores on shared origin                                                    | `PushNotificationPrompt.tsx:9`; `WaTokenHydrator.tsx:44,120`    |
| F6  | **Low**    | PLAUSIBLE          | Public wishlist disclosed by `userId` with no share/consent flag                                                                 | `routes/public.routes.ts:855`                                   |
| F7  | **Low**    | CONFIRMED          | Comment falsely claims `products`/`bulk_ai_jobs` are not RLS-protected (reinforces F4 mental model)                              | `bulk-ai-balance-descriptions.ts:~52`                           |
| F8  | **Low**    | CONFIRMED          | Custom `domain` claimable without DNS-ownership proof (squatting nuisance; not isolation)                                        | `store.routes.ts:1173`; `store.service.ts:240`                  |

\*F1 is CONFIRMED at the code/comment level (guard is in allow-mode, comment dated
2026-06-27); confirming the _live_ prod DB role is a one-command `railway run … psql`
check, not a code read.

**Count by severity:** High 3 · Medium 2 · Low 4 · (Total 9). No Critical — because
the strong, consistent app-layer scoping (`requireStoreAccess` + check-then-act)
holds the line that RLS currently does not. The strategic risk is that this makes the
app layer _load-bearing with no backstop_ (F1/F2), so the High items should be closed
as a set before the `force_app` cutover.
