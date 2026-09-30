/**
 * Payment-event service — append-only lifecycle log.
 *
 * Every Payment row mutation (create, status flip, refund, webhook
 * receipt) MUST go through `recordPaymentEvent` so the audit trail
 * stays complete. The `payments.status` column shows only the CURRENT
 * state; this table shows HOW it got there.
 *
 * Writes are best-effort (never block the caller). A failed event log
 * is reported to logger but doesn't throw — the payment mutation is
 * the source of truth, the event log is the audit aid.
 */

import type { PaymentStatus } from '@force/database';
import { Prisma, prisma } from '@force/database';
import logger from '../lib/logger';
import { withSavepoint } from '../lib/savepoint';

/** Coarse-grained categorisation so audit UIs can filter quickly. */
export type PaymentEventType =
  | 'created' // Payment row first created (status: pending)
  | 'status_change' // status flip via admin / order route / refund
  | 'webhook' // provider webhook receipt (may or may not flip status)
  | 'refund' // refund issued (admin or webhook driven)
  | 'admin_action' // admin manually marked failed / disputed / etc
  | 'reconciliation'; // settlement-vs-row diff written by a future cron

interface RecordPaymentEventInput {
  paymentId: string;
  storeId: string;
  orderId: string;
  eventType: PaymentEventType;
  fromStatus?: PaymentStatus | null;
  toStatus?: PaymentStatus | null;
  provider?: string | null;
  providerPayload?: Prisma.InputJsonValue | null;
  details?: Prisma.InputJsonValue;
  triggeredByUserId?: string | null;
  occurredAt?: Date;
}

/**
 * Append a row to `payment_events`. Never throws — if the write fails
 * (DB hiccup, missing FK), the caller's transaction is unaffected.
 */
export async function recordPaymentEvent(input: RecordPaymentEventInput): Promise<void> {
  try {
    // Savepointed (issue 2215's class): order routes write this inside the
    // request's tenant transaction, AFTER the payment/status writes it
    // records; a failure the catch below swallows must not abort them.
    await withSavepoint(() =>
      prisma.paymentEvent.create({
        data: {
          paymentId: input.paymentId,
          storeId: input.storeId,
          orderId: input.orderId,
          eventType: input.eventType,
          fromStatus: input.fromStatus ?? null,
          toStatus: input.toStatus ?? null,
          provider: input.provider ?? null,
          providerPayload: input.providerPayload ?? Prisma.JsonNull,
          details: (input.details ?? {}) as Prisma.InputJsonValue,
          triggeredByUserId: input.triggeredByUserId ?? null,
          occurredAt: input.occurredAt ?? new Date(),
        },
      })
    );
  } catch (err) {
    // Audit logging must never break the payment flow.
    logger.error(
      {
        err,
        paymentId: input.paymentId,
        eventType: input.eventType,
        fromStatus: input.fromStatus,
        toStatus: input.toStatus,
      },
      '[PAYMENT-EVENT] failed to record event'
    );
  }
}

/**
 * Resolve storeId from a Payment id by joining through orders.
 * Convenience for call sites that have the paymentId but not the
 * orderId/storeId in scope (webhook handler, admin routes).
 */
async function lookupPaymentContext(
  paymentId: string
): Promise<{ orderId: string; storeId: string } | null> {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: { orderId: true, order: { select: { storeId: true } } },
  });
  if (!payment?.order?.storeId) return null;
  return { orderId: payment.orderId, storeId: payment.order.storeId };
}
