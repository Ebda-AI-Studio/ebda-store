# AP-5c

> Section: 2026-10-01 — owner decisions #2277 + #1370 (branch `fix/owner-decisions-2277-1370`)

**Ruling AP-5c — cancelling a backorder line heals its stock debt up to 0, never above (owner
decision, Ahmad 2026-10-01, #2277).** Settles the question BS-8(c) left open. AP-5 left `restoreInventory: false` on the grounds that no stock
was reserved for a backordered unit. That is true for variant lines only: checkout FORCE-decrements a
NON-variant product unfloored, so the shortfall sits on `products.inventory` as a negative debt that no
cancel ever cleared — the product read out of stock and stayed on reorder reports for units that will
never ship, while the GL adjustment debited Inventory 1200 for them. Of the three options put to the
owner (restore all the units / restore only the negative part / leave it), the decision was the middle
one. `cancelBackorder` now restores `min(qty − qtyFulfilled, −inventory)` inside the same `withMoneyTx`
and under the same `cancelledAt: null` claim, so it happens exactly once per line; writes a
`return_stock` InventoryHistory row (`reference` = `backorder:<lineId>`, NOT the orderId, which the
whole-order restore reads as "already restored"; `createdBy` = the cancelling user); records the healed
units as `stockRestored` on the existing `backorder_line_cancelled` marker; and busts the storefront
product caches after the write. A product that is not negative, or does not track inventory, gets
nothing — a line that left no debt cannot add phantom units. The whole-order inventory restore
(`order-refunded` `restore-inventory`) subtracts `stockRestored` per item, or a later full cancel would
put the healed units back a second time (measured: 2 on hand, 5 backordered → −3 → line cancel → 0 →
full cancel → 2, not 5). **Variant path checked: no heal.** Checkout floors variant rows at 0
(`forceDecrementVariantInventory`), so a variant backorder never drives stock negative and has no debt
of its own to heal; the heal returns 0 for a variant line rather than touch a row checkout never pushed
below zero. Proven in `tests/integration/accounting/backorder-cancel-stock-heal.test.ts` (8 tests,
through the real checkout); 5 mutations (no heal, unbounded heal, no track-inventory guard, no
whole-order subtraction, no cache bust) each turned a test red. Cost if wrong: the units that were
really on hand when the line was backordered (2 in the example) are not returned to stock by the line
cancel — the owner chose that over ever inflating stock; a stock count corrects it.
