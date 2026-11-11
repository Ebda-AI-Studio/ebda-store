# CORS-TB-2

> Section: Security — credentialed cross-origin tenant binding (issue #622 follow-up, audit ID-05, 2026-11-11)

**Ruling CORS-TB-2: from a store origin, `POST /auth/logout` may end only that store's own
customer session. Anything else is a 403 `ORIGIN_NOT_PERMITTED` with no side effect.**

Logout is CSRF-exempt, reads the ambient `SameSite=None` cookies, and every verified merchant
domain is CORS-credentialed. Before this, a page on merchant A's domain could POST it and log
out a lured store-B owner, revoking their identity session suite-wide, or log out another
store's shopper.

`storeOriginMayEndAmbientSession` (`apps/api/src/routes/auth.routes.ts`) checks every ambient
credential that verifies: the Bearer or cookie access token, and the refresh cookie. The
signature is checked; expiry is ignored, so an expired session can still log out. Each one
must be a customer token bound to the origin's store, using the same
`customerTokenMatchesRequestStore` as reads. The request is refused if any ambient credential
is one of these:

- an identity-service (ES256) token;
- a token with a non-customer role, including impersonation;
- another store's customer token.

A credential that does not verify is nobody's session, so it is still cleared (the #1531
dead-cookie heal). The body refresh token is not ambient: it is caller-supplied and only
revokes what the caller already holds. Platform origins and Origin-less callers are
unchanged.

Tests: `tests/unit/logout-store-origin-binding.test.ts`. Removing the guard turns 4 cases red.

**Cost if wrong:** a store-origin logout that holds another store's or a merchant's cookie
gets a 403 instead of clearing it. The storefront shows a customer as signed in only for that
store's own token, so a customer's logout button never sends such a cookie.
