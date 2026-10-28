# CSRF-AUTH-1

> Section: 2026-10-02 — SMS consent follow-ups (branch `fix/backlog-followups10`, issues 2423–2426)

**Ruling CSRF-AUTH-1 — `/auth/` is no longer a blanket CSRF exemption; only the credential-less
entry points are exempt, by exact path (issue 2425).** The exemption was
`req.path.includes('/auth/')`, justified as "auth endpoints use JWT tokens (not session cookies)". That
was false for every route behind `authenticate`. A merchant custom domain is CORS-allowlisted, so a
page on it could forge a credentialed `PUT /auth/me/sms-consent` on a visiting shopper's cookie, as the
issue reported. The same held for `PUT /auth/me`, `DELETE /auth/me`, `POST /auth/me/erase`,
`POST /auth/change-password`, `POST /auth/logout-all` and the MFA enroll/disable routes. The fix
narrows the exemption instead of moving one route, which closes the class. `CSRF_EXEMPT_AUTH_PATHS`
holds register, login, refresh, logout, forgot/reset-password, verify-email, resend-verification and
mfa/verify, the same set as the storefront's `NO_REFRESH_AUTH_ROUTES`, and a unit test fails on drift.
Every client already sends `X-Session-ID` + `X-CSRF-Token` through its request helper (web, admin,
orders). A JSON request from a platform origin and a Bearer request still skip by their own rules, and a
CSRF-403 heals through a refresh on the storefront. Evidence:
`tests/unit/csrf-merchant-origin.test.ts` covers 9 forged writes refused, the legitimate token-bearing
write accepted, the exempt paths in three spellings, substring non-matches and the parity check. The
mutant restoring `includes('/auth/')` turned 18 tests red and was restored byte-identical. It is
recorded as `csrf-auth-exemption-credential-less-only`. Not verified live: a custom-domain shopper
changing their profile after deploy. That path has to mint a token at login or refresh, as every
`/stores/*` write there already does. Cost if wrong: if some client calls an authenticated `/auth/`
write from a merchant custom domain without the CSRF headers, that call now 403s CSRF_MISSING_SESSION
instead of succeeding.
