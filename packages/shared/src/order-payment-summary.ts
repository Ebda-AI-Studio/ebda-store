/**
 * What an order's payment card says. One pure helper for the admin order page and the orders PWA, which both
 * rendered `paymentStatus === 'paid' ? Paid : Unpaid`. A fully refunded order (paymentStatus `refunded`) fell into the
 * Unpaid arm and showed "Remain 160" for money that was handed back (Amelia ORD-TOYND8-R19A2, 2026-11-23): a merchant could
 * chase a customer for a refunded amount.
 */
export interface OrderPaymentSummaryInput {
  status: string;
  paymentStatus: string;
  total: number;
  walletAmount?: number | null;
  payments?: ReadonlyArray<{ refundedAmount?: number | null }> | null;
}

export type OrderPaymentState = 'paid' | 'refunded' | 'unpaid';

export interface OrderPaymentSummary {
  state: OrderPaymentState;
  /** Piastres handed back so far across the order's payments (0 when none). */
  refunded: number;
  /** Piastres still to collect: 0 unless the order is genuinely unpaid. */
  remain: number;
}

export function orderPaymentSummary(order: OrderPaymentSummaryInput): OrderPaymentSummary {
  const recorded = (order.payments ?? []).reduce(
    (s, p) => s + Math.max(0, p.refundedAmount ?? 0),
    0
  );
  if (order.paymentStatus === 'refunded') {
    // The order-level flag is authoritative; the payment rows may lag (a status-only refund).
    return { state: 'refunded', refunded: recorded > 0 ? recorded : order.total, remain: 0 };
  }
  if (order.paymentStatus === 'paid') return { state: 'paid', refunded: recorded, remain: 0 };
  return {
    state: 'unpaid',
    refunded: recorded,
    remain: Math.max(0, order.total - (order.walletAmount ?? 0)),
  };
}
