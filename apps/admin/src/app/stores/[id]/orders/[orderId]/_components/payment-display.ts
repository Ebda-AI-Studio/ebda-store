import { orderPaymentSummary } from '@ebda/shared';
import type { OrderDetail } from './types';

export type PaymentDisplayState =
  | 'paid'
  | 'unpaid'
  | 'refunded'
  | 'partially_refunded'
  | 'disputed';

/**
 * ONE derivation for the order payment block (QA-95). The shared `orderPaymentSummary` decides paid / refunded /
 * disputed / unpaid (a refunded order is never "unpaid / still owed"); this adds the one state the card shows on top:
 * a partial refund keeps the order paid, so it reads "partially refunded" with nothing to collect.
 */
export function paymentDisplay(
  order: Pick<OrderDetail, 'status' | 'paymentStatus' | 'total' | 'walletAmount' | 'payments'>
): { state: PaymentDisplayState; remain: number; refunded: number } {
  const s = orderPaymentSummary(order);
  if (s.state === 'unpaid' && order.paymentStatus === 'partially_refunded')
    return { state: 'partially_refunded', remain: 0, refunded: s.refunded };
  return s;
}
