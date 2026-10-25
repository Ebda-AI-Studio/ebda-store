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
 *    amount nor one that equals the whole payment (a gateway's refund webhook
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
   * True when a refund event with an UNKNOWN id and a usable amount was held because an own, already-executed claim is
   * still open on the payment: the provider's refund id may differ from the id its API answered with (Kashier: unverified),
   * and booking would then count one refund twice. Nothing is booked; an operator matches it to the claim.
   */
  heldOpenClaimIdUnverified: boolean;
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
  /**
   * True when this event is the settle notice of an in-band refund whose claim already added its amount but has not
   * yet recorded the provider's id (the webhook outran the id write). It is NOT added again; the claim records the id.
   */
  absorbedByInFlightClaim: boolean;
  /** The claim this event was reconciled with (the caller CONSUMES it in the same transaction as its writes), else null. */
  absorbedClaimId: string | null;
  /**
   * The payment predates the per-refund ledger and this event names a refund with a usable amount that was therefore
   * HELD: the caller logs it (recoverable, but invisible otherwise, #1487).
   */
  warnProvenanceHeld: boolean;
}

export interface InFlightClaim {
  claimId: string;
  amount: number;
  /** epoch ms */
  createdAt: number;
}

/** Longest a claim may stay a candidate: the provider answer + the id write take seconds; the stuck-claim sweep flags at 15 min. */
export const IN_FLIGHT_CLAIM_WINDOW_MS = 5 * 60 * 1000;

/**
 * The claims a settle webhook may be reconciled with: claimed, YOUNG (inside the window), with no outcome event
 * (executed / released / indeterminate / reconciled) and not already CONSUMED by an earlier webhook (an `absorbed`
 * event carrying the claim id). One claim reconciles at most one webhook.
 */
export function selectInFlightClaims(input: {
  events: readonly RefundClaimEventRow[];
  now: number;
  windowMs?: number;
  claimEvent: string;
  /** every event type that ends a claim or consumes it */
  closingEvents: readonly string[];
}): InFlightClaim[] {
  const windowMs = input.windowMs ?? IN_FLIGHT_CLAIM_WINDOW_MS;
  const at = (e: RefundClaimEventRow) =>
    e.createdAt instanceof Date ? e.createdAt.getTime() : e.createdAt;
  const det = (e: RefundClaimEventRow) =>
    e.details && typeof e.details === 'object' ? (e.details as Record<string, unknown>) : {};
  const closed = new Set<string>();
  for (const e of input.events) {
    const id = det(e).claimId;
    if (typeof id === 'string' && input.closingEvents.includes(e.eventType)) closed.add(id);
  }
  const out: InFlightClaim[] = [];
  for (const e of input.events) {
    const d = det(e);
    if (
      e.eventType !== input.claimEvent ||
      typeof d.claimId !== 'string' ||
      typeof d.amount !== 'number'
    )
      continue;
    if (closed.has(d.claimId) || input.now - at(e) > windowMs || at(e) > input.now + 60_000)
      continue;
    out.push({ claimId: d.claimId, amount: d.amount, createdAt: at(e) });
  }
  return out;
}

/**
 * Own claims that EXECUTED (their provider id is recorded) recently and are neither released, indeterminate, reconciled nor
 * consumed. When a Kashier webhook arrives with an id we do not know while one exists, the two may be the same refund.
 */
export function selectOpenExecutedClaims(input: {
  events: readonly RefundClaimEventRow[];
  now: number;
  windowMs?: number;
  claimEvent: string;
  executedEvent: string;
  closingEvents: readonly string[];
}): string[] {
  // AGE NEVER CLOSES THIS: a late Kashier webhook (days later) with an unknown id while an executed claim is still
  // unconsumed is held, not booked. A claim closes only when its own id is seen, an operator matches it, or it is
  // released / indeterminate / reconciled / absorbed.
  const windowMs = input.windowMs ?? Number.POSITIVE_INFINITY;
  const at = (e: RefundClaimEventRow) =>
    e.createdAt instanceof Date ? e.createdAt.getTime() : e.createdAt;
  const det = (e: RefundClaimEventRow) =>
    e.details && typeof e.details === 'object' ? (e.details as Record<string, unknown>) : {};
  const closed = new Set<string>();
  for (const e of input.events) {
    const id = det(e).claimId;
    if (typeof id === 'string' && input.closingEvents.includes(e.eventType)) closed.add(id);
  }
  return input.events
    .filter(e => e.eventType === input.executedEvent)
    .filter(e => {
      const id = det(e).claimId;
      return (
        typeof id === 'string' &&
        !closed.has(id) &&
        input.now - at(e) <= windowMs &&
        at(e) <= input.now + 60_000
      );
    })
    .map(e => det(e).claimId as string);
}

/**
 * The executed, still-unconsumed claim whose provider refund id IS `refundId`: the refund's own webhook has arrived with
 * the id the refund API answered with, so the claim is settled and is consumed (this is what closes a claim for the
 * Kashier hold above). Null when none.
 */
export function executedClaimForRefundId(input: {
  events: readonly RefundClaimEventRow[];
  refundId: string | null | undefined;
  executedEvent: string;
  closingEvents: readonly string[];
}): string | null {
  if (typeof input.refundId !== 'string' || input.refundId.length === 0) return null;
  const det = (e: RefundClaimEventRow) =>
    e.details && typeof e.details === 'object' ? (e.details as Record<string, unknown>) : {};
  const closed = new Set<string>();
  for (const e of input.events) {
    const id = det(e).claimId;
    if (typeof id === 'string' && input.closingEvents.includes(e.eventType)) closed.add(id);
  }
  for (const e of input.events) {
    const d = det(e);
    if (
      e.eventType === input.executedEvent &&
      d.refundId === input.refundId &&
      typeof d.claimId === 'string' &&
      !closed.has(d.claimId)
    )
      return d.claimId;
  }
  return null;
}

/** One `payment_events` refund row, as `correlateSettleNotice` reads it. */
export interface RefundClaimEventRow {
  eventType: string;
  createdAt: Date | number;
  details: unknown;
}

/** Longest after OUR refund executed that a Fawry settle notice may still be attributed to it (Fawry documents no delay). */
export const SETTLE_NOTICE_WINDOW_MS = 30 * 60 * 1000;

const FAWRY_NOTICE_REF = /^fawry-refund-([A-Za-z0-9_.]{1,64})-(REFUNDED|PARTIAL_REFUNDED)$/;
const FAWRY_INBAND_REF = /^fawry-refund-([A-Za-z0-9_.]{1,64})-(\d{1,12})$/;

/**
 * Which refund of OURS does an amount-less Fawry settle notice settle? Fawry reports no amount and nothing that says how
 * much is signed, so the notice is attributed only on POSITIVE evidence specific to ONE claim, else the caller keeps the
 * hold and alerts (fail closed):
 *   - the notice's reference parses as `fawry-refund-<fawryRef>-(REFUNDED|PARTIAL_REFUNDED)`; anything else = no match;
 *   - the claim has an EXECUTED event (an outcome we know) whose refund id is `fawry-refund-<SAME fawryRef>-<digits>`,
 *     executed inside the window, and whose claim is a full refund for REFUNDED / a partial one for PARTIAL_REFUNDED;
 *   - the claim is not released, indeterminate, reconciled, or already CONSUMED by an earlier notice (one claim, one notice).
 * Returns the OLDEST such claim id; the caller consumes it (an absorbed event naming the notice id) in the same
 * transaction as its writes. Claims without an outcome never match.
 */
export function correlateSettleNotice(input: {
  events: readonly RefundClaimEventRow[];
  /** the notice's derived refund reference */
  noticeRef: string | null | undefined;
  now: number;
  windowMs?: number;
  claimEvent: string;
  executedEvent: string;
  /** every event that ends or consumes a claim OTHER than executed (released, indeterminate, reconciled, absorbed) */
  closingEvents: readonly string[];
}): string | null {
  const m = typeof input.noticeRef === 'string' ? FAWRY_NOTICE_REF.exec(input.noticeRef) : null;
  if (!m) return null;
  const [, noticeFawryRef, noticeKind] = m;
  const windowMs = input.windowMs ?? SETTLE_NOTICE_WINDOW_MS;
  const at = (e: RefundClaimEventRow) =>
    e.createdAt instanceof Date ? e.createdAt.getTime() : e.createdAt;
  const det = (e: RefundClaimEventRow) =>
    e.details && typeof e.details === 'object' ? (e.details as Record<string, unknown>) : {};
  const closed = new Set<string>();
  const full = new Map<string, boolean>();
  for (const e of input.events) {
    const d = det(e);
    if (typeof d.claimId !== 'string') continue;
    if (input.closingEvents.includes(e.eventType)) closed.add(d.claimId);
    if (e.eventType === input.claimEvent && typeof d.isFullRefund === 'boolean')
      full.set(d.claimId, d.isFullRefund);
  }
  const candidates: Array<{ claimId: string; at: number }> = [];
  for (const e of input.events) {
    const d = det(e);
    if (
      e.eventType !== input.executedEvent ||
      typeof d.claimId !== 'string' ||
      typeof d.refundId !== 'string'
    )
      continue;
    if (closed.has(d.claimId)) continue;
    const ref = FAWRY_INBAND_REF.exec(d.refundId);
    if (!ref || ref[1] !== noticeFawryRef) continue;
    if (full.get(d.claimId) !== (noticeKind === 'REFUNDED')) continue;
    if (input.now - at(e) > windowMs || at(e) > input.now + 60_000) continue;
    candidates.push({ claimId: d.claimId, at: at(e) });
  }
  candidates.sort((a, b) => a.at - b.at);
  return candidates[0]?.claimId ?? null;
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
  /**
   * In-band refund claims that are committed (their amount is inside `alreadyRefunded`), young (inside the window),
   * unconsumed and without an outcome yet (`selectInFlightClaims`). A webhook for an unaccounted id whose credible
   * amount equals the OLDEST such claim is that refund's own settle notice, not a second refund; the caller must
   * consume the claim (write the absorbed id on it) in the same transaction, so a second webhook cannot match it.
   */
  inFlightClaims?: readonly InFlightClaim[] | null;
  /** The claim `correlateSettleNotice` proved this amount-less notice settles: nothing to hold or alert; the caller consumes it. */
  correlatedClaimId?: string | null;
  /**
   * An own claim that already EXECUTED (its provider id is on the ledger) is still open and unconsumed on this payment,
   * and the provider is one whose webhook id is not proven equal to its API refund id (Kashier). An event with an unknown
   * id is then HELD instead of added: it may be that very refund under another id.
   */
  openExecutedClaimWithUnverifiedId?: boolean;
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
  // A named refund that no list has counted. With provenance known it is a candidate to ADD; with provenance unknown
  // (the payment's first refund: the claim's amount is in the total, its id not yet recorded) it is still the notice of
  // an in-flight claim when one of the same amount exists.
  const namedUncounted =
    typeof reportedEventId === 'string' &&
    reportedEventId.length > 0 &&
    !ids.includes(reportedEventId);
  const matchedClaim =
    namedUncounted && credibleAmount !== null
      ? ([...(input.inFlightClaims ?? [])]
          .sort((a, b) => a.createdAt - b.createdAt)
          .find(c => c.amount === credibleAmount) ?? null)
      : null;
  const absorbedByInFlightClaim = matchedClaim !== null;
  const heldOpenClaimIdUnverified =
    !!input.openExecutedClaimWithUnverifiedId &&
    isUnaccountedEvent &&
    credibleAmount !== null &&
    !absorbedByInFlightClaim;
  const settled =
    isUnaccountedEvent &&
    credibleAmount !== null &&
    !absorbedByInFlightClaim &&
    !heldOpenClaimIdUnverified
      ? accounted + credibleAmount
      : Math.max(accounted, credibleAmount ?? 0);

  // Unknown means "the whole payment" only while nothing is accounted.
  const unknownMeansFull = credibleAmount === null && !hasAccountedRefund;
  const isFullRefund = unknownMeansFull || paymentAmount <= 0 || settled >= paymentAmount;

  const accountedThisEvent =
    isUnaccountedEvent &&
    credibleAmount !== null &&
    !absorbedByInFlightClaim &&
    !heldOpenClaimIdUnverified;
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
    absorbedByInFlightClaim,
    absorbedClaimId:
      matchedClaim?.claimId ?? (namedUncounted ? (input.correlatedClaimId ?? null) : null),
    warnProvenanceHeld:
      !absorbedByInFlightClaim &&
      !provenanceKnown &&
      credibleAmount !== null &&
      typeof reportedEventId === 'string' &&
      reportedEventId.length > 0,
    heldOpenClaimIdUnverified,
    heldUnaccountedEvent:
      !input.correlatedClaimId &&
      typeof reportedEventId === 'string' &&
      reportedEventId.length > 0 &&
      !ids.includes(reportedEventId) &&
      credibleAmount === null &&
      !isFullRefund,
    heldProvenanceUnknown:
      !absorbedByInFlightClaim &&
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
