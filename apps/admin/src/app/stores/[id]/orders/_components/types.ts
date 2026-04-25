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

export interface Order {
  id: string;
  orderNumber?: string;
  customer: OrderCustomer;
  total: number;
  status: string;
  paymentStatus: string;
  createdAt: string;
  payments?: OrderPayment[];
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
