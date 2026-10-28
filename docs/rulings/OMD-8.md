# OMD-8

> Section: 2026-10-01 — owner money decisions (branch `fix/owner-money-decisions-1001`)

**Ruling OMD-8 — merged over #2279 (`fix/backlog-a-money-services`, merged to
main during this branch): its `alertUnbookedRefund` helper is kept, and two of
its three `partial_no_gl` call sites are removed because those refunds are now
booked.** The webhook and refresh-route sites book instead; the order-page site
keeps `alertUnbookedRefund({ kind: 'partial_no_gl' })` only for an event that
could not be queued. #2279's `held_unaccounted` and `held_provenance_unknown`
alerts are unchanged. Its new partial-return stuck sweep never arms an
amount-only event (`restoreInventory: false`, and no Return row has a
`refund:<id>` key), so a refund outside a return has no sweep behind it (OMD-4).
Cost if wrong: none known beyond OMD-4's.
