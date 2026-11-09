# Admin audit closure 2026-11-09, phase 2: api + storefront

- BE:S-11: `requireMfaEnrolled` on staff `DELETE /:userId` and `DELETE /invites/:inviteId`.
- BE:S-29: `GET /public/:storeId/loyalty/my-points` now behind `requireFeature('loyalty')` (checkout treats a failed response as "no points").
- QA P2-8 / D4: storefront `ResendVerification` (POST `/auth/resend-verification`) on check-email (address handed over via sessionStorage from register, else asked) and on login when the API answers `EMAIL_NOT_VERIFIED`. The verification requirement is unchanged; the API login does not currently return that code, so the login path is dormant until it does.
- BE:F-5 / QA P2-5: lazy idempotent default-category `nameAr` repair on the merchant category list (see `cf/default-category-backfill.md`).
- Rulings: `CLOSURE-S9`, `CLOSURE-F2F3`, `CLOSURE-S20`, `CLOSURE-E4`. BE:F-9 (info endpoint inventory) skipped, report-only.
- Tests: `apps/api/src/routes/__tests__/closure-gates.test.ts`, `apps/api/src/lib/__tests__/default-category-backfill.test.ts`, `apps/web/src/components/ResendVerification.test.tsx`.
