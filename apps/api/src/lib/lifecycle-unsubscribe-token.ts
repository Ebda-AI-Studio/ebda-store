import { createHmac, timingSafeEqual } from 'crypto';
import { config } from '../config';
import { derivedSecret } from './derived-secret';

/**
 * Signed one-click unsubscribe token for the self-serve lifecycle emails:
 *
 *   token = <storeId>.<base64url(HMAC-SHA256(secret, "lifecycle-unsubscribe:v1:<storeId>"))>
 *
 * Same design as `campaign-unsubscribe-token.ts`: the store travels IN the signed token (so the public
 * route opens a tenant-scoped transaction without an RLS bypass), the message is domain-separated so a
 * MAC valid here means nothing elsewhere, there is no expiry (an unsubscribe link must work for as long
 * as the email sits in an inbox) and no address in the URL. Signing key: a purpose-bound key derived
 * from ENCRYPTION_KEY (`derived-secret.ts`), so no new env var; JWT_SECRET is NOT involved.
 */
function signingKey(): Buffer {
  return derivedSecret('ebda:lifecycle-unsubscribe-mac:v1');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mac(key: Buffer, storeId: string): Buffer {
  return createHmac('sha256', key).update(`lifecycle-unsubscribe:v1:${storeId}`).digest();
}

export function signLifecycleUnsubscribeToken(storeId: string): string {
  return `${storeId}.${mac(signingKey(), storeId).toString('base64url')}`;
}

/** The store id the token was issued for, or null for anything malformed, tampered or foreign. */
export function verifyLifecycleUnsubscribeToken(token: unknown): { storeId: string } | null {
  if (typeof token !== 'string' || token.length > 120) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [storeId, sig] = parts;
  if (!UUID_RE.test(storeId) || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return null;
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== 32) return null;
  if (timingSafeEqual(given, mac(signingKey(), storeId))) return { storeId };
  return null;
}

/** The public unsubscribe page the email links to (GET shows a confirm button, POST does it). */
export function lifecycleUnsubscribeUrl(storeId: string): string {
  const base = (config.apiUrl ?? '').replace(/\/$/, '');
  return `${base}/api/v1/public/lifecycle-emails/unsubscribe?token=${encodeURIComponent(signLifecycleUnsubscribeToken(storeId))}`;
}
