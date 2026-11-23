/**
 * The ONE place a refund is settled against a payment on the Postgres path. The webhook, the manual refresh route and the
 * in-band claim release used to each do part of this and raced each other; they now all call here.
 *
 * Ruling NZ-REFUND-LOCK-1 (2026-11-23): production has no Postgres. A store is served by its StoreDO, whose refund
 * sections (packages/repo/src/do/payments.ts: `beginRefund`, `completeRefund`, `releaseRefund`, `matchRefundToClaim`, and
 * `applyPaymentEventSync` -> `applyRefundWebhook`) each run as ONE `transactionSync` on a single-threaded object, so the
 * payment row lock and the joined tenant transaction this module used to take are gone. Every caller takes the DO branch first (`storeMoney(storeId)`), a `pg` store answers
 * 410 on the Worker (lib/store-backend.ts `backendFromRow`), and any Prisma call there throws POSTGRES_REMOVED (worker.ts).
 * What is left here runs only under Node (unit tests, local dev) and is NOT serialised; it goes with the pg branches (N-16).
 *
 * The rules (shared with the DO through `@ebda/shared`):
 *   - a settle event is reconciled with an in-flight claim ONLY when it is a COMPLETED refund (a pending / failed notice
 *     never consumes a claim), and consumes it (REFUND_ABSORBED_EVENT) so one claim settles one notice;
 *   - a claim is released ONLY if no webhook absorbed it (otherwise the money left: it is marked for review, nothing is
 *     given back); a released claim can never be absorbed afterwards;
 *   - an amount-less Fawry notice is attributed to ONE executed claim of ours on positive evidence (see
 *     `correlateSettleNotice`), else it stays held and alerts;
 *   - the unique index `payment_events_claim_single_outcome_key` makes "one claim, one of absorbed/released" a database fact.
 * The callers keep their own effects (order reversal, booking, alerts) and pass their payment-row patch to `commit`.
 */
import { prisma, Prisma } from '@ebda/database';
import {
  correlateSettleNotice,
  executedClaimForRefundId,
  isRefundEventAlreadySeen,
  readAccountedRefundEventIds,
  selectInFlightClaims,
  selectOpenExecutedClaims,
  appendRefundEventId,
  recordRefundStatus,
  REFUND_EVENT_IDS_KEY,
  REFUND_STATUS_BY_ID_KEY,
  IN_FLIGHT_CLAIM_WINDOW_MS,
} from '@ebda/shared';
import {
  REFUND_ABSORBED_EVENT,
  REFUND_CLAIM_EVENT,
  REFUND_EXECUTED_EVENT,
  REFUND_INDETERMINATE_EVENT,
  REFUND_RECONCILED_EVENT,
  REFUND_RELEASED_EVENT,
  REFUND_REVIEW_EVENT,
} from './refund-outcome';
import { resolveRefundSettlement, type RefundSettlement } from './refund-settlement';

const OUTCOME_EVENTS = [
  REFUND_EXECUTED_EVENT,
  REFUND_RELEASED_EVENT,
  REFUND_INDETERMINATE_EVENT,
  REFUND_RECONCILED_EVENT,
  REFUND_ABSORBED_EVENT,
];
/** Closes a claim for the Fawry notice rule (executed is how a claim becomes a candidate there, so it is not a closer). */
const FAWRY_CLOSING = [
  REFUND_RELEASED_EVENT,
  REFUND_INDETERMINATE_EVENT,
  REFUND_RECONCILED_EVENT,
  REFUND_ABSORBED_EVENT,
];

export interface FreshPayment {
  id: string;
  amount: number;
  currency: string;
  status: string;
  refundedAmount: number;
  metadata: Record<string, unknown>;
}

/** Read the payment fresh (no row lock: see the file header). Null when it does not exist. */
export async function readPayment(paymentId: string): Promise<FreshPayment | null> {
  const row = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: {
      id: true,
      amount: true,
      currency: true,
      status: true,
      refundedAmount: true,
      metadata: true,
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    amount: row.amount,
    currency: row.currency,
    status: row.status as string,
    refundedAmount: row.refundedAmount ?? 0,
    metadata: (row.metadata && typeof row.metadata === 'object' ? row.metadata : {}) as Record<
      string,
      unknown
    >,
  };
}

async function refundEvents(paymentId: string, storeId: string) {
  return prisma.paymentEvent.findMany({
    where: { storeId, paymentId, eventType: { in: [REFUND_CLAIM_EVENT, ...OUTCOME_EVENTS] } },
    select: { eventType: true, createdAt: true, details: true },
  });
}

export interface SettleEventInput {
  paymentId: string;
  storeId: string;
  orderId: string;
  provider: string;
  refund: { refundId: string; status: string; amount?: number | null; reference?: string | null };
  now?: number;
}
export interface SettleEventResult {
  payment: FreshPayment;
  /** the same refund at the same status was already processed: change nothing */
  seen: boolean;
  decision: RefundSettlement | null;
  /** write the caller's payment patch and the outcome (consumed claim) atomically; call at most once */
  commit(patch: { data?: Record<string, unknown> }): Promise<void>;
}

/** Decide how a provider refund event settles; the caller applies its effects then `commit`s. */
export async function settleRefundEvent(input: SettleEventInput): Promise<SettleEventResult> {
  const now = input.now ?? Date.now();
  const payment = await readPayment(input.paymentId);
  if (!payment) throw new Error(`settleRefund: payment ${input.paymentId} not found`);
  const prevRefundStatus = (payment.metadata.refundStatus as string | undefined) || 'pending';
  const completed = input.refund.status === 'completed';
  const events = await refundEvents(input.paymentId, input.storeId);
  // The refund's OWN webhook (the id the refund API answered with) settles the executed claim and CONSUMES it: that is what
  // closes a claim for the Kashier unverified-id hold (age never does).
  const ownIdClaim = completed
    ? executedClaimForRefundId({
        events,
        refundId: input.refund.refundId,
        executedEvent: REFUND_EXECUTED_EVENT,
        closingEvents: FAWRY_CLOSING,
      })
    : null;
  const consumeOwnId = () =>
    prisma.paymentEvent.create({
      data: {
        paymentId: input.paymentId,
        storeId: input.storeId,
        orderId: input.orderId,
        eventType: REFUND_ABSORBED_EVENT,
        provider: input.provider,
        details: {
          claimId: ownIdClaim,
          refundId: input.refund.refundId,
          via: 'id_match',
        } as Prisma.InputJsonValue,
      },
    });
  // Fawry's amount-less notice ref is NOT proven unique per refund (paymentRefrenceNumber may be per payment): a repeat is
  // never silently 'seen'; it goes through the settlement rules (consume a claim on positive evidence, else held + alerted).
  // A true redelivery of the SAME notice is stopped upstream by the webhook inbox's provider event id.
  const fawryAmountless =
    input.provider === 'fawry' &&
    !(typeof input.refund.amount === 'number' && input.refund.amount > 0);
  const seen =
    !fawryAmountless &&
    isRefundEventAlreadySeen({
      metadata: payment.metadata,
      refundId: input.refund.refundId,
      status: input.refund.status,
      previousPaymentStatus: prevRefundStatus,
    });
  if (seen) {
    if (ownIdClaim) await consumeOwnId();
    return { payment, seen: true, decision: null, commit: async () => undefined };
  }

  const amountless = !(typeof input.refund.amount === 'number' && input.refund.amount > 0);
  // only a COMPLETED refund can be reconciled with (and consume) a claim
  const inFlightClaims = completed
    ? selectInFlightClaims({
        events,
        now,
        claimEvent: REFUND_CLAIM_EVENT,
        closingEvents: OUTCOME_EVENTS,
      })
    : [];
  const correlatedClaimId =
    completed && amountless && input.provider === 'fawry'
      ? correlateSettleNotice({
          events,
          noticeRef: input.refund.refundId,
          now,
          claimEvent: REFUND_CLAIM_EVENT,
          executedEvent: REFUND_EXECUTED_EVENT,
          closingEvents: FAWRY_CLOSING,
        })
      : null;
  const decision = resolveRefundSettlement({
    paymentAmount: payment.amount,
    alreadyRefunded: payment.refundedAmount,
    reported: [input.refund.amount],
    reportedEventId: input.refund.refundId,
    accountedEventIds: readAccountedRefundEventIds(payment.metadata),
    inFlightClaims,
    correlatedClaimId,
    // Kashier: the refund API's id is not proven equal to the webhook's transactionId (unverified in the docs; checked on the
    // first live refund). With an own executed claim still open, an unknown id is HELD, never auto-booked.
    openExecutedClaimWithUnverifiedId:
      completed &&
      input.provider === 'kashier' &&
      selectOpenExecutedClaims({
        events,
        now,
        claimEvent: REFUND_CLAIM_EVENT,
        executedEvent: REFUND_EXECUTED_EVENT,
        closingEvents: FAWRY_CLOSING,
      }).length > 0,
  });
  // only a COMPLETED refund is accounted: a pending / failed notice must not file its id (that would make the real, later
  // completed refund look already counted, and it would never be added)
  const decided = completed ? decision : { ...decision, accountedThisEvent: false };
  let committed = false;
  return {
    payment,
    seen: false,
    decision: decided,
    async commit(patch) {
      if (committed) throw new Error('settleRefund: commit called twice');
      committed = true;
      let data: Record<string, unknown> = patch.data ?? {};
      // (not for a Fawry amount-less notice: its ref is not proven unique per refund, so filing it would make the NEXT notice with
      // the same ref look already counted)
      if (decision.absorbedClaimId && completed && !fawryAmountless) {
        // an absorbed id is FILED as accounted and its status recorded, whatever the caller's patch: callers must not
        // diverge, or a replay after the claim closed would be booked as a new refund
        const base = (
          data.metadata && typeof data.metadata === 'object' ? data.metadata : payment.metadata
        ) as Record<string, unknown>;
        data = {
          ...data,
          metadata: {
            ...base,
            [REFUND_EVENT_IDS_KEY]: appendRefundEventId(base, input.refund.refundId),
            [REFUND_STATUS_BY_ID_KEY]: recordRefundStatus(
              base,
              input.refund.refundId,
              input.refund.status
            ),
          },
        };
      }
      if (Object.keys(data).length > 0)
        await prisma.payment.update({
          where: { id: input.paymentId },
          data: data as Prisma.PaymentUpdateInput,
        });
      if (ownIdClaim && !decision.absorbedClaimId) await consumeOwnId();
      if (decision.absorbedClaimId && completed)
        await prisma.paymentEvent.create({
          data: {
            paymentId: input.paymentId,
            storeId: input.storeId,
            orderId: input.orderId,
            eventType: REFUND_ABSORBED_EVENT,
            provider: input.provider,
            details: {
              claimId: decision.absorbedClaimId,
              refundId: input.refund.refundId,
              amount: input.refund.amount ?? null,
            } as Prisma.InputJsonValue,
          },
        });
    },
  };
}

export interface ReleaseInput {
  paymentId: string;
  storeId: string;
  orderId: string;
  claimId: string;
  amount: number;
  claimedStatus: string;
  priorStatus: string;
  provider: string | null;
  reason: string;
  error: string;
}
export type ReleaseResult = 'released' | 'review' | 'already_released';

/**
 * The provider REFUSED (nothing was sent): give the claimed amount back — unless a webhook already absorbed this claim
 * (the gateway says the money left), in which case nothing is given back and the claim is marked for review.
 */
export async function settleClaimRelease(input: ReleaseInput): Promise<ReleaseResult> {
  const payment = await readPayment(input.paymentId);
  if (!payment) throw new Error(`settleRefund: payment ${input.paymentId} not found`);
  const events = await refundEvents(input.paymentId, input.storeId);
  const forClaim = events.filter(
    e => (e.details as { claimId?: string } | null)?.claimId === input.claimId
  );
  if (forClaim.some(e => e.eventType === REFUND_ABSORBED_EVENT)) {
    await prisma.paymentEvent.create({
      data: {
        paymentId: input.paymentId,
        storeId: input.storeId,
        orderId: input.orderId,
        eventType: REFUND_REVIEW_EVENT,
        fromStatus: input.claimedStatus as never,
        provider: input.provider,
        details: {
          claimId: input.claimId,
          reason: 'claim_released_after_webhook_reported_it_completed',
          error: input.error,
        } as Prisma.InputJsonValue,
      },
    });
    return 'review';
  }
  if (forClaim.some(e => e.eventType === REFUND_RELEASED_EVENT)) return 'already_released';
  if (payment.refundedAmount < input.amount)
    throw new Error('refund claim no longer on the payment row');
  const left = payment.refundedAmount - input.amount;
  await prisma.payment.update({
    where: { id: input.paymentId },
    data: {
      refundedAmount: left,
      status: (left <= 0
        ? input.priorStatus
        : left >= payment.amount
          ? 'refunded'
          : 'partially_refunded') as never,
    },
  });
  await prisma.paymentEvent.create({
    data: {
      paymentId: input.paymentId,
      storeId: input.storeId,
      orderId: input.orderId,
      eventType: REFUND_RELEASED_EVENT,
      fromStatus: input.claimedStatus as never,
      provider: input.provider,
      details: {
        claimId: input.claimId,
        reason: input.reason,
        error: input.error,
      } as Prisma.InputJsonValue,
    },
  });
  return 'released';
}

export { IN_FLIGHT_CLAIM_WINDOW_MS };

export interface MatchInput {
  paymentId: string;
  storeId: string;
  orderId: string;
  /** the refund id the provider's webhook carried */
  providerRefundId: string;
  claimId: string;
  actorUserId: string;
  now?: number;
}
export type MatchResult = 'matched' | 'already_matched';

/**
 * Operator action: this provider refund id IS the refund of that claim (the webhook was held because the ids differ). Moves
 * no money: the claim already counted it. It consumes the claim (so nothing else can match it), records the provider id as
 * seen, and writes an audit event naming the operator. Refuses a claim that was not executed or is already closed.
 */
export async function matchRefundToClaim(input: MatchInput): Promise<MatchResult> {
  const payment = await readPayment(input.paymentId);
  if (!payment) throw new Error(`settleRefund: payment ${input.paymentId} not found`);
  const events = await refundEvents(input.paymentId, input.storeId);
  const forClaim = events.filter(
    e => (e.details as { claimId?: string } | null)?.claimId === input.claimId
  );
  if (!forClaim.some(e => e.eventType === REFUND_CLAIM_EVENT))
    throw new Error('claim not found on this payment');
  if (forClaim.some(e => e.eventType === REFUND_ABSORBED_EVENT)) return 'already_matched';

  if (!forClaim.some(e => e.eventType === REFUND_EXECUTED_EVENT))
    throw new Error('claim has no executed refund to match');
  if (
    forClaim.some(e =>
      [REFUND_RELEASED_EVENT, REFUND_INDETERMINATE_EVENT, REFUND_RECONCILED_EVENT].includes(
        e.eventType
      )
    )
  )
    throw new Error('claim is already closed');
  // the id must be one a provider webhook actually delivered and we HELD on this payment, and not yet accounted: a typo
  // must not pre-mark a future real refund as seen
  if (readAccountedRefundEventIds(payment.metadata).includes(input.providerRefundId))
    throw new Error('that refund id is already accounted');
  const held = await prisma.paymentEvent.findMany({
    where: { storeId: input.storeId, paymentId: input.paymentId, eventType: 'webhook' },
    select: { eventType: true, createdAt: true, details: true },
  });
  const heldEvent = held.find(e => {
    const d = e.details as {
      flavour?: string;
      refundId?: string;
      heldUnaccountedRefund?: boolean;
    } | null;
    return (
      d?.flavour === 'refund' &&
      d.refundId === input.providerRefundId &&
      d.heldUnaccountedRefund === true
    );
  });
  if (!heldEvent) throw new Error('no held webhook for that refund id on this payment');
  // the held webhook's amount, when it reported one, must equal the claim's: matching a 500 refund to a 2000 claim would
  // mark the 500 accounted without ever adding it (refundable balance overstated)
  const claimAmount = (
    forClaim.find(e => e.eventType === REFUND_CLAIM_EVENT)?.details as { amount?: number } | null
  )?.amount;
  const reported = (heldEvent.details as { reportedAmount?: number | null } | null)?.reportedAmount;
  if (typeof reported === 'number' && typeof claimAmount === 'number' && reported !== claimAmount)
    throw new Error('the held webhook amount does not equal the claim amount');
  await prisma.paymentEvent.create({
    data: {
      paymentId: input.paymentId,
      storeId: input.storeId,
      orderId: input.orderId,
      eventType: REFUND_ABSORBED_EVENT,
      triggeredByUserId: input.actorUserId,
      details: {
        claimId: input.claimId,
        refundId: input.providerRefundId,
        matchedBy: input.actorUserId,
        via: 'operator_match',
      } as Prisma.InputJsonValue,
    },
  });
  await prisma.payment.update({
    where: { id: input.paymentId },
    data: {
      metadata: {
        ...payment.metadata,
        [REFUND_EVENT_IDS_KEY]: appendRefundEventId(payment.metadata, input.providerRefundId),
        [REFUND_STATUS_BY_ID_KEY]: recordRefundStatus(
          payment.metadata,
          input.providerRefundId,
          'completed'
        ),
      } as Prisma.InputJsonValue,
    },
  });
  return 'matched';
}

/** The provider refund id a settle webhook was reconciled with for this claim, or null. */
export async function absorbedRefundIdFor(
  paymentId: string,
  storeId: string,
  claimId: string
): Promise<string | null> {
  const events = await prisma.paymentEvent.findMany({
    where: { storeId, paymentId, eventType: REFUND_ABSORBED_EVENT },
    select: { eventType: true, createdAt: true, details: true },
  });
  const hit = events.find(e => (e.details as { claimId?: string } | null)?.claimId === claimId);
  const refundId = (hit?.details as { refundId?: unknown } | null | undefined)?.refundId;
  return typeof refundId === 'string' ? refundId : null;
}
