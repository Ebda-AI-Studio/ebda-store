# Adversarial audit — auth-session dimension

Attacker model: unauthenticated → low-priv customer/merchant → trying to become
another user (cross-tenant admin / super_admin / another customer).

Cross-origin shape: API on Railway (`api-production-c058.up.railway.app` /
`api.force-ai.co`), frontends on CF Workers under `*.force-ai.co` +
per-tenant CUSTOM merchant domains resolved at runtime from the DB. Auth cookie
is host-only on the API host, `SameSite=None; Secure`, and CORS runs with
`credentials: true`. That is exactly the surface where the bug below lives.

> **Status note (2026-09-02, #1166):** see the "Remediation status" table in
> `docs/audits/2026-09-02-adversarial-audit.md` for the authoritative per-finding fixed/open state.

---

### [P1] Attacker-controlled merchant custom domains are trusted for CREDENTIALED cross-origin reads AND writes → super_admin CSRF + impersonation-token theft

- **Where:**
  - `apps/api/src/index.ts:214-306` — `cors({ origin: … , credentials: true })`: any hostname present as a `Store.domain` row is allowlisted (`prisma.store.findFirst({ where: { domain: hostname } })`, no status/verification filter).
  - `apps/api/src/middleware/security.ts:143-157` — `csrfProtection` skips the CSRF-token check when `isJsonOrXhr && (isPlatformOrigin(origin) || isAllowlistedMerchantOrigin(origin))`.
  - `apps/api/src/lib/cors-cache.ts:97-118` — `isAllowlistedMerchantOrigin` returns true for any cached merchant domain.
  - `apps/api/src/routes/auth.routes.ts:22-27` — `AUTH_COOKIE_OPTIONS` = `httpOnly, secure, sameSite:'none'`, **no `domain`** → cookie is sent on every cross-site request to the API host.
  - Sink example: `apps/api/src/routes/admin.routes.ts:1704` `POST /admin/impersonate` (super_admin only, but reachable with the victim's cookie).
- **Attack — SUMMARY, reproduction trimmed 2026-09-02 (P0, still open — escalated to P0-3 in `docs/audits/2026-09-02-adversarial-audit.md`; see that report for current fix status):** an attacker who self-registers a merchant store can point its custom domain at a page they control (the CORS lookup accepts any DB-registered domain with no verification-status check), lure a logged-in super_admin there, and have the victim's browser make a credentialed, CSRF-exempt cross-origin call that both executes as the victim AND is readable by the attacker's JS — reaching `POST /admin/impersonate` as one concrete sink. The exact request/response mechanics are recoverable from the fix commit once P0-3 lands (dropping the `isAllowlistedMerchantOrigin` OR from the CSRF skip).
- **Damage:** Full cross-tenant compromise. Even without impersonate: every GET is CSRF-exempt and CORS-readable from `attacker.com`, so the lured victim's entire authorized read surface (all stores, customers, orders, payment settings for a super_admin) is exfiltrated; every non-`/public/` cookie-auth mutation (`/admin/*`, `/stores/:id/*`) is forgeable.
- **Evidence:** `security.ts:151-157`:
  ```ts
  if ( isJsonOrXhr &&
       (isPlatformOrigin(origin, {...}) || isAllowlistedMerchantOrigin(origin)) )
    return next();   // CSRF token NOT required
  ```
  `cors-cache.ts:117` `return true` for any cached merchant host; `index.ts:258-262` populates the cache from `Store.domain` with `allowed = store !== null` (no verification gate). Cookie is `sameSite:'none'` with no `domain` (`auth.routes.ts:20-27`).
- **Why prior audits missed it:** `docs/audits/2026-07-02-security-surface.md:268-276` claims: _"`csrfProtection` correctly scopes its JSON/XHR skip to platform-controlled origins only (not 'any CORS-allowed origin')"_ — **FALSE for the shipped code.** Commit `619c43e7` (2026-05-14, _before_ that audit) added `|| isAllowlistedMerchantOrigin(origin)` to the skip. `docs/audits/2026-08-31-reel-derived-lenses.md` L10 rates CORS **PASS** ("custom merchant domains resolved per-request") without noting that per-request resolution of _attacker-controlled_ domains + `credentials:true` is the vulnerability. `cors-cache.ts:99-107`'s own threat-model note only considered _"a merchant compromises their OWN customers via their own domain"_ — it never considered a super_admin / other-tenant admin being lured to that domain, nor that `/admin/impersonate` is readable cross-origin.
- **Blast radius:** Every cookie-authenticated route that is NOT under `/public/` and not Bearer-only: all of `/api/v1/admin/*`, `/api/v1/stores/*` admin CRUD, `/api/v1/payment-settings/*`, `/auth/logout-all`, `/auth/me/erase`. Same root cause reachable by ANY merchant, not just one.
- **Fix:** Do not treat merchant custom domains as CSRF-exempt. Keep the guest-cart use-case working by requiring the double-submit CSRF token on merchant origins (storefront already receives one at login / can mint a per-session one), OR scope the skip to the specific unauthenticated guest endpoints (cart/checkout) rather than "all non-/public non-Bearer requests". Separately, gate `/admin/*` behind an Origin allowlist that excludes merchant domains regardless of CSRF.

---

### [P2] `optionalAuthenticate` accepts refresh tokens as access tokens and performs ZERO revocation checks

- **Where:** `apps/api/src/middleware/auth.ts:125-146` (`optionalAuthenticate`). Used at `payment.routes.ts:167` (`POST /payments/create`), `public.routes.ts:552` (`POST /public/orders`), `public.routes.ts:636` (`GET /public/orders/:id`), `public.routes.ts:711` (`POST /orders/:id/verify-payment`), `review.routes.ts:51` (`GET /reviews/product/:id`).
- **Attack:** `optionalAuthenticate` calls `jwt.verify(..., audience:'force-app')` and stops. The refresh token is minted with `audience:'force-app'` too (`auth.service.ts:1121-1130`), and this middleware — unlike `authenticate` (`auth.ts:69-73`) — never rejects `type:'refresh'`, never checks the `purpose` claim, never consults the JTI denylist, and never checks `tokenVersion`. So a customer's 1-year refresh token replayed as `Authorization: Bearer <refresh>` is accepted as their identity, and a token that was revoked via logout / logout-all / password-change is still honored on these routes.
- **Damage:** Bounded — every one of these handlers re-checks ownership against `req.user.userId` / `role==='customer'` (`public.routes.ts:576`, `payment.routes.ts:190`), so a stale/refresh identity still only reaches the attacker's OWN orders/reviews. No cross-user access. The defect is that "revoked" is not honored here and a long-lived refresh token grants an access identity, defeating the revocation guarantees the codebase builds elsewhere.
- **Evidence:** `auth.ts:130-140` — the `catch {}` swallows failures and the success path sets `req.user = payload` with none of the four guards that `authenticate` applies.
- **Why prior audits missed it:** `docs/audits/2026-07-02-tenancy-rls-auth.md` / the 2026-05-28 auth-access audit map `authenticate`'s revocation chain (T1-3 refresh-reuse) but never audited `optionalAuthenticate` as a second, weaker verifier.
- **Blast radius:** all 5 `optionalAuthenticate` call sites above; same class as any future "identify-if-present" route.
- **Fix:** In `optionalAuthenticate`, reject `type==='refresh'` / non-`access` `purpose`, and run the same JTI-denylist + tokenVersion checks as `authenticate` (or have it delegate to a shared verifier that only differs in whether a missing token 401s).

---

### [P2] Rate-limit IP bucketing collapses / is spoofable depending on an env var, and the documented API host is the naked Railway origin

- **Where:** `apps/api/src/index.ts:78-90` (`TRUST_PROXY_HOPS`, default 1); `security.ts:265-282` (`authLimiter` keyed on `${ipKeyGenerator(req.ip)}-${email}`).
- **Attack / two failure modes:** The real prod topology is client→Cloudflare→Railway→app (2 hops). (a) If `TRUST_PROXY_HOPS` is left at the default 1, `req.ip` becomes the Cloudflare edge IP for all traffic → every client shares one IP bucket, so the IP+email auth limiter is near-useless as an IP control. (b) If it is set to 2 (as the code's own comment instructs for prod) **while the naked `api-production-c058.up.railway.app` host still accepts direct traffic** — and CLAUDE.md documents that exact hostname as the live API — an attacker hitting Railway directly with a spoofed `X-Forwarded-For` forges `req.ip` and gets a fresh limiter bucket per request.
- **Damage:** Amplifies credential-stuffing / enumeration volume. Per-account brute force is still capped by the email-keyed `accountLockout` (5 attempts, `auth.service.ts:398-430`), so single-account takeover is NOT opened; the exposure is high-volume cross-account stuffing and limiter evasion.
- **Evidence:** `index.ts:74-77` comment explicitly warns raising the hop count while the naked railway host is reachable "is the spoofing hole." The default (1) is safe-but-collapsing; the prod-correct value (2) is spoofable unless Railway is locked to CF-only.
- **Why prior audits missed it:** L18 (`2026-08-31-reel-derived-lenses.md`) rates rate limiting PASS on the existence of `authLimiter`; it did not test the trust-proxy interaction with the reachable Railway origin.
- **Blast radius:** every IP-keyed limiter (`publicLimiter`, `writeLimiter`, `viewIngestLimiter`, global mutation limiter `index.ts:308`).
- **Fix:** Lock the Railway origin to Cloudflare-only ingress (mTLS / CF Access / IP allowlist) and only then set `TRUST_PROXY_HOPS=2`; add a boot assertion that fails closed if the naked origin is publicly reachable.
- **BLIND SPOT:** I cannot read the live `TRUST_PROXY_HOPS` value or whether the railway host rejects direct traffic. Settle with: `curl -sI https://api-production-c058.up.railway.app/health` from off-CF (does it answer?) and `railway variables | grep TRUST_PROXY_HOPS`.

---

### [P3] `/admin/impersonate` issues a full-privilege token with an unused `impersonatedBy` marker

- **Where:** `apps/api/src/routes/admin.routes.ts:1704-1780`.
- **Observation:** The endpoint is correctly gated (super_admin-only via the admin router's `authenticate`+`requireMfaEnrolled`+`requireRole`, `admin.routes.ts:35-42`), refuses deleted users and other super_admins, is 1h-lived, jti/tv-revocable, and audited. But the issued token carries the target's real `role` and the `impersonatedBy` claim is documented as "allows FUTURE guards to detect impersonation" — no guard actually reads it. So an impersonation session is indistinguishable from a real one and can perform destructive self-service acts as the target (`/auth/me/erase`, `/auth/logout-all`, profile/password flows). It is time-limited and scoped, so this is hardening, not an exploit — but it is the amplifier that makes the P1 CSRF a full takeover.
- **Fix:** Have sensitive self-service routes (`/auth/me/erase`, password/email change, `/admin/*` writes) reject tokens bearing `impersonatedBy`, or downgrade impersonation tokens to read-only scopes.

---

## FALSIFIED

- **`2026-07-02-security-surface.md:268` — "CSRF … correctly scopes its JSON/XHR skip to platform-controlled origins only (not 'any CORS-allowed origin')."** FALSE. `security.ts:155` skips CSRF for `isAllowlistedMerchantOrigin(origin)` too, added in `619c43e7` (2026-05-14). See P1.
- **`2026-08-31-reel-derived-lenses.md` L10 — CORS PASS ("no wildcard; platform allowlist; custom domains resolved per-request").** Technically no wildcard, but the per-request DB resolution allowlists _attacker-controllable_ domains with `credentials:true`, which is the P1 vulnerability. The PASS verdict misses the credentialed-cross-origin consequence.
- **`2026-08-31-reel-derived-lenses.md` L3 — "every route lacking `authenticate` carries its own gate."** Upheld on inspection (see below) — this one I could NOT break; it stands.

## UPHELD (attacked hardest, could not break)

- **Ungated route files each have a real gate.** Re-verified all 5 (`alert-webhooks` token+timing-safe `alert-webhooks.routes.ts:22-34`; `cart` guest+x-session-id, no cookie identity; `mcp` slug-resolve-404 + fail-closed `agent_checkout` gate + byte-identical 404 `mcp.routes.ts:24-38`; `public-store-layout` public read; `webhook` HMAC `verifyWebhookSignature` / carrier shared-secret fail-closed `webhook.routes.ts:19,840-847`). No NEW ungated route was added since the 2026-08-31 audit — `git log --since=2026-08-30 apps/api/src/routes` shows only the reel-lens/CI/inventory commits, none adding routes. Claim holds.
- **Auth-limiter email-variation bypass is NOT exploitable.** The limiter key uses raw `req.body.email`, so `Attacker@x.com` / `attacker+1@x.com` get separate buckets — but `authScope` (`auth.service.ts:34`) and the Postgres unique index do an EXACT email match, so a varied email never reaches the target account's credential check; it just fails as "no user." Killed this tempting false positive.
- **Password reset / refresh rotation.** `crypto.randomBytes(32)` tokens, stored only as SHA-256 (`reset:<hash>`), 1h expiry, single-use delete, tenant-scoped lookup, anti-enumeration identical responses; refresh rotation has reuse-detection with family revocation (`auth.service.ts:530-560`). Access token also correctly rejects `type:'refresh'` and non-access `purpose` in the real `authenticate` path. Could not break these.
- **Staff invite privilege escalation.** `staff.routes.ts` invite is `authorize('store_admin','super_admin')`+`requireStoreAccess`+`requireFeature('staff_accounts')`, creates users with a hardcoded `role: UserRole.staff` in the `storeId:null` namespace and rejects reusing customer/super_admin emails — no path to mint a role above the inviter's grant.

## BLIND SPOTS

- Live `TRUST_PROXY_HOPS` value and whether the naked Railway origin rejects direct traffic (P2) — needs the two commands listed there.
- Whether setting a custom store domain requires provider DNS verification _before_ the row exists (P1). Even if it does, the attacker controls `attacker.com` and can pass it; and the CORS lookup at `index.ts:258` has no verification-status filter. Settle by reading `PUT /stores/:id/domain` full handler (`store.routes.ts:1124+`) for a `status` gate on the `Store.domain` write — I confirmed the CORS read side is unfiltered; the write side gating only changes attacker effort, not feasibility.
- Runtime CORS behaviour (does the preflight actually echo `attacker.com` with `Allow-Credentials: true`?) — settle with a `curl -H 'Origin: https://<a-configured-merchant-domain>' -I https://api.force-ai.co/api/v1/health` and an OPTIONS preflight against `/api/v1/admin/impersonate`.
