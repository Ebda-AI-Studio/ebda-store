# CORS-TB-1

> Section: Security — credentialed cross-origin tenant binding (issue #622, 2026-11-11)

**Ruling CORS-TB-1: credentialed cross-origin is same-tenant only. From a store origin, the
API accepts one identity: a customer token issued for that origin's own store. Every other
token is no identity at all.**

## What #622 claimed, and what the code shows

The claim: merchant A verifies `evil.com`, a store-B shopper visits it, and
`fetch('https://api.ebda.app/api/v1/public/orders', {credentials:'include', headers:{'x-store-id': B}})`
returns B's orders and addresses.

- **Cookie:** `token` (and `refresh_token`), HttpOnly, `SameSite=None; Secure` in production,
  no `Domain` attribute, so it is host-only on the API host. It is one cookie per browser, not
  one per store. Signing in to another store overwrites it.
- **Session scope:** a customer token is store-bound. `AuthService.generateTokens` stamps
  `storeId`. `authenticate` and `optionalAuthenticate` call `customerTokenMatchesRequestStore`
  on every customer token (F-01 / Ruling S11-1, in the audited commit `6905e26be`). The request
  Origin must resolve to `token.storeId`.
- **Verdict on the shopper exploit: REFUTED.** `Origin: https://evil.com` resolves to store A,
  and the token says store B, so the request gets a 401, or is treated as a guest on public
  routes. Setting `x-store-id` to B does not help, because the Origin check runs regardless.
  `tests/unit/customer-store-binding.test.ts` pins this, including the custom-domain variant.
- **Real residual: CONFIRMED (code-read; not exploited against production).** The same
  `token` cookie also carries merchant, staff and super_admin identity tokens (ES256, set by
  `POST /auth/session` from the admin app) and HS256 impersonation tokens. None of these is
  origin-bound. `restrictPlatformOnlyOrigins` is a path gate. It denies
  `/admin`, `/payment-settings` and `/stores/**` minus the storefront shapes, and leaves about 20 other
  credentialed mounts readable from any merchant origin with a lured owner's or admin's cookie:
  `/auth/me`, `/realtime/session`, `/uploads`, `/onboarding`, `/mcp/admin`,
  `/provider-activation`, `/staff-invites`, `/me/*` and others. A merchant domain could read
  another tenant's account data through the owner's browser.

## The fix

`nonCustomerTokenAllowedForRequest(req)` in `apps/api/src/lib/customer-store-binding.ts` is
false for any store origin: a slug host, a custom domain, an unknown host, or `Origin: null`.
Both verifiers check it on both token kinds:

- `authenticate` answers 401 `TOKEN_INVALID`, the same answer as a dead token, so it gives no oracle;
- `optionalAuthenticate` treats the request as a guest.

A test pins the four call sites.

This makes a cross-store read impossible by construction. A request from a store origin
runs as a guest, or as that store's own customer, whose routes are already scoped by
ownership. The store origin is merchant-controlled; even a fully verified domain is.

## Why an allow-list on the principal, not on paths

The issue proposed a path allow-list for non-platform origins. The `/stores` deny-list was
already rewritten once, after it missed `shipments`, `coupons` and `/orders/:id/invoice`.
Inverting the whole API into a path allow-list means enumerating ~40 top-level mounts. That
list goes stale with every new router, and the first missed storefront path breaks checkout
on custom domains only.

The principal allow-list has one entry ("this store's customer"), and new routes cannot
invalidate it. The storefront already rejects every role except `customer`
(`apps/web/src/contexts/AuthContext.tsx`), so it loses nothing. `restrictPlatformOnlyOrigins`
stays in place as defence in depth.

**Not done: per-store cookie names.** Session validity is already per store, because the token
is store-bound and origin-bound. Renaming the cookie per store would change only the
multi-store sign-in experience, not security.

**Cost if wrong:** a platform surface that is legitimately served from a store origin and
needs a merchant session, such as a future on-storefront merchant toolbar, gets a 401 and must
move to a platform origin or a scoped token. The admin, orders and builder apps are platform
origins today, and the builder's `/admin/**` calls were already denied to store origins.

## Related, not in scope

- S2 (P2): CSRF skipped for `/public/` paths. With this ruling, a forged `POST /public/orders`
  from another store's origin runs as a guest and can no longer act as the shopper.
- ID-05 (P2): forced logout.
