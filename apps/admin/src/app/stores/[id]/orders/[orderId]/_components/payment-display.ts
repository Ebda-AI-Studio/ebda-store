import type { OrderDetail } from './types';

export type PaymentDisplayState = 'paid' | 'unpaid' | 'refunded' | 'partially_refunded';

/**
 * ONE derivation for the order payment block (QA-95). A refunded order is
 * not "unpaid / still owed": status or paymentStatus `refunded` wins, a
 * partial refund keeps the order paid but shows what went back.
 */
export function paymentDisplay(
  order: Pick<OrderDetail, 'status' | 'paymentStatus' | 'total' | 'walletAmount' | 'payments'>
): { state: PaymentDisplayState; remain: number; refunded: number } {
  const refunded = (order.payments ?? []).reduce((s, p) => s + (p.refundedAmount ?? 0), 0);
  let state: PaymentDisplayState;
  if (order.status === 'refunded' || order.paymentStatus === 'refunded') state = 'refunded';
  else if (order.paymentStatus === 'partially_refunded') state = 'partially_refunded';
  else state = order.paymentStatus === 'paid' ? 'paid' : 'unpaid';
  const remain = state === 'unpaid' ? Math.max(0, order.total - (order.walletAmount ?? 0)) : 0;
  return { state, remain, refunded };
}
