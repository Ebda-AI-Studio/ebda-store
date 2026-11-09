# Admin audit closure 2026-11-09, phase 2: api + storefront

- BE:S-11: `requireMfaEnrolled` on staff `DELETE /:userId` and `DELETE /invites/:inviteId`.
- BE:S-29: `GET /public/:storeId/loyalty/my-points` now behind `requireFeature('loyalty')` (checkout treats a failed response as "no points").
- QA P2-8 / D4: storefront `ResendVerification` (POST `/auth/resend-verification`) on check-email (address handed over via sessionStorage from register, else asked) and on login when the API answers `EMAIL_NOT_VERIFIED`. The verification requirement is unchanged.
- BE:F-5 / QA P2-5: lazy idempotent default-category `nameAr` repair on the merchant category list (see `cf/default-category-backfill.md`).
- Rulings: `CLOSURE-S9`, `CLOSURE-S20`, `CLOSURE-E4`.
- Tests: `apps/api/src/routes/__tests__/closure-gates.test.ts`, `apps/api/src/lib/__tests__/default-category-backfill.test.ts`, `apps/web/src/components/ResendVerification.test.tsx`.
- QA P2-8 / D4 (API half): storefront customer login (`CustomerAuthFlows.login`) now answers 403 `EMAIL_NOT_VERIFIED` after a correct password for an unverified account, so the login-page resend button is live. Wrong password / unknown email still gets the identical 401 `INVALID_CREDENTIALS` (no oracle); lockout counters behave as before (a correct password resets them). Test: `apps/api/src/services/__tests__/customer-auth-flows.login-unverified.test.ts`, `apps/web/src/app/auth/login/LoginClient.unverified.test.tsx`.
- BE:F-9: `scripts/api-route-inventory.mjs` statically lists every Express route (method, mounted path, auth chain, `requireFeature`, `requirePermission`, heuristic admin/web caller) into `docs/api/route-inventory.md`; `--check` exits 1 when the doc is stale (not wired into CI).
