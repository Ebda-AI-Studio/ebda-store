# MONEY-LOYALTY-LOTS-1

> Section: 2026-11-12 (issue #631, money backfill audit)

**Ruling MONEY-LOYALTY-LOTS-1 - loyalty points are lot-aware without a schema change, and a
refund reversal is never forgiven.** (1) `reverseEarnedPointsFromOrder` takes back the FULL
points the order earned. Points already spent (for example redeemed as a discount on another
order) leave the balance negative. That debt is paid by the next points earned, and a
negative balance cannot redeem (the redeem gate needs `points >= n`). Before this, the clawback
was floored at the balance, so redeem-then-refund kept the discount for free. (2)
`lotRemaining` replays one customer's ledger in time order. Every positive row is a lot. A
`refund-revoke:<earnTxId>` reversal consumes its own lot first; redeems, expiries and negative
adjusts consume the oldest lots first. What a lot cannot cover is debt, which the next lot pays
first. `expirePoints` expires only the remainder of the expiring lots, capped at a positive
balance. So reversed, redeemed or debt-paying points never expire a second time against
unrelated points. Existing rows are classified the same way (no backfill). The Postgres
`LoyaltyService` keeps the old floor; it cannot run in the Worker (NZ-D23). Evidence:
`packages/repo/test/do-loyalty-lots.test.ts` (the issue's three scenarios plus a partial lot,
all red on main). Cost if wrong: a customer may see a negative points balance after a refund,
which support explains as points spent before the refund; FIFO is an approximation of which
lot an old expiry consumed, so an expiry written before this change may be attributed to a
different lot than it originally drew from.
