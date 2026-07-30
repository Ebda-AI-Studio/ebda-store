# API tenant-scoping / IDOR audit — 2026-07-15

**Scope:** application-layer authorization on every Express route in
`apps/api/src/routes/*.ts` (59 route files, ~490 route handlers). Focus: does every
store/resource-param route carry the ownership guard (`requireStoreAccess` or an
equivalent), is any client-supplied `storeId` trusted for authz, is `requirePermission`
coverage consistent on sensitive mutations, are public/webhook routes path-scoped +
signature-verified, and is 404-vs-403 anti-enumeration behaviour correct.
**Method:** read-only. Six parallel fan-out passes (balanced by file size) over all route
files, each tracing the full middleware chain per route down into the service layer;
headline findings re-verified directly by the coordinator against source. No source edited.
**Builds on / cross-refs:** `docs/audits/2026-07-02-tenancy-rls-auth.md` (RLS + tenant-context
wiring — NOT re-audited here; that audit's F1 "prod runs as a BYPASSRLS owner role, RLS is
inert" is load-bearing context for severity below). Prior-audit findings are not re-reported
except where their status changed.

## How authorization is supposed to work

Canonical chain for a store-scoped admin route:
`authenticate → authorize('store_admin','super_admin'[,'staff']) → requireStoreAccess → requirePermission(...) → handler`.

- `authenticate` (`middleware/auth.ts:51`) — verifies the access JWT, sets `req.user`.
- `authorize(...roles)` (`auth.ts:148`) — role membership only; **no** ownership check.
- `requireStoreAccess` (`middleware/store-access.ts:14`) — reads
  `req.params.storeId || req.params.id`, loads the `Store`, and enforces ownership:
  super_admin always OK (writes audited); store_admin OK only if `store.ownerId === user.userId`;
  staff OK only if a `StoreStaff (userId,storeId)` row exists; else 403. **This is the IDOR
  guard.** It reads `req.params` at route-match time, so it works regardless of the router's
  mount path (unlike `tenantContext`/RLS). 404 `STORE_NOT_FOUND` if the store doesn't exist,
  403 `FORBIDDEN` if it exists but isn't owned — correct anti-enumeration ordering.
- `checkStoreAccess(storeId, user)` (`store-access.ts:154`) — programmatic equivalent for
  mixed-audience (admin OR customer) handlers; safe only when the handler branches on the
  result and 403/404s when `!ok`.
- `requirePermission(perm)` (`middleware/rbac.ts:144`) — finer-grained gate on top of role
  (e.g. `orders:refund`, `store:settings`). Its absence on a sensitive mutation is an
  **inconsistency/privilege-boundary** finding, not by itself an IDOR.

**Critical property (severity multiplier):** because RLS is inert in production today
(2026-07-02 F1 — `neondb_owner` BYPASSRLS role), the application layer is the **only** line
of tenant isolation. Any confirmed app-layer IDOR is live-exploitable **now**, not merely
"defense-in-depth degraded."

---

## Findings

### C1 — Product FAQ CRUD ignores `storeId` → cross-tenant read/write/delete of any product's FAQs

**Severity: Critical** · **Verdict: CONFIRMED (coordinator-verified)**
`apps/api/src/routes/product.routes.ts:830 (GET), 848 (POST), 874 (PUT), 903 (DELETE)`

`productRoutes` is mounted at `/stores/:storeId/products` (mergeParams), so the chain
`authenticate → authorize('store_admin','super_admin','staff') → requireStoreAccess`
validates the caller owns **`req.params.storeId`** — the store in the mount path. It does
**not** validate that `:id` (the product) belongs to that store. The four FAQ handlers then
query/mutate `ProductFaq` scoped **only** by `productId: req.params.id`:

- `:838` `prisma.productFaq.findMany({ where: { productId: req.params.id } })`
- `:856-866` `prisma.productFaq.create({ data: { productId: req.params.id, ... } })`
- `:882-891` `prisma.productFaq.updateMany({ where: { id: req.params.faqId, productId: req.params.id }, ... })`
- `:910-912` `prisma.productFaq.deleteMany({ where: { id: req.params.faqId, productId: req.params.id } })`

`ProductFaq` (`packages/database/prisma/schema.prisma`) has **no `storeId` column** — only a
`productId` FK. A store*admin/staff who owns \_any* store passes `requireStoreAccess` with
their own `storeId`, then supplies a product UUID belonging to a **different** store in the
`:id` segment and reads, creates, edits, or deletes that other store's product FAQs. Product
IDs are surfaced routinely in admin lists / product URLs — not secrets.

**Worse than RLS-backstoppable:** because `ProductFaq` has no `storeId` column, RLS could
**never** filter it by store even after the planned `force_app` cutover. Every other
product-scoped route in the same file (`getById`/`update`/`delete`) does the correct
`(storeId, id)` check-then-act — the FAQ block is the sole outlier (oversight, not intent).

**Fix:** cross-check product ownership before touching FAQs — e.g. precede each handler with a
`prisma.product.findFirst({ where: { id: req.params.id, storeId: req.params.storeId } })`
guard (404 on miss), mirroring `ProductService.getById(storeId, id)`.

---

### C2 — Smart-layer `accept` / `clearance` create records in a foreign store (unscoped service lookup)

**Severity: Critical** · **Verdict: CONFIRMED (coordinator-verified)** · one defect class, two endpoints
`apps/api/src/routes/smart-layer.routes.ts:92 (…/reorder-suggestions/:id/accept), :184 (…/deadstock-flags/:id/clearance)`
→ `services/accounting/purchase-order.service.ts:328 createPoFromSuggestion`,
`services/accounting/deadstock-scan.service.ts:364 createClearanceCouponFromFlag`

Both routes are correctly chained (`authenticate → requireMfaEnrolled → authorize('store_admin','super_admin') → requireStoreAccess`)
and wrap the call in `runInTenantContext(req.params.storeId, …)`. But they pass **only**
`req.params.id` (the child-entity id) to the service, which does an **unscoped**
`findUnique({ where: { id } })`:

- `purchase-order.service.ts:332-336` looks up the suggestion by id with no `storeId` filter,
  then creates a real PO using `sug.storeId` (the suggestion's own store, `:354`).
- `deadstock-scan.service.ts:367-370` looks up the flag by id with no `storeId` filter, then
  creates a live `Coupon` using `flag.storeId` (`:388`).

A store_admin who owns store A (passes `requireStoreAccess` for A) can POST another store B's
suggestion/flag id and create a purchase order (with B's supplier/cost data) or a clearance
discount coupon **inside store B**. The lookup also discloses B's product/supplier/cost data.
Contrast the sibling `dismiss` endpoints (`smart-layer.routes.ts:112,204`), which correctly
scope `updateMany({ where: { id, storeId: req.params.storeId, status:'open' } })` and no-op on
a foreign id.

**RLS note:** because both writes run inside `runInTenantContext(req.params.storeId)`, a
_completed_ `force_app` RLS cutover would make the unscoped `findUnique` return null for a
foreign row → 404, backstopping this. But under today's BYPASSRLS prod role (2026-07-02 F1)
there is **no backstop — live-exploitable now.**

**Fix:** thread `storeId` into both service functions and change `findUnique({where:{id}})` →
`findFirst({ where: { id, storeId } })`, 404 on mismatch — matching the `dismiss` handlers.

---

### C3 — WA-bridge `meta-catalog-config` write trusts body `storeId` → cross-tenant Meta credential hijack

**Severity: Critical** · **Verdict: CONFIRMED (coordinator-verified)**
`apps/api/src/routes/wa-bridge.routes.ts:1111 (POST /store/meta-catalog-config)`

The WA-bridge surface authenticates via `waBridgeAuth` (`middleware/wa-bridge-auth.ts:36`),
which resolves a **per-store** `wbsApiKey` (`X-WBS-API-KEY` header) to exactly one
`req.bridgeStore`. So each WBS-connected merchant holds a key scoped to their own store — a
real per-tenant boundary. But this handler reads `storeId` straight from the request **body**
and writes with it, never cross-checking against `req.bridgeStore.id`:

```
const { storeId, catalogId, businessId, accessToken } = parse.data;   // :1118 (body)
...
await prisma.store.update({ where: { id: storeId }, data: updateData }); // :1128
```

Any merchant who has connected WBS (holds a valid `wbsApiKey`) can POST another store's
`storeId` and overwrite that store's `metaCatalogId` / `metaBusinessId` / `metaAccessToken`
— i.e. install their own encrypted Meta access token onto a competitor's WhatsApp Business
catalog integration (credential hijack / integration takeover). Target `storeId`s are
readily discoverable. Contrast `wa-bridge.routes.ts:954` (`/templates/status`), which
explicitly cross-checks body `fwbStoreId` against `req.bridgeStore.id` and 403s on mismatch —
the correct pattern this route omits.

**Fix:** ignore body `storeId`; use `req.bridgeStore.id` (or 403 when body `storeId !==
req.bridgeStore.id`), matching `/templates/status`.

---

### H1 — WA-bridge `customer-addresses` GET/POST have NO tenant scoping → cross-tenant PII read/write

**Severity: High** · **Verdict: CONFIRMED (coordinator-verified)**
`apps/api/src/routes/wa-bridge.routes.ts:1150 (GET), :1169 (POST)` →
`services/customer-address.service.ts:23 listForCustomer, :30 createForCustomer`

Both handlers take `customerId` from the query/body and pass it to a service that queries
`where: { customerId }` with **no `storeId` filter and no cross-check** that the customer
belongs to `req.bridgeStore`:

- `customer-address.service.ts:24-27` `findMany({ where: { customerId } })`
- `customer-address.service.ts:34-36` `create({ data: { customerId, ...input } })`

Any WBS-authenticated bridge (valid for its own store) can read or fabricate full delivery-
address PII (street / area / block / governorate / building) for **any** `customerId`,
including customers of other stores. Precondition is knowing a target `customerId` (a UUID,
not trivially enumerable) — hence High rather than Critical — but the code applies zero
ownership scoping, so it is a genuine cross-tenant IDOR class.

**Fix:** scope both service methods by store (`where: { customerId, customer: { storeId: req.bridgeStore.id } }`
or add a `storeId` filter) and verify the customer belongs to the bridge store before write.

---

### H2 — Order refund endpoints lack `requirePermission('orders:refund')` → staff can move money

**Severity: High** · **Verdict: CONFIRMED**
`apps/api/src/routes/order.routes.ts:1178 (POST /:orderId/refund-via-provider), :1003 (POST /:orderId/refresh-refund-status)`

Both gate only on `authenticate → authorize('store_admin','super_admin','staff') → requireStoreAccess`
with **no** `requirePermission`. The permission model (`rbac.ts:61-72`) deliberately excludes
`orders:refund` / `payments:refund` from the `staff` role — refunds are meant to be
store_admin/super_admin only. Because these routes never call `requirePermission`, any `staff`
member of the store can trigger a real provider-side refund (money leaves the merchant
account via `refund-via-provider`) and flip `Payment.status → refunded`, bypassing the
intended approval boundary. Contrast `PUT /:id/status` (`order.routes.ts:505`), which
correctly adds `requirePermission('orders:manage')`.

**Not cross-tenant** (`requireStoreAccess` still blocks store B) — this is a same-tenant
privilege-boundary escalation on money-movement endpoints.
**Fix:** add `requirePermission('orders:refund')` to both routes.

---

### M1 — WA-bridge config GETs disclose any store's bot/Meta config via query `storeId`

**Severity: Medium** · **Verdict: CONFIRMED (coordinator-verified)**
`apps/api/src/routes/wa-bridge.routes.ts:1042 (GET /store/service-menu), :1067 (GET /store/meta-catalog-config)`

Same root cause as C3: `storeId` is read from `req.query` and used raw in
`prisma.store.findUnique({ where: { id: storeId } })` with no cross-check against
`req.bridgeStore.id`. Any WBS-authenticated bridge can read any store's `botServiceMenu`
(`:1049-1052`) and Meta catalog config — `catalogId` / `businessId` / `hasToken`
(`:1074-1090`, token itself not returned). Cross-tenant config disclosure (no write, no plain
token) → Medium. **Fix:** use `req.bridgeStore.id`, ignore query `storeId`.

### M2 — Order `mark-paid` / `bulk-mark-paid` missing `requirePermission` (consistency)

**Severity: Medium** · **Verdict: CONFIRMED**
`apps/api/src/routes/order.routes.ts:646 (POST /:orderId/mark-paid), :754 (POST /bulk-mark-paid)`

Gated by `authorize(...)+requireStoreAccess` but no `requirePermission`; a staff member can
flip local payment status. Lower than H2 because these only mutate local `Payment.status`
(no outbound money movement). Same class as H2 — align on an explicit permission
(`orders:manage`). `POST /:orderId/refresh-payment-status:883` is the same class.

---

### Low findings (functional / consistency — no IDOR)

- **L1 — `typography` PUT over-restrictive permission** (`typography.routes.ts:118`):
  `PUT /stores/:storeId/typography` gates on `requirePermission('settings:write')`, but
  `settings:write` exists only on `super_admin` (`rbac.ts`), not `store_admin`. Likely a
  functional bug (merchants can't save their own typography), not a security gap. CONFIRMED.
- **L2 — `feature` my-features missing explicit `authorize()`** (`feature.routes.ts:348`):
  `/stores/:storeId/my-features` relies solely on `requireStoreAccess` for role gating
  (which internally rejects non-admin roles) — functionally safe, style deviation. CONFIRMED.
- **L3 — `store` PATCH `/:id/status` missing `requireStoreAccess`** (`store.routes.ts:594`):
  `authorize('super_admin')` only. Not exploitable (super_admin bypasses ownership anyway) —
  inconsistency. CONFIRMED.
- **L4 — `shipping-carrier` excludes `staff`** (`shipping-carrier.routes.ts`, shared
  `adminMiddleware`) inconsistently with `inventory.routes.ts` which includes staff —
  business-logic inconsistency, not a security gap. CONFIRMED.
- **L5 — `finance` bank-statement FK not store-checked** (`finance.routes.ts:1076` →
  `bank-reconcile.service.ts:145`): body `glAccountId` written to a `bankStatement.create`
  with no check it belongs to `storeId`. Write stays in caller's own store (not IDOR), but
  a store_admin can FK a statement to another store's GL account — data-integrity bug. CONFIRMED/PLAUSIBLE.
- **L6 — `alert-webhooks` non-timing-safe token compare** (`alert-webhooks.routes.ts`):
  `x-alerts-token` compared with `!==` (not `crypto.timingSafeEqual` as webhook.routes.ts
  uses). Ops-only surface, no tenant data. CONFIRMED (minor).

---

## Verified safe (checked, not findings)

- **Batch 1 (coordinator-verified directly):** `ai.routes.ts` — a single router-level
  `router.use(authenticate, authorize('store_admin','super_admin'), requireStoreAccess)`
  (`:30`) gates all 45 routes under the `/stores/:storeId/ai` mount. `store-layout` (3 routes,
  all guarded), `return.routes.ts` (customer routes use `authenticate + customerUserId`
  self-scoping; admin list uses `checkStoreAccess` correctly `:148`; all admin CRUD use
  `requireStoreAccess`), `upload.routes.ts` (every path runs `resolveFolderAndStore` →
  `checkStoreAccess` `:141,:345` before trusting the `x-store-id` header as an R2 prefix),
  `newsletter` / `pages` / `locations` (requireStoreAccess ≥ route count), `wishlist.routes.ts`
  - `address.routes.ts` (user-scoped via `customerUserId(req)` + explicit "not authorized"
    ownership checks `wishlist:304`, `address:157,234`). **0 IDOR.**
- **admin.routes.ts** — router-level `authenticate` + `requireMfaEnrolled`; every cross-tenant
  list/export/impersonate/webhook-replay route is `requireRole('super_admin')`; the mixed
  `GET /stores`, `GET /stores/:id`, `GET /dashboard` apply explicit `ownerScope`/ownership
  filters + 403 for non-super-admins. Correct — the shared `:id` token is a legitimate
  super_admin cross-tenant surface here.
- **product / category / variant / bulk / suppliers / stock-adjustments / warehouse /
  purchase-orders / expenses / abandoned-cart / affiliate / wbs-integration (GET/PUT/provision)**
  — all admin routes carry `requireStoreAccess`; every service mutation is check-then-act
  `where:{id, storeId}`; bulk delete/update scope `{id:{in:[...]}, storeId}` (foreign ids
  no-op).
- **order / customers / payment / payment-links / insights** — order mutations gated;
  customer export `.xlsx` is `{storeId}`-scoped (raw `$queryRaw` uses Prisma-parameterized
  `${storeId}::uuid`, no SQLi); payment `/create,/status,/refund,/retry,/order,/:id/events`
  all do role-branched order→store ownership derivation + uniform 404 anti-enumeration +
  `runInTenantContext(derived storeId)`; `/events/:eventId/payload` is super_admin-only.
- **store / payment-settings / tax / payment-abandonments / public-store-layout** —
  store settings routes double-gated (`requireStoreAccess` + `requirePermission('store:settings')`
  - inline re-check); payment-settings global config gated by super_admin-only permissions;
    public tax/layout routes expose no tenant PII.
- **auth / mfa / staff / onesignal / loyalty / analytics / notification / bot-analytics /
  finance / cart / pwa** — auth/mfa operate strictly on `req.user.userId` (never a client
  `userId`; MFA re-enroll/disable require a current TOTP + revoke sessions); staff add/remove
  excludes the `staff` role (no self-escalation); onesignal device ops scoped to caller;
  loyalty/analytics gated (`requirePermission('analytics:read')` substitutes for `authorize`
  correctly); guest cart keyed by `(storeId path, sessionId)` with `customerUserId` guard
  against shared-origin admin-cookie misread.
- **webhook.routes.ts** — payment webhook per-store HMAC (prior audit); `/shipping/icarry`
  - `/shipping/aramex` use a shared platform secret via `crypto.timingSafeEqual`, 401 on
    missing/bad signature.
- **No client-supplied body `storeId` used for authz anywhere:** repo-wide
  `grep -rn 'req\.body\.storeId|req\.body\.store_id' apps/api/src/routes` → **zero matches**.
  The only client-supplied-tenant-id authz bugs are on the **query/body of the WA-bridge
  surface** (C3/H1/M1), which is a separate auth model (`waBridgeAuth`, not JWT/RBAC).
- **Prior-audit F6 appears FIXED:** `GET /public/:storeId/wishlist/:userId` now has an
  `isPublic` gate (`public.routes.ts:961-967`); no sibling `/public/:storeId/<resource>/:userId`
  disclosure pattern found.

---

## Ranked findings

| #   | Severity     | Verdict   | Cross-tenant?             | Finding                                                                                                                         | Location                                                                                          |
| --- | ------------ | --------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| C1  | **Critical** | CONFIRMED | YES (r/w/del)             | Product FAQ CRUD scoped by `productId` only, never `storeId`; `ProductFaq` has no `storeId` column → not even RLS-backstoppable | `product.routes.ts:830,848,874,903`                                                               |
| C2  | **Critical** | CONFIRMED | YES (write)               | Smart-layer `accept`/`clearance` create PO/coupon in a foreign store via unscoped service `findUnique`                          | `smart-layer.routes.ts:92,184` → `purchase-order.service.ts:328`, `deadstock-scan.service.ts:364` |
| C3  | **Critical** | CONFIRMED | YES (write)               | WA-bridge `meta-catalog-config` POST trusts body `storeId` → overwrite another store's Meta credentials (hijack)                | `wa-bridge.routes.ts:1111`                                                                        |
| H1  | **High**     | CONFIRMED | YES (r/w PII)             | WA-bridge `customer-addresses` GET/POST have zero tenant scoping → any customer's address PII by `customerId`                   | `wa-bridge.routes.ts:1150,1169` → `customer-address.service.ts:23,30`                             |
| H2  | **High**     | CONFIRMED | No (same-tenant priv-esc) | Order refund / refresh-refund lack `requirePermission('orders:refund')`; staff can move money                                   | `order.routes.ts:1178,1003`                                                                       |
| M1  | **Medium**   | CONFIRMED | YES (read)                | WA-bridge `service-menu` + `meta-catalog-config` GETs disclose any store's config via query `storeId`                           | `wa-bridge.routes.ts:1042,1067`                                                                   |
| M2  | **Medium**   | CONFIRMED | No                        | Order `mark-paid`/`bulk-mark-paid`/`refresh-payment-status` missing `requirePermission`                                         | `order.routes.ts:646,754,883`                                                                     |
| L1  | Low          | CONFIRMED | No                        | `typography` PUT gated on `settings:write` which store_admin lacks (functional)                                                 | `typography.routes.ts:118`                                                                        |
| L2  | Low          | CONFIRMED | No                        | `feature` my-features relies on `requireStoreAccess` for role gating, no explicit `authorize()`                                 | `feature.routes.ts:348`                                                                           |
| L3  | Low          | CONFIRMED | No                        | `store` PATCH `/:id/status` super_admin-only, no `requireStoreAccess` (not exploitable)                                         | `store.routes.ts:594`                                                                             |
| L4  | Low          | CONFIRMED | No                        | `shipping-carrier` excludes `staff` inconsistently with `inventory`                                                             | `shipping-carrier.routes.ts`                                                                      |
| L5  | Low          | CONFIRMED | No                        | `finance` bank-statement `glAccountId` FK not store-checked (data integrity)                                                    | `finance.routes.ts:1076` → `bank-reconcile.service.ts:145`                                        |
| L6  | Low          | CONFIRMED | No                        | `alert-webhooks` token compared with non-timing-safe `!==`                                                                      | `alert-webhooks.routes.ts`                                                                        |

**Count by severity:** Critical 3 · High 2 · Medium 2 · Low 6 (Total 13).
Of these, **5 are cross-tenant IDORs** (C1, C2, C3, H1, M1); the rest are same-tenant
privilege-boundary / consistency / data-integrity issues.

**Routes checked:** ~490 handlers across all 59 route files.

## Does any NEW IDOR exist?

**YES.** Five confirmed cross-tenant IDORs not present in the 2026-07-02 audit:

- **3 Critical cross-tenant writes** — C1 (product FAQ r/w/delete of any store), C2 (create
  PO/clearance-coupon in a foreign store), C3 (overwrite another store's Meta catalog
  credentials via the WA-bridge).
- **1 High cross-tenant PII r/w** — H1 (unscoped customer-address read/write via the WA-bridge).
- **1 Medium cross-tenant read** — M1 (WA-bridge config disclosure).

C1 is the worst structurally (no `storeId` column on `ProductFaq`, so RLS can never backstop
it). C2 is backstopped once the `force_app` RLS cutover lands but is live under today's
BYPASSRLS prod role. C3/H1/M1 sit on the `waBridgeAuth` surface, which RLS/tenant-context
was never wired to — they trust a client-supplied `storeId`/`customerId` with no cross-check
against the authenticated `req.bridgeStore.id`. All five should be fixed by adding the same
missing check: **derive the tenant key from the authenticated context (path `:storeId` via
`requireStoreAccess`, or `req.bridgeStore.id`), never from a body/query field, and scope the
resource lookup by it.**
