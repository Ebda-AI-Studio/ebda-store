import { createHmac, timingSafeEqual } from 'crypto';
import { derivedSecret } from './derived-secret';

/**
 * Signed, expiring link that re-attaches ONE cart to whoever opens it (the cart-recovery email's
 * button), including guests, who have no account to sign in to.
 *
 *   token = <storeId>.<cartId>.<expiresAtEpochSeconds>.<base64url(HMAC-SHA256(key, "cart-restore:v1:<storeId>:<cartId>:<exp>"))>
 *
 * - Store-scoped and single-cart: the MAC covers both ids, so a token for store A / cart 1 names
 *   nothing else. The store travels in the token so the storefront can be asked for the restore
 *   on any host.
 * - No PII: two UUIDs and an expiry. No email address, no session id.
 * - Expires (7 days): unlike an unsubscribe link, a cart link should die; the snapshot is stale
 *   after that and the cart row is purged by retention anyway.
 * - Domain-separated (`cart-restore:v1:`) with its own HKDF label, so no other token's MAC means
 *   anything here.
 * - It is a capability for the CART'S LINES only: the restore endpoint copies lines into the
 *   visitor's own session cart. It never reveals the source cart's session id.
 */
export const CART_RESTORE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function key(): string | Buffer {
  return process.env.CART_RESTORE_SECRET || derivedSecret('ebda:cart-restore-mac:v1');
}

function mac(k: string | Buffer, storeId: string, cartId: string, exp: number): Buffer {
  return createHmac('sha256', k).update(`cart-restore:v1:${storeId}:${cartId}:${exp}`).digest();
}

export function signCartRestoreToken(
  storeId: string,
  cartId: string,
  now: number = Date.now()
): string {
  const exp = Math.floor((now + CART_RESTORE_TTL_MS) / 1000);
  return `${storeId}.${cartId}.${exp}.${mac(key(), storeId, cartId, exp).toString('base64url')}`;
}

/** The ids the token was issued for, or null for anything malformed, tampered or expired. */
export function verifyCartRestoreToken(
  token: unknown,
  now: number = Date.now()
): { storeId: string; cartId: string } | null {
  if (typeof token !== 'string' || token.length > 200) return null;
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [storeId, cartId, expRaw, sig] = parts;
  if (!UUID_RE.test(storeId) || !UUID_RE.test(cartId)) return null;
  if (!/^\d{1,12}$/.test(expRaw)) return null;
  if (!/^[A-Za-z0-9_-]{43}$/.test(sig)) return null;
  const exp = Number(expRaw);
  if (exp * 1000 < now) return null;
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== 32) return null;
  return timingSafeEqual(given, mac(key(), storeId, cartId, exp)) ? { storeId, cartId } : null;
}
