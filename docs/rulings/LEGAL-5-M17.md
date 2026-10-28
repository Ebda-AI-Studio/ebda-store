# LEGAL-5-M17

> Section: 2026-10-07 — Legal pages v1.0 (branch `docs/legal-pages`)

Ruling LEGAL-5-M17 — no Resend idempotency key on legal notices. At-most-once comes from the `queued -> sending` claim; the Resend SDK in use (`resend@4.8.0`, `node_modules/resend/dist`) has no internal retry, so there is no transport-level duplicate for a key to absorb, and a key reused by **Retry failed** inside Resend's 24 h window could return a cached failure. Evidence: grep of the SDK dist finds no retry logic; claim tests in `tests/unit/legal-notice-send-job.test.ts` and `tests/integration/legal-notice-fanout.test.ts`. Cost if wrong: a merchant receives the same legal notice twice if a future SDK retries internally.
