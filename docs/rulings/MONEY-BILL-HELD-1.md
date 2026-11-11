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
