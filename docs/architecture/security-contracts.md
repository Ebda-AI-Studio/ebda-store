# Security Contracts

This document collects the non-obvious security contracts the API
relies on. Each section covers WHAT the contract is, WHY it exists,
and the canonical files where it's enforced. If you change one of
these, search the codebase for the linked names — the contract is
spread across multiple files and a partial change is worse than no
change.

---

## CSRF protection: when JSON requests skip the token

Every state-changing request must carry an anti-CSRF token unless it
qualifies for the **JSON content-type skip** described below. See
`apps/api/src/middleware/security.ts` (`csrfProtection`) for the
canonical implementation.

### The skip rule

A request is allowed to skip the CSRF token check when ALL of these
hold:

1. The HTTP method is state-changing (POST/PUT/PATCH/DELETE).
2. The `Content-Type` is `application/json` OR the request carries an
   `X-Requested-With` header.
3. The `Origin` header matches a **platform origin** (admin, web,
   Cloudflare Workers preview, localhost in dev). Custom merchant
   domains DO NOT qualify.

### Why the skip is safe for platform origins

Browsers refuse to send `application/json` (or any
`X-Requested-With`) on a cross-origin fetch without a CORS preflight.
The preflight is rejected by the API's CORS handler when the origin
isn't on the platform list. So a malicious page on `attacker.com`
cannot mount a CSRF attack against our platform endpoints with a JSON
body — the preflight fails before the actual POST.

### Why the skip is NOT safe for custom merchant domains

Merchants can configure arbitrary domains as their storefront
hostname. Once they do, that origin is in the CORS allowlist (DB
lookup in `apps/api/src/index.ts`). A merchant who sets `attacker.com`
as their domain would have that origin pass CORS — and without
gating the JSON skip, they could issue authenticated JSON CSRF
requests to other tenants' endpoints.

The fix (T0-11): the JSON skip is gated through `isPlatformOrigin()`
in `apps/api/src/lib/cors-cache.ts`. Custom domains pass CORS but
must still send the CSRF token explicitly.

### `/auth/` is not a blanket exemption (issue 2425)

Only the credential-less auth entry points skip the check by path:
`register`, `login`, `refresh`, `logout`, `forgot-password`,
`reset-password`, `verify-email`, `resend-verification` and `mfa/verify`
(`CSRF_EXEMPT_AUTH_PATHS` / `isCsrfExemptAuthPath`, an exact match on the
whole path). They run before a session exists, mint the CSRF token itself,
or must work for a session that lost it. The same set is the storefront's
`NO_REFRESH_AUTH_ROUTES`; a unit test fails if the two drift.

Every other `/auth/` write sits behind `authenticate` and rides the same
SameSite=None cookie as any store write — `PUT /auth/me`,
`PUT /auth/me/sms-consent`, `DELETE /auth/me`, `POST /auth/me/erase`,
`POST /auth/change-password`, `POST /auth/logout-all` and the MFA
enroll/disable routes — so it goes through the full check above. The old
`req.path.includes('/auth/')` skip let a merchant custom domain forge any of
them on a visiting shopper's cookie. A new `/auth/...` route is checked
until someone adds it to the exempt list on purpose.

### Where this lives

- `apps/api/src/middleware/security.ts` — `csrfProtection` middleware
- `apps/api/src/lib/cors-cache.ts` — `isPlatformOrigin` (single source
  of truth shared with the CORS handler)
- `apps/api/src/index.ts` — CORS handler, `isPlatformOrigin` import

### Corollary: never mount an admin router at `/public` (#1993)

`csrfProtection` skips every path containing `/public/`, and
`restrictPlatformOnlyOrigins` only denies non-platform origins under
`/api/v1/stores`. Both are keyed on the PATH PREFIX, not on the
route's own middleware chain — so an admin route
(`authorize('store_admin','super_admin')` / `requireStoreAccess`)
reachable under `/api/v1/public/...` is a CSRF-free, credentialed
cross-origin target for any merchant custom domain.
`authenticate`/`authorize` do not close that: they bound which stores
the lured admin reaches, not whether the attacker's page may use the
admin's cookie. Routers that serve both surfaces export a separate
storefront-only router (`publicLoyaltyRoutes`, `publicAffiliateRoutes`,
`publicNotificationRoutes`, `publicRecommendationRoutes`) and only that
one is mounted at `/public`. Enforced for every mount by
`tests/unit/public-mount-admin-route-guard.test.ts`, which walks the
real router table — per-route middleware AND router-level `router.use(...)`
middleware, threaded down to every later route under its mount path (#2036).
It also holds the explicit, reasoned list of `authenticate`d `/public` routes
(customer reads + loyalty join): a credentialed `/public` route is CSRF-free
whatever its role check, so any new one must be added there with its reason.
It cannot see authorization done inside a handler body.

**The `/stores/public` twin (issue 2121).** A `'/public/:storeId/…'` path
declared on a router mounted at bare `/stores` resolves to
`/api/v1/stores/public/…`. That shape is exempt from BOTH controls too —
`csrfProtection`'s `includes('/public/')` and the storefront allowlist
`^/api/v1/stores/public/…` in `restrictPlatformOnlyOrigins` — so it is
treated exactly like `/public`: no admin guard may appear under it, and its
authenticated routes (wallet balance/history, carrier tracking — all
read-only with in-handler ownership) are on the same reasoned list. The
guard walks both prefixes; `csrf-admin-route-not-at-stores-public` in the
defence-mutation record proves it goes red.

---

## JWT lifetime contract

| Token         | Default lifetime | Set via                    | Notes                                                                                                                       |
| ------------- | ---------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Access token  | 30 days          | `JWT_EXPIRES_IN`           | Long because the iOS PWA needs to wake from a push notification weeks later and land authenticated                          |
| Refresh token | 1 year           | `REFRESH_TOKEN_EXPIRES_IN` | Single-use server-side: each refresh issues a new hash, old hash is marked `revokedAt` and detect-replays as `TOKEN_REUSED` |

### What breaks if the access token TTL is too short

A merchant tapping a push notification for a new order on their phone
should land directly on the order page. With a short JWT (e.g. `3h`),
they're forced into a re-login flow before they can act on the
notification — degrading the response-to-order metric the PWA
exists for.

A previous incident: a stale `JWT_EXPIRES_IN="3h"` env var on Railway
silently logged merchants out every 3 hours mid-day even though the
cookie's `maxAge` was 30 days. The mismatch was invisible until
support reports surfaced it. `apps/api/src/index.ts` now logs the
resolved values at boot AND warns when `JWT_EXPIRES_IN` looks like
a short override (`/^\d+\s*[hms]$/i`).

### What breaks if the refresh token TTL is too short

Customers / merchants are forced to re-login at the refresh boundary
even if they were active recently. 1 year is intentionally generous;
the security boundary is not the TTL but **reuse detection** (see
below).

### Refresh-token reuse detection (T1-3)

Schema fields: `replaced_by_id`, `revoked_at`, `revoked_reason`. On
rotate the old row is kept (not deleted) so a replay of a
previously-rotated refresh token is recognisable. Any presentation of
a row with `revoked_at != NULL` revokes EVERY active refresh token
for that user — the legitimate session re-logs in next request,
which is preferable to letting a stolen token keep refreshing in
parallel.

A periodic cleanup loop (`AuthService.cleanupRefreshTokens`, started
in `apps/api/src/index.ts`) prunes expired rows immediately and
revoked rows older than 30 days — bounds the table size in steady
state while keeping the reuse-detection window meaningful.

### Where this lives

- `apps/api/src/config/index.ts` — env resolution + boot-time warning
- `apps/api/src/services/auth.service.ts` — `refreshTokens`, `logout`,
  `cleanupRefreshTokens`, `generateTokens`
- `apps/api/src/index.ts` — cleanup loop registration + boot logging
- `packages/database/prisma/migrations/20260430020000_refresh_token_rotation/`

---

## R2 prefix as the only cross-tenant boundary for uploaded files

Cloudflare R2 holds product images, store logos, page images, etc.
The bucket is **public** (`*.r2.dev`) and tenant isolation is
achieved entirely through the **key prefix**: every uploaded asset
lives at `stores/<storeId>/<folder>/<filename>`.

### Implications

1. **There is no bucket-level ACL or row-level filter.** Anyone with
   a valid R2 URL can read it. Tenant isolation depends on `storeId`
   being correctly resolved at upload time and never letting a caller
   write under another tenant's prefix.
2. The `storeId` used to compose the R2 key is **trusted as-is** —
   the upload routes verify caller ownership via `checkStoreAccess`
   before passing it to `StorageService.upload`. Skipping that check
   = data-injection into another tenant's prefix.
3. Delete is similarly gated: `DELETE /uploads/:key` rejects keys
   that don't start with the caller's verified `storeId/` prefix.

### Why not private bucket + presigned reads?

The storefront serves images directly to end-customer browsers; a
private bucket with presigned reads would either (a) leak time-bound
URLs to every render, or (b) require server-side proxy rendering
which is an unnecessary cost. Public-bucket + key-prefix isolation
is the standard pattern for SaaS storefronts.

### Where this lives

- `apps/api/src/routes/upload.routes.ts` — `resolveFolderAndStore`,
  per-route `requirePermission('products:write')`, `checkStoreAccess`
- `apps/api/src/services/storage.service.ts` — key composition
- The R2 bucket itself: keep the public-read policy unchanged

---

## Multi-tenant isolation: 4-layer defense

Every store-scoped admin route should pass through ALL FOUR layers
before touching tenant data:

1. **Route guard** — `authenticate → authorize(...roles) → requireStoreAccess`
   verifies the JWT, role, and `Store.ownerId` match before the
   handler runs.
2. **`tenantContext` middleware** — wraps the request in a Prisma
   `$transaction` with `SET LOCAL app.current_store_id = '<storeId>'`
   so RLS policies are active for the duration.
3. **Application-level `where: { storeId }` filters** — every query
   that could in theory return rows from another tenant has a
   redundant filter. Defense-in-depth: if a developer forgets to
   wrap a query in `tenantContext`, the WHERE clause still scopes
   it.
4. **Postgres Row-Level Security policies** — final backstop. The
   API connects as the earlier app role (NOT `neondb_owner`) which has
   `rolbypassrls = false`, so the policies are enforced at the DB
   level. See `packages/database/prisma/migrations/20260404000000_add_rls_policies/`.

If a route bypasses any layer, the others should still hold. The
audit's T0-1 finding was that we were running as `neondb_owner` in
production — bypassing layer 4 — making the route-guard gaps in T0-2
exploitable.

### Mixed-audience routes (admin + customer)

Some endpoints serve both customers (storefront) and admins (admin
dashboard) — e.g. `/stores/:storeId/orders/:id`. The `requireStoreAccess`
middleware can't blanket these because it rejects customers. Use
`checkStoreAccess(storeId, user)` from
`apps/api/src/middleware/store-access.ts` programmatically inside the
handler to apply the same ownership gate without coupling to Express
flow.

### Customer-leak guard

The API cookie space is shared between `store.ebda.app` (admin)
and `store.ebda.app` (storefront). An admin's JWT can reach
a customer-facing endpoint. Customer-write endpoints (wishlist, cart,
loyalty `/my-*`, review create, return create) MUST resolve the
caller's userId through `customerUserId(req)` from
`apps/api/src/middleware/auth.ts` — it returns `undefined` for any
non-customer role, which the handler should 403/401. Direct
`req.user?.userId` access on these endpoints is a leak.

### Where this lives

- `apps/api/src/middleware/store-access.ts` — `requireStoreAccess`,
  `checkStoreAccess`, `requireStoreRole`, `requireActiveStore`
- `apps/api/src/middleware/tenant-context.ts` — `tenantContext`
- `apps/api/src/middleware/auth.ts` — `customerUserId`
- `packages/database/prisma/migrations/20260404000000_add_rls_policies/`

---

## Email enumeration: the four flows

| Flow                             | Behavior                                                                                                                                                                                                                                                                                                                                                | Why                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/register`            | Returns `{ emailVerificationSent: true }` for both new and existing emails. Existing-email path sends a "registration attempt" notice to the rightful owner.                                                                                                                                                                                            | T1-4 enumeration close. Identical response shape, identical wall-clock cost (bcrypt always runs), no enumeration channel. |
| `POST /auth/login`               | Returns `INVALID_CREDENTIALS` when user doesn't exist OR password is wrong. Runs bcrypt against a constant dummy hash on the missing-user branch to equalize timing.                                                                                                                                                                                    | Indistinguishable response shape AND wall-clock cost.                                                                     |
| `POST /auth/forgot-password`     | Returns `{ success: true }` regardless of whether the email is registered. Sends the reset email only when it is, handed to `cfWaitUntil` so the found branch does not wait on Resend. Store accounts get the branded store mail; Ebda Store accounts (`store_id` NULL) get the platform mail linking `store.ebda.app/reset-password` (EBDA-PWRESET-1). | OWASP-standard masked response; latency no longer tracks the mail send.                                                   |
| `POST /auth/resend-verification` | Returns `{ success: true }` regardless.                                                                                                                                                                                                                                                                                                                 | Same pattern.                                                                                                             |

The 409 ALREADY_EXISTS response is **gone** as of T1-4. Calling
sites that previously expected a 409 response on duplicate-register
must now look for the success path with `emailVerificationSent: true`
and route to a "check your email" page.

### Where this lives

- `apps/api/src/services/auth.service.ts` — `register`, `login`,
  `requestPasswordReset`, `resetPassword` (atomic single-use claim, revokes
  every session, clears the lockout, never touches MFA)
- `apps/api/src/services/platform-mailer.ts` — `sendMerchantPasswordResetEmail`
- `apps/admin/src/app/{forgot-password,reset-password}/` — the Ebda Store pages
- `apps/api/src/routes/auth.routes.ts` — register handler, audit log
- `apps/api/src/services/email.service.ts` — `sendDuplicateRegistrationNotice`
- `apps/web/src/app/auth/check-email/` — the post-register landing

---

## User-supplied URLs: scheme validation required

Any URL stored in the database and later rendered as an `<a href>` on the storefront
must pass a URL-scheme check before being saved. Allowed schemes are `https?:` and
relative paths. `javascript:` and `data:` URIs must be rejected at the API layer —
they bypass any client-side sanitization and render as stored XSS on the storefront.

### The contract

1. **Every `*Link` / `*Url` field in Zod schemas that is rendered in an `<a href>` on
   the storefront MUST validate the URL scheme** using a shared helper (e.g. `isAllowedUrl()`
   from `@ebda/shared`).
2. The validation must live on the **server** (API Zod schema), not only on the client.
   Client-side validation is defence-in-depth; the API is the trust boundary.
3. **`heroCtaLink` was the first confirmed case** — it accepted `javascript:alert(1)` and
   rendered it on the live storefront (`heroCtaLink` XSS, C6 from the 2026-06-09 audit).
   The fix ships in PR #87. Any future field that feeds an `<a href>` must add the same
   check at addition time.

### Where this lives

- Zod schema in `apps/api/src/routes/store-layout.routes.ts` — `heroCtaLink` now
  has `.refine(isAllowedUrl)`.
- `packages/shared/src/utils/url-validation.ts` — `isAllowedUrl()` (shared helper).
- Audit grep: `grep -rn 'href={' apps/web/src | grep -E 'ctaLink|Url|href'` — every
  match that accepts a user-supplied value needs the scheme check on the write path.

---

## Cross-service tenant isolation: Ebda Store and Ebda Chat

The legacy in-Store WhatsApp bridge (`/api/v1/wa-bridge/*`, the per-store bridge key
and the `ebda_wbs_bridge_keys()` definer) was DELETED (Ruling WA-LEGACY-1, 2026-10-25).
Ebda Chat (wa.ebda.app) is a separate product that talks to the Store only through
the Store contract (`business/ebda/plans/2026-10-24-ebda-whatsapp-store-contract.md`).
The rule that carried over: a cross-service caller never names its own tenant in a
query string or body; the tenant is derived from the credential, in the middleware,
before any handler runs.
