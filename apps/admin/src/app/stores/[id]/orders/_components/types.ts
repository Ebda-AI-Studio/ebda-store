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
  variantName?: string | null;
  quantity: number;
  price?: number;
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

// Valid status transitions — must mirror `assertValidTransition` in
// apps/api/src/services/order.service.ts. Admins can jump ahead in the
// workflow (e.g. confirmed → delivered for same-day COD) instead of
// stepping through every intermediate state. Backwards moves are still
// blocked. `refunded` is reachable from confirmed/processing/shipped/
// delivered (not just delivered) — money-integrity Task 6 unified this
// list with the payment-gateway refund flow, which could already refund an
// order before it shipped.
export const VALID_TRANSITIONS: Record<string, string[]> = {
  pending: ['confirmed', 'processing', 'shipped', 'delivered', 'cancelled'],
  confirmed: ['processing', 'shipped', 'delivered', 'cancelled', 'refunded'],
  processing: ['shipped', 'delivered', 'cancelled', 'refunded'],
  shipped: ['delivered', 'refunded'],
  delivered: ['refunded'],
};

export const STATUS_FILTERS = [
  'all',
  'pending',
  'confirmed',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
] as const;

export type StatusFilter = (typeof STATUS_FILTERS)[number];
