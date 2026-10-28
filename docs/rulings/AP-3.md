# AP-3

> Section: 2026-09-30 — accounting + profit batch (branch `fix/accounting-profit-batch`)

**Ruling AP-3 — `postOrderPaymentJournal` books no sale for an order that is
already `cancelled` or `refunded`.** Evidence: ORD-1778670342233-50212B65
(refunded by status in May, `paymentStatus` left `paid`) had its sale posted on
2026-07-09 by the order-created stuck sweep's fanout, with nothing left to
reverse it. A paid order cancelled later is reversed by the refund path, so
"no sale" is the same end state. Cost if wrong: a paid order whose status is
cancelled but whose money was knowingly kept books no revenue.
