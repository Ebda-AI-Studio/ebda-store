# API-HANG-2

> Section: 2026-11-10 — API hangs on cache misses (branch `fix/api-hangs-do-chain`), limiter fail mode on an AuthState timeout.

**Ruling API-HANG-2 — when AuthState does not answer a rate-limit call within `AUTH_STATE_TIMEOUT_MS`, only the anonymous
public READ limiters fail OPEN; every other limiter fails CLOSED.** Fail open (`RL_FAIL_OPEN_PREFIXES`,
`apps/api/src/cf/rate-limit-store.ts`): `rl:public:`, `rl:public-tenant:`, `rl:public-search:`, `rl:store-resolve:`,
`rl:store-miss:`, `rl:view-ingest:` — the timeout reaches express-rate-limit as a store error and `passOnStoreError` serves the
request (store-miss's own handler catches it). Fail closed (everything else, including any limiter added later): `auth`,
`auth-ip`, `auth-ip-fail`, `auth-email-any`, `refresh`, `refresh-ip`, `reset-email`, `verify-email`, `passkey-*`,
`merchant-signup-ip`, `global`, `write`, `payment`, `cart`, `coupon-*`, `promotion-preview`, `upload*`, `newsletter`,
`wa-consent-*`, `mmcp*`, `admin-search`, `catalog-import-store`, contact-enquiry limiters — the store answers
`totalHits = Number.MAX_SAFE_INTEGER` for the rest of the window, so the limiter's OWN handler sends its normal 429 body, with
`Retry-After` wherever the limiter sets standard/legacy headers. Before API-HANG-1 a stuck instance hung these requests (an
effective deny); now they get that deny in 2.5 s. Non-timeout store errors keep each limiter's existing `passOnStoreError`
policy. Tests: `tests/unit/api-hang-limiter-fail-mode.test.ts` (one case per class through express-rate-limit + the pinned list;
fails when the fail-closed branch is removed), `workers-test/api-hang-concurrency.test.ts` (stuck limiter instance: sign-in
429 + Retry-After, store resolve 200). Cost if wrong: a slow-but-healthy AuthState (> 2.5 s) turns a legitimate sign-in, write
or payment into a 429 for one window instead of a slow success.
