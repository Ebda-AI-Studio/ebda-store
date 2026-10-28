# BFP-4

> Section: 2026-09-25 — buy-flow parity harness (`scripts/buy-flow-parity/`)

**Ruling BFP-4: the admin "refund via provider" 30-second self-lock is reported,
not fixed, in the harness PR.** On base 96814545 and on main b1b5bbd1 alike,
`POST /stores/:id/orders/:id/refund-via-provider` for a paid MyFatoorah order
waits 30s and returns 502 `REFUND_FAILED` (Transaction already closed). Two
things lock each other. `PaymentService.refund` takes its claim `updateMany` in
the request transaction, and then its `prisma.$transaction([...])` batch, which
is not proxied to the tenant transaction (packages/database/src/index.ts), waits
on that row lock on a second connection until the request transaction times out.
MakeRefund has already been sent to the gateway by then. The result is order +
payment `refunded`, `payments.refunded_amount = 0`, and no `order/refunded`
event, so stock is not returned. Unit tests mock Prisma, so no test drives this
over HTTP. It is identical on both refs, so it is not a parity difference. It
belongs in its own fix PR. Cost if wrong: merchants who refund from the admin
see an error for a refund that did go through, and the stock is not restored.
