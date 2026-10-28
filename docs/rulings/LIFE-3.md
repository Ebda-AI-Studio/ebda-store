# LIFE-3

> Section: Lifecycle emails and referral attribution (2026-10-22, branch `feat/lifecycle-emails`)

- Ruling LIFE-3 - idempotency is the `store_lifecycle_emails` row (UNIQUE store + kind), inserted BEFORE the send; only the inserter sends. The same row is the merchant's log (`/stores/[id]/lifecycle-emails`): `sent`, `skipped` with the reason (the step was already done, opted out, store inactive), or `failed` when the enqueue threw (never left looking sent). A skip is recorded too, so a step that was done on day 3 is not re-judged on day 5. A test order placed by the owner's own email does not count as "the first order" and records nothing, so the next real order still gets the referral ask. Cost if wrong: a crash between the insert and the enqueue loses that one email (it shows `sent`); preferred over a duplicate.
