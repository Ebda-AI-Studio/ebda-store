# MONEY-BILL-HELD-1

> Section: 2026-11-12 (issue #627, money backfill audit)

**Ruling MONEY-BILL-HELD-1 - a signed subscription `charge.succeeded` that does not match
what we billed is HELD, never ignored.** Holding reasons: unknown order, a different amount or
currency, no amount or currency, or a charge against a card-saving row. The dedupe row
`billing_webhook_events` keeps outcome `held` with the facts as JSON in `detail` (no schema
change: `outcome` is free text). A store-scoped P1 `sendAlert` goes out after the commit.
The super-admin `/billing-events` page lists it under "Held payments" until a person resolves
it (`credited` / `refunded` / `not_ours`, with a note, audited as
`billing.held_webhook_resolved`). The provider still gets 200 and a redelivery is a replay. A
failed or card event that mismatches stays `ignored`, because no money moved. Nothing is
settled automatically from a held event. Evidence: `tests/unit/platform-billing-d1-money.test.ts`
(#627 block, red on main). Cost if wrong: an over-strict reason (for example a provider that
legitimately omits currency) leaves a paid merchant un-upgraded until someone resolves the row
from the alert.

**Amended after the #687 review (a held charge was still upgraded by the stuck-charge sweep):**
every settle path goes through ONE predicate, `maySettle` (subscription-billing.service.ts),
evaluated inside `settleInTx`. That covers the webhook, the synchronous charge answer, the
hourly `sweepStuckCharges` gateway lookup, and the failure settles (unreadable card, declined
lookup, not found). The predicate refuses any settle of a row whose
`failure_reason` carries `held:<reason>` (a webhook hold now marks its ledger row too). It also
refuses to settle a SUCCESS on a charge row unless the amount is ours (`charge_request`: the
gateway's direct answer to our own charge of that row) or the gateway STATED an amount and
currency equal to the row. A bare SUCCESS (for example a status lookup with no amount) holds
the row and adds it to the same queue (`settle:<rowId>`, once) with a P1. Resolving writes the
audit row first (`auditLogStrict`: an audit failure refuses the resolve), then closes the hold
and moves the held ledger row to `failed` / `held_resolved:<action>`, with no dunning effects,
so no sweep picks it up again. Kashier's transaction lookup now reads the stated amount and
currency when the body carries them; the stub states what it charged.
