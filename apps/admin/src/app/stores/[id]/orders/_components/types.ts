export interface OrderCustomer {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
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
  customer: OrderCustomer;
  total: number;
  status: string;
  paymentStatus: string;
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

// Valid status transitions — must mirror the backend list in
// apps/api/src/routes/order.routes.ts. Admins can jump ahead in the workflow
// (e.g. confirmed → delivered for same-day COD) instead of stepping through
// every intermediate state. Backwards moves are still blocked.
export const VALID_TRANSITIONS: Record<string, string[]> = {
  pending: ['confirmed', 'processing', 'shipped', 'delivered', 'cancelled'],
  confirmed: ['processing', 'shipped', 'delivered', 'cancelled'],
  processing: ['shipped', 'delivered', 'cancelled'],
  shipped: ['delivered'],
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
