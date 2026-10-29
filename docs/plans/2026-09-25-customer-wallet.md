# D1 — Customer Wallet (store credit)

Date: 2026-09-25 · Branch: `feat/d1-customer-wallet` · Owner rule: **production must not break**.

## Why

`ReturnService.complete` already accepts `store_credit` as a refund method and
`Return.refundMethod` records it, but nothing backs it: a "store credit" refund
today means "the merchant sorted it out off-platform". The wallet is where that
credit lands, where the merchant can see and adjust it, and (behind a second
toggle) where the shopper can spend it at checkout.

## Finish line (stated before starting)

- **Must work:** a return completed with `store_credit` credits the customer's
  wallet exactly once; an admin can credit/debit a wallet with a required note
  (audited); the customer sees balance + history on `/account/wallet`; with the
  checkout toggle on, a signed-in customer can pay part or all of an order from
  the wallet, and a cancel/refund of that order puts the wallet portion back
  exactly once.
- **Exercised by:** unit tests on the ledger service (no-negative, idempotent
  replay, key reuse, lock-before-read), integration tests against Postgres
  (concurrent debit race, return→credit, checkout debit + reversal on cancel,
  payment-create rollback reversal, feature-off checkout unchanged, erasure,
  export), route 403s with the feature off, and a defence-mutation record for
  the two money guards.
- **Must NOT change:** anything a store without `customer_wallet` sees. Every
  new route is behind `requireFeature('customer_wallet')`; every checkout /
  payment / refund code path is a no-op when `Order.walletAmount = 0`, which is
  the column default and the value of every existing order.
- **Done =** `tsc --noEmit` clean for api/admin/web/shared, the unit suite green,
  lint 0 errors, format clean, the integration suite green (locally against a
  PG cluster, and in CI), the mutation record shows both money guards KILLED,
  PR open with the unverifiable half stated.

## Rollout / flags

| Key                        | Registry           | Baseline | Default | Gates                                                                   |
| -------------------------- | ------------------ | -------- | ------- | ----------------------------------------------------------------------- |
| `customer_wallet`          | un-hidden, `addon` | none     | **OFF** | every wallet route, admin pages, storefront account page, return→credit |
| `customer_wallet_checkout` | new, `addon`       | none     | **OFF** | the checkout "use wallet balance" option only                           |

Feature resolution (verified in `feature.service.ts` `rowsToMap`): start
all-false → turn on `PLAN_BASELINE[plan]` → apply `StoreFeature` override rows.
Neither key is in any baseline (`plan-baselines.ts`), so a store only gets them
through an explicit super-admin override. Toggles live on the super-admin
`FeatureMatrix` (`/stores/[id]/features`) — un-hiding makes them appear there.

**Found during the build (Ruling W-1):** production already had an enabled
`customer_wallet` override on the live `demo-boutique` store, left by an
enable-everything sweep while the key was a hidden no-op. Relying on "no
baseline → off" alone would have switched the wallet on there at deploy. The
migration resets every `customer_wallet` override to `enabled = false`, the API
feature cache moves to the `features:store:v3:` namespace so no cached `true`
survives, and the storefront shows wallet UI only when the wallet endpoint
itself answers 200 (never on the edge-cached `enabledFeatures` alone).

Checkout debit ships **behind the second toggle** because it is the only part
that touches the money path of every order (payment amount, COD amount,
cancellation reversal). The credit/admin/customer-view half is useful on its
own and can be switched on first.

**Accounting (Ruling W-3):** wallet checkout is refused while the store has
accounting enabled — the GL has no store-credit liability account yet.
`accountingEnabled` defaults to true and is on for all three live stores, so in
practice wallet spending needs the GL follow-up before it is usable there.

## Data model

```
enum WalletTransactionType { credit debit refund_credit order_payment
                             order_payment_reversal admin_adjust expire }

customer_wallets        (cached balance, one row per store+customer)
  id, store_id, customer_id → users (RESTRICT), balance INT >= 0 (CHECK),
  created_at, updated_at
  UNIQUE (store_id, customer_id); INDEX (store_id, balance); INDEX (customer_id)

wallet_transactions     (append-only ledger — the source of truth)
  id, store_id, wallet_id → customer_wallets (CASCADE),
  customer_id → users (RESTRICT), amount INT signed (CHECK <> 0),
  balance_after INT (CHECK >= 0), type, order_id → orders (SET NULL),
  return_id → returns (SET NULL), idempotency_key, actor_id, note, created_at
  UNIQUE (store_id, idempotency_key)
  INDEX (store_id, customer_id, created_at); INDEX (wallet_id); FK-only
  indexes on order_id and return_id

orders.wallet_amount INT NOT NULL DEFAULT 0 (CHECK >= 0)
```

- Money is integer piastres everywhere; no floats (UI converts EGP↔piastres with the
  existing format helpers).
- `store_id` on every row; RLS copied verbatim from
  `20260911190000_merchant_api_keys` (latest store-scoped policy set:
  `current_store_id() IS NULL OR app.bypass_rls = 'true' OR store_id =
current_store_id()` for SELECT/INSERT/UPDATE/DELETE, ENABLE + FORCE).
- Customer FK is **RESTRICT**, not CASCADE like loyalty: a money ledger must
  not vanish because someone hard-deleted a user row. The one hard-delete path
  for users (`DELETE /admin/users/:id`) already maps P2003 to a clean 409.
- Hand-written `rollback.sql` drops the two tables, the enum and the column.

## Invariants

1. `balance = SUM(amount)` over the wallet's ledger rows, and every row's
   `balance_after` is the running sum. Maintained because every write goes
   through one function (`WalletService.applyEntry`).
2. **Balance never negative** — enforced twice: the service refuses under the
   row lock, and the DB CHECK on `customer_wallets.balance` /
   `wallet_transactions.balance_after` refuses if the service is bypassed.
3. **Idempotent writes** — every entry carries an idempotency key; a replay
   returns the original entry and moves no money; the same key with a
   different amount/customer/type is a 409, never a silent second write.
   UNIQUE `(store_id, idempotency_key)` is the backstop.
4. **Serialised per wallet** — `INSERT … ON CONFLICT DO NOTHING` then
   `SELECT … FOR UPDATE` on the wallet row; the idempotency re-check and the
   balance check both happen AFTER the lock, so two concurrent debits (or two
   deliveries of the same key) cannot both pass.
5. Runs on the caller's transaction: the ambient request tx under
   `tenantContext` (so a return completion and its credit commit or roll back
   together), the order-create `tx` for checkout, `runInTenantContext` in the
   Inngest fanout, and its own `withMoneyTx` only when there is none.
6. Guests have no wallet (no `customerId` → nothing is read or written).

## Write paths (all idempotent)

| Path                                                                  | Key                                        | Where                                                            |
| --------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------- |
| Return completed with `store_credit` (feature on, type return/refund) | `return-credit:<returnId>`                 | `ReturnService.complete`, same tx as the completion write        |
| Admin adjust (credit/debit, note required, audited)                   | client-supplied UUID `admin-adjust:<uuid>` | `POST /stores/:storeId/customers/:customerId/wallet/adjustments` |
| Checkout debit (both toggles on, signed-in, balance > 0)              | `order-payment:<orderId>`                  | `OrderService.create`, inside the order tx                       |
| Reversal on cancel/refund (whole order)                               | `order-payment-reversal:<orderId>`         | `order-refunded` fanout step `reverse-wallet-payment`            |
| Reversal on payment-create failure                                    | same key as above                          | `OrderService.rollbackForPaymentFailure`, inside its tx          |
| Forfeit on erasure                                                    | `erasure-forfeit:<walletId>:<lastEntryId>` | `AuthService.eraseAccount`                                       |

### Return → credit amount

Uses the same allocator the gateway branch and the GL use
(`allocatePartialReturn`, prior completed returns subtracted):

- partial return: credit = `cashCredit` (net of discount, incl. tax); zero → 400.
- full return: credit = `cashCredit + shipping − order.walletAmount` (floored
  at 0). The whole-order fanout puts `walletAmount` back separately, so the
  customer ends up with exactly what the order cost, once.
- exchanges never credit (an exchange moves no money — same rule the gateway
  branch already enforces).
- feature OFF: `store_credit` keeps today's meaning (off-platform), unchanged.

`Return.refundAmount` is overwritten with the credited figure, as the gateway
branch already does with the provider amount.

### Checkout debit

- `Order.total` keeps meaning "order value". `walletAmount` is the part settled
  from the wallet; **amount due = `total − walletAmount`**. Every place that
  charges money reads the amount due: `/payments/create` (online + COD),
  `PaymentService.retryPayment`. With `walletAmount = 0` both are byte-for-byte
  the old value.
- Fully covered (`walletAmount = total > 0`): the order is created
  `confirmed` + `paymentStatus: paid`, `order/created` fires (as for COD), the
  storefront skips `/payments/create` and goes to the success page, and
  `/payments/create` refuses such an order (409) so a replay can never mint a
  gateway invoice for money already paid.
- Blocked while `store.accountingEnabled` (see Ruling W-3).
- The debit throws `INSUFFICIENT_WALLET_BALANCE` inside the order tx if a
  concurrent spend drained the balance → the whole order rolls back.

### Reversals

- The fanout step runs only for a WHOLE-order event (`partial` absent) and only
  when `reverseWallet !== false`. `applyRefundEffects` gains
  `reverseWallet?: boolean` (default true); the backorder single-line cancel
  passes `false` so cancelling one backordered line can never hand back the
  whole wallet payment.
- `rollbackForPaymentFailure` stamps `refundReversedAt` itself (the fanout never
  runs for it), so it re-credits inside its own tx.

## UI surfaces

Admin (bilingual en/ar, RTL, compact per design.md):

- Customer detail: **Wallet** card — balance, ledger (load more), **Adjust**
  modal (credit/debit, EGP amount, required note). Registered customers only.
- **Sales → Wallet** tab `/stores/[id]/wallet`: outstanding total, count of
  customers holding a balance, customers-with-balance table linking to the
  customer page, and the checkout-toggle status (incl. the accounting block).
- Returns: the refund-method picker states that store credit lands in the
  wallet when the feature is on; the return detail shows the credited amount.
- Order detail (admin + orders PWA): "Paid from wallet" + "Amount due" lines
  when `walletAmount > 0`.

Storefront (copy through `LanguageContext` `t(en, ar)`):

- `/account/wallet`: balance + history; nav entry gated on the feature.
- Checkout: "Use wallet balance (X EGP)" toggle (both toggles on, signed in,
  balance > 0); summary shows the wallet line and the amount due.
- Customer order detail: "Paid from wallet" line.

## Erasure / export

- Export (`AuthService.exportAccount`) adds `wallets` + `walletTransactions`.
- Erasure keeps the ledger (a financial record; it holds no PII once notes are
  scrubbed), nulls every `note`, and **forfeits** any positive balance with an
  `expire` entry so the merchant's outstanding-liability figure stays true
  (Ruling W-4). The erase modal warns when a balance exists.

## Tests

- `tests/unit/wallet-service.test.ts` — no-negative guard, replay, key reuse
  409, lock issued before the balance read, customer-not-in-store refusal.
- `tests/integration/customer-wallet.test.ts` — real Postgres: concurrent debit
  race (FOR UPDATE), DB CHECK backstop, return→credit (partial + full), checkout
  debit partial + full, cancel → reversal idempotent across redelivery,
  payment-create rollback reversal, feature-off checkout ignores `useWallet`,
  erasure forfeit + note scrub, export.
- Feature gate: routes 403 with the feature off (integration).
- Defence mutations (unit tier): remove the no-negative check → red; remove the
  idempotency re-check → red. Recorded via `DATABASE_URL=<migrated Postgres> npm run test:defence-mutations -- --write --tier=all`
  (`--write` refuses any partial tier since #1233/#1262 — see issue 2192).

## Rulings

Recorded in `docs/RULINGS.md` under 2026-09-25 (W-1 … W-6).

**Update 2026-10-29 (Ruling W-8):** both keys are now in the Growth and Business baselines; the "no baseline" statements above describe the original D1 release.
