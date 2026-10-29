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

| #   | Step in the Postgres transaction                                                        | Kind              | Where it lives on the DO (`placeOrder`)                                                                              |
| --- | --------------------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1   | `assertSameRates` (gold rates FOR SHARE)                                                | read, lock        | gold gate over `gold_rates` rows in the section (`do/gold.ts`)                                                       |
| 2   | `SELECT ... FROM carts FOR UPDATE`; re-read cart items and bundles; compare with priced | lock, read        | `input.cart` claim: the cart rows are compared with the ordered lines and boxes and deleted in the section (CF-R2-1) |
| 3   | checkout idempotency lookup (`orders.checkout_idempotency_key`)                         | read              | `orders.idempotency_key`, then the `_money_ops` marker                                                               |
| 4   | `assertStockHoldCapNotExceeded` (3 advisory locks, count of open unpaid orders)         | lock, read        | step 9: count of `OPEN` orders per phone/email/IP in the section                                                     |
| 5   | per line: product/variant stock read, conditional `UPDATE inventory` (backorder branch) | read, write       | `decrementProduct/Variant`, `forceDecrementVariant` (variant XOR product row)                                        |
| 6   | bundle component expansion and per-component decrement                                  | read, write       | `resolveBundles` + the same decrement                                                                                |
| 7   | per-user coupon usage count (guests by phone/email under an advisory lock)              | lock, read        | coupon per-user check in the section                                                                                 |
| 8   | `coupon.updateMany` usage_count + 1 guarded by `usage_limit`                            | write             | conditional `UPDATE coupons` (0 rows = `COUPON_EXHAUSTED`)                                                           |
| 9   | `order.create` with nested items                                                        | write             | `INSERT orders`, `order_items`                                                                                       |
| 10  | `inventoryHistory.createMany` (`sale`, quantity negative)                               | write             | `recordMovement` (sign fixed in this PR, see below)                                                                  |
| 11  | `backorderLine.create`, `orderItem.update costPriceDeferred`                            | write             | backorder rows in the section                                                                                        |
| 12  | `LoyaltyService.redeemPoints` (points row + transaction row)                            | read, write       | `redeemPoints` (`do/loyalty.ts`)                                                                                     |
| 13  | `WalletService.debitForOrder` (wallet row lock, ledger row)                             | lock, read, write | `applyWalletEntry`: one conditional `UPDATE ... balance + amount >= 0`                                               |
| 14  | `cartItem`/`cartBundle.deleteMany` + count check                                        | write             | the same cart claim, in the section (CF-R2-1)                                                                        |
| 15  | `FiscalDocumentService.issueSaleDocument`                                               | write             | `issueSaleDocument` (`do/fiscal.ts`) in the section, gapless counter (CF-R2-1)                                       |
| 16  | abandoned-cart recovery update                                                          | write             | an `UPDATE abandoned_carts` in the section; a guest cart matches only its own row (CF-R2-1)                          |

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
5. Options the Postgres path honours, found by the security review and fixed (one class: an option the DO branch dropped):
   - `restoreInventory: false` on a cancel (MONEYB-5) now reaches the `cancel` operation; the engine skips only the stock return (coupon, loyalty, wallet and backorders still reverse) and does not arm the reversal claim, like the `order/refunded` fanout.
   - The gold price-quote protection: each line carries `quotedUnitPrice` and `goldRequireQuote = !dryRun`; a rate that moved after the shopper saw the price is `PRICE_CHANGED` 409 on both backends (a materialised-price drift is mapped to the same code).
   - InstaPay proof: the shopper's reference is read from the DO payment metadata and the receipts from Postgres; `expireOne` fails closed (skips) when the proof state cannot be read, and an order with proof is never expired (audit O1). A DO confirm runs the Postgres path's post-commit work: receipt approval, screenshot deletion, customers cache, `order/created`, the merchant socket push.
   - `notes`, `locale`, `sms_opt_in` and `source` are stamped on the order row in the same section; the SMS consent grant, the merchant socket push and the order/created event follow the Postgres path.
   - The cancel tail matches Postgres: refund fanout with the right notify flag, `order/status-changed` (with the inline fallback) and the customer push.
   - Refused loudly (501), never dropped, because the engine cannot honour them yet: a delivery slot (`DELIVERY_SLOT_NOT_ON_DO`) and a personalisation note (`PERSONALISATION_NOT_ON_DO`); a missing required personalisation is `PERSONALISATION_REQUIRED` 400 as on Postgres.
6. A quote (`dryRun`) for a DO store answers 501 `QUOTE_NOT_ON_DO` (the engine has no dry run; the gate forbids a flip until it does).

## PR D2b-4a (Ruling CF-FINAL-1)

`orderStatus` (confirmed/processing/shipped/delivered, COD settled on delivery, fanout armed), `quoteOrder` (dry run, writes nothing), an atomic cart claim inside `createOrder` (`cartClaim`, `_cart_claims`), the delivery date note and the per-line personalisation text now run on the DO; the residuals below about the cart claim, delivery slots, personalisation and the status fanout arming are CLOSED. What is still open is the machine-checked list `docs/cf/not-on-do.json`.

## PR R2 (Ruling CF-R2-1)

Fiscal documents, the cart rows and the order reads moved; `createOrder` claims the cart rows in its own section and closes CF-ORDERS-CART-1.

- **Fiscal**: `do/fiscal.ts` holds the ports of `issueSaleDocument`, `issueRefundDocument`, `cancelSaleDocument` and the gapless counter (one upsert on `fiscal_document_counters` in the order's section). `createOrder` issues the sale document; a whole-order cancel or refund settles its document inside `reverseWholeOrder`; a partial refund event reaches `fiscalRefund` through `OrderService.applyRefundEffects` (the `order/refunded` fanout job is `unported`, so for a DO store this is the only door). Reads (`FiscalDocumentService.list/getById/documentsForOrder`) go through `storeDb`.
- **Carts**: `Cart`, `CartItem`, `CartBundle`, `AbandonedCart` and `AbandonedCartConfig` are DO-writable models. `CartService`, the cart email opt-in / restore and the abandoned-cart admin reads follow the store's backend; `rollbackForPaymentFailure` has a DO branch (the `cancel` op takes a `note`).
- **Order reads**: `getById`, `getByOrderNumber`, `list`, `getCustomerOrders` and the created-order read use `storeRepo`; `Order.customer` (a platform `User`) is attached after the DO read. Admin order search on a DO store is answered from the StoreDO's derived search index (money op `searchOrders`, `do/order-search.ts`; Arabic-folded names, any phone form, e-mail, guest contact snapshots, order numbers; Ruling CF-R4-1). A term matching more than 20,000 rows is `ORDER_SEARCH_TOO_BROAD` 422.
- **Manual (phone) orders** (R4, Ruling CF-R4-2): `OrderService.createAdminOrder` has a DO branch, the money op `createAdminOrder` (`do/admin-order.ts`): priced from the DO's rows by the `createOrder` pieces, NO stock reserved, coupon rules enforced (or overridden by a permitted role, recorded as `order_events` in the same section), MOQ override likewise, the gapless sale document in the same section.
- **Cart pricing** (R4, Ruling CF-R4-3): `PriceResolver` tiers and buyer group, and the public gold facts, read through `storeDb`.
- **Still on Postgres** (accepted, Ruling CF-R2-1 point 5): cart pricing (PriceResolver, public gold pricing, bundle totals), `newsletter_subscribers` of the cart email consent, and the abandoned-cart detection, reminder and recovery-email jobs (`unported` jobs, refused with an alert for a DO store by the jobs guard).

## Residuals and follow-ups (the flip gate stays closed)

- InstaPay receipts have not moved (an ORDER receipt for a DO store is refused 501, CF-PAY-1): `proofSubmitted` reads the DO payment metadata only. Payments, webhooks, refunds, the ledger and gold repricing moved in D2b-3: `docs/cf/payments-on-do.md`.
- Order-time affiliate attribution is not written by the engine (Ruling DO-MONEY-2).
- The `order/refunded` fanout (affiliate commission, GL journal, notifications) still runs through Inngest; for a DO store only its money steps are redundant (idempotent markers), the rest is jobs work (`docs/cf/jobs-on-do.md`).

## Tests

- `packages/repo/test/do-order-ops.test.ts` (node:sqlite, real DO schema): registry, trust boundary (`storeId`/`now` never from the caller), keyed replay, a refused order leaves nothing, last items, cancel once, delivered refusal, confirm/expire, wallet and coupon bounds, hold cap.
- `packages/repo/test/do-fiscal.test.ts` and `do-cart-claim.test.ts` (R2: numbering, credit notes, the cart row claim); `tests/integration/repo-factory-carts-contract.test.ts` (R2: CartService, Postgres vs DO); `tests/integration/repo-factory-orders-contract.test.ts` (real Postgres 17 vs the DO schema on SQLite, real `OrderService` and `InstapayService`, 12 scenarios): plain order, coupon, last items, coupon limit, cancel, cancel with `restoreInventory:false`, stamped options (notes, locale, sms, source), gold quote (moved rate = `PRICE_CHANGED`, unchanged rate priced the same), InstaPay expiry (no proof expires, proof skipped, open window skipped) and confirm (once, late without proof refused, late with proof confirmed); equal return values, error code + status, and order, item, stock, coupon and ledger rows.
- `apps/api/workers-do/orders.test.ts` (real workerd, `npm run cf:test:do -- orders`): 60 concurrent orders for the last 25 items (exactly 25), a coupon with 7 uses under 40 orders (exactly 7), a wallet of 5000 under 30 orders of 1000 (5 paid, balance 0), hold cap 2 under 20 orders (2), one key fired 20 times (one order) and 20 concurrent cancels (stock restored once), a confirm racing an expiry (one wins).
- R4 (Rulings CF-R4-1 .. CF-R4-5): the order-search, admin-order and cart-pricing scenarios in `tests/integration/repo-factory-orders-contract.test.ts` and `repo-factory-carts-contract.test.ts` (real Postgres 17 vs the DO schema); `apps/api/workers-do/admin-order.test.ts` and `newsletter-carts.test.ts` (real workerd: coupon limits, per-customer limit, overrides, gapless numbers, the e-mail claim, the recovery coupon, signup races).
