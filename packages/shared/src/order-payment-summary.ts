/**
 * What an order's payment card says, and whether the order can still be marked paid. One pure module for the admin
 * order page, the orders PWA and `orderActionVisibility`, so the card and the buttons can never disagree.
 *
 * Before: `paymentStatus === 'paid' ? Paid : Unpaid`. A fully refunded order fell into Unpaid and showed "Remain 160"
 * for money that was handed back (Amelia ORD-TOYND8-R19A2, 2026-11-23). A merchant could chase a refunded customer.
 *
 * `status === 'refunded'` counts as refunded even when `paymentStatus` was left alone: a status-only refund on a
 * Durable Object store keeps `payment_status` (keepPaymentStatus, packages/repo/src/do/refund.ts), so a delivered,
 * never-paid COD order is Refunded with nothing owed, and a paid one is Refunded, not Paid.
 */
interface OrderPaymentStateInput {
  status: string;
  paymentStatus: string;
}

interface OrderPaymentSummaryInput extends OrderPaymentStateInput {
  total: number;
  walletAmount?: number | null;
  payments?: ReadonlyArray<{ refundedAmount?: number | null }> | null;
  /**
   * Piastres handed back across every recorded channel (payments + merchant-booked partial refunds), computed by the
   * API. Preferred over summing `payments`, which misses a merchant-booked partial on a Durable Object store.
   */
  refundedTotal?: number | null;
}

type OrderPaymentState = 'paid' | 'refunded' | 'disputed' | 'unpaid';

interface OrderPaymentSummary {
  state: OrderPaymentState;
  /** Piastres handed back so far (0 when none or unknown). */
  refunded: number;
  /** Piastres still to collect: 0 unless the order is genuinely unpaid and not cancelled. */
  remain: number;
}

const CAPTURED = ['paid', 'refunded', 'disputed'];

export function orderPaymentState(order: OrderPaymentStateInput): OrderPaymentState {
  if (order.paymentStatus === 'refunded' || order.status === 'refunded') return 'refunded';
  if (order.paymentStatus === 'disputed') return 'disputed';
  return order.paymentStatus === 'paid' ? 'paid' : 'unpaid';
}

export function orderPaymentSummary(order: OrderPaymentSummaryInput): OrderPaymentSummary {
  const state = orderPaymentState(order);
  const fromPayments = (order.payments ?? []).reduce(
    (s, p) => s + Math.max(0, p.refundedAmount ?? 0),
    0
  );
  const recorded = Math.max(0, order.refundedTotal ?? fromPayments);
  if (state === 'refunded') {
    // Recorded money wins. With none recorded, the whole total went back only if it was ever paid.
    const wasPaid = CAPTURED.includes(order.paymentStatus);
    return { state, refunded: recorded > 0 ? recorded : wasPaid ? order.total : 0, remain: 0 };
  }
  if (state === 'unpaid' && order.status !== 'cancelled') {
    return {
      state,
      refunded: recorded,
      remain: Math.max(0, order.total - (order.walletAmount ?? 0)),
    };
  }
  // paid, disputed (the customer's bank holds the money; nothing to collect) or a cancelled unpaid order: nothing owed.
  return { state, refunded: recorded, remain: 0 };
}
