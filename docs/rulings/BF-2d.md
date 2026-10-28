# BF-2d

> Section: Backlog batch followups (2026-10-01, branch `fix/backlog-followups`)

**Ruling BF-2d — a post-send failure never re-sends; a landed park is a park (issues 2382, 2385).**
SMS: `sendSms` records the provider's `messageId` the moment the send returns; a throw after that
(the `NotificationLog` upsert — the very idempotency row a retry looks for) is logged with the
message id and NOT retried or dead-lettered, because the retry would text the customer and spend
the merchant's credit twice. The pre-write reservation (`status: 'sending'` before dispatch) the
audit also offered was not taken: it needs a new status value every admin reader must learn, for no
gain over the flag on the retry path. Email is OUT of this class: nothing after a successful send
can throw (a log line only), so there is no post-send write to fail; a provider that accepts a
message and then times out is provider-side ambiguity, not this defect. Dead letters:
`parkCorrupt`'s LPUSH alone decides the outcome; LTRIM + EXPIRE are best-effort (logged, re-applied
by the next write). A failed trim used to be read as a failed park, so the entry was also put back
on the live queue — one duplicate per tick, the cap and TTL never applied. Cost if wrong: a
set-aside list whose trim keeps failing can exceed 200 entries / miss its TTL until one write's
trim lands (logged each time); an SMS whose log write failed is missing from the admin log (the
text did go out, the error log carries its message id).
