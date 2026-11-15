# MONEY-REVERSAL-2

> Section: 2026-11-16 — Money-abuse audit fixes (#837 review follow-up, branch `fix/out-of-band-refund-revokes`)

Ruling MONEY-REVERSAL-2 — a PENDING Ebda Store refund counts as "its gateway call is still running" for 15 minutes only (`REFUND_IN_FLIGHT_MS`).

**Inside the window**, a gateway refund webhook for that charge is handled by amount:

- same amount → it attaches to the pending row and settles it;
- no amount stated → it answers a retryable 503, so the gateway redelivers;
- a different amount → it is a different refund, so it is booked out-of-band and paged.

The daily reconcile waits for an in-flight row.

**Past the window** the pending row never blocks:

- The reported reversal is booked once and access fails CLOSED (the plan it paid for is revoked). A P1 fires, because the money fact is never lost.
- A stale pending row of the same (or an unstated) amount is closed `failed` with `superseded_by_gateway_reversal:<ref>`, so it can never settle a second time. If it was a real second refund, the gateway lists its own ref and the daily reconcile books it.
- The stuck-charge sweep also asks the gateway about every pending refund past the window, through the charge's record (`listReversals`). Its ref listed as a successful reversal settles it `succeeded`. Anything else stays pending and is paged; it is never failed blindly.

Evidence: security review 2026-11-16 (2× MEDIUM). Before this ruling, a stuck pending row made the webhook answer 503 forever and the reconcile drop the reversal silently, so a real reversal was never booked and access was never revoked.

Cost if wrong: a gateway that answers an Ebda refund call more slowly than 15 minutes has its own refund booked as out-of-band. The plan is then revoked on a refund a super admin chose to make (a goodwill refund). A P1 says so and the plan can be re-assigned by hand.
