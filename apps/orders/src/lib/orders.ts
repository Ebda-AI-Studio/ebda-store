/**
 * Order types + status helpers — mirror the existing admin contracts so the
 * PWA reads the same `{ orders, meta }` / `{ order }` envelopes the API
 * (OrderService) already emits. No new endpoints.
 */

import { z } from 'zod/v3';
import { ORDER_STATUS_TRANSITIONS, orderStatusOptions } from '@ebda/shared';

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
  /** Specific method within the provider (e.g. card, meeza, wallet). */
  method?: string | null;
  status: string;
  amount?: number;
  /** Provider-side transaction id, useful for reconciliation. */
  transactionId?: string | null;
  /** Provider's hosted-checkout URL (Paymob / Kashier / Fawry). */
  paymentUrl?: string | null;
  /** Legacy alias for paymentUrl kept for backwards compatibility. */
  paymentLink?: string | null;
  /** Piastres already refunded from this payment (partial refunds accumulate). */
  refundedAmount?: number | null;
  createdAt?: string;
}

export interface OrderLineItem {
  id: string;
  productId?: string;
  productName: string;
  variantName?: string | null;
  /** Arabic variant snapshot (Ruling B0-41); null on orders placed before it existed. */
  variantNameAr?: string | null;
  /** The customer's personalisation text (e.g. the name to embroider). */
  personalisation?: string | null;
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
  /**
   * Bundle-expansion tags — a bundle purchase expands into one `OrderItem`
   * per component at checkout, all sharing a `bundleGroupId` (one id per
   * BOX, never per bundle-in-cart, so two boxes of the same bundle produce
   * two separate groups). `bundleName`/`bundleNameAr` are snapshotted onto
   * the order at checkout time — like `productName` already is — so a
   * renamed/deleted bundle still shows the name the customer actually
   * bought. Mirrors the admin's `OrderItemDetail` and the web's `Order`
   * item shape (`apps/web/src/lib/api.ts`) so all three surfaces agree on
   * field names. This is the fulfilment app: like admin (and unlike the
   * customer-facing storefront), it must keep every component line
   * individually visible under the bundle's grouped/labelled row — the
   * fulfiller needs to know exactly what to physically put in the box.
   */
  bundleId?: string | null;
  bundleGroupId?: string | null;
  bundleName?: string | null;
  bundleNameAr?: string | null;
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
  /** Piastres handed back across every recorded channel (API-computed; includes merchant-booked partial refunds). */
  refundedTotal?: number | null;
  createdAt: string;
  /** InstaPay hold deadline (ISO) while the order awaits the merchant's confirmation. */
  paymentConfirmationExpiresAt?: string | null;
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
  // Governorate (top-level Egyptian governorate (محافظة)).
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
  /** Frozen at sale time (Ruling M3-8): `tax` is already inside subtotal/total. */
  taxIncludedInPrice?: boolean;
  shipping: number;
  /** COD fee frozen at creation, inside `total` (ruling MONEYB-3). */
  codFee?: number;
  discount: number;
  couponCode?: string | null;
  couponDiscount?: number;
  /** The automatic-promotion portion of `discount` (0 when a coupon — not a
   *  promotion — was the winning lever, or when no discount applied). */
  promotionDiscount?: number;
  /** The promotion that discounted this order, when `promotionDiscount` > 0. */
  appliedPromotion?: { id: string; name: string; nameAr?: string | null } | null;
  /** The loyalty-points redemption portion of `discount`, in piastres (0 when no
   *  points were redeemed). */
  loyaltyDiscount?: number;
  /** Points redeemed for `loyaltyDiscount`; null on a pre-feature order. */
  loyaltyPointsRedeemed?: number | null;
  /** Customer-wallet (store credit) portion of `total`, in piastres (D1). The
   *  gateway / courier collects `total - walletAmount`. 0 or absent for every
   *  order that did not use the wallet. */
  walletAmount?: number;
  notes: string | null;
  customerNotes: string | null;
  shippingAddress: AddressJson | null;
  billingAddress?: AddressJson | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  updatedAt: string;
  items: OrderLineItem[];
  payments?: OrderPayment[];
  /** InstaPay summary for the merchant (the customer's entered reference, the handle paid to). */
  instapay?: {
    customerReference: string | null;
    customerReferenceAt: string | null;
    handle: string | null;
    expiresAt: string | null;
  } | null;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/**
 * Valid status transitions and the per-order options — the canonical map in
 * @ebda/shared, the same one the admin order list and order page read. This
 * file kept its own copy, which drifted: no `cancelled` key and `refunded`
 * only from `delivered`, so a paid, cancelled order could not be marked
 * refunded from the PWA (#1936, also #1899 — shipped -> processing on shipment
 * cancellation is included). Backwards moves are blocked server-side.
 */
export const VALID_TRANSITIONS: Readonly<Record<string, readonly string[]>> =
  ORDER_STATUS_TRANSITIONS;

/** Status options to offer for one order (drops `refunded` on an unpaid pending/cancelled order). */
export const statusOptionsFor = orderStatusOptions;

/**
 * The status filter set surfaced in the PWA. `new` is a UI alias for the
 * `pending` API status (a brand-new, not-yet-acknowledged order). `paid` is a
 * client-side concept derived from paymentStatus rather than a status enum
 * value — see filterMatches below.
 */
export const STATUS_FILTERS = [
  'all',
  'new',
  // InstaPay orders waiting for the merchant's "payment received" (SP6a).
  'awaiting',
  'paid',
  'processing',
  'shipped',
  'delivered',
] as const;

export type StatusFilter = (typeof STATUS_FILTERS)[number];

/**
 * Map a UI filter to the API `status` query param. `all` and `paid` send no
 * status filter (paid is applied client-side); `new` maps to `pending`.
 */
export function filterToApiStatus(filter: StatusFilter): string | undefined {
  if (filter === 'all' || filter === 'paid') return undefined;
  if (filter === 'new') return 'pending';
  if (filter === 'awaiting') return 'awaiting_payment_confirmation';
  return filter;
}

/** Client-side refinement for the `paid` pseudo-filter. */
export function clientFilterMatches(order: Order, filter: StatusFilter): boolean {
  if (filter === 'paid') return order.paymentStatus === 'paid';
  return true;
}

export const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-warning/15 text-warning-foreground border-warning/30',
  awaiting_payment_confirmation: 'bg-primary/15 text-primary-ink border-primary/30',
  confirmed: 'bg-info/15 text-info-ink border-info/30',
  processing: 'bg-info/15 text-info-ink border-info/30',
  shipped: 'bg-primary/15 text-primary-ink border-primary/30',
  delivered: 'bg-success/15 text-success-ink border-success/30',
  cancelled: 'bg-destructive/15 text-destructive-ink border-destructive/30',
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
  // Recording a refund the merchant already paid out (the API's REFUND_NOT_RECORDED gate).
  refundRecorded: z.literal(true).optional(),
  refundMethod: z.enum(['cash', 'instapay', 'bank_transfer', 'store_credit', 'other']).optional(),
  refundReference: z.string().trim().max(120).optional(),
});

/**
 * `statusOptionsFor` minus `refunded` for a user who cannot refund. Recording a refund needs the
 * API's `orders:refund` permission, which staff lack, so the option is hidden, not offered and 403'd.
 */
export function statusOptionsForRole(
  order: Parameters<typeof orderStatusOptions>[0],
  canRefund: boolean
): string[] {
  const options = orderStatusOptions(order);
  return canRefund ? [...options] : options.filter(s => s !== 'refunded');
}
