# AP-2

> Section: 2026-09-30 — accounting + profit batch (branch `fix/accounting-profit-batch`)

**Ruling AP-2 — `order/refunded` is sent after the request transaction commits
(`deferAfterTenantCommit`).** Evidence: wady-aljuz ORD-1781512189610-9972A710 —
a delivered→refunded change rolled back (30 s request-tx timeout, 2026-07-09)
while its reversal had committed and the event had been sent; the GL reversed a
refund that never happened. Outside a request the send stays inline and a failed
enqueue still throws. Accepted residual: inside a request, a post-commit enqueue
failure can no longer roll the request back — it is alerted by
`deferAfterTenantCommit`, and a WHOLE-order reversal is re-sent by
refund-reversal-stuck-sweep (its `refundReversalRequestedAt` stamp commits with
the request). A PARTIAL-return event has no sweep. Cost if wrong: a partial
return whose post-commit enqueue fails keeps its returned lines' stock and GL
unadjusted until someone replays it from the alert. _Residual closed
2026-10-01 (issues 2246 / 2267):_ `applyRefundEffects` now stamps
`Return.reversalRequestedAt` in the completing transaction, the fanout's
partial arm stamps `reversalAppliedAt`, and refund-reversal-stuck-sweep
re-sends the item-level event (notify:false) for a return requested but not
applied (`handlePartialReturnReversalSweep`; migration
`20261001090000_return_partial_reversal_stamps`). No 12h recency floor on this
branch: the column is new, so there is no back-catalog, and a floor would
abandon a return armed before a long Inngest outage. A request that rolls back
after a gateway refund is still the refund-key path (REFUND_ALREADY_ISSUED →
record-only completion), not this sweep.
