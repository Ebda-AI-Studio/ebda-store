# OMD-4

> Section: 2026-10-01 — owner money decisions (branch `fix/owner-money-decisions-1001`)

**Ruling OMD-4 — the order page's partial refund sends its ledger event
immediately, not after the request commits.** PaymentService commits the refund
record on its own transaction before returning; deferring the event to the
request's commit (AP-2) would drop the ledger entry of a refund that stands
whenever the request then fails. The webhook path (no request) sends inline
before its idempotency write, so a failed send is retried; the refresh route
writes the payment row in the request, so its event rides the request commit.
A failed send on the order-page path raises the `partial_no_gl` P1 instead of
failing a refund that already happened; no sweep re-sends it. Cost if wrong:
that one refund's GL entry is booked by hand from the alert.
**Amended (issue 2310, backlog batch x-api):** the order-page path no longer books under an invented
key. When the provider returns NO refund id it used to fall back to `claim-<claimId>`, a key the
provider's settle webhook (which carries the real id) never repeats — so one refund could book
twice. With no id there is no key both paths share, so the in-band path books nothing and raises the
`partial_no_gl` P1 (saying why); the settle webhook, if the provider sends one, books it under the
real id. `postAmountOnlyRefundJournal` now logs its `already-posted` skip at warn with the amount.
Residual, unchanged by this: the same id-less refund's settle webhook is also read as a NEW refund
by `resolveRefundSettlement` (the id was never filed in `refundEventIds`), so the payment's
`refundedAmount` can count it twice. Cost if wrong: an id-less partial refund is booked by hand, or
by its webhook, and its payment balance may read short by that amount until reconciled — none of
the four provider adapters is written to expect an id-less answer (each reads one from the refund
response; whether a provider can omit it was not verified against its docs).
