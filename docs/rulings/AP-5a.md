# AP-5a

> Section: 2026-09-30 — accounting + profit batch (branch `fix/accounting-profit-batch`)

**Ruling AP-5a — the backorder cancel marker counts as a PRIOR reversal
everywhere the partial allocation runs.** `loadPriorReversedQty` sums completed
Return rows AND `backorder_line_cancelled` markers for the GL posting,
`ReturnService.allocateThisReturn` and `computeStoreCreditAmount`, and
`ReturnService.create` counts the cancelled units as not returnable. Without it
the cumulative discount/tax allocation stops telescoping (measured: cancelling
all three lines of a 1000-discount / 777-tax order one by one left fils on
revenue, tax and cash) and a later return could re-claim units that never
shipped. `allocateThisReturn`'s `allLinesNowReturned` therefore also treats a cancelled
backorder unit as gone: a return that takes back the rest of such an order is sent to the
provider as NOT item-level, and if it exhausts the payment the whole-order reversal runs —
which backs the line adjustments out, so the GL still nets to zero. Backorder lines cancelled by the refund FANOUT get no marker — their
units are already the Return row's, or the sale was reversed whole. Cost if
wrong: none known; the marker is written only by `cancelBackorder`.
