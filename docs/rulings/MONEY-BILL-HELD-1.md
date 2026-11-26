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

Review of #687 (AI review, critical + 8 warnings), how each landed:

- Resolve order and retry (critical): the LEDGER row closes first (idempotent), the queue entry second. A failure at the queue step leaves
  the entry open and the retry completes it. A queue entry an earlier build already closed while its ledger row stayed `held:` is
  resolvable again with the action it recorded (a different action is 409 `HELD_PAYMENT_ACTION_CONFLICT`, an entry with nothing left to
  close is the usual 409 `HELD_PAYMENT_NOT_OPEN`). Resolving applies no plan change: a hand credit is a person's act, so nothing can apply twice.
- Platform client (warning 1): `billing_webhook_events` is a platform D1 model and in the tenant guard's GLOBAL_MODELS (no tenant scope
  applies). The list, the resolve and the open-hold digest use one `heldQueueDb()`: the platform D1 client once billing is on D1, the
  Postgres client before that; no bare `prisma as unknown as Tx` at the call sites.
- A later delivery never rewrites the first hold reason (warning 2), an open hold is re-alerted by every sweep (warning 3, the digest), a
  hold on a no-longer-open row queues nothing and the replaced decline reason is kept as `priorFailureReason` (warning 4), the amount
  unit of Kashier's lookup is decimal EGP converted to piastres and pinned by a test (warning 6).
- Admin route (warning 7): `requireRole('super_admin')` is the file's own convention for every management route. The audit row is written
  BEFORE the change on purpose (a resolve that cannot be audited changes nothing); the opposite residual, an audit row for a resolve that
  then fails, is harmless because the resolve is retriable and idempotent. The note is audit-only, never shown to merchants.
- Panel (warning 8): every error refreshes the list (a 409 never leaves a stale open row); a conflicting earlier decision shows the
  server's own sentence.

Runbook note, resolving a hold as `credited` (money review of #687): this only closes the hold. The original ledger row moves to `failed` /
`held_resolved:credited` and is never settled, so the money reaches the books only when the operator ALSO records the payment on the
manual payment form (`POST /admin/stores/:id/manual-payment`, which writes its own `manual_payment` ledger row and moves the subscription).
Order for a paid-but-unmatched charge the team accepts: record the manual payment first, then resolve the hold as `credited` with the
manual payment's reference in the note. The held payments panel says this next to the action (`billingEvents.held.creditedHelp`, ar + en).
`refunded` and `not_ours` need no second step.
