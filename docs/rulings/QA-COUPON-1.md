# QA-COUPON-1

> Section: 2026-11-03 - QA store full run, branch `fix/qa-p1-coupon-price-holds`

**Ruling QA-COUPON-1 - an order is never charged more than the last total the buyer saw.** The storefront always sends `expectedTotal` (the fresh server quote total, else the total on screen; `expectedTotalToSend`), so a coupon dropped between quote and order, a stale estimate or a repricing becomes `409 PRICE_CHANGED` with the new total, never a silent charge. A percentage or fixed coupon stored with value 0 is refused (`COUPON_VALUE_REQUIRED` / `INVALID_COUPON`) in `CouponService.getByCode` (validate, quote, order) and in the Durable Object `checkout.ts`, so it can no longer be "accepted" and then charge full price.

Evidence: QA run 2026-11-03 (`business/ebda/audits/2026-11-03-qa-store-full-run.md`, P1-1): UI quoted 420 EGP, order created at 510 with no coupon. The client sent `expectedTotal` only when a fresh held quote existed (`expectedTotalFor` returns undefined otherwise) and the server compares only when it is present, so any gap in the quote left the order unguarded. The exact point where the coupon was lost on the live store was NOT reproduced locally (every code path read here carries `couponCode` end to end; the QA coupon was saved with value 0 by the form). Tests: `apps/web/src/lib/checkout-quote.test.ts`, `packages/repo/test/do-order-ops.test.ts` (DO), `tests/unit/sellable-price.test.ts`, `tests/integration/qa-coupon-and-holds.test.ts` (Postgres, needs a database).

Cost if wrong: a buyer whose local estimate differs from the server (rounding, tier price) gets one extra PRICE_CHANGED round trip instead of a silent charge; if the real drop is elsewhere the guard still refuses the order, but the cause stays open.
