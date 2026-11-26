# MONEY-REVERSAL-1

> Section: 2026-11-15 — Money-abuse audit fixes (#837, branch `fix/out-of-band-refund-revokes`)

Ruling MONEY-REVERSAL-1 — a refund or chargeback that the card gateway makes OUTSIDE Ebda (a refund from the Kashier dashboard, a reversal, a bank dispute) is booked and acted on. It is never ignored.

Two paths book it, and both share `applyOutOfBandReversalInTx` and one idempotency key per gateway reversal id (`oob-reversal:<provider>:<ref>`):

- **The webhook path.** A signed, gateway-confirmed (PROVIDERS-17) `refund.succeeded` that matches no Ebda refund row is matched to the charge it reverses, by the echoed merchant order id or else by the charge's transaction id.
- **A daily reconcile** (`reconcileGatewayReversals` in `billing-renewal-daily`). It reads `listReversals` (the gateway's own transaction record) for every card charge of the last 120 days that still counts as paid.

**One identity for every refund:** the gateway's reversal id.

- A refund row with the same provider and ref, in ANY status, means the reversal is already booked. This covers refunds Ebda Store started and out-of-band ones alike, on both paths.
- `refundCharge` records its pending refund row BEFORE it calls the gateway. A webhook that arrives before the API call has written the ref attaches to that row when the amount matches or is not stated. Otherwise it answers a retryable 503, so the gateway redelivers.
- A succeeded Ebda refund with no gateway ref cannot be told apart from a new reversal. Nothing is booked and a person is paged.

What happens once it is booked:

- **Recorded in full, never refused** (global never-abort rule). The reported amount stays in `raw`. The ledger amount is clamped to what the charge still holds, and any excess is paged.
- **Full reversal.** The charge flips to `refunded` and the free months it earned are revoked. If it was the payment behind the current plan (the store's latest money-in row), OR the term it paid for is still running (renewal: from its `forPeriodEnd`; checkout/upgrade: from its settle, for one billing interval; e.g. a yearly payment later followed by an upgrade), the plan is revoked at once: `downgradeToFree(..., 'payment_reversed')`, which drops every cache layer. It is NOT sent into dunning, because retrying a card whose holder disputed the charge would charge them again.
- **Partial reversal.** No plan change. A person decides from the P1.
- **Paging.** Every booking raises a P1. So does a reversal that matches no charge, and so does an operation the code does not know.

Evidence:

- **Audit.** Money-abuse audit S6, 2026-11-15: `applyWebhookEvent` answered `ignore('unknown_refund')` for any refund Ebda did not start, and nothing modelled a chargeback.
- **Kashier's webhook docs** (developers.kashier.io/docs/webhooks, /docs/webhooks/payloads) list the event operations `pay, authorize, capture, refund, partial_refund, void, reject, reversal` and no chargeback or dispute event. That is why the reconcile exists.
- **Not verified.** The docs host was unreachable from the build machine on 2026-11-15, so this list comes from the docs' indexed text. The operation name Kashier would put on a chargeback in the transaction record is also unverified: `chargeback` and `dispute` are treated as reversals, and any other unknown operation pages a person.
- **Production.** `BILLING_PROVIDER=none` (InstaPay only), so neither path has anything to act on today. The reconcile makes no gateway call without a card provider or a charge in the window.

Cost if wrong: if Kashier names a chargeback something we do not list, it pages instead of auto-revoking. A person then has to downgrade the store by hand from the alert.
