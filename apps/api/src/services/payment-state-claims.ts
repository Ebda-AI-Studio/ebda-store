/**
 * Conditional order payment-state transitions (audit M-049 / M-064, fix group P08).
 *
 * The pull-side confirm (guest verify-on-return, admin Refresh) and the webhook both used to read an order
 * snapshot, decide, then write unconditionally. Two paths racing on one order could both see `unpaid`, both write, and
 * both enqueue the post-payment fan-out; and a late "failed/expired" answer could overwrite a PAID order.
 *
 * Here each transition is ONE conditional UPDATE. Postgres row-locks the order, and under READ COMMITTED the loser
 * re-evaluates its WHERE against the winner's committed row, so exactly one caller sees count = 1 and only that caller
 * may fan out. The paid state is final for these paths: only the refund / dispute flows move an order off `paid`.
 */
import { prisma } from '@ebda/database';

export type PaidClaim = 'claimed' | 'already_paid' | 'blocked_status';
export type FailedClaim = 'claimed' | 'already_failed' | 'blocked_paid_or_settled' | 'not_found';

/**
 * unpaid|failed -> paid. Only the caller that gets `claimed` runs the fan-out.
 *  - pending / awaiting confirmation / confirmed: the order becomes `confirmed` + paid.
 *  - processing / shipped / delivered (the merchant moved an unpaid online order on, or it was already fulfilled):
 *    the money is real, so ONLY `paymentStatus` becomes paid and the fulfilment status is left alone. Refusing it
 *    would leave a captured payment unrecorded for ever, with every webhook retry failing the same way.
 *  - cancelled / refunded: `blocked_status` (the caller raises INVALID_STATUS_TRANSITION, which the auto-cancel
 *    sweep turns into a "captured money on a terminal order" alert).
 */
export async function claimOrderPaid(orderId: string, storeId: string): Promise<PaidClaim> {
  const confirming = await prisma.order.updateMany({
    where: {
      id: orderId,
      storeId,
      paymentStatus: { in: ['unpaid', 'failed'] },
      status: { in: ['pending', 'awaiting_payment_confirmation', 'confirmed'] },
    },
    data: { status: 'confirmed', paymentStatus: 'paid' },
  });
  if (confirming.count === 1) return 'claimed';
  const fulfilled = await prisma.order.updateMany({
    where: {
      id: orderId,
      storeId,
      paymentStatus: { in: ['unpaid', 'failed'] },
      status: { in: ['processing', 'shipped', 'delivered'] },
    },
    data: { paymentStatus: 'paid' },
  });
  if (fulfilled.count === 1) return 'claimed';
  const cur = await prisma.order.findUnique({
    where: { id: orderId, storeId },
    select: { paymentStatus: true },
  });
  return cur?.paymentStatus === 'unpaid' || cur?.paymentStatus === 'failed'
    ? 'blocked_status'
    : 'already_paid';
}

/**
 * Take the payment row lock BEFORE the order claim, the order every refund path uses (payment, then order), so a
 * replayed webhook and a refund settling the same order cannot deadlock.
 */
export async function lockPaymentRow(paymentId: string): Promise<void> {
  await prisma.$queryRaw`SELECT id FROM payments WHERE id = ${paymentId} FOR UPDATE`;
}

/** Statuses a payment row must not be moved OFF by an incoming provider answer (never regress captured money). */
export function paymentStatusesNotOverwrittenBy(
  incoming: string
): Array<'completed' | 'refunded' | 'partially_refunded' | 'disputed'> {
  if (incoming === 'completed') return ['refunded', 'partially_refunded', 'disputed'];
  return ['completed', 'refunded', 'partially_refunded', 'disputed'];
}

/**
 * unpaid -> failed. A PAID (or refunded/disputed) order is never touched: `blocked_paid_or_settled`. A repeat on an
 * already-failed order is `already_failed` (no second "payment failed" push).
 */
export async function claimOrderFailed(orderId: string, storeId: string): Promise<FailedClaim> {
  const res = await prisma.order.updateMany({
    where: { id: orderId, storeId, paymentStatus: 'unpaid' },
    data: { paymentStatus: 'failed' },
  });
  if (res.count === 1) return 'claimed';
  const cur = await prisma.order.findUnique({
    where: { id: orderId, storeId },
    select: { paymentStatus: true },
  });
  // 0 rows AND no such order here (a Durable Object store's order is not in Postgres): never read as "paid or settled".
  if (!cur) return 'not_found';
  return cur.paymentStatus === 'failed' ? 'already_failed' : 'blocked_paid_or_settled';
}
