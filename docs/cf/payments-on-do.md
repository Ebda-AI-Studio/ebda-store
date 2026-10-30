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

`resolveStoreFromWebhookRef` (`lib/definer.ts`) asks Postgres first (`ebda_webhook_resolve_store_scoped`); a miss falls to `resolveDoStoreFromWebhookRef`, which reads the D1 `entity_index` key `webhook` `<provider>:<ref>` (written in the DO section that created the payment, drained by the alarm). Same contract as the Postgres resolver (WEBHOOK-SCOPE-1): no provider -> no lookup; the `payment` kind is never read for a gateway reference; the per-store URL's store must equal the index row; only a store in `STORE_DO_ENABLED_IDS` is routed. A reference nobody resolves, while any store is flagged, is 503 + Retry-After + a P0 (never the constant 401) on the generic URL.

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

Carts, fiscal documents and the order reads (moved in R2, Ruling CF-R2-1), delivery slots, personalisation notes and quotes (moved in D2b-4), expense / PO / stock-adjustment journals and `payment-reconcile-sweep`, `payment-webhook-stuck-sweep`, `refund-reversal-stuck-sweep` (still `unported`, refused for a DO store with a P0).

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
