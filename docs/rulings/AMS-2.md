# AMS-2

> Section: 2026-10-01 — backlog batch a-money-services (branch `fix/backlog-a-money-services`)

**Ruling AMS-2 — no `@@unique` on `payments.transaction_id` / `invoice_id` in
this batch; ambiguity is refused in code instead (issue 769).** A unique index
would fail the deploy's `migrate deploy` if production already holds a
duplicate, and this lane may not read production. `handleWebhook` and
`PaymentService.refund` now read up to two rows and refuse more than one
(409 `AMBIGUOUS_PAYMENT`, logged with both payment ids) rather than binding an
arbitrary — possibly another tenant's — row. The constraint can ship after a
read-only check returns zero rows for
`SELECT transaction_id FROM payments WHERE transaction_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1`
(and the same for `invoice_id`). Cost if wrong: a genuine collision now stops
that payment's webhook/refund for a human instead of processing it. _Amended
(PR 2279 audit P1):_ on the webhook path that human is actually paged —
`handleWebhook` sends a P0 (`payment.webhook.ambiguous_payment`, provider +
transaction/invoice ids + every matching payment id in the context) before
refusing, and `isTerminalWebhookClientError` exempts `AMBIGUOUS_PAYMENT` from
the silent `rejected` lane, so the inbox row retries, lands `failed`, and
dead-letters into alerts-failure-watch's P0 like any other stuck money event.
