# AN-1

> Section: 2026-09-30 — Analytics batch 1 (branch `fix/analytics-batch-1`, PR #2220)

**Ruling AN-1 — on a store that takes guest orders, a 0 from an `abandoned_carts`-derived metric
renders "not tracked for guest checkout"; a non-zero count renders as a number labelled
"registered customers only".** Abandoned carts are recorded only with a customer contact, so a 0 on
such a store says nothing about shoppers (demo-store: 0 checkouts started vs 55 completed in 30d).
"Takes guest orders" = at least one order with `customer_id IS NULL` in the surface's window (90d
for abandoned-cart stats). Paid or not: every surface reads it through `storeTakesGuestOrders`
(`lib/guest-checkout.ts`) — the insights dashboard used to derive it from its PAID orders and read
`false` on a store whose guest orders are unpaid COD (issue 2257). A non-zero count is real, just
partial, so it is kept rather than hidden.
Cost if wrong: a mixed store (e.g. wady-aljuz, 5/41 orders registered) shows a registered-only
undercount next to all-customer figures; the label is the only guard against reading it as total.
