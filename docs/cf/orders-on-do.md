# Orders on the StoreDO (INFRA-CF-1 PR D2b-2, Rulings CF-ORDERS-1, CF-ORDERS-CART-1)

Four named money operations replace the interactive Postgres transactions of order creation and the order status changes that move money. Each is ONE `transactionSync` section on the StoreDO (the single thread replaces `FOR UPDATE`, the `pg_advisory_xact_lock` of the hold cap and the conditional `UPDATE` retry loops), reached through `StoreDO.moneyOp` -> `runMoneyOp` with an optional marker-row idempotency key (`_money_ops`, CF-MONEY-1). Services reach them with `const money = await storeMoney(storeId); if (money) {...}`; the Postgres code below the branch is unchanged, so with every flag at `pg` nothing runs differently.

| Operation        | Engine (`packages/repo/src/do/`) | Replaces                                                                         | Worker caller               |
| ---------------- | -------------------------------- | -------------------------------------------------------------------------------- | --------------------------- |
| `createOrder`    | `checkout.ts` `placeOrder`       | `OrderService.create` `withMoneyTx` body                                         | `OrderService.createOnDo`   |
| `confirmPayment` | `payments.ts` `confirmInstapay`  | `InstapayService.confirm` transaction                                            | `InstapayService.confirm`   |
| `cancel`         | `refund.ts` `cancelOrder`        | `OrderService.updateStatus(..., 'cancelled')` + the `order/refunded` money steps | `OrderService.cancelOnDo`   |
| `expireHold`     | `payments.ts` `expireInstapay`   | `InstapayService.expireOne` transaction (+ its cancel)                           | `InstapayService.expireOne` |

## Map: every read and write inside the Postgres transactions

### `OrderService.create` (`withMoneyTx`, order.service.ts)

| #   | Step in the Postgres transaction                                                        | Kind                | Where it lives on the DO (`placeOrder`)                                       |
| --- | --------------------------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------- |
| 1   | `assertSameRates` (gold rates FOR SHARE)                                                | read, lock          | gold gate over `gold_rates` rows in the section (`do/gold.ts`)                |
| 2   | `SELECT ... FROM carts FOR UPDATE`; re-read cart items and bundles; compare with priced | lock, read          | `input.cart` claim (CF-ORDERS-CART-1: not used from the Worker yet)           |
| 3   | checkout idempotency lookup (`orders.checkout_idempotency_key`)                         | read                | `orders.idempotency_key`, then the `_money_ops` marker                        |
| 4   | `assertStockHoldCapNotExceeded` (3 advisory locks, count of open unpaid orders)         | lock, read          | step 9: count of `OPEN` orders per phone/email/IP in the section              |
| 5   | per line: product/variant stock read, conditional `UPDATE inventory` (backorder branch) | read, write         | `decrementProduct/Variant`, `forceDecrementVariant` (variant XOR product row) |
| 6   | bundle component expansion and per-component decrement                                  | read, write         | `resolveBundles` + the same decrement                                         |
| 7   | per-user coupon usage count (guests by phone/email under an advisory lock)              | lock, read          | coupon per-user check in the section                                          |
| 8   | `coupon.updateMany` usage_count + 1 guarded by `usage_limit`                            | write               | conditional `UPDATE coupons` (0 rows = `COUPON_EXHAUSTED`)                    |
| 9   | `order.create` with nested items                                                        | write               | `INSERT orders`, `order_items`                                                |
| 10  | `inventoryHistory.createMany` (`sale`, quantity negative)                               | write               | `recordMovement` (sign fixed in this PR, see below)                           |
| 11  | `backorderLine.create`, `orderItem.update costPriceDeferred`                            | write               | backorder rows in the section                                                 |
| 12  | `LoyaltyService.redeemPoints` (points row + transaction row)                            | read, write         | `redeemPoints` (`do/loyalty.ts`)                                              |
| 13  | `WalletService.debitForOrder` (wallet row lock, ledger row)                             | lock, read, write   | `applyWalletEntry`: one conditional `UPDATE ... balance + amount >= 0`        |
| 14  | `cartItem`/`cartBundle.deleteMany` + count check                                        | write               | Worker side after commit (CF-ORDERS-CART-1)                                   |
| 15  | `FiscalDocumentService.issueSaleDocument`                                               | write               | NOT on the DO yet (follow-up PR, below)                                       |
| 16  | abandoned-cart recovery update                                                          | write (best effort) | NOT on the DO (carts and abandoned carts not moved)                           |

Reads before the transaction (cart, product internals, bundles, price resolver, tax, shipping, COD fee, coupon validation, loyalty quote) are all computed by the engine from the DO's own rows inside the same section, so the totals and the stock write can no longer be separated by a concurrent order.

### Status changes (`updateStatus`, `InstapayService`)

| Step                                                                                                                                           | Kind              | DO operation                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `getById`, `assertValidTransition`                                                                                                             | read              | `cancel` re-checks the state machine on the DO row (`INVALID_TRANSITION` 409); the service also checks on the DO-read status first |
| `order.update status`, `order_events` row                                                                                                      | write             | `cancel`                                                                                                                           |
| `applyRefundEffects` -> `order/refunded` money steps: restore stock, release coupon use, loyalty reversals, wallet reversal, cancel backorders | write             | `cancel` (`reverseWholeOrder`), every step individually idempotent                                                                 |
| Lock order row, status `awaiting_payment_confirmation` check, window check, claim, payment `completed`, `order_events`, `payment_events`       | lock, read, write | `confirmPayment`                                                                                                                   |
| Expiry: window check, proof check, cancel with reversal, notes, payment `expired`, event                                                       | lock, read, write | `expireHold` (a concurrent `confirmPayment` is serialised: one wins)                                                               |

Other transitions (`confirmed`, `processing`, `shipped`, `delivered`) move no stock, coupon, wallet or loyalty balance and stay plain row writes with the existing state machine (`order-status-machine.ts`); they move with the order reads in the next slice.

## Differences kept or fixed (found by the contract test)

1. FIXED in the engine: the stock ledger row of a sale carried a POSITIVE quantity on the DO and `-qty` on Postgres; `loyalty_points_redeemed` was `0` instead of `NULL` without a redemption; the sale row had no reason. All three now equal Postgres.
2. Refusals are translated by `OrderService.translateDoRefusal` to the Postgres codes and statuses (`OUT_OF_STOCK` -> 400 `INSUFFICIENT_INVENTORY`, `COUPON_EXHAUSTED`/`COUPON_INVALID`/`COUPON_EXPIRED` -> 400 `INVALID_COUPON`, per-user limit -> 400 `COUPON_LIMIT_REACHED`, `INSUFFICIENT_WALLET` -> 409 `INSUFFICIENT_WALLET_BALANCE`, `TOO_MANY_OPEN_ORDERS` -> 429 `TOO_MANY_OPEN_HOLDS`).
3. A coupon whose last use is taken by a concurrent order answers `INVALID_COUPON` (the Postgres pre-check) where Postgres can answer `COUPON_LIMIT_REACHED` for the same race; both are 400.
4. External payment facts are recorded in full, never rejected: `confirmPayment` after the window with a proof of payment still confirms; a refund or cancel reverses what the balances hold (floor at the balance) and writes the full row.
5. A quote (`dryRun`) for a DO store answers 501 `QUOTE_NOT_ON_DO` (the engine has no dry run; the gate forbids a flip until it does).

## Residuals and follow-ups (the flip gate stays closed)

- Carts (`carts`, `cart_items`, `cart_bundles`) and the abandoned-cart table are still read and cleared on Postgres; the order is created on the DO from the cart's lines and bundles (CF-ORDERS-CART-1). Until carts move, the cart claim is not atomic with the order: two concurrent submits of one cart without a key can both read the full cart (the engine's own `cart` claim exists and is tested, `money-stock.test.ts`, but is not used from the Worker). A keyed retry is safe (the key is hashed with the cart id).
- Fiscal sale documents (`issueSaleDocument`), delivery slots, personalisation notes and order-time affiliate attribution are not written by the engine (Ruling DO-MONEY-2).
- InstaPay receipts have not moved: `proofSubmitted` reads Postgres and finds none for a DO store; receipt approval after a confirm is not run for a DO store.
- The `order/refunded` fanout (affiliate commission, GL journal, notifications) still runs through Inngest; for a DO store only its money steps are redundant (idempotent markers), the rest is jobs work (`docs/cf/jobs-on-do.md`).

## Tests

- `packages/repo/test/do-order-ops.test.ts` (node:sqlite, real DO schema): registry, trust boundary (`storeId`/`now` never from the caller), keyed replay, a refused order leaves nothing, last items, cancel once, delivered refusal, confirm/expire, wallet and coupon bounds, hold cap.
- `tests/integration/repo-factory-orders-contract.test.ts` (real Postgres 17 vs the DO schema on SQLite, real `OrderService`): plain order, coupon, last items, coupon limit, cancel; equal return values, error code + status, and order, item, stock, coupon and ledger rows.
- `apps/api/workers-do/orders.test.ts` (real workerd, `npm run cf:test:do -- orders`): 60 concurrent orders for the last 25 items (exactly 25), a coupon with 7 uses under 40 orders (exactly 7), a wallet of 5000 under 30 orders of 1000 (5 paid, balance 0), hold cap 2 under 20 orders (2), one key fired 20 times (one order) and 20 concurrent cancels (stock restored once), a confirm racing an expiry (one wins).
