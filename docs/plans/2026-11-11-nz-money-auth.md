# NZ money + auth paths on a Durable Object store (2026-11-11)

The last `reachable-broken` rows of `docs/cf/neon-zero-final-classification.md`: money (refunds, the agent COD payment,
billing grants, the tax report, the WhatsApp COD outcome) and auth (customer MFA, the merchant e-mail flows). The Worker
has no Postgres (NZ-D23): every one of these answers 500 `POSTGRES_REMOVED` on a store on its Durable Object today.

Finish line:

- what must work: each path below answers on a DO store with the same business result it had on Postgres.
- exercised: InstaPay refund record, refund match-claim, agent `place_order` COD, WhatsApp COD outcome / cancel after
  erasure, billing grant award / restore / sweep, referral record, tax report + export, customer MFA enroll / verify /
  disable, merchant resend-verification / password reset.
- must NOT change: the Postgres legs (kept byte for byte where they still exist), every money and auth check (no check is
  weakened to make a port compile), the refund amount rules, idempotency of every replay.
- done: a workerd test on a store WITH orders and customers per path, red on the old code, green with zero Postgres
  reaches; unit tests for every failure path named below.

## Principles (apply to every item)

1. **One DO section owns each atomic write.** The Worker reaches the DO in separate calls, so a Postgres
   `BEGIN … FOR UPDATE … COMMIT` becomes ONE DO money op that does the read, the checks and every write in
   `db.transactionSync` (the DO serialises a call; it does not serialise a read in one call and a write in another).
2. **DB write + irreversible external call = a resumable claim, never "write then hope".** The claim is committed first,
   the external call runs outside every transaction, the outcome is recorded by a second op; a retry finds the claim and
   resumes (the existing `refundBegin → provider → refundComplete / refundRelease / refundIndeterminate` shape).
3. **Idempotency keys are business keys**: the InstaPay refund reference (`referenceKey`), `refundKey` (`return:<id>`),
   the order id for a COD payment (the DO reuses the open COD row), the grant `idempotency_key` on D1.
4. **Tenant scoping**: a DO op runs inside ONE store's DO (`storeMoney(storeId)`), and every op still checks `store_id`
   on each row it reads; a D1 statement names `store_id` in its WHERE. The store id is the one the route authorised
   (`requireStoreAccess`), never a body field.
5. **Partial failure**: every multi-call flow states its order of calls and what a crash between two calls leaves, and
   the retry path that completes it (below, per item). Compensation is forward (resume) unless an external effect can be
   undone (the R2 screenshot).

## M1. InstaPay refund record (`instapay.service.ts` recordRefund, POST /stores/:storeId/orders/:orderId/instapay-refund)

No external money call: InstaPay refunds are made by the merchant in their bank app and RECORDED here. External effects:
the R2 screenshot (reversible: `deletePrivate`) and `OrderService.updateStatus(refunded)` (stock / coupon / loyalty
effects + notifications, already DO-ported).

- New DO money op `instapayRefundRecord { orderId, referenceKey, amountMinor, record }`, one `transactionSync`:
  order exists in this store and is not deleted -> latest `instapay` payment in (completed, partially_refunded, refunded)
  else `NO_INSTAPAY_PAYMENT` 409 -> `metadata.refunds[].referenceKey === referenceKey` -> return `{ duplicate: true, … }`
  -> `remaining = amount - refunded_amount`, `<= 0` -> `ALREADY_REFUNDED` 409, `amountMinor > remaining` ->
  `INVALID_REFUND_AMOUNT` 400 -> update payment (status, `refunded_amount + amountMinor`, refunds appended) -> insert the
  `refund` payment event -> if full, `orders.payment_status = 'refunded'`. Returns `{ duplicate, full, paymentId,
fromStatus, status, refundedAmount }`.
- Order of calls in the service: (1) R2 put; (2) the op; (3) if `full` and the order is not `refunded`:
  `OrderService.updateStatus(refunded)`.
- Partial failure: crash after (1) -> the catch deletes the screenshot (nothing committed). Crash after (2) -> the refund
  IS recorded: the screenshot must NOT be deleted (the record points at it), so the catch deletes it only when the op did
  not commit. A retry with the same reference gets `duplicate: true`; when the payment is `refunded` and the order is not,
  the retry runs step (3) (forward completion), so the order always converges.
- Tests: duplicate reference (no second increment), over-remaining 400, no payment 409, full refund flips both
  statuses, partial leaves the order, step (3) failure then retry converges, screenshot kept after a committed op.

## M2. Refund match-claim (POST /stores/:storeId/orders/:orderId/refund-match-claim)

The DO function `matchRefundToClaim` (`packages/repo/src/do/payments.ts`) exists and is unit-tested but is not a money op.
Wire it: `refundMatchClaim { claimId, providerRefundId, actorUserId }` in `MONEY_OPS` + `MoneyClient`, and an
`if (await storeMoney(storeId))` branch in the route before `inSettlementTx`. One DO section (it already uses
`transactionSync`); `already_matched` is the idempotent replay; its refusals keep their 409 mapping.

## M3. Gateway refunds (`PaymentService.refund`)

Already DO-guarded (`refundOnDo`, claim -> provider -> outcome, `refundKey` refuses a double attempt) whenever `storeId`
is passed; all four callers pass it (order.routes, payment.routes, return.service x2). No change; a guard test asserts
`refund()` without a store id on a DO-only Worker never reaches Prisma.

## M4. Agent `place_order` COD payment (`mcp/tools/order.tools.ts` ~L196-300)

Replace the Postgres `tx.payment.create` + `recordPaymentEvent` with `PaymentService.recordCodPayment` (the storefront
COD path: DO `paymentCreate` writes the payment, its `created` event and the index rows in ONE section, and reuses the
open COD row of the order = idempotent per order). `auditLog('payment.created')` only when `!replayed`. On a create
failure the existing `OrderService.rollbackForPaymentFailure` (DO `cancel { unpaidOnly }`) runs without a tenant wrap.

## M5. Billing grants (`billing/grants.service.ts`)

The billing models are served from D1 by the router; the blockers are `inOwnTx` (`runInTenantContext`) and the
`recordReferral` store-owner read (`withStore`). On D1, `inOwnTx` runs `fn` directly: the atomic pieces already are
single D1 statements / batches (`insertCappedGrant` = lock-then-count in ONE statement with `ON CONFLICT
(idempotency_key) DO NOTHING`; `applyGrantsBatchD1`, `revokeGrantsD1`, `claimRestoreD1`). The owner read becomes a D1
read of `stores.owner_id`. No money moves here (grants are free months), so no external call.

## M6. Tax report (`accounting/tax-report.service.ts`, GET finance tax report + .xlsx)

New DO read op `taxReportLines { fromMs, toMs }`: the SQLite twin of the raw Postgres query (journal entries with
`source = 'order'`, status posted / reversed, in the window; account 2100 = tax, 4000 = base; order id =
`substr(source_id, 1, instr(source_id || ':', ':') - 1)`; `HAVING tax <> 0`; ordered by posted_at, order_number). The
customer name comes from the store's `customers` row of the order's customer, else the shipping-address snapshot
(`json_type`-guarded `firstName` / `lastName`), since `users` is not in the Worker. Read-only.

## M7. WhatsApp COD outcome + cancel after erasure (`lib/wa/store-events-consumer.ts`)

Read the order through `storeDb` (no `FOR UPDATE`), keep the eligibility checks, then `OrderService.updateStatus`
(DO state machine). Check-then-act: the DO status transition re-validates the FROM status inside its own section, so a
ship that lands between the read and the op makes the cancel fail instead of cancelling a shipped order; the consumer
treats that refusal as "no longer eligible" (ack, audit the skip), never a retry loop.

## A1. Customer MFA on a DO store (`routes/mfa.routes.ts`)

TOTP is deliberately not ported to the DO (Ruling NZ-N9-1): a DO login of an MFA account already refuses
(`mfaUnavailable`), and `passkeyAdd` refuses MFA accounts. The four MFA handlers have no DO branch and 500. Decision:
for a customer whose store is on its DO they answer the same `MFA_UNAVAILABLE` 409 BEFORE any `withUser`
(enroll/begin, enroll/verify, disable via `customerAuthRoute(storeId)`; verify refuses a challenge for a DO store). This
keeps the existing policy; it never weakens it (no path enrols or disables without the TOTP proof). Passkeys: every
customer path already branches to the DO (`doClientFor`); the test asserts the list / rename / remove calls stay off
Postgres.

## A2. Merchant e-mail flows with no store (`auth.service.ts` resend verification, password reset)

Merchants are identity-managed (Rulings ID-1..ID-11). With `storeId` null on a Postgres-less Worker these two flows
answer the enumeration-safe generic success (as a missing user does) and, for the reset, delegate to the identity
service (`forgotIdentityPassword`), never reaching `withUser`. Same response shape and timing class as today.

## Order, PRs, tests

- PR G3a (money): M1, M2, M4, M7 (+ M3 guard test). Workerd: third case of `merchant-orders-do.test.ts`.
- PR G3b (accounts + books): M5, M6, A1, A2. Workerd: `account-books-do.test.ts` (same fixture shape: a DO store with
  orders and customers; journal postings produced by running the `order/created` jobs inline via `/__dev/run-event`).
- Each red-run on the old code is recorded in its PR body; Rulings `NZ-MONEY-1` (M1/M2/M4/M7) and `NZ-ACCT-1`
  (M5/M6/A1/A2) are written when each PR lands.
