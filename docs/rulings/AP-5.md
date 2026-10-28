# AP-5

> Section: 2026-09-30 — accounting + profit batch (branch `fix/accounting-profit-batch`)

**Ruling AP-5 — backorder line cancel still fires a WHOLE-order `order/refunded`
(not changed here).** `cancelBackorder` passes `restoreInventory: false` but no
`partial`, so the GL poster reverses the entire sale of a still-live order. It is
not the cause of either production row (0 backorder lines in prod) and the right
ledger shape for a single cancelled line (a pro-rata adjustment via
`postPartialReturnJournal`?) is a semantics decision. Needs the owner. Cost if
wrong: the first merchant to cancel a backorder line on a paid order gets the
whole sale reversed in the ledger.

**RESOLVED 2026-09-30 (branch `fix/backorder-line-cancel-ledger`) — owner decision
(Ahmad): cancelling ONE backorder line reverses only THAT line's amount.**
`cancelBackorder` now fires the item-level event (`partial`, refundKey
`backorder:<lineId>`, units = `qty − qtyFulfilled`), so the GL posts through the
partial-return path: that line's revenue net of its discount share, its VAT
share, its COGS — with the partial-return allocation, not a new one. Whole-order
cancel/refund is unchanged and backs these adjustments out. Idempotency follows
returns: the cancel is claimed by a conditional update in the same `withMoneyTx`
that writes a `backorder_line_cancelled` orderEvent (the backorder twin of a
completed Return row); the GL keys on `${orderId}:partial:backorder:<lineId>`, and
the event is sent after commit (`deferAfterTenantCommit`). Proven in
`tests/integration/accounting/backorder-line-cancel-ledger.test.ts` (7 tests, 5
mutations each turned a test red).
