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

// Valid status transitions — matches the platform-wide orders page
export const VALID_TRANSITIONS: Record<string, string[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'cancelled'],
  processing: ['shipped', 'cancelled'],
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
