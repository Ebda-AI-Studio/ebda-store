export interface ReturnItem {
  id: string;
  productName: string;
  quantity: number;
  reason?: string;
  condition?: string;
  product?: {
    name: string;
    images?: { url: string }[];
  };
}

export interface ReturnRecord {
  id: string;
  returnNumber: string;
  type: 'return' | 'exchange' | 'refund';
  status: string;
  reason: string;
  reasonDetail?: string;
  refundAmount: number;
  refundMethod?: string;
  trackingNumber?: string;
  customerNotes?: string;
  adminNotes?: string;
  createdAt: string;
  approvedAt?: string;
  receivedAt?: string;
  refundedAt?: string;
  order: {
    orderNumber: string;
    total: number;
  };
  customer: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
  };
  items: ReturnItem[];
}

export interface ReturnsStats {
  total: number;
  pending: number;
  approved: number;
  completed: number;
}

export interface ListMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export const RETURN_STATUS_KEYS = [
  'pending',
  'approved',
  'rejected',
  'shipped',
  'received',
  'inspecting',
  'completed',
  'cancelled',
] as const;

export type ReturnStatus = (typeof RETURN_STATUS_KEYS)[number];

export const RETURN_TYPE_KEYS = ['return', 'exchange', 'refund'] as const;

export type ReturnType = (typeof RETURN_TYPE_KEYS)[number];

export const RETURN_FILTER_KEYS = ['all', 'pending', 'approved', 'completed'] as const;

export type ReturnFilter = (typeof RETURN_FILTER_KEYS)[number];
