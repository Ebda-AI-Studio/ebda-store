# AP-5d

> Section: 2026-10-01 — owner decisions #2277 + #1370 (branch `fix/owner-decisions-2277-1370`)

**Ruling AP-5d — the other two backorder stock paths, fixed in the same PR (issue 2299, coordinator
direction 2026-10-01).** (1) PO receive FIFO-clears a backorder line without adding the received units
to on-hand (they go to the customer), so a NON-variant debt from a FULFILLED backorder never healed. It
now heals `min(fulfilled units, −inventory)` per cleared line with the AP-5c rule and helper
(`healBackorderStockDebt`, `accounting/backorder-stock-heal.ts`; `return_stock` row referenced
`po-backorder:<lineId>`); the rest of the receipt goes on the shelf as before. No marker is written for
a PO heal and the whole-order restore does not subtract it: after a PO fulfils the line, a cancel's
restore is units coming back from the customer, which are real. (2) A whole-order cancel of a VARIANT
backorder restored the full line quantity onto a row checkout only floored to 0 (2 on hand, 5 ordered
→ 0 → cancel → 5). New nullable column `backorder_lines.stock_taken` (migration
`20261001120000_backorder_line_stock_taken`) records what checkout actually took — full qty for a
non-variant line, `min(qty, on-hand)` for a variant — and the restore subtracts `qty − stock_taken`
per line. `forceDecrementVariantInventory` now reads the real previous stock under the row lock (it
reconstructed it as `newStock + qty`), so the variant sale's ledger row reads 2 → 0, not 5 → 0 (its
`quantity` stays the units sold, −5). NULL `stock_taken` (pre-migration lines) means "fully taken",
the old behaviour, so no existing row changes meaning. Proven in
`tests/integration/accounting/backorder-cancel-stock-heal.test.ts` (4 more tests, 12 total); 5
mutations (no PO heal, no never-taken subtraction, `stock_taken` not recorded, reconstructed previous
stock, unbounded heal in the shared helper) each turned a test red. Cost if wrong: with the heal-to-0
rule a PO-fulfilled non-variant backorder, like a cancelled one, does not return the units that were
really on hand when it was backordered — stock can read low by up to that amount, never high; and a
pre-migration variant backorder cancelled whole still over-restores, as before.
