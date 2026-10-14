/**
 * An order whose payment has not been confirmed must never reach fulfilment
 * (carrier booking, label printing, pick/pack). InstaPay orders sit in
 * `awaiting_payment_confirmation` until the merchant confirms the transfer
 * arrived (SP6a, Review Focus 3). The state machine already refuses
 * processing/shipped/delivered from that status; this guard is the second line,
 * on the paths that call a carrier and would otherwise spend money before the
 * status machine is ever consulted.
 */
import { UNFULFILLABLE_ORDER_STATUSES } from '@ebda/shared';
import { AppError } from '../middleware/error-handler';

export function isFulfillable(order: { status: string }): boolean {
  return !(UNFULFILLABLE_ORDER_STATUSES as readonly string[]).includes(order.status);
}

export function assertOrderFulfillable(order: { status: string }): void {
  if (!isFulfillable(order)) {
    throw new AppError(
      409,
      'ORDER_AWAITING_PAYMENT_CONFIRMATION',
      'This order is waiting for the InstaPay transfer to be confirmed and cannot be fulfilled yet'
    );
  }
}
