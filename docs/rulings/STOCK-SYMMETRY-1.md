# STOCK-SYMMETRY-1

> Section: 2026-11-12 (issues #632 and #633, money backfill audit)

**Ruling STOCK-SYMMETRY-1 - a stock movement is only ever undone by what actually moved.**
(1) #632: a checkout decrements only the aggregate (`products` / `product_variants`), never a
warehouse row, so the warehouse shadow runs ahead of real stock between reconciles.
`setWarehouseStock` / `adjustWarehouseStock` now first bring the SKU's shadow back to the
aggregate (`reconcileToAggregate`, the same routine the daily sweep uses; a deficit comes off
the default warehouse first) in the same DO section. The edit then lands on the real numbers
and the aggregate is recomputed from an accurate sum, so sold units are never resurrected. A
SKU with no warehouse row yet keeps the old meaning (its first row defines the stock). Making
checkout decrement a warehouse row was rejected: checkout does not know which warehouse ships.
(2) #633: a manual (phone) order takes no stock, so `placeAdminOrder` records a
`stock_not_taken` order event listing every line, and the cancel / refund / partial-return
restock (`neverTakenByItem`) puts none of it back. Decrementing at placement was not chosen:
that is a product change (a phone order would then reserve or refuse on stock), left to the
owner. The stale header claim "the mark-paid path decrements" is corrected. Residual: admin
orders created before this change have no marker, so cancelling one still restocks (pre-launch,
test stores only). Evidence: `do-stock-ops.test.ts` (#632, 2 cases) and `do-order-ops.test.ts`
(#633, 2 cases), all red on main. Cost if wrong: a merchant who restocks a warehouse while
another warehouse holds the sold units sees the deficit taken from the default warehouse first.

**Addendum (2026-11-11, main CI red after #693).** #693 shipped the marker on the DO backend only, so the
Postgres `OrderService.createAdminOrder` wrote no `stock_not_taken` event and `repo-factory-orders-contract`
(DO vs Postgres parity) went red on every main commit from 97d67ef9f. The Postgres path had the same #633 bug
(cancel / refund restocked a phone order's lines). It now writes the same event in the order transaction, and
`order-refunded.ts` (whole-order and partial-return restock) skips those units via `lib/stock-not-taken.ts`.
Proof: a new parity case cancels an admin order and expects inventory unchanged on both backends (13, not 10,
with the Postgres skip removed).
