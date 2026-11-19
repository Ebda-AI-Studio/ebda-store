# R-REFUND-PERIOD-1

Ruling R-REFUND-PERIOD-1 - a FULL card refund of the charge that paid the current plan ends that access at once (money-abuse audit S7, issue #840).

- **What happens.** `refundCharge` moves the subscription to free / `canceled` through `downgradeToFree`. That clears the provider and the saved card, and the `downgraded` effect drops every cache layer.
- **No automatic charge.** Nothing charges the card after the refund. Amended 2026-11-16 after review: the first version put the store into `past_due` with dunning, which would have charged the same card again about 3 days after the money went back.
- **Which charge counts.** Only the newest paid charge (checkout / renewal / upgrade) can own the current plan.
- **Partial refunds** never change the plan.
- **Goodwill refunds.** A super admin sets `keepAccess: true` (admin button "Refund, keep access") for a goodwill refund. The choice is stored on the refund row at CLAIM time, so an async gateway confirmation applies it the same way.
- **Re-subscribing** is a new paid checkout.

Evidence: tests/unit/platform-billing-refund-period.test.ts.

Cost if wrong: a mistaken full refund (meant as goodwill) puts a paying merchant on free until they subscribe again, or until a super admin re-assigns the plan.
