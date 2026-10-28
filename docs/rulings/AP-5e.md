# AP-5e

> Section: 2026-10-01 — owner decisions #2277 + #1370 (branch `fix/owner-decisions-2277-1370`)

**Ruling AP-5e — the two backorder surfaces AP-5c/AP-5d did not reach (issues 2302, 2316, backlog
batch x-api).** (1) AP-5d stated that after a PO fulfils a line "a cancel's restore is units coming
back from the customer, which are real", but the whole-order restore subtracted `qty − stock_taken`
unconditionally, so a PO-fulfilled variant backorder cancelled whole restored 2 of 5 real units. It now
subtracts `qty − stock_taken − qty_fulfilled` (floored at 0), which is what AP-5d said. (2) A PARTIAL
return's `cancel-backorders` step released the returned item's open backorder lines with a bare
`updateMany`, so a non-variant product kept the released units' negative debt for ever — the AP-5c
defect on a surface AP-5c did not name. The step now claims each released line, heals it with the
AP-5c rule and helper in the same `withMoneyTx`, and records `stockRestored` on a new
`backorder_release_healed` orderEvent that the whole-order restore subtracts. It is deliberately not
the `backorder_line_cancelled` marker, which `loadPriorReversedQty` counts for the GL: a fanout release
is already the Return row's quantity there. Proven in
`tests/integration/accounting/backorder-cancel-stock-heal.test.ts` (3 more tests, 15 total); reverting
`order-refunded.ts` turns all three red. Cost if wrong: same as AP-5c — the units really on hand when
the line was backordered are not returned by the release, so stock can read low by up to that amount,
never high.
