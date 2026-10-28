# CL-9

> Section: 2026-10-01 — backlog batch c-api-lib (branch `fix/backlog-c-api-lib`)

**Ruling CL-9 — the once-per-order refund notice claim is released per channel
(issue 2138, issue 2135); #1948 stays with the owner.** Amends Ruling R2-8: an
email-only failure now records `metadata.released: ['email']` on the single
`refund_notified` claim row instead of deleting it, so a replay sends the
email alone — not a second billed WhatsApp/SMS template and a second admin
push — and a later independent `order/refunded` for the order still finds the
claim. A claim row with no `released` list (every row written before this
change) means all channels were sent. Runs that started before the change
replay the claim step's memoized boolean, which is mapped to "all channels" /
"none". Issue 1948 (the notice is claimed at CANCEL, before money moves) is
NOT changed here: Ruling R2-5 already records it as an owner question about
what a customer is told at the cancel of a paid order. Cost if wrong: none new
— a replay after a release sends exactly the channel that failed.
