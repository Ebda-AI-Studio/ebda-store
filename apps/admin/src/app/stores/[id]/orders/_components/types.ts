import { ORDER_STATUS_TRANSITIONS, orderStatusOptions } from '@ebda/shared';

export interface OrderCustomer {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

/** Shipping address JSON — for guest orders the shopper's name/email live here
 *  (there is no `customer` row), so the list falls back to it for the name. */
export interface OrderAddress {
  firstName?: string;
  lastName?: string;
  email?: string;
}

export interface OrderPayment {
  provider: string;
  status: string;
}

export interface OrderLineItem {
  id: string;
  productName: string;
  /** The product's Arabic name (list rows carry only this field of the product). */
  product?: { nameAr?: string | null } | null;
  variantName?: string | null;
  quantity: number;
  price?: number;
  // Bundle tagging snapshot (see packages/database Prisma schema's OrderItem
  // comment) — set on every component row a bundle box expanded into at
  // checkout, null otherwise. Needed here so the list-row summary can group
  // a box back into one entry instead of listing its unrelated components.
  bundleGroupId?: string | null;
  bundleName?: string | null;
  bundleNameAr?: string | null;
}

export interface Order {
  id: string;
  orderNumber?: string;
  customer?: OrderCustomer | null;
  // Guest orders have no `customer` row — name/email fall back to this.
  shippingAddress?: OrderAddress | null;
  total: number;
  status: string;
  paymentStatus: string;
  /**
   * Order provenance — 'web' (default) | 'agent' (placed by an AI agent via
   * the MCP `place_order` tool). Optional/nullable: treat missing as 'web'.
   * Rendered as a small badge in the status column — every-data-needs-a-UI.
   */
  source?: string | null;
  createdAt: string;
  payments?: OrderPayment[];
  /**
   * Line items as returned by the orders-list API (see
   * apps/api/src/services/order.service.ts getStoreOrders → include.items).
   * Used to render a compact item summary in the list row so merchants can
   * tell orders apart without opening each one.
   */
  items?: OrderLineItem[];
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// Valid status transitions and the per-order options — one canonical map in
// @ebda/shared, read by the order list, the order page and the orders PWA
// (#1936/#1947). The API enforces its own typed copy
// (apps/api/src/services/order-status-machine.ts); a parity test pins them.
export const VALID_TRANSITIONS: Readonly<Record<string, readonly string[]>> =
  ORDER_STATUS_TRANSITIONS;

/**
 * Status options to offer for an order. `refunded` from pending/cancelled only
 * applies to an order that captured a payment; the API rejects it otherwise
 * (ORDER_NOT_PAID), so don't offer it.
 */
export const statusOptionsFor = orderStatusOptions;

/**
 * `statusOptionsFor` minus `refunded` for a user who cannot refund. Recording a refund needs the
 * API's `orders:refund` permission, which staff lack, so the option is hidden rather than offered
 * and answered with a 403.
 */
export function statusOptionsForRole(
  order: Parameters<typeof orderStatusOptions>[0],
  canRefund: boolean
): string[] {
  const options = orderStatusOptions(order);
  return canRefund ? [...options] : options.filter(s => s !== 'refunded');
}

export const STATUS_FILTERS = [
  'all',
  'pending',
  // InstaPay orders waiting for the merchant's "payment received" (SP6a).
  'awaiting_payment_confirmation',
  'confirmed',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
] as const;

export type StatusFilter = (typeof STATUS_FILTERS)[number];
