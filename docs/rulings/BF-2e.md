# BF-2e

> Section: Backlog batch followups (2026-10-01, branch `fix/backlog-followups`)

**Ruling BF-2e — an accepted SMS without a message id is a sent SMS (issue 2389).** BF-2d's class
("a failure raised after the provider took the message") also covered a failure we raised
ourselves: Unifonic answering 2xx with `success: true` (accepted, will be delivered and billed) but
no `data.messageId` made `sendSms` throw, and the queue retried an accepted message up to
`maxAttempts` times. `sendSms` now returns `{ messageId: null }` with a warning, and the queue
writes the `sent` NotificationLog row with `providerMessageId` null (the column was already
nullable; no admin surface renders it). A 2xx whose body cannot be parsed at all stays retryable:
we cannot tell `success: true` from `false`, which is BF-2d's provider-ambiguity carve-out, not
this defect. Pinned by `tests/unit/sms-accepted-without-id.test.ts` (mutation-proven) and a queue
case in `tests/unit/sms-queue-corrupt-set-aside.test.ts`. Cost if wrong: an SMS Unifonic accepted
but later failed to deliver is recorded as sent with no id to trace it by.
