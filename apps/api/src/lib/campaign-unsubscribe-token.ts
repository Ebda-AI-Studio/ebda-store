import { createHmac, timingSafeEqual } from 'crypto';
import { config } from '../config';

/**
 * Signed one-click unsubscribe token for campaign emails.
 *
 *   token = <storeId>.<recipientId>.<base64url(HMAC-SHA256(secret, "campaign-unsubscribe:v1:<storeId>:<recipientId>"))>
 *
 * - The store travels IN the token so the public endpoint can open a
 *   tenant-scoped transaction (`runInTenantContext(storeId)`) without an RLS
 *   bypass, and the signature covers it, so a token for store A cannot be
 *   replayed against store B's recipient.
 * - The message is domain-separated (`campaign-unsubscribe:v1:`) because the
 *   fallback secret is JWT_SECRET, which also signs session tokens and review
 *   links; a MAC valid here must mean nothing anywhere else.
 * - No expiry: an unsubscribe link must keep working for as long as the email
 *   sits in someone's inbox.
 * - No email address in the token, so the URL (and any access log that
 *   records it) carries no PII.
 *
 * Secret precedence: CAMPAIGN_UNSUBSCRIBE_SECRET → JWT_SECRET, the same shape
 * as REVIEW_TOKEN_SECRET in `review-token.ts`.
 */
const SECRET = () => process.env.CAMPAIGN_UNSUBSCRIBE_SECRET || config.jwtSecret;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mac(storeId: string, recipientId: string): Buffer {
  return createHmac('sha256', SECRET())
    .update(`campaign-unsubscribe:v1:${storeId}:${recipientId}`)
    .digest();
}

export function signUnsubscribeToken(storeId: string, recipientId: string): string {
  return `${storeId}.${recipientId}.${mac(storeId, recipientId).toString('base64url')}`;
}

/**
 * Returns the ids the token was issued for, or null for anything malformed,
 * tampered, or signed with another secret. Never throws.
 */
export function verifyUnsubscribeToken(
  token: unknown
): { storeId: string; recipientId: string } | null {
  if (typeof token !== 'string' || token.length > 200) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [storeId, recipientId, sig] = parts;
  if (!UUID_RE.test(storeId) || !UUID_RE.test(recipientId)) return null;
  if (!/^[A-Za-z0-9_-]{43}$/.test(sig)) return null;

  const expected = mac(storeId, recipientId);
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length) return null;
  return timingSafeEqual(given, expected) ? { storeId, recipientId } : null;
}
