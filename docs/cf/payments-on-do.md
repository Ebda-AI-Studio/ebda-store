# Payments, refunds, ledger and gold repricing on the StoreDO (INFRA-CF-1 PR D2b-3, Rulings CF-PAY-1, CF-LEDGER-1)

Named `moneyOp`s, each ONE `transactionSync` section, reached with `const money = await storeMoney(storeId); if (money) {...}`; the Postgres code below the branch is unchanged, so with every flag at `pg` nothing runs differently. Registry: `packages/repo/src/do/money-ops.ts`.

| Operation                                                                            | Engine                                | Replaces                                                             | Worker caller                           |
| ------------------------------------------------------------------------------------ | ------------------------------------- | -------------------------------------------------------------------- | --------------------------------------- |
| `paymentCreate`                                                                      | `payments.ts` `createPayment`         | `PaymentService.recordCreatedPayment`                                | `recordProviderPayment`                 |
| `paymentWebhook`                                                                     | `payments.ts` `applyPaymentEventSync` | `PaymentService.handleWebhook` (Paymob, Kashier, Fawry)              | `handleWebhookOnDo`                     |
| `refundBegin` / `refundComplete` / `refundRelease` / `refundIndeterminate`           | `payments.ts`                         | the claim, outcome and release steps of `PaymentService.refund`      | `refundOnDo`                            |
| `refundBook`                                                                         | `refund.ts` `refundOrder`             | refund by status, the whole-order reversal, partial and store-credit | `OrderService.refundOnDo`, `refundOnDo` |
| `journalSale` / `journalRefund`                                                      | `ledger.ts`                           | `postOrderPaymentJournal`, `postRefundJournal`                       | `order-posting.ts`, `refund-posting.ts` |
| `goldApplyRates` / `goldDecidePending` / `goldUpdateSettings` / `goldRepriceProduct` | `gold-rates.ts`                       | `GoldRateService.applyRates`, `decidePending`, `updateSettings`      | `GoldRateService`                       |
| `fanoutDisarm`                                                                       | `money-ops.ts`                        | the superseded-transition disarm of the status-fanout stuck sweep    | `order-status-fanout-stuck-sweep`       |

## Webhook routing (D1 entity index)

`resolveStoreFromWebhookRef` (`lib/definer.ts`) asks the D1 entity index first when D1 is bound; Postgres is asked only while a `pg` store exists. The D1 `entity_index` key `webhook` `<provider>:<ref>` is queued in `d1_outbox` by the DO section that created the payment and written to D1 by `StoreDO.moneyOp` BEFORE it answers (`drainEntityIndexOutbox`; a D1 failure leaves it queued, retried on the next money op and by the alarm). Until NZ-MONEY-1 nothing drained the outbox. Same contract as the Postgres resolver (WEBHOOK-SCOPE-1): no provider -> no lookup; the `payment` kind is never read for a gateway reference; the per-store URL's store must equal the index row; only a store in `STORE_DO_ENABLED_IDS` is routed. A reference nobody resolves, while any store is flagged, is 503 + Retry-After + a P0 (never the constant 401) on the generic URL.

## Options the Postgres path honours, and what the DO does with each

| Postgres option / behaviour                               | On the DO                                                                                |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Kashier confirm-before-apply (PROVIDERS-17)               | done by the Worker, the gateway's answer is applied; none = 503, nothing written         |
| store-scoped webhook key (WEBHOOK-SCOPE-1)                | route unchanged; the DO's dedupe is `payment_event_log (provider, event_id)`             |
| `refundKey` (a retry must not pay twice)                  | `REFUND_ALREADY_ISSUED` 409 while a claim is open                                        |
| `itemLevel` refund (no order flip)                        | honoured by `refundBegin`                                                                |
| cumulative cap, claim before the provider call            | honoured (CAS on `refunded_amount`)                                                      |
| refund by status keeps `payment_status`                   | `keepPaymentStatus` (found by the contract test)                                         |
| external refund exceeding the order / on a reversed order | recorded in full, `review` flag + alert (`external: true`), never thrown                 |
| `restoreInventory:false`                                  | cancel (CF-ORDERS-1)                                                                     |
| any other status of a DO order                            | 501 `ORDER_STATUS_NOT_ON_DO`                                                             |
| partial-return pro-rata journal                           | `journalPartialReturn` (CF-RETURNS-1)                                                    |
| gold `setProductPricing`, `asRepricer`, `bulkSwitchMode`  | `goldSetProductPricing` / `goldCreateVariant` / `goldBulkSwitchMode` (CF-LAST-1)         |
| InstaPay ORDER receipt upload / submit / reject / approve | DO table `instapay_order_receipts`, one section each (INSTAPAY-DO-1)                     |
| wallet movement outside a Postgres transaction            | `walletEntry` (ledger row, balance and the 2150 journal half in one section)             |
| wallet movement INSIDE a Postgres transaction             | `walletEntry`, keyed on the entity (WALLET-DO-TX-2); return completion is `returnFinish` |

## Not moved (the flip gate stays closed)

Carts, fiscal documents and the order reads (moved in R2, Ruling CF-R2-1), delivery slots, personalisation notes and quotes (moved in D2b-4), expense / PO / stock-adjustment journals (still `unported`, refused for a DO store with a P0). `payment-reconcile-sweep`, `payment-webhook-stuck-sweep` and `refund-reversal-stuck-sweep` moved in Ruling CF-JOBS-4.

## Tests

- `packages/repo/test/do-payment-ops.test.ts` (14, node:sqlite, real DO schema): registry, replay, fail-closed Kashier, claim / release, external facts recorded in full, store credit once, trial balance, wallet tender, accounting off, missing account.
- `tests/integration/repo-factory-payments-contract.test.ts` (3, Postgres 17 vs the DO schema): trial balance parity, refund by status, gold re-pricing.
- `apps/api/workers-do/payments.test.ts` (6, real workerd): 20 concurrent webhook replays apply once; 20 concurrent full-refund claims, one wins; one `refundKey` x20 one claim; 20 whole-order refund bookings restore stock once; 20 sale / refund posts post once with distinct numbers; `STORE_MISMATCH`.
- `tests/unit/webhook-do-resolver.test.ts` (8), `tests/unit/ledger-do-cash-codes.test.ts`.

## PR D2b-5 (Ruling CF-LAST-1)

Gold product pricing edits are money ops (`do/gold-pricing.ts`); `PaymentService.handleWebhook` / `refund` have an end-to-end Postgres-vs-DO contract (`tests/integration/repo-factory-payment-service-contract.test.ts`, stub provider adapter). The open list is `docs/cf/not-on-do.json`.

## PR R3 (Rulings WALLET-GL-1 / WALLET-DO-TX-1, INSTAPAY-DO-1, IMPORT-DO-1)

- Wallet movements: `walletEntry` journals `admin_adjust` / `credit` / `debit` on 5950 Customer Goodwill and `expire` on 4100 Unused Store Credit against 2150 (`do/ledger.ts` `postWalletMovementJournal`; 2150 / 4100 / 5950 self-heal like the Postgres template). Tests: `tests/integration/repo-factory-wallet-contract.test.ts`, `apps/api/workers-do/wallet.test.ts` (20 concurrent debits cannot overdraw; 20 replays post once).
- InstaPay order receipts: ops `receiptCreate`, `receiptExtraction`, `receiptGet`, `receiptList`, `receiptProof`, `receiptSubmit`, `receiptReject`, `receiptImageDeleted`, `receiptSweep`; `confirmPayment` approves the submitted receipts in its own section. Cross-store reference claim: D1 `entity_index` kind `instapay_ref`, bound to the receipt (`claim_ref`). At cutover the table is copied from the platform `instapay_receipts` order rows with count and checksum (R6a, Ruling CF-R6A-4).
- CSV import: ops `importBatch` and `importVariants` (`docs/cf/repo-factory.md`).
- FOUNDING-1 `billing_grants` guard on D1: already ported by CF-LAST-2 (`migrations/platform/0002_invariants.sql`, `packages/cf-schema/test/platform.test.ts`). `PaymentService.handleWebhook` / `refund` end to end with a stub adapter: already `tests/integration/repo-factory-payment-service-contract.test.ts` (CF-LAST-1). Both re-run green in R3; nothing new was needed.

## NEON-ZERO money path (Ruling NZ-MONEY-1)

Postgres is gone from the Worker; these were the last Postgres calls a DO store's checkout, webhooks and payouts could reach.

| Operation          | Engine                           | Replaces                                                           | Worker caller                                             |
| ------------------ | -------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------- |
| `paymentCreate`    | `payments.ts` `createPayment`    | + the COD row of `POST /payments/create` (`cod_pending`, metadata) | `PaymentService.recordCodPayment`, `recordCreatedPayment` |
| `instapayInitiate` | `payments.ts` `initiateInstapay` | `InstapayService.initiate` (hold, pending row, both events)        | `InstapayService.initiateOnDo`                            |
| `affiliatePayout`  | `job-ops.ts` `affiliatePayoutOp` | `AffiliateService.createPayout` (debit + payout + event)           | `AffiliateService.createPayout`                           |

- `paymentCreate` takes the amount DUE (`total - wallet_amount`, what every Postgres caller charges); a second COD create while one is open returns the same row (`replayed: true`).
- `instapayInitiate` replays an awaiting order's pending row (`created: false`); otherwise `ORDER_NOT_PAYABLE` / `ORDER_ALREADY_PAID` as on Postgres.
- `affiliatePayout` re-checks the balance inside the section (`INSUFFICIENT_BALANCE`), like the Postgres `updateMany ... gte`.
- Reads of `POST /payments/create`, `/payments/status/:ref`, `/payments/refund`, `/payments/retry/:id`, `/payments/order/:id`, `/payments/:id/events`, `/payments/events/:id/payload`, the payment-abandonment reports and the affiliate events / payouts go through `storeDb(storeId)`; `Order -> User` and `Order -> Store` are read beside the order (`customersById`, `db.store`). `POST /payments/refund` names the store, so `PaymentService.refund` takes `refundOnDo`. The inline webhook fallback (Inngest send failed) skips the Postgres transaction for a DO store, like the job. The error redirect resolves its store from the D1 index per gateway.
- Tests: `apps/api/workers-test/money-path.test.ts` (10, built Worker, Postgres absent, signed webhooks with test keys, `gateway-stub` outbound service answers Kashier's confirm), `packages/repo/test/do-payment-ops.test.ts` (+4), `tests/unit/no-prisma-in-routes.test.ts` (static gate).

Ruling NZ-MONEY-1 - the DO `paymentCreate` charges the amount due, not the order total. Evidence: every Postgres caller (`/payments/create`, payment link, retry) records `order.total - order.walletAmount`, and the DO refused that with `PAYMENT_AMOUNT_MISMATCH` (a wallet-part-paid order could not record its gateway payment; the gateway invoice was then orphaned). The one DO test that paid the full total of a wallet order encoded the wrong amount and now pays the due. Cost if wrong: a caller that really meant the full total of a wallet order is refused 409 instead of over-charging the wallet part.

Ruling NZ-MONEY-2 - a PAYMENT reference is handed out only when D1 can route it. `StoreDO.moneyOp`, for every op that answers a payment (`paymentCreate`, `instapayInitiate` and its replay, and `paymentIndexCheck`, which `POST /payments/create` calls before it hands an EXISTING payment out again: the COD replay, the InstaPay replay, a live invoice / Fawry code), writes that payment's still-queued index rows NOW (backoff ignored) and reads every id back from D1 (`awaitEntityIndexed`, 3 s bound); when they are not there it answers 503 `ENTITY_INDEX_UNAVAILABLE`. The check reads D1, not "did this call write rows", so a retry during an outage is refused too (review NEW-1). Every retry returns the same committed payment. Any other op keeps its answer, a checkout order included (its retry is a replay that would not re-run the post-commit fan-out, review NEW-2); its rows are written by the op when D1 is up and otherwise wait for the alarm, and `POST /payments/create` by that order id answers 404 until they land. Rows still queued arm a short alarm (`max(next attempt, now + 30 s)`, env `STORE_DO_INDEX_RETRY_MS`); the alarm backs the store up only when the nightly backup is due (`_identity.backup_due_at`). Evidence: `drainEntityIndexOutbox` had no caller in the Worker, so D1 `entity_index` never learnt a DO store's new orders, payments or gateway references. Reviews I-2 and NEW-1 of PR 455 found the earlier fixes answered success on a failed write and on a replay. Tests: `money-path.test.ts` (D1 refuses the payment row: first and retry 503, back up: 200 with the row in D1 before the answer; D1 refuses the order row: the checkout still answers 2xx and a keyed retry replays it), `workers-do/index-retry-alarm.test.ts`. Cost if wrong: during a D1 write outage payment creation answers 503 (retryable) instead of handing out a reference nobody can route, and a checkout placed in the outage waits up to the next alarm before it can be paid online.

Ruling NZ-MONEY-3 - money-out requests take an `Idempotency-Key`: same key, same answer, no second effect. `POST /payments/refund` claims it with an atomic `SET NX EX` on the AuthState store (`lib/money-idempotency.ts`; a failure after which money may have moved keeps it, so a retry gets 409 and a human checks the provider); `POST /stores/:id/affiliates/:id/payouts` passes it as the DO money-op key (the section replays its first payout). The gateway `refundKey` was NOT reused for this: it switches off the refund-outside-a-return GL / notification branch. Evidence: review M-6 / M-8 of PR 455. Cost if wrong: a client that reuses one key for two different refunds of the same payment gets the first answer back for the second (it must send a new key).

Ruling NZ-MONEY-4 - a `completed` gateway delivery confirms a DO order only when it states the amount due (within 5 piastres) in the payment's currency; a short, over or missing amount, or another or missing currency, is recorded in full on the payment (`reconciliation` event, `amountMismatch` metadata), the order is NOT marked paid and a P1 `amount_mismatch` is raised. Evidence: review I-4 of PR 455 (`under` only caught a short payment in the same currency). Tests: `do-payment-ops.test.ts` (5 cases + wallet split), `money-path.test.ts` (a validly signed wrong amount per provider is held). Cost if wrong: a gateway that legitimately reports a fee-adjusted amount leaves the order unpaid until a merchant confirms it from the alert. Exception, stated explicitly: a STATUS POLL (`applyPolledStatusOnDo`: the merchant's refresh, the shopper's verify on return, the auto-cancel sweep) is our server asking the gateway about OUR invoice; when the gateway's answer carries no amount or currency the poll fills the payment's own (`payment.factory.ts` `providerStatus.paidAmount ?? payment.amount`), so a poll-confirmed `paid` with no amount still confirms. Only a delivered webhook is held for a missing amount or currency.
