import logger from '../../lib/logger';

/**
 * Does a reported refund settle the payment, and what is the cumulative total?
 *
 * This existed twice — once in the refund-webhook branch of payment.factory.ts,
 * once in the refresh-refund-status route — and the two copies diverged twice
 * in a single evening, in opposite directions:
 *
 *  1. The whole-order effects gate was added to the route and not the webhook,
 *     so a partial out-of-band refund still restored all inventory and reversed
 *     the entire sale journal.
 *  2. The unknown-amount rule was then added to the webhook and not the route,
 *     so an amount-less provider response was recorded as a 0-piastre PARTIAL
 *     refund — suppressing every reversal while the money had already left the
 *     gateway, and leaving the payment looking refundable so a later return
 *     could fire a second real refund.
 *
 * Both are the same rule stated twice. One implementation, imported.
 *
 * The rule:
 *
 *  - An amount the provider did NOT report is not evidence of a partial
 *    refund. Providers vary in whether they echo one, and a missing, non-finite
 *    or non-positive value must mean "the whole payment" — the behaviour that
 *    predates the partial split. Reading absence as zero is what produced both
 *    of the failures above.
 *  - ...but that inference only holds while NOTHING is accounted. Once
 *    `alreadyRefunded` is positive, an IN-BAND partial refund has already been
 *    claimed on this payment and the event is almost certainly the provider's
 *    asynchronous settle notice for exactly that slice. Neither an absent
 *    amount nor one that equals the whole payment (MyFatoorah's refund webhook
 *    falls back to the INVOICE `Amount` when `RefundAmount` is missing) is then
 *    evidence that the balance was refunded too, so neither settles the
 *    payment. Reading them as full marks a partly-refunded payment as settled
 *    with an inflated total: `refundableRemaining` drops to <= 0, every later
 *    legitimate partial return is rejected with PAYMENT_FULLY_REFUNDED, and
 *    refund/tax reporting overstates refunds by the difference.
 *  - Only a reported amount that falls SHORT of the payment downgrades to
 *    partial.
 *  - A payment with no positive total cannot be partially refunded.
 *  - Distinct refunds ADD. A provider reports the amount of one refund, never a
 *    running total, so two refunds on one payment must sum. Only the provider's
 *    refund id establishes that an event is a new refund rather than a
 *    redelivery of a counted one; without an id the total is held, because
 *    understating a refund is recoverable and paying one twice is not.
 *  - The cumulative total never decreases: an in-band refund was already
 *    accounted by the atomic claim, so the stored value leads; an out-of-band
 *    one is first seen here and raises it. When the refund settles the payment
 *    the total is the payment amount, even if nothing was reported — leaving it
 *    at zero understates customer refund totals and leaves a phantom refundable
 *    balance behind an already-executed refund.
 */
export interface RefundSettlement {
  /** The amount the provider actually reported, or null when it reported none. */
  reportedAmount: number | null;
  /** Cumulative refunded total after accounting for this event. Never decreases. */
  settledTotal: number;
  /** True when this refund exhausts the payment — gates whole-order effects. */
  isFullRefund: boolean;
  /**
   * True when THIS event's amount was added to the total. Only then may its
   * refund id be recorded as accounted — filing an id whose amount was held
   * would make the real refund carrying that id look already counted, and it
   * would never be added at all.
   */
  accountedThisEvent: boolean;
  /**
   * True when the event names a refund id nothing has accounted, and the
   * total was nonetheless HELD — no credible amount came with it, so it could
   * not be added. That is either a genuine second refund whose amount the
   * provider did not report, or a redelivery whose provenance is unknown; the
   * rule cannot tell them apart and holds on purpose (paying twice is worse
   * than understating). It must not also be silent (#1477): a real refund here
   * leaves a phantom refundable balance that a later return would pay out
   * again, so callers raise it for reconciliation.
   */
  heldUnaccountedEvent: boolean;
  /**
   * True when the payment PREDATES the per-refund ledger (a refund is
   * accounted but no refund ids are recorded) and this event names a refund
   * with a usable amount that was therefore NOT added. The rule cannot tell a
   * settle notice for the refund already counted (benign) from a genuinely
   * NEW second refund (the refundable balance is then overstated, and a later
   * return could pay it out again), so it is raised for a human to check in
   * the provider dashboard — with its own wording, not the "reported without
   * an amount" text (PR 2279 audit P1).
   */
  heldProvenanceUnknown: boolean;
}

export function resolveRefundSettlement(input: {
  /** The payment's total, in fils. */
  paymentAmount: number;
  /** What the payment row already records as refunded. */
  alreadyRefunded: number | null | undefined;
  /**
   * The provider's own id for the refund THIS event describes, when it gives
   * one. It is what separates a brand-new refund from a re-notification of one
   * already counted — without it the two are indistinguishable and the total
   * can only be held, never raised.
   */
  reportedEventId?: string | null;
  /**
   * Provider refund ids whose amounts are already inside `alreadyRefunded` —
   * written by whichever path accounted them, in-band claim or earlier webhook.
   */
  accountedEventIds?: readonly string[] | null;
  /**
   * Amounts the provider may have reported, in preference order — the first
   * finite positive one wins. Pass every candidate the payload offers.
   */
  reported: Array<number | null | undefined>;
}): RefundSettlement {
  const { paymentAmount, alreadyRefunded, reported, reportedEventId, accountedEventIds } = input;

  const reportedAmount =
    reported.find(
      (value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0
    ) ?? null;

  const accounted = alreadyRefunded ?? 0;

  // Is anything already accounted on this payment? Then this event carries no
  // usable evidence unless it reports an amount that is BOTH present and short
  // of the payment — see the rule above. Derived from the row rather than
  // passed in by the caller so a third call site cannot forget it.
  const hasAccountedRefund = accounted > 0;
  const credibleAmount =
    reportedAmount !== null && (!hasAccountedRefund || reportedAmount < paymentAmount)
      ? reportedAmount
      : null;

  // Providers report the amount of THIS refund, never a running total, so two
  // distinct refunds on one payment must ADD. Taking the larger of the two
  // instead silently discards the smaller: a 2000 in-band return followed by
  // the merchant refunding the remaining 3000 in the dashboard settled at
  // max(2000, 3000) = 3000, leaving 2000 marked refundable after the gateway
  // had already sent back the whole 5000 — and ReturnService accepts a
  // partially-refunded payment, so that phantom balance funds a second real
  // payout. Two equal refunds collapsed the same way.
  //
  // Adding is only safe for an event we have not already counted, and the
  // provider's refund id is the only thing that establishes that. Without one
  // the event cannot be told apart from a redelivery of the last, so the total
  // is held rather than raised — understating a refund is recoverable, paying
  // one twice is not.
  // A payment that already carries a refund but names NO accounted ids predates
  // this bookkeeping: its pending settle webhook would look like a brand-new
  // refund and be added a second time. Provenance is unknown there, so the
  // total is held. Once nothing is accounted, or the list is being maintained,
  // an id absent from it really is a refund nothing has counted.
  const ids = accountedEventIds ?? [];
  const provenanceKnown = accounted === 0 || ids.length > 0;
  const isUnaccountedEvent =
    provenanceKnown &&
    typeof reportedEventId === 'string' &&
    reportedEventId.length > 0 &&
    !ids.includes(reportedEventId);

  // A real, credible amount for a named refund is being HELD only because the
  // payment predates the ledger. Recoverable, but invisible unless logged —
  // the settled total stays short of what the provider sent back (#1487).
  if (
    !provenanceKnown &&
    credibleAmount !== null &&
    typeof reportedEventId === 'string' &&
    reportedEventId.length > 0
  ) {
    logger.warn(
      { reportedEventId, accounted, credibleAmount, paymentAmount },
      '[refund-settlement] refund amount held: payment predates the per-refund ledger, provenance unknown — reconcile manually'
    );
  }

  const settled =
    isUnaccountedEvent && credibleAmount !== null
      ? accounted + credibleAmount
      : Math.max(accounted, credibleAmount ?? 0);

  // Unknown means "the whole payment" only while nothing is accounted.
  const unknownMeansFull = credibleAmount === null && !hasAccountedRefund;
  const isFullRefund = unknownMeansFull || paymentAmount <= 0 || settled >= paymentAmount;

  const accountedThisEvent = isUnaccountedEvent && credibleAmount !== null;
  return {
    reportedAmount,
    // A full refund exhausts the payment even when nothing was reported.
    settledTotal: isFullRefund ? Math.max(settled, Math.max(paymentAmount, 0)) : settled,
    isFullRefund,
    accountedThisEvent,
    // Only when the AMOUNT is unusable (issue 2029). A provenance-unknown
    // event WITH a credible amount is a different case with different wording
    // — heldProvenanceUnknown below — because it may be a benign settle notice
    // for the refund already counted OR a genuinely new refund (PR 2279 audit).
    heldUnaccountedEvent:
      typeof reportedEventId === 'string' &&
      reportedEventId.length > 0 &&
      !ids.includes(reportedEventId) &&
      credibleAmount === null &&
      !isFullRefund,
    heldProvenanceUnknown:
      !provenanceKnown &&
      credibleAmount !== null &&
      typeof reportedEventId === 'string' &&
      reportedEventId.length > 0 &&
      !isFullRefund,
  };
}

/** Where the accounted refund ids live on `Payment.metadata`. */
export const REFUND_EVENT_IDS_KEY = 'refundEventIds';

/**
 * The provider refund ids already folded into `Payment.refundedAmount`.
 *
 * Both writers — the in-band claim and the webhook — read and append through
 * these two helpers so the list cannot mean one thing on one path and something
 * else on the other. That divergence is the whole reason this module exists.
 */
export function readAccountedRefundEventIds(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const raw = (metadata as Record<string, unknown>)[REFUND_EVENT_IDS_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

/**
 * The list with `id` included, unchanged when it is absent or already present.
 * Append only after the amount it represents has actually been accounted —
 * recording it first would make a later, genuine refund look already-counted.
 */
export function appendRefundEventId(metadata: unknown, id: string | null | undefined): string[] {
  const existing = readAccountedRefundEventIds(metadata);
  if (typeof id !== 'string' || id.length === 0 || existing.includes(id)) return existing;
  return [...existing, id];
}

/** Where each refund's last-seen status lives on `Payment.metadata`. */
export const REFUND_STATUS_BY_ID_KEY = 'refundStatusById';

export function readRefundStatusById(metadata: unknown): Record<string, string> {
  if (!metadata || typeof metadata !== 'object') return {};
  const raw = (metadata as Record<string, unknown>)[REFUND_STATUS_BY_ID_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && k.length > 0) out[k] = v;
  }
  return out;
}

/**
 * Has this exact refund already been seen at this exact status?
 *
 * The webhook's duplicate check used to compare `metadata.refundStatus`, which
 * is ONE scalar for the whole payment rather than one per refund. After any
 * refund settled it read 'completed' forever, so the NEXT refund's webhook —
 * a different refund, a different id — matched and returned before the
 * settlement rule ran at all. The cumulative-total logic was therefore dead
 * for out-of-band refunds, the only case it exists to serve, and the second
 * portal refund left no trace: no amount, no ledger entry, no audit row.
 *
 * Identity first, status second. Two refunds are only the same event when they
 * carry the same provider id.
 *
 * Two fallbacks keep this from being a regression. A payment whose map is empty
 * predates the per-refund ledger, and a provider that names no refund id offers
 * no identity to compare — both fall back to the payment-wide status, which is
 * the behaviour that shipped before. Those rows also refuse to raise the
 * refunded total, so the pair stays consistent: where identity is unknown,
 * nothing is added and nothing is reprocessed.
 */
export function isRefundEventAlreadySeen(input: {
  metadata: unknown;
  refundId: string | null | undefined;
  status: string;
  previousPaymentStatus: string;
}): boolean {
  const { metadata, refundId, status, previousPaymentStatus } = input;
  const seen = readRefundStatusById(metadata);

  if (typeof refundId === 'string' && refundId.length > 0 && Object.keys(seen).length > 0) {
    // Tracked payment: a refund absent from the map is genuinely new.
    return seen[refundId] === status;
  }

  return previousPaymentStatus === status;
}

/** The map with this refund recorded at this status. */
export function recordRefundStatus(
  metadata: unknown,
  refundId: string | null | undefined,
  status: string
): Record<string, string> {
  const seen = readRefundStatusById(metadata);
  if (typeof refundId !== 'string' || refundId.length === 0) return seen;
  return { ...seen, [refundId]: status };
}
