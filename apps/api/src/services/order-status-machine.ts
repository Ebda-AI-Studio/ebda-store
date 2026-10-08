import { OrderStatus } from '@force/database';
import { AppError } from '../middleware/error-handler';

/**
 * The single source of truth for allowed order status transitions.
 *
 * Enforced on EVERY writer of `Order.status` (updateStatus + the gateway/
 * webhook direct writers) to stop a stale webhook or an out-of-order gateway
 * callback from silently regressing an order. Backwards moves are blocked;
 * admins/gateways can still jump ahead. A same-status write is a safe no-op.
 *
 * `refunded` is reachable from EVERY non-terminal state, including `pending`
 * and `cancelled`. An online payment can complete while the order is still
 * pending (webhook not yet advanced) or before staff cancel it (a paid order
 * cancelled by staff still owes the customer a refund), so the gateway refund
 * flow must reach `refunded` from any state that can hold a completed payment.
 * Blocking `cancelled → refunded` rejected refunds of paid-then-cancelled
 * orders with a 502 before any money moved (PR #770, whose fix never reached
 * main). Stock/coupon/loyalty reversal is safe to reach twice (cancel, then
 * refund) ONLY because every path that reverses an order writes the canonical
 * per-order markers the `order/refunded` fanout guards on — the
 * `return_stock` InventoryHistory row and the `coupon_reversed` orderEvent.
 * That is load-bearing for this edge, not incidental: `rollbackForPaymentFailure`
 * reverses inline, and while it wrote `type='adjustment'` instead the markers
 * never matched, so refunding a rolled-back-then-paid order (auto-cancel →
 * customer pays the still-live provider invoice → finance refunds it) invented
 * stock and returned a coupon redemption. Any NEW inline reversal path must
 * write those markers before it can be allowed to reach `refunded`.
 * `refunded` is the only terminal state.
 *
 * Lives in its own module (no service/inngest imports) so any status writer
 * can import the guard without pulling in the heavy OrderService dependency
 * graph. The merchant surfaces (admin list + order page, orders PWA) read
 * `ORDER_STATUS_TRANSITIONS` in @force/shared; change both together —
 * tests/unit/order-status-transitions-parity.test.ts fails when they differ.
 */
export const VALID_ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  // InstaPay manual transfer (SP6a, Review Focus 3). The order holds stock but
  // is NOT shippable: the only ways out are `confirmed` (the merchant's one
  // "payment received" action, which also records the payment — see
  // instapay-confirmation.service.ts) and `cancelled` (merchant or expiry).
  // processing/shipped/delivered are deliberately absent, so no generic writer
  // can ship an unconfirmed order. `refunded` is absent too: nothing was captured.
  awaiting_payment_confirmation: ['confirmed', 'cancelled'],
  pending: ['confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'],
  confirmed: ['processing', 'shipped', 'delivered', 'cancelled', 'refunded'],
  processing: ['shipped', 'delivered', 'cancelled', 'refunded'],
  // 'processing' models SHIPMENT CANCELLATION: cancelling a carrier shipment
  // returns the order to processing. shipping-carrier.service.ts has performed
  // this write in production all along; the machine simply never described it,
  // which is why that writer could not be guarded. Adding it here changes no
  // behaviour — it makes the existing behaviour expressible, so the guard can
  // be applied to every Order.status writer instead of all but four.
  // 'cancelled' models RETURN TO ORIGIN (ruling MONEYB-5): the courier brings
  // the parcel back (refused COD, failed delivery), so the order is cancelled —
  // nothing collected on COD, stock back per the merchant's choice.
  shipped: ['delivered', 'refunded', 'processing', 'cancelled'],
  delivered: ['refunded'],
  cancelled: ['refunded'],
  refunded: [],
};

/** Throws AppError(400, INVALID_STATUS_TRANSITION) if from→to is not allowed. */
export function assertValidTransition(from: OrderStatus, to: OrderStatus): void {
  if (from === to) return;
  if (!VALID_ORDER_TRANSITIONS[from]?.includes(to)) {
    throw new AppError(400, 'INVALID_STATUS_TRANSITION', `Cannot transition from ${from} to ${to}`);
  }
}
