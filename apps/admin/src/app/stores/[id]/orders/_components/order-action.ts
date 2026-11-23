/**
 * A status NAME is not an action: a button reading "Refunded" on a delivered order looks like a
 * state ("already refunded"). Every transition target has a verb label under `orders.action.<status>`.
 */
const ACTION_STATUSES = new Set([
  'pending',
  'awaiting_payment_confirmation',
  'confirmed',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
  'refunded',
  'paid',
  'unpaid',
]);

/** True when `orders.action.<status>` exists, so callers can fall back to the status name for an unknown one. */
export function orderActionKey(status: string): boolean {
  return ACTION_STATUSES.has(status);
}
