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
export type FailedClaim = 'claimed' | 'already_failed' | 'blocked_paid_or_settled';

/**
 * unpaid|failed -> paid (+ status confirmed). Only the caller that gets `claimed` runs the fan-out. An order that was
 * cancelled / refunded / shipped in the meantime is `blocked_status` (the money is captured, the order is not
 * confirmable: the caller alerts, it does not flip the order).
 */
export async function claimOrderPaid(orderId: string, storeId: string): Promise<PaidClaim> {
  const res = await prisma.order.updateMany({
    where: {
      id: orderId,
      storeId,
      paymentStatus: { in: ['unpaid', 'failed'] },
      status: { in: ['pending', 'awaiting_payment_confirmation', 'confirmed'] },
    },
    data: { status: 'confirmed', paymentStatus: 'paid' },
  });
  if (res.count === 1) return 'claimed';
  const cur = await prisma.order.findUnique({
    where: { id: orderId, storeId },
    select: { paymentStatus: true },
  });
  return cur?.paymentStatus === 'unpaid' || cur?.paymentStatus === 'failed'
    ? 'blocked_status'
    : 'already_paid';
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
  return cur?.paymentStatus === 'failed' ? 'already_failed' : 'blocked_paid_or_settled';
}
