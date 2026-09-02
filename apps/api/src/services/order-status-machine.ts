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
 * `refunded` is reachable from confirmed/processing/shipped/delivered (not
 * just delivered): the payment-gateway refund flow can legitimately refund an
 * order before it ships. Both terminal states have no outgoing transitions.
 *
 * Lives in its own module (no service/inngest imports) so any status writer
 * can import the guard without pulling in the heavy OrderService dependency
 * graph. Mirror this map in apps/admin/.../orders/_components/types.ts.
 */
export const VALID_ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ['confirmed', 'processing', 'shipped', 'delivered', 'cancelled'],
  confirmed: ['processing', 'shipped', 'delivered', 'cancelled', 'refunded'],
  processing: ['shipped', 'delivered', 'cancelled', 'refunded'],
  // 'processing' models SHIPMENT CANCELLATION: cancelling a carrier shipment
  // returns the order to processing. shipping-carrier.service.ts has performed
  // this write in production all along; the machine simply never described it,
  // which is why that writer could not be guarded. Adding it here changes no
  // behaviour — it makes the existing behaviour expressible, so the guard can
  // be applied to every Order.status writer instead of all but four.
  shipped: ['delivered', 'refunded', 'processing'],
  delivered: ['refunded'],
  cancelled: [],
  refunded: [],
};

/** Throws AppError(400, INVALID_STATUS_TRANSITION) if from→to is not allowed. */
export function assertValidTransition(from: OrderStatus, to: OrderStatus): void {
  if (from === to) return;
  if (!VALID_ORDER_TRANSITIONS[from]?.includes(to)) {
    throw new AppError(400, 'INVALID_STATUS_TRANSITION', `Cannot transition from ${from} to ${to}`);
  }
}
