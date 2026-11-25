# Returns on the StoreDO (INFRA-CF-1 last-mile R1, Ruling CF-RETURNS-1)

Code: `packages/repo/src/do/returns.ts` (engine), `return-allocation.ts` and `return-adjustment.ts` (verbatim copies of the pure math, kept equal by `tests/unit/do-return-math-parity.test.ts`), `apps/api/src/services/return.service.ts` (Worker caller), `apps/api/src/services/accounting/posting/partial-return-posting.ts` (journal caller). Every operation is ONE `transactionSync` section reached through `StoreDO.moneyOp` -> `runMoneyOp`, with the optional marker-row key (`_money_ops`, CF-MONEY-1).

| Operation                 | Replaces                                               | Notes                                                                                                                              |
| ------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `returnCreate`            | `ReturnService.create`                                 | window, bundle groups, gold exchange, over-claim (rows + backorder cancels), tier estimate, rows                                   |
| `returnStatus`            | `updateStatus` / `approve` / `reject` / `markReceived` | same columns per status as Postgres (no transition table there either)                                                             |
| `returnTracking`          | `updateTracking`                                       |                                                                                                                                    |
| `returnClaim`             | `complete()` up to the provider call                   | status gate, the atomic claim (`refunded_at`), the plan (full/partial, allocation, wallet share, open refund claims)               |
| `returnFinish`            | `complete()` after the provider call                   | completion row, tier items, STORE CREDIT / wallet share, stock effects, record-only settlement of open claims, arming: ONE section |
| `returnRelease`           | `complete()` catch                                     | releases the claim while no money moved                                                                                            |
| `journalPartialReturn`    | `postPartialReturnJournal`                             | one adjustment + one COGS entry per `refundKey`; skips with the Postgres reasons                                                   |
| `journalAmountOnlyRefund` | `postAmountOnlyRefundJournal`                          | DR 4090 / CR the sale cash account, once per provider refund id                                                                    |

## What the single thread replaces

`lockOrderReturns` / `lockOrderReturnsBounded` (advisory locks) become the claim: a second claim, or a create, while another return of the order is being completed is `RETURN_ORDER_BUSY` 409 (Postgres waits, up to 3 s for a create, then 409). The `FOR UPDATE` on the sale entry is moot.

## Wallet credit and the open Postgres transaction

The store-credit credit (and the wallet share of a gateway refund) is written in `returnFinish`, in the SAME section as the completion row, the tier items and the restock. They commit together or not at all. The gateway call is the only thing between `returnClaim` and `returnFinish`. A request whose Postgres transaction rolls back after `returnFinish` and is retried cannot credit twice: the retry sees the return `completed` (`returnClaim` is `INVALID_STATUS`; `returnFinish` is `replayed: true`), the wallet entry is keyed `return-credit:<returnId>` / `return-wallet-share:<returnId>`, and the Worker sends `returnFinish` under the key `return-finish:<returnId>`.

## Differences kept

1. The `order/refunded` fanout (GL notification, affiliate, customer email) is still Inngest, and jobs for a DO store are a separate port (`docs/cf/jobs-on-do.md`); the money steps (restock, coupon, loyalty, wallet reversal) run in the DO section, the rest waits for the jobs port. `reversal_applied_at` is therefore NOT stamped by a DO completion (the fanout stamps it): the row stays armed (`reversal_requested_at`) and the stuck-reversal sweep keeps covering it.
2. A DO customer is a `User` row in the identity/Postgres side: a DO read cannot `include` it, so the Worker reads the return without `customer` and attaches the user (`withCustomer`).
3. `MoneyError.meta` now crosses the wire (`details` of the `AppError`): `RETURN_WINDOW_CLOSED` keeps its `returnWindowDays` / `closesAt`, `GOLD_EXCHANGE_UNSUPPORTED` its Arabic message.
4. The "refund already issued for this return" guard reads the DO's own `payment_events` in the claim section (`outstandingClaims`); `refundBegin` refuses the same `refundKey` under the payment lock as well.

## Tests

- `packages/repo/test/do-returns.test.ts` (node:sqlite, real DO schema): create/over-claim/window/gold exchange, keyed create, claim/busy/release, a refused plan leaves no claim, telescoping allocation of two partial returns, store credit on/off, wallet share, exchange to gateway, full return effects, the rollback/retry of a completion with its wallet credit, the journal and its skips.
- `tests/integration/repo-factory-returns-contract.test.ts` (real Postgres 17 vs the DO schema, real `ReturnService` and posting functions, 13 scenarios): equal returns or errors (status + code) and equal return, item, wallet, stock and journal rows.
- `apps/api/workers-do/returns.test.ts` (real workerd, `npm run cf:test:do -- returns`): 40 concurrent completions claim once, two returns of one order complete one at a time, 10 concurrent requests for the same two tees hold them once, 30 concurrent journals of one refundKey book once, 25 retried completions credit the wallet once, a failing credit rolls the completion back.

## Guest returns (Ruling GUEST-RET-1)

`returnCreate` takes `guest: true` for a shopper-opened return on a guest order (`orders.customer_id` is null): the order is matched with `customer_id IS NULL`, an account `customerId` never reaches it, and the row stores the `guest:<orderId>` marker (`returns.customer_id` stays NOT NULL; GUEST-RETURN-MARKER-1). A null `customerId` is never accepted. `returnClaim` refuses `store_credit` for such a return (`GUEST_STORE_CREDIT`). The identity check (order number plus phone or email) is Worker-side in `ReturnService.createForGuest`, before the op, and the guest path needs a StoreDO store (`RETURNS_NEED_DO_STORE` otherwise). See `docs/rulings/GUEST-RET-1.md`.

## Merchant-opened returns and the admin partial refund (STORE-QA-76)

`returnCreate` takes `byMerchant: true` (set only by `POST /returns/admin` and `POST /orders/:id/partial-refund`, never by a shopper route): the order's own customer is used, the return window does not bind the merchant, and an item may carry `restock: false`. A guest order is allowed: the row stores the `guest:<orderId>` marker (GUEST-RET-1).

- Per-line restock rides `return_items.condition = 'no_restock'` (merchant-opened only; a shopper-supplied value is dropped). `finishReturn` passes `skipRestock` to `refundOrder` (no stock move) and `postPartialReturnJournal` leaves those lines' COGS expensed (no inventory reversal). A return covering every line takes the whole-order reversal, which restocks everything, so a mixed choice there is refused at the claim (`FULL_RETURN_RESTOCK_ALL`).
- `analyticsRefundQuote` (read): paid / refunded / refundable (the ONE balance, #624), per-line remaining quantity, and an estimate for a selection from `allocatePartialReturn`, the allocation the completion pays.
- `POST /orders/:id/partial-refund` = open (merchant) -> approve -> receive -> complete in one request under an `Idempotency-Key`, `orders:refund`. A failure before money may have moved rejects the opened return so its lines can be retried; an indeterminate provider failure keeps it for reconciliation.
- Test: `apps/api/workers-do/admin-partial-refund.test.ts` (workerd, `npm run cf:test:do -w apps/api -- admin-partial-refund`).
