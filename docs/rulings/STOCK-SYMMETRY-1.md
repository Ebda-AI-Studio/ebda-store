# STOCK-SYMMETRY-1

> **Part (2) SUPERSEDED 2026-11-11 (owner decision, Ahmad): a phone / admin order now TAKES stock at placement - see the Supersession below.** Part (1) (#632, warehouse shadow) stands.

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

**Supersession (2026-11-11, Ahmad): phone / admin orders reserve stock like online orders, and refuse when short.**
Part (2) above (a manual order takes no stock; its `stock_not_taken` marker lists every line) is replaced. Now:

- `placeAdminOrder` (DO, `packages/repo/src/do/admin-order.ts`) and `OrderService.createAdminOrder` (Postgres) reserve every
  tracked line in the order's own section / transaction with the same conditional `UPDATE ... WHERE inventory >= qty` checkout
  uses (integer units, atomic, tenant-scoped, idempotent with the order: a refused order rolls everything back), one
  `inventory_history` `sale` row per line. Lines of the same SKU are checked against one running stock; untracked products take
  and give back nothing.
- Short stock refuses the whole order `422 INSUFFICIENT_STOCK` (details list each short line: product, variant, requested,
  available). No backorders on a phone order.
- Override (same pattern as the coupon / MOQ overrides): body `overrideStock: true` + `stockOverrideReason` (3-500 chars),
  `store_admin` only (staff 403 `STOCK_OVERRIDE_FORBIDDEN`, no reason 400 `STOCK_OVERRIDE_REASON_REQUIRED`). The order then takes
  what is on hand, the missing units go into a `stock_not_taken` marker (so cancel / refund puts back only what was taken), a
  `stock_override` order event (reason, role, shortages) is written in the order's section, and an `order.stock_override` audit row
  shows on the merchant timeline (hidden from the customer's).
- New fully-stocked orders carry NO `stock_not_taken` marker, so cancel / refund / partial return restock symmetrically.
- Legacy orders (placed under #693 / #703, before this change) keep their full-line marker and their behaviour: cancel / refund
  restocks none of it. Their stock was never taken, so nothing changes for them. The marker readers (`refund.ts`
  `neverTakenByItem`, `order-refunded.ts` via `lib/stock-not-taken.ts`) are untouched.
- Admin UI (`orders/new`): on the refusal the form shows the shortage notice (Egyptian Arabic + English, `stockSection.*`); a store
  admin sees "place the order anyway" with a required reason.
  Evidence: `repo-factory-orders-contract.test.ts` (DO vs Postgres parity: reserve, refuse, override + cancel restock, legacy marker),
  `do-order-ops.test.ts` (6 DO cases), `workers-do/admin-order.test.ts` (60 concurrent racers on 10 units: exactly 10 win, stock 0).
  Cost if wrong: a merchant who cannot get a phone order in because the stock count is stale is blocked until a store admin overrides
  or corrects the count (the override is one tick and a reason, and is audited).
