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

| Postgres option / behaviour                               | On the DO                                                                        |
| --------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Kashier confirm-before-apply (PROVIDERS-17)               | done by the Worker, the gateway's answer is applied; none = 503, nothing written |
| store-scoped webhook key (WEBHOOK-SCOPE-1)                | route unchanged; the DO's dedupe is `payment_event_log (provider, event_id)`     |
| `refundKey` (a retry must not pay twice)                  | `REFUND_ALREADY_ISSUED` 409 while a claim is open                                |
| `itemLevel` refund (no order flip)                        | honoured by `refundBegin`                                                        |
| cumulative cap, claim before the provider call            | honoured (CAS on `refunded_amount`)                                              |
| refund by status keeps `payment_status`                   | `keepPaymentStatus` (found by the contract test)                                 |
| external refund exceeding the order / on a reversed order | recorded in full, `review` flag + alert (`external: true`), never thrown         |
| `restoreInventory:false`                                  | cancel (CF-ORDERS-1)                                                             |
| any other status of a DO order                            | 501 `ORDER_STATUS_NOT_ON_DO`                                                     |
| partial-return pro-rata journal                           | 501 `PARTIAL_RETURN_JOURNAL_NOT_ON_DO`                                           |
| gold `setProductPricing`, `asRepricer`, `bulkSwitchMode`  | `goldSetProductPricing` / `goldCreateVariant` / `goldBulkSwitchMode` (CF-LAST-1) |
| InstaPay ORDER receipt upload / submit                    | 501 `INSTAPAY_RECEIPTS_NOT_ON_DO`                                                |

## Not moved (the flip gate stays closed)

Carts, fiscal documents and the order reads (moved in R2, Ruling CF-R2-1), delivery slots, personalisation notes and quotes (moved in D2b-4), InstaPay receipts, the Return row lifecycle (`return.service.ts`: its refund legs reach the DO only through `PaymentService.refund` and `refundBook`), expense / PO / stock-adjustment journals, the wallet-movement journal (WALLET-GL-1, open PR), and `payment-reconcile-sweep`, `payment-webhook-stuck-sweep`, `refund-reversal-stuck-sweep` (still `unported`, refused for a DO store with a P0).

## Tests

- `packages/repo/test/do-payment-ops.test.ts` (14, node:sqlite, real DO schema): registry, replay, fail-closed Kashier, claim / release, external facts recorded in full, store credit once, trial balance, wallet tender, accounting off, missing account.
- `tests/integration/repo-factory-payments-contract.test.ts` (3, Postgres 17 vs the DO schema): trial balance parity, refund by status, gold re-pricing.
- `apps/api/workers-do/payments.test.ts` (6, real workerd): 20 concurrent webhook replays apply once; 20 concurrent full-refund claims, one wins; one `refundKey` x20 one claim; 20 whole-order refund bookings restore stock once; 20 sale / refund posts post once with distinct numbers; `STORE_MISMATCH`.
- `tests/unit/webhook-do-resolver.test.ts` (8), `tests/unit/ledger-do-cash-codes.test.ts`.

## PR D2b-5 (Ruling CF-LAST-1)

Gold product pricing edits are money ops (`do/gold-pricing.ts`); `PaymentService.handleWebhook` / `refund` have an end-to-end Postgres-vs-DO contract (`tests/integration/repo-factory-payment-service-contract.test.ts`, stub provider adapter). The open list is `docs/cf/not-on-do.json`.
