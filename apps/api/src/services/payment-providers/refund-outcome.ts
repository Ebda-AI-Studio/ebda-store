/**
 * What a failed refund attempt tells its caller about the money.
 *
 * A refund has exactly two failure shapes that matter, and they need opposite
 * handling:
 *
 *  1. NOTHING WAS SENT, or the provider answered and said no. The payment's
 *     claim can be released and the merchant can safely try again.
 *  2. THE MONEY MAY HAVE MOVED: the request reached the provider and we never
 *     got a clear answer (timeout, dropped connection, 5xx), or the provider
 *     said yes and something after that failed. Releasing here and letting the
 *     merchant retry pays the customer twice. Gateway refunds have no
 *     undo API.
 *
 * Callers used to infer which one happened by re-reading
 * `Payment.refundedAmount` after the throw. That column is shared, so a
 * concurrent refund that moved it made a harmless failure look like shape 2
 * (#1431), and PaymentService reset it on every provider throw, including a
 * timeout, so a real shape 2 looked like shape 1 (#1359). The code that made
 * the call is the only place that knows which it was, so it says so here.
 *
 * Dependency-free on purpose: ReturnService and its tests import it without
 * pulling in the payment factory.
 */

/**
 * The provider did NOT execute this request. Either it answered with an
 * explicit rejection (a 4xx, or a 2xx whose body says the call failed), or the
 * request was never sent. Anything that is not this — a network error, a
 * timeout, a 5xx, an unparseable body — is treated as "may have executed".
 */
export class ProviderRejectedError extends Error {
  constructor(
    message: string,
    /** HTTP status of the provider's answer; 0 when the request was never sent. */
    readonly httpStatus: number
  ) {
    super(message);
    this.name = 'ProviderRejectedError';
  }
}

/**
 * The error a provider's HTTP helper should throw for a failed call.
 *
 * `responseOk` is true when the HTTP call itself succeeded and only the body
 * reported failure: the provider processed the request and refused it. A 4xx is
 * also a refusal, except 408, which is the server giving up on the request, not
 * a decision about it. A 5xx can come after the provider has already acted, so
 * it stays an ordinary Error.
 */
export function providerRequestError(
  message: string,
  httpStatus: number,
  responseOk: boolean
): Error {
  const refused = responseOk || (httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408);
  return refused ? new ProviderRejectedError(message, httpStatus) : new Error(message);
}

const MAY_HAVE_EXECUTED = new WeakSet<object>();

/** Tag an error as "the refund may have gone out". Returns the same error. */
export function markRefundMayHaveExecuted<T>(err: T): T {
  if (err !== null && typeof err === 'object') MAY_HAVE_EXECUTED.add(err as object);
  return err;
}

/**
 * True when the refund that threw `err` may have reached the customer. Only
 * PaymentService.refund sets it, and only after it has sent the request to the
 * provider.
 */
export function refundMayHaveExecuted(err: unknown): boolean {
  return err !== null && typeof err === 'object' && MAY_HAVE_EXECUTED.has(err as object);
}

/**
 * `payment_events.event_type` values PaymentService.refund writes for each
 * refund it attempts, keyed by a `claimId` in `details`. The admin order page's
 * payment-events timeline labels all four. A claim with neither a completed
 * nor a failed event is a refund whose outcome nobody knows.
 */
export const REFUND_CLAIM_EVENT = 'refund_initiated';
export const REFUND_EXECUTED_EVENT = 'refund_completed';
export const REFUND_RELEASED_EVENT = 'refund_failed';
export const REFUND_INDETERMINATE_EVENT = 'refund_indeterminate';
/**
 * A claim whose outcome the MERCHANT settled: they checked the provider and
 * completed the return with a non-gateway method ("Already refunded — record
 * only"). Resolves the claim for the stuck-claim sweep (issue 2002). It moves
 * no money and does not touch `refundedAmount` — the claim already counted it.
 */
export const REFUND_RECONCILED_EVENT = 'refund_reconciled';
/**
 * A settle webhook was reconciled with (and CONSUMED) this in-band claim: `details = { claimId, refundId, amount }`.
 * One claim absorbs at most one webhook, so a second genuine refund of the same amount is added, never swallowed.
 */
export const REFUND_ABSORBED_EVENT = 'refund_webhook_absorbed';
/** A claim was released AFTER a webhook reported its refund completed: needs a human, moves no money. */
export const REFUND_REVIEW_EVENT = 'refund_reconcile_review';
