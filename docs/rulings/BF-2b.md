# BF-2b

> Section: Backlog batch followups (2026-10-01, branch `fix/backlog-followups`)

**Ruling BF-2b — one shape predicate per queue, shared by reader, replayer and processor (issues
2371, 2374).** `isQueuedEmail` / `isQueuedSms` check every field the sender and the list route
dereference. The replayer used to accept any SMS object (`{}` was re-queued, then destroyed by a
Prisma validation error on `idempotencyKey: undefined`), and the email reader accepted anything
`JSON.parse` returned (an entry without `options` TypeErrored the list mapper and 500ed the whole
endpoint, which the page then showed as "No failed emails"). Now a shapeless dead letter is skipped
by the reader (still counted in `stats.failed`, so the page says "unreadable") and set aside by
"Retry all"; a shapeless entry on the LIVE queue is set aside by the processor instead of being
destroyed; the SMS idempotency lookup moved inside the send `try`, so a DB blip retries and
dead-letters rather than dropping. The list mapper also optional-chains as a second net. Cost if
wrong: an entry the predicate wrongly rejects (a legitimate future field shape) is parked in
`*:failed:corrupt` for 30 days instead of sent — visible on the page and alerted on replay, not lost
(issue 2378: only while Redis accepts the park — see Ruling BF-2c for when it does not).
