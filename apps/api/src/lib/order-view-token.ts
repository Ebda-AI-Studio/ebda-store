import { createHmac, timingSafeEqual } from 'crypto';
import { derivedSecret } from './derived-secret';
import { verifyOrderStatusLinkToken } from './order-status-link-token';

/**
 * Signed, expiring "view" token for ONE guest order (SEC-15 / M-137).
 *
 *   token = <orderId>.<expiresAtEpochSeconds>.<base64url(HMAC-SHA256(key, "order-view:v1:<orderId>:<exp>"))>
 *
 * A guest has no account, so the order UUID used to be the whole credential: it leaks through
 * history, screenshots and shared links, and then exposed the shipping address and phone. The token
 * is handed back ONLY in the response to the call that created the order; the storefront keeps it
 * in the buyer's own sessionStorage. Without it `GET /public/orders/:id` still answers (status,
 * lines, totals) but masks the buyer's identity and address.
 *
 * - Bound to the order id (a token for order A reads nothing else) and expires (30 days).
 * - No PII inside. Domain-separated with its own HKDF label.
 */
export const ORDER_VIEW_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function key(): string | Buffer {
  return process.env.ORDER_VIEW_SECRET || derivedSecret('ebda:order-view-mac:v1');
}

function mac(k: string | Buffer, orderId: string, exp: number): Buffer {
  return createHmac('sha256', k).update(`order-view:v1:${orderId}:${exp}`).digest();
}

export function signOrderViewToken(orderId: string, now: number = Date.now()): string {
  const exp = Math.floor((now + ORDER_VIEW_TTL_MS) / 1000);
  return `${orderId}.${exp}.${mac(key(), orderId, exp).toString('base64url')}`;
}

/** True only for a well-formed, unexpired token issued for exactly this order. */
export function verifyOrderViewToken(
  token: unknown,
  orderId: string,
  now: number = Date.now()
): boolean {
  if (typeof token !== 'string' || token.length > 200) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [tokOrderId, expRaw, sig] = parts;
  if (!UUID_RE.test(tokOrderId) || tokOrderId.toLowerCase() !== orderId.toLowerCase()) return false;
  if (!/^\d{1,12}$/.test(expRaw)) return false;
  if (!/^[A-Za-z0-9_-]{43}$/.test(sig)) return false;
  const exp = Number(expRaw);
  if (exp * 1000 < now) return false;
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== 32) return false;
  return timingSafeEqual(given, mac(key(), tokOrderId, exp));
}

/**
 * Does this request carry a valid view token for this order? Never throws: a missing signing key
 * or a malformed header is simply "no" (the masked view), never a 500.
 */
export function requestHoldsOrderViewToken(
  req: { get(name: string): string | undefined },
  orderId: string
): boolean {
  try {
    return verifyOrderViewToken(req.get('x-order-view-token'), orderId);
  } catch {
    return false;
  }
}

/**
 * Ruling INSTAPAY-UPLOAD-1 part b (register G54): the signed order-status link (`X-Order-Status-Link`, the token behind
 * the COD/WhatsApp "order details" button, `order-status-link-token.ts`) also opens THIS order's InstaPay payment flow,
 * so a guest who reopens the order from WhatsApp on another device can pay. It must name exactly this order AND the
 * store the order belongs to (`orderStoreId`, the route's own lookup). Never throws: a missing secret, a malformed or
 * expired token, another order or another store is simply "no". It opens instructions, upload and submit only: the receipt
 * payer's PII stays masked for a link holder (a forwarded URL is not the shopper), only the view token unmasks it.
 */
export async function requestHoldsOrderStatusLink(
  req: { get(name: string): string | undefined },
  orderId: string,
  orderStoreId: (orderId: string) => Promise<string | null>
): Promise<boolean> {
  try {
    const raw = req.get('x-order-status-link');
    if (!raw) return false;
    const claim = verifyOrderStatusLinkToken(raw);
    if (!claim || claim.orderId.toLowerCase() !== orderId.toLowerCase()) return false;
    return (await orderStoreId(orderId)) === claim.storeId;
  } catch {
    return false;
  }
}

/**
 * TEN-5 (2026-11-12 audit) + Ruling INSTAPAY-UPLOAD-1: route guard for the guest InstaPay WRITES (`receipt` upload,
 * `submit`). The order UUID alone is not a credential (it leaks through history, screenshots, shared links). They accept the order's view token OR the SIGNED-IN customer who owns the order, so a shopper
 * who returns on another tab or device (no sessionStorage token) can still pay. `ownsOrder` is the route's own
 * fail-closed lookup (order id + the caller's customer id on the order's store); any throw or false is a 403, the same
 * answer as no credential. The token path stays first and needs no lookup. Mount BEFORE multer.
 */
export function requireOrderAccess(
  ownsOrder: (customerId: string, orderId: string) => Promise<boolean>,
  /** Set = the signed order-status link is accepted too (INSTAPAY-UPLOAD-1 part b), checked against this lookup. */
  orderStoreId?: (orderId: string) => Promise<string | null>
) {
  return async (
    req: {
      get(name: string): string | undefined;
      params: Record<string, string | undefined>;
      user?: { role?: string; userId?: string };
    },
    res: { status(code: number): { json(body: unknown): unknown } },
    next: () => void
  ): Promise<void> => {
    const orderId = req.params.orderId ?? '';
    if (!UUID_RE.test(orderId) || requestHoldsOrderViewToken(req, orderId)) return next();
    if (orderStoreId && (await requestHoldsOrderStatusLink(req, orderId, orderStoreId)))
      return next();
    const customerId = req.user?.role === 'customer' ? req.user.userId : undefined;
    let owns = false;
    if (customerId) {
      try {
        owns = await ownsOrder(customerId, orderId);
      } catch {
        owns = false;
      }
    }
    if (owns) return next();
    res.status(403).json({
      success: false,
      error: {
        code: 'ORDER_VIEW_TOKEN_REQUIRED',
        message: 'Sign in to the account that placed this order, or use the device that placed it.',
      },
    });
  };
}
