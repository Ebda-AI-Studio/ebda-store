/**
 * Order types + status helpers — mirror the existing admin contracts so the
 * PWA reads the same `{ orders, meta }` / `{ order }` envelopes the API
 * (OrderService) already emits. No new endpoints.
 */

import { z } from 'zod';

export interface OrderCustomer {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string | null;
}

export interface OrderPayment {
  id?: string;
  provider: string;
  /** Specific method within the provider (e.g. knet, visa, mastercard). */
  method?: string | null;
  status: string;
  amount?: number;
  /** Provider-side transaction id, useful for reconciliation. */
  transactionId?: string | null;
  /** Provider's hosted-checkout URL (MyFatoorah / Tap / Hesabe / UPayments). */
  paymentUrl?: string | null;
  /** Legacy alias for paymentUrl kept for backwards compatibility. */
  paymentLink?: string | null;
  createdAt?: string;
}

export interface OrderLineItem {
  id: string;
  productId?: string;
  productName: string;
  variantName?: string | null;
  sku?: string | null;
  quantity: number;
  price?: number;
  total?: number;
  product?: {
    id: string;
    // Arabic product name from the live product (order_items only snapshots
    // the English productName); used to localize the item label in RTL.
    nameAr?: string | null;
    images?: Array<{ url: string; alt?: string | null }>;
  };
}

export interface Order {
  id: string;
  orderNumber?: string;
  customer?: OrderCustomer | null;
  // Guest orders have no `customer` row — the name the shopper entered lives
  // here, so the card falls back to it (otherwise guest orders show no name).
  shippingAddress?: AddressJson | null;
  total: number;
  currency?: string;
  status: string;
  paymentStatus: string;
  createdAt: string;
  payments?: OrderPayment[];
  items?: OrderLineItem[];
}

export interface AddressJson {
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  country?: string;
  city?: string;
  area?: string;
  block?: string;
  street?: string;
  avenue?: string;
  house?: string;
  building?: string;
  floor?: string;
  apartment?: string;
  notes?: string;
  // Governorate (top-level KW administrative division).
  governorate?: string;
  governorateAr?: string;
  // Bilingual fallback fields stored as the customer entered them.
  cityAr?: string;
  areaAr?: string;
  streetAr?: string;
}

export interface OrderDetail extends Order {
  storeId: string;
  subtotal: number;
  tax: number;
  shipping: number;
  discount: number;
  notes: string | null;
  customerNotes: string | null;
  shippingAddress: AddressJson | null;
  billingAddress?: AddressJson | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  updatedAt: string;
  items: OrderLineItem[];
  payments?: OrderPayment[];
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/**
 * Valid status transitions — mirrors the admin's VALID_TRANSITIONS, which in
 * turn mirrors the backend list in apps/api/src/routes/order.routes.ts.
 * Admins can jump ahead (e.g. confirmed → delivered for same-day COD).
 * Backwards moves are blocked server-side.
 */
export const VALID_TRANSITIONS: Record<string, string[]> = {
  pending: ['confirmed', 'processing', 'shipped', 'delivered', 'cancelled'],
  confirmed: ['processing', 'shipped', 'delivered', 'cancelled'],
  processing: ['shipped', 'delivered', 'cancelled'],
  shipped: ['delivered'],
  delivered: ['refunded'],
};

/**
 * The status filter set surfaced in the PWA. `new` is a UI alias for the
 * `pending` API status (a brand-new, not-yet-acknowledged order). `paid` is a
 * client-side concept derived from paymentStatus rather than a status enum
 * value — see filterMatches below.
 */
export const STATUS_FILTERS = ['all', 'new', 'paid', 'processing', 'shipped', 'delivered'] as const;

export type StatusFilter = (typeof STATUS_FILTERS)[number];

/**
 * Map a UI filter to the API `status` query param. `all` and `paid` send no
 * status filter (paid is applied client-side); `new` maps to `pending`.
 */
export function filterToApiStatus(filter: StatusFilter): string | undefined {
  if (filter === 'all' || filter === 'paid') return undefined;
  if (filter === 'new') return 'pending';
  return filter;
}

/** Client-side refinement for the `paid` pseudo-filter. */
export function clientFilterMatches(order: Order, filter: StatusFilter): boolean {
  if (filter === 'paid') return order.paymentStatus === 'paid';
  return true;
}

export const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-warning/15 text-warning-foreground border-warning/30',
  confirmed: 'bg-info/15 text-info border-info/30',
  processing: 'bg-info/15 text-info border-info/30',
  shipped: 'bg-primary/15 text-primary border-primary/30',
  delivered: 'bg-success/15 text-success border-success/30',
  cancelled: 'bg-destructive/15 text-destructive border-destructive/30',
  refunded: 'bg-muted text-muted-foreground border-border',
};

// Zod schema for the only mutation input — the status update.
export const statusUpdateSchema = z.object({
  status: z.enum([
    'pending',
    'confirmed',
    'processing',
    'shipped',
    'delivered',
    'cancelled',
    'refunded',
  ]),
});
