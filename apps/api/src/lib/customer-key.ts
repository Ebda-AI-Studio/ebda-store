import { createHash } from 'node:crypto';

/**
 * ONE definition of "which customer does this order belong to".
 *
 * Before this module, the key was derived three ways:
 *  - the Customers page / export (`customers.routes.ts`): user id, else the
 *    lowercased shipping email, else the shipping phone, else `guest:<orderId>`;
 *  - the RFM + cohort rollups (`analytics-rollup.service.ts`): user id, else
 *    `GUEST:sha256("<email>:<phone>")`.
 *
 * The two could never be joined, so an RFM segment could not be resolved to
 * the Customers-page rows it counted (audit 2026-09-30 analytics §4), and a
 * guest who used one email with two phones was ONE customer on the page but
 * TWO customers to RFM. Every surface now groups with `customerKeyOf`, and
 * RFM stores `rfmKeyFor(key)` — the same grouping, with a guest's contact
 * hashed so `customer_rfm_snapshots` never holds a plain email or phone.
 */

interface OrderIdentity {
  /** `orders.customer_id` — set only when a signed-in shopper placed it. */
  customerId?: string | null;
  /** Optional joined `customer` relation (list queries select it). */
  customer?: { id?: string | null } | null;
  /** `orders.shipping_address` JSON snapshot. */
  shippingAddress?: unknown;
}

function contactOf(shippingAddress: unknown): { email: string; phone: string } {
  if (!shippingAddress || typeof shippingAddress !== 'object') return { email: '', phone: '' };
  const a = shippingAddress as Record<string, unknown>;
  return {
    email: typeof a.email === 'string' ? a.email.toLowerCase() : '',
    phone: typeof a.phone === 'string' ? a.phone : '',
  };
}

/**
 * The Customers-page grouping key for an order: the registered user id, else
 * the lowercased shipping email, else the shipping phone. `null` when the
 * order is a guest checkout with no contact at all — callers decide what that
 * means (the list gives it its own `guest:<orderId>` row; RFM skips it,
 * because a customer nobody can contact cannot be segmented usefully).
 *
 * The email is lowercased but NOT trimmed, and the phone is used verbatim —
 * exactly the list's historical behaviour, because this value is also the
 * `:customerKey` URL of the customer detail page and bookmarked links must
 * keep resolving.
 */
export function customerKeyOf(order: OrderIdentity): string | null {
  const userId = order.customer?.id || order.customerId;
  if (userId) return userId;
  const { email, phone } = contactOf(order.shippingAddress);
  return email || phone || null;
}

/** True when `customerKeyOf` fell back to the guest contact. */
export function isGuestOrder(order: OrderIdentity): boolean {
  return !(order.customer?.id || order.customerId);
}

/** Prefix for a hashed guest key in `customer_rfm_snapshots.customer_id`. */
export const GUEST_RFM_KEY_PREFIX = 'GUEST:';

/**
 * The key RFM stores for a customer. Registered: the user id, unchanged.
 * Guest: `GUEST:` + sha256 of the `customerKeyOf` value, so the snapshot row
 * joins to the Customers-page row by hashing that row's id — no plain email
 * or phone is written to the analytics table.
 */
export function rfmKeyFor(key: string, isGuest: boolean): string {
  if (!isGuest) return key;
  return `${GUEST_RFM_KEY_PREFIX}${createHash('sha256').update(key, 'utf8').digest('hex')}`;
}
