import { createHmac, timingSafeEqual } from 'crypto';
import { derivedSecret } from './derived-secret';

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
 * TEN-5 (2026-11-12 audit): route guard for the guest InstaPay WRITES (`receipt` upload, `submit`). The order UUID
 * alone is not a credential (it leaks through history, screenshots, shared links); anyone holding it could upload a
 * receipt or submit fields and freeze another shopper's hold. Same signed token the reads already use. Mount it
 * BEFORE multer so a refused request never buffers an upload. Bad/missing UUID falls through to the handler's own
 * zod 400.
 */
export function requireOrderViewToken(
  req: { get(name: string): string | undefined; params: Record<string, string | undefined> },
  res: {
    status(code: number): { json(body: unknown): unknown };
  },
  next: () => void
): void {
  const orderId = req.params.orderId ?? '';
  if (!UUID_RE.test(orderId) || requestHoldsOrderViewToken(req, orderId)) return next();
  res.status(403).json({
    success: false,
    error: {
      code: 'ORDER_VIEW_TOKEN_REQUIRED',
      message: 'This order can only be changed from the device that placed it.',
    },
  });
}
