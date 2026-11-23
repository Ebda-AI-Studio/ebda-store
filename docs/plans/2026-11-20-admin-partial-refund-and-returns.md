# Admin partial refund + merchant-opened returns (STORE-QA-76)

Finish line. Works: a merchant refunds PART of a delivered, paid order from the order page (lines, quantities, per-line restock, method) and opens a return for an order from /returns, then approves and refunds it with the existing steps. Exercised: the three API routes and the DO ops behind them on workerd. Must NOT change: the shopper return path (customer match, window, `condition` values), the full-refund button, the guest return form (PR #611). Done: DO tests green, tsc clean, bilingual copy, PR with the mutation check.

## What already existed (read, not rebuilt)

`refundOrder` partial arm, `createReturn` / `claimReturn` / `finishReturn` (allocation caps, one refundable balance #624, gateway claim, journal ops), `refund-via-provider` with `amount`. The gap was only: no merchant way to OPEN a return, a whole-remainder-only dialog, no per-line restock, no quote to show the remaining refundable.

## Design

- A partial refund IS a return (`type: refund`) opened by the merchant, approved, received and completed in one request. Reuses the whole engine, so the ceilings, journal and revenue rules are the proven ones.
- `createReturn({ byMerchant: true })`: uses the order's own customer, waives the customer-facing return window (the merchant decides), accepts `restock: false` per item. Delivered orders with a customer only; a guest order is refused with `GUEST_ORDER_RETURN_UNSUPPORTED` until #611's nullable customer lands.
- Ruling QA76-1 - the per-line "do not restock" flag rides `return_items.condition = 'no_restock'`, merchant-opened returns only (a shopper-supplied value is dropped). No schema change. Cost if wrong: a later dedicated column is one mechanical migration; today's `damaged` condition behaviour is untouched.
- Ruling QA76-2 - a return covering EVERY line takes the whole-order reversal, which restocks every line, so a mixed restock choice there is refused (`FULL_RETURN_RESTOCK_ALL`) before money moves; the dialog locks restock on and says so. Cost if wrong: the merchant leaves one unit out; no money is ever wrong.
- Not-restocked lines: no stock move (`refundOrder skipRestock`) and no inventory GL reversal (COGS stays expensed, `postPartialReturnJournal`).
- `analyticsRefundQuote` (read op, `analytics*` so it is read-only for the revenue cache): paid / refunded / refundable, per-line remaining, an estimate for a selection from the same `allocatePartialReturn`.
- Routes: `GET /orders/:id/refund-quote`, `POST /orders/:id/partial-refund` (Idempotency-Key required, `returns:write`, gateway or store-credit also needs `orders:refund`, impersonation refused), `POST /returns/admin`.
- Failure handling: if completion fails before money may have moved, the opened return is rejected so its lines are free to retry; an indeterminate provider failure keeps it for reconciliation (existing recovery).
- Revenue caches: every op used is a non-read-only money op, so `callMoney` invalidation of PR #982 (REVENUE-CACHE-1) covers it by default once that merges.

## Verify

Workerd (`apps/api/workers-do/admin-partial-refund.test.ts`): two partials sum to the paid total and a third is refused, net sales follows, restock per line + GL, forged flags, idempotent create, quote estimate = paid amount. Admin: tsc, key parity, Egyptian register, ActionFooter test.
