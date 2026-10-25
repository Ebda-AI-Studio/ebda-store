/**
 * The ONE place a refund is settled against a payment (Postgres path). The webhook, the manual refresh route and the
 * in-band claim release used to each do part of this and raced each other; they now all call here.
 *
 * Every entry point takes the payment row lock (`SELECT … FOR UPDATE`), re-reads the payment AND its refund events, decides,
 * and writes the outcome event in the same transaction:
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

/** Lock the payment row for the rest of the caller's transaction and read it fresh. Null when it does not exist. */
export async function lockPayment(paymentId: string): Promise<FreshPayment | null> {
  await prisma.$queryRaw`SELECT id FROM payments WHERE id = ${paymentId} FOR UPDATE`;
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

/** Decide (under the payment lock) how a provider refund event settles; the caller applies its effects then `commit`s. */
export async function settleRefundEvent(input: SettleEventInput): Promise<SettleEventResult> {
  const now = input.now ?? Date.now();
  const payment = await lockPayment(input.paymentId);
  if (!payment) throw new Error(`settleRefund: payment ${input.paymentId} not found`);
  const prevRefundStatus = (payment.metadata.refundStatus as string | undefined) || 'pending';
  const seen = isRefundEventAlreadySeen({
    metadata: payment.metadata,
    refundId: input.refund.refundId,
    status: input.refund.status,
    previousPaymentStatus: prevRefundStatus,
  });
  if (seen) return { payment, seen: true, decision: null, commit: async () => undefined };

  const completed = input.refund.status === 'completed';
  const amountless = !(typeof input.refund.amount === 'number' && input.refund.amount > 0);
  const events = completed ? await refundEvents(input.paymentId, input.storeId) : [];
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
  let committed = false;
  return {
    payment,
    seen: false,
    decision,
    async commit(patch) {
      if (committed) throw new Error('settleRefund: commit called twice');
      committed = true;
      if (patch.data && Object.keys(patch.data).length > 0)
        await prisma.payment.update({
          where: { id: input.paymentId },
          data: patch.data as Prisma.PaymentUpdateInput,
        });
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
  const payment = await lockPayment(input.paymentId);
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
  const payment = await lockPayment(input.paymentId);
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
