## 1. Security & Compliance Audit

### Executive summary

- Auth layer is well-hardened: bcrypt cost-12, dual Bearer/cookie path, refresh-token rotation with reuse detection, and a correct `customerUserId()` role guard preventing merchant cookies from tainting customer-scope data.
- Tenant isolation is defense-in-depth: `runInTenantContext` wraps every store-scoped route in a Postgres transaction with `SET LOCAL app.current_store_id`, backed by `ENABLE ROW LEVEL SECURITY` on 52+ tables and `requireStoreAccess` ownership gate at the route level.
- The most material open gap is **Sentry sending raw `req.headers` on 5xx** — this pipes `Authorization: Bearer <token>` and `Cookie: token=<jwt>` directly to Sentry as `extra` data on every unhandled error, bypassing the pino redact list.
- Access-token TTL defaults to **30 days**, well above the 7-day convention documented in CLAUDE.md; refresh token defaults to **365 days**. Both are configurable but the out-of-the-box defaults weaken token revocation windows.
- GDPR Art. 17 erasure (`/auth/me/erase`) and Art. 20 export (`/auth/me/export`) both exist and are correctly implemented with irreversible PII anonymisation.

---

### Findings (by domain)

#### 1.1 Authentication

- ✅ **JWT algorithm pinned to HS256** [P2] — `jwt.verify` specifies `algorithms: ['HS256']`, `issuer: 'force-api'`, `audience: 'force-app'`. Algorithm-confusion attacks (RS256 none-alg) blocked. `apps/api/src/middleware/auth.ts:55-59`

- ✅ **Refresh-token rotation with reuse detection** [P1] — Tokens are hashed SHA-256 before storage; once rotated, re-presenting the old token revokes the entire token family and forces re-login. `apps/api/src/services/auth.service.ts:477-534`

- ✅ **Refresh token type guard** [P1] — Refresh tokens with `payload.type === 'refresh'` are rejected at the `authenticate()` middleware level; they cannot be used as access tokens. `auth.ts:62-63`

- ✅ **Dual-path token extraction (Bearer + HTTP-only cookie)** [P2] — Clean fallback, cookie-path appropriately secondary. `auth.ts:32-45`

- ✅ **Auth rate limiter: 15 req / 15 min / (IP+email)** [P1] — Uses `ipKeyGenerator()` to normalize IPv6/64 prefixes preventing per-request bucket rotation. `security.ts:228-245`

- ✅ **Password reset rate limiter: 3 req / 1hr** [P1] — Separate limiter on `/auth/forgot-password`. `security.ts:248-262`

- ✅ **Password hashing: bcrypt cost-12** [P1] — `SALT_ROUNDS = 12` at class level, used consistently for registration, change-password, reset-password. `auth.service.ts:35`

- ✅ **Constant-time password dummy compare** [P1] — Existing-user branch always runs `bcrypt.compare` against a pre-computed dummy hash to prevent email-enumeration via timing. `auth.service.ts:413-417`

- ⚠️ **Access token TTL default: 30 days** [P2] — `config/index.ts:59` defaults `JWT_EXPIRES_IN` to `'30d'`. CLAUDE.md documentation says "7 days" but code ships 30. A stolen JWT is valid for a month before expiry. Remediation: set env var `JWT_EXPIRES_IN=7d` in Railway production, or tighten the code default to `'7d'`.

- ⚠️ **Refresh token TTL default: 365 days** [P2] — `config/index.ts:60` defaults `REFRESH_TOKEN_EXPIRES_IN` to `'365d'`. Coupled with the 30d access token, the revocation window is very long. Remediation: set `REFRESH_TOKEN_EXPIRES_IN=30d` in prod env.

- ⚠️ **No account lockout for store_admin / super_admin logins** [P2] — The account-lockout service fires at 5 wrong-password attempts for the same email per comments in `security.ts:204-210`, but this is noted only for the customer path. Confirm `AuthService.login` enforces lockout equally for all roles at the service layer.

---

#### 1.2 Authorization & tenant isolation

- ✅ **Route middleware chain enforced** [P1] — `authenticate → authorize('store_admin', 'super_admin') → requireStoreAccess → handler` pattern documented in CLAUDE.md and visible in all admin routes. `store-access.ts`

- ✅ **`customerUserId()` role guard** [P0] — Prevents `store_admin` auth cookies from being interpreted as customer identity on cart/wishlist/review routes. Critical for a cross-origin shared-cookie architecture. `auth.ts:128-130`

- ✅ **`requireStoreAccess` ownership check** [P1] — DB-level ownership lookup; `store.ownerId !== user.userId` → 403 + audit log. Super-admin writes additionally logged. `store-access.ts:82-98`

- ✅ **Tenant context via `runInTenantContext` + RLS** [P0] — AsyncLocalStorage wraps every store-scoped request in a Postgres interactive transaction with `SET LOCAL app.current_store_id`. 52 tables have `ENABLE ROW LEVEL SECURITY`. `tenant-context.ts:55-87`; migrations at `packages/database/prisma/migrations/`.

- ✅ **RBAC permission matrix defined** [P2] — Granular `Permission` type with `hasPermission()` / `requirePermission()` per-route middleware. Roles: `customer`, `store_admin`, `super_admin`. `rbac.ts`

- ✅ **Cross-tenant access prevention** [P1] — `requireStoreAccess` resolves the storeId from route params (not request body), uses an unambiguous `storeId || id` precedence rule with code comments explaining the nested-router pitfall. `store-access.ts:27-28`

- ⚠️ **Super-admin read access not audit-logged** [P3] — Only writes (`POST/PUT/PATCH/DELETE`) by super_admin are logged; reads are explicitly skipped to reduce noise (`store-access.ts:56-57`). For a compliance scenario, cross-tenant reads by operators are typically required in audit logs. Remediation: at minimum log sensitive read endpoints (order details, customer PII) by super_admin.

---

#### 1.3 OWASP Top 10 surface

**A01 – Broken Access Control**

- ✅ StoreId gates on every admin route via `requireStoreAccess`. `store-access.ts`
- ✅ Blog routes gate on `store.blogEnabled` column.
- ⚠️ **Super-admin escalation path undocumented** [P3] — No dedicated endpoint to grant/revoke `super_admin` role was surfaced in the audit. Confirm super_admin assignment is done only via DB migration or a guarded internal admin route.

**A02 – Cryptographic Failures**

- ✅ Bcrypt cost-12 for passwords.
- ✅ Refresh tokens stored as SHA-256 hash, not plaintext.
- ⚠️ **`sslmode` not enforced in `.env.example`** [P2] — `apps/api/.env.example` `DATABASE_URL` does not include `sslmode=verify-full`. Per the global memory note (`feedback-pg-sslmode-verify-full.md`), pg v9 demotes `sslmode=require` to weaker TLS verification. If production Railway env doesn't have `sslmode=verify-full`, the connection may be susceptible to MITM.

**A03 – Injection**

- ✅ All reviewed Prisma queries use the ORM (parameterized).
- ✅ Raw SQL exists in: `finance.routes.ts`, `customers.routes.ts`, `public.routes.ts`, `analytics.service.ts`, `store.service.ts`, `order.service.ts`, `sequence.service.ts`, and Inngest functions. Spot-checked `sequence.service.ts` — uses `$queryRaw` via Prisma template literal. Full sweep should be validated in CI.
- ✅ Global `sanitizeInput` middleware strips null bytes and invisible Unicode. `security.ts:463-521`
- ✅ CMS HTML renderer has `escapeHtml()` and `safeUrl()`. `pages.service.ts:59-80`

**A04 – Insecure Design**

- ✅ Paid-plan gating via `feature-gate.ts` middleware.
- ✅ Blog route gates on `blogEnabled` Store column (double gate: feature flag + plan).

**A05 – Security Misconfiguration**

- ✅ CORS allowlist: platform origins hardcoded in `cors-cache.ts`; custom merchant domains resolved from DB with TTL-cached lookup. HTTP origins and non-HTTPS custom domains rejected. `index.ts:138-185`
- ✅ Helmet + duplicate `securityHeaders` middleware (HSTS, X-Frame-Options: DENY, Permissions-Policy 27-feature lockdown, CSP `default-src 'none'` for API, nosniff). `security.ts:527-604`
- ✅ `X-Powered-By` and `Server` headers removed.

**A07 – Identification and Auth Failures** — Covered in §1.1.

**A08 – Software and Data Integrity**

- ✅ Payment webhook HMAC: `webhook.routes.ts` reads `x-tap-signature` / `x-myfatoorah-signature` / `x-hesabe-signature` and passes raw body for HMAC verification. Webhook routes skip CSRF (correct, since they use HMAC). `webhook.routes.ts:23-25`
- ✅ Vercel spend-webhook: HMAC-SHA1 over raw body, verified at `webhook.routes.ts:643-646`.
- ✅ Alert webhooks boot-warn loudly when `ALERTS_WEBHOOK_TOKEN` is unset in production. `alert-webhooks.routes.ts:14-18`

**A09 – Security Logging / Monitoring**

- ✅ Sentry initialized at API boot with sampling for production. `sentry.service.ts:27-43`
- ✅ Pino structured logging with `redact` list covering `authorization`, `cookie`, `x-csrf-token`, `password*`, `token*`, `cardNumber`, `cvv`. `logger.ts:39-58`
- ❌ **Sentry errorHandler sends raw `req.headers` on 5xx** [P1] — `sentry.service.ts:59` passes `headers: req.headers` as Sentry `extra`. This leaks `authorization: Bearer <jwt>` and `cookie: token=<jwt>` into Sentry for every 500 error. The pino redact list does NOT protect this path. Remediation: strip auth/cookie headers before passing to Sentry.

**A10 – SSRF**

- ✅ WBS bridge URL is a hardcoded env var (`WBS_BASE_URL`), not user-controlled.
- ✅ Vercel domain provisioning calls fixed Vercel API endpoints with server-side API token.
- ✅ Outbound fetch in carriers (icarry, aramex) use hardcoded carrier API base URLs.
- No user-controlled URL fetching path surfaced. Low SSRF risk.

---

#### 1.4 Headers + CSRF

- ✅ **CSRF protection** [P1] — `csrfProtection` middleware with correct skip logic: GET/HEAD/OPTIONS, `/webhooks/`, `/auth/`, `/public/`. Bearer requests exempt. `security.ts:86-119`
- ✅ **Custom-domain CSRF gate** [P1] — JSON+XHR requests from platform origins bypass token check; custom merchant domains must present a CSRF token. `security.ts:140-154`
- ✅ **HSTS** [P1] — 1-year max-age, includeSubDomains, preload-ready. Production-only guard.
- ✅ **CSP on API** [P1] — `default-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`.
- ✅ **X-Frame-Options: DENY** [P2] — set globally.
- ⚠️ **Helmet CSP for API has `'unsafe-inline'` on styleSrc** [P3] — `index.ts:112` sets `styleSrc: ["'self'", "'unsafe-inline'"]`. API is JSON-only; directive is irrelevant.

---

#### 1.5 Secrets management

- ✅ **gitleaks CI workflow** [P1] — Full-history scan on every push to main and every PR. Binary-pinned at v8.21.2. `.github/workflows/gitleaks.yml`
- ✅ **TruffleHog in CI** [P1] — `ci.yml` security job runs `trufflesecurity/trufflehog@main --only-verified` after `npm audit`.
- ✅ **secretlint pre-commit via lint-staged** [P1] — `package.json:86-88`.
- ✅ **Required secrets assert on missing** [P1] — `config/index.ts` uses `getRequiredSecret()` for `DATABASE_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`.
- ✅ **Optional secrets with graceful degrade** [P2] — Redis, OneSignal, Sentry, VAPID, Gemini all fail-open with logged warnings.
- ⚠️ **`audit:high` script uses `--audit-level=high`** [P2] — `package.json:60` defines `"audit:high": "npm audit --audit-level=high"`. CI security job correctly uses `--audit-level=low`. Script misleadingly named.

---

#### 1.6 PII handling

- ✅ **Pino redact list** [P1] — 17 paths redacted covering auth, cookies, passwords, tokens, card numbers, CVV.
- ✅ **Request logger logs only userId + storeId** [P2] — No email/phone/address in structured request logs.
- ✅ **Audit log uses userId references** [P2] — Action/userId/resourceType/resourceId — not raw PII.
- ❌ **Sentry sends `email` in user context for every authenticated request** [P2] — `sentry.service.ts:155` sets `SentryService.setUser({ id, email: req.user.email, role })`. Customer emails land in Sentry per 500 error.
- ❌ **Sentry `extra.headers` on 5xx** [P1] — Already cited in A09.

---

#### 1.7 GDPR / Kuwait Law 13/2023 compliance

- ✅ **`/auth/me/erase` endpoint** [P0] — Irreversible anonymisation: email → `erased-{uuid}@anonymized.local`, password hash → random bytes, name/phone/avatar/DOB nulled, addresses deleted, carts/wishlists/push subs deleted, orders de-linked but preserved for tax records. `auth.service.ts:792-868`
- ✅ **`/auth/me/export` endpoint** [P0] — Art. 20 portability endpoint exists. `auth.routes.ts:385`
- ✅ **Cookie consent gate** [P0] — `ConsentContext.tsx` + `CookieConsentBanner` with server-side cookie read. `MarketingPixelsProvider` only rendered when `consent.marketing === true`, read server-side from `force-cookie-consent` cookie.
- ✅ **Erase endpoint requires authentication** [P1] — `authenticate` middleware on `/me/erase`.
- ⚠️ **Admin accounts not erasable via self-service** [P2] — `auth.service.ts:804-805` explicitly blocks non-customer roles from self-erasure. "Manual super_admin offboarding path" referenced but no code path was found.

---

#### 1.8 Marketing pixels gating

- ✅ **Consent state read server-side** [P0] — `layout.tsx:366` reads `force-cookie-consent` cookie in the Next.js Server Component; `MarketingPixelsProvider` is conditionally rendered only with consent. Pixels never reach the browser unless consent exists.
- ✅ **ConsentProvider persists across navigations** [P2] — Server-side cookie ensures the gate persists across Next.js route transitions.
- ✅ **PostHog consent-gated** [P2] — PostHog init is gated on marketing consent.

---

#### 1.9 Anti-fake-reviews policy

- ✅ **No AI review generation** [P0] — `review.routes.ts` AI endpoints at lines 333-370 are `draftOwnerResponse()` (merchant response drafting) and `summarizeProductReviews()` (summary for merchant dashboard). Neither creates or seeds reviews. Reviews are customer-submitted only via `ReviewService.create()` with `canReview()` gate (purchase-required check).
- ✅ **Review approval gate** [P2] — Admin must `approve`/`reject` reviews before public. `review.routes.ts:257-296`

---

#### 1.10 Security gates in CI

- ✅ **CI `npm audit --audit-level=low`** [P1] — Zero-vulns policy enforced at every severity in the `security` job.
- ✅ **gitleaks** [P1] — Separate workflow, full-history scan, binary-pinned.
- ✅ **TruffleHog** [P1] — Second secret scanner in the CI security job.
- ✅ **Preview env isolation gate** [P1] — Weekly scheduled check + PR gate verifies `NEXT_PUBLIC_API_URL` differs between Preview and Production Vercel scopes.
- ✅ **Neon snapshot workflow** [P2] — Per-commit Neon branch `prod-<sha>` for DB rollback.
- ⚠️ **`audit:high` script name is a trap** [P3] — Not used in CI but devs running it locally will silently miss moderate/low CVEs.

---

### Compliance posture summary

| Rule                                       | Status    | Evidence                                                                  |
| ------------------------------------------ | --------- | ------------------------------------------------------------------------- |
| GDPR Art. 17 (erasure)                     | ✅        | `auth.service.ts:792` — irreversible anonymisation in `$transaction`      |
| GDPR Art. 20 (portability)                 | ✅        | `auth.routes.ts:385` — `/auth/me/export` endpoint                         |
| Kuwait Law 13/2023 (erasure)               | ✅        | Same endpoint, same implementation                                        |
| Admin account erasure path                 | ⚠️        | Customer-only; no documented admin offboarding                            |
| Cookie/tracking consent (CLAUDE.md rule 5) | ✅        | Server-side consent gate in `layout.tsx` before `MarketingPixelsProvider` |
| GDPR Art. 6(a) prior consent for pixels    | ✅        | ConsentContext + server-render gating                                     |
| Audit log coverage                         | ✅        | `security.ts:412-435`, `store-access.ts:56-96`                            |
| PII in logs                                | ✅ w/ gap | Pino redacted; Sentry sends email + headers — see P1/P2 findings          |
| sslmode=verify-full                        | ⚠️        | Not enforced in `.env.example`; confirm Railway prod env                  |
| Zero-vulns CI gate                         | ✅        | `ci.yml` security job: `npm audit --audit-level=low`                      |
| Secret scanning CI                         | ✅        | gitleaks + trufflehog both active                                         |
| Pre-commit secret scanning                 | ✅        | secretlint via husky lint-staged                                          |
| Alert webhook token (CLAUDE.md rule 12)    | ✅        | Boot-time prod warning when unset                                         |
| Preview env isolation (CLAUDE.md rule 13)  | ✅        | Dedicated workflow with weekly schedule                                   |

---

### Top 5 P0/P1 security risks

1. **Sentry sends raw Authorization + Cookie headers on 5xx** [P1]
   What: `sentry.service.ts:59` passes `headers: req.headers` as Sentry `extra` on every 5xx error. `Authorization: Bearer <jwt>` and `cookie: token=<jwt>` are included verbatim.
   Exploit: Sentry is a third-party SaaS; if a Sentry account is compromised or an internal member has read access to Sentry issues, live JWTs are exposed. A JWT valid for 30 days (current default) gives a window.
   Remediation: destructure headers before passing — exclude `authorization` and `cookie` keys. One-line fix:

   ```ts
   const { authorization, cookie, ...safeHeaders } = req.headers;
   ```

2. **Sentry sets user email context on every authenticated request** [P2]
   What: `sentry.service.ts:155` calls `SentryService.setUser({ id, email: req.user.email })` for every authenticated request. Every Sentry issue captures the email of the authenticated user who triggered the error.
   Exploit: GDPR/Kuwait Law violation — customer emails are transmitted to a US SaaS without explicit consent for error-tracking. Also surfaces email enumeration if Sentry issues are shared externally.
   Remediation: remove `email` from `setUser` call; use `id` only.

3. **Access token TTL default 30 days** [P2]
   What: `config/index.ts:59` default `JWT_EXPIRES_IN = '30d'`. CLAUDE.md documents "7 days" but unset prod env gets 30-day tokens.
   Exploit: stolen JWT (from Sentry leak, XSS, log exposure) is valid for a month with no revocation mechanism for access tokens (only refresh tokens are revocable).
   Remediation: set `JWT_EXPIRES_IN=7d` in Railway production env vars; tighten code default.

4. **`sslmode` not in `.env.example` DATABASE_URL** [P2]
   What: `.env.example` omits `sslmode=verify-full`. Per global memory note, pg v9+ weakens `sslmode=require`. If Railway prod env copies the example template without the sslmode param, TLS verification is degraded.
   Exploit: MITM on the Railway internal network or Neon connection without certificate verification.
   Remediation: add `?sslmode=verify-full` to `.env.example` `DATABASE_URL` and `DIRECT_URL`. Verify the Railway env has it set.

5. **Super-admin read accesses not audit-logged** [P2]
   What: `store-access.ts:56-57` explicitly skips audit logging for `GET` requests by super_admin to reduce noise. This means cross-tenant read access (order details, customer PII) is unlogged.
   Exploit: insider threat scenario — a super_admin can read any store's customer orders/PII with no audit trail.
   Remediation: add a lightweight audit log entry for super_admin cross-tenant GETs on sensitive routes (orders, customers) — at minimum the storeId + path + timestamp. Can be rate-limited to avoid noise: log once per (userId, storeId, hour) tuple.
