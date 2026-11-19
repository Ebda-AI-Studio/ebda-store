import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Signed, expiring, view-only link to ONE order's status summary (Ruling WA-COD-V2-2). It is what the COD
 * WhatsApp message's "order details" button opens, so a GUEST (no account) can see their order.
 *
 *   token = <storeId>.<orderId>.<expiresAtEpochSeconds>.<base64url(HMAC-SHA256(secret, "order-status-link:v1:<storeId>:<orderId>:<exp>"))>
 *
 * - Bound to the store AND the order (a token for order A / store 1 reads nothing else); expires (14 days).
 * - No PII inside: two UUIDs and an expiry.
 * - A DEDICATED secret, `ORDER_STATUS_LINK_SECRET` (>= 32 chars), never derived from another key and never
 *   shared with the guest view token (`order-view-token.ts`), which stays out of URLs (SEC-15). This token only
 *   opens the minimal read-only summary (`GET /public/order-status/:token`): no phone, no email, no street.
 * - Constant-time verify. A missing or short secret throws (boot guard: `assertWhatsAppLinkConfig`).
 */
const ORDER_STATUS_LINK_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MIN_SECRET_LENGTH = 32;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function orderStatusLinkSecret(): string {
  const v = process.env.ORDER_STATUS_LINK_SECRET ?? '';
  if (v.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `ORDER_STATUS_LINK_SECRET must be set (>= ${MIN_SECRET_LENGTH} chars): it signs the order-status links`
    );
  }
  return v;
}

function mac(secret: string, storeId: string, orderId: string, exp: number): Buffer {
  return createHmac('sha256', secret)
    .update(`order-status-link:v1:${storeId}:${orderId}:${exp}`)
    .digest();
}

export function signOrderStatusLinkToken(
  storeId: string,
  orderId: string,
  now: number = Date.now()
): string {
  const exp = Math.floor((now + ORDER_STATUS_LINK_TTL_MS) / 1000);
  return `${storeId}.${orderId}.${exp}.${mac(orderStatusLinkSecret(), storeId, orderId, exp).toString('base64url')}`;
}

/** The store and order a well-formed, unexpired, correctly signed token names, else null. Never throws on a bad token. */
export function verifyOrderStatusLinkToken(
  token: unknown,
  now: number = Date.now()
): { storeId: string; orderId: string } | null {
  if (typeof token !== 'string' || token.length > 250) return null;
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [storeId, orderId, expRaw, sig] = parts as [string, string, string, string];
  if (!UUID_RE.test(storeId) || !UUID_RE.test(orderId)) return null;
  if (!/^\d{1,12}$/.test(expRaw) || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return null;
  const exp = Number(expRaw);
  if (exp * 1000 < now) return null;
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== 32) return null;
  return timingSafeEqual(given, mac(orderStatusLinkSecret(), storeId, orderId, exp))
    ? { storeId, orderId }
    : null;
}
