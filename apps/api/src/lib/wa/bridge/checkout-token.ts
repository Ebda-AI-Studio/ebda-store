import { createHmac, timingSafeEqual } from 'crypto';
import { derivedSecret } from '../../derived-secret';

/**
 * Signed 30-minute token behind `/cart/from-wa?t=` (contract section 5, Ruling WA-RPC-3). Carries variant ids and quantities
 * ONLY (never a price): the Store re-prices the cart when the link is redeemed. Bound to the store and the buyer key, domain
 * separated (`wa-checkout:v1:`), HMAC-SHA256, no PII. Redeem route: verifyCheckoutToken (follow-up, see the ruling).
 *   token = base64url(JSON payload) . base64url(HMAC)
 */
export const CHECKOUT_TTL_MS = 30 * 60 * 1000;

export interface CheckoutPayload {
  storeId: string;
  items: Array<{ variantId: string; quantity: number }>;
  buyerKey: string;
}

const mac = (body: string) =>
  createHmac('sha256', derivedSecret('ebda:wa-checkout-mac:v1'))
    .update(`wa-checkout:v1:${body}`)
    .digest();

export function signCheckoutToken(p: CheckoutPayload, now: number = Date.now()): string {
  const body = Buffer.from(
    JSON.stringify({ ...p, exp: Math.floor((now + CHECKOUT_TTL_MS) / 1000) })
  ).toString('base64url');
  return `${body}.${mac(body).toString('base64url')}`;
}

export function verifyCheckoutToken(
  token: unknown,
  now: number = Date.now()
): (CheckoutPayload & { exp: number }) | null {
  if (typeof token !== 'string' || token.length > 4000) return null;
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const want = mac(body);
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as CheckoutPayload & {
      exp: number;
    };
    return typeof p.exp === 'number' && p.exp * 1000 > now ? p : null;
  } catch {
    return null;
  }
}
