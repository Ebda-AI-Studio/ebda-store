# HSTS-ALL-1

> Section: 2026-10-29 - Close sweep 2 (N10, `fix/hsts-accounts-status`)

Ruling HSTS-ALL-1 - every Ebda host sends `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`, one constant (`HSTS_VALUE`, `@ebda/shared` studio-pages) shared by the studio pages, `apps/accounts` (all responses, in the app middleware) and `apps/status` (its `SECURITY_HEADERS`, so every route). Measured 2026-10-29 (master M-131): `accounts.ebda.app` login 302 and `status.ebda.app` 200 carried no HSTS while api, store and orders did. Tests: `apps/accounts/test/hardening.test.ts` and `apps/status/test/status.test.ts` assert the exact value on health, login, JSON, assets, 404 (JSON and HTML); the status test was seen red against the old source. Cost if wrong: `preload` plus `includeSubDomains` is sticky in browsers for a year, so a future plain-HTTP subdomain would be unreachable (the same policy is already on every other host).
