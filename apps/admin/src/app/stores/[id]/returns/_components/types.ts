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
  /**
   * Bundle-tagging snapshot, joined from the returned line's `OrderItem`
   * (`ReturnService.list`/`getById`'s `items.include.orderItem` select) — a
   * bundle box's return always includes EVERY component at its full
   * quantity (returns are atomic, see `bundle_returns_are_atomic`), so
   * every `ReturnItem` sharing a `bundleGroupId` belongs to the same box.
   * `null`/`undefined` for a non-bundle line.
   */
  orderItem?: {
    bundleGroupId: string | null;
    bundleName: string | null;
    bundleNameAr: string | null;
  } | null;
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
  /** null: a guest order's return whose order snapshot was not joined, or a deleted customer */
  customer: {
    id: string | null;
    email: string;
    firstName: string;
    lastName: string;
    phone?: string | null;
    /** a guest order's return: the identity is the order's own name/email/phone, there is no account */
    isGuest?: boolean;
  } | null;
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
