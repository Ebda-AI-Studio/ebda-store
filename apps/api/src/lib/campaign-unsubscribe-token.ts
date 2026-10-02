import { createHmac, timingSafeEqual } from 'crypto';
import { config } from '../config';
import { derivedSecret } from './derived-secret';

/**
 * Signed one-click unsubscribe token for campaign emails.
 *
 *   token = <storeId>.<recipientId>.<base64url(HMAC-SHA256(secret, "campaign-unsubscribe:v1:<storeId>:<recipientId>"))>
 *
 * - The store travels IN the token so the public endpoint can open a
 *   tenant-scoped transaction (`runInTenantContext(storeId)`) without an RLS
 *   bypass, and the signature covers it, so a token for store A cannot be
 *   replayed against store B's recipient.
 * - The message is domain-separated (`campaign-unsubscribe:v1:`) so a MAC
 *   valid here means nothing anywhere else, whichever key signed it.
 * - No expiry: an unsubscribe link must keep working for as long as the email
 *   sits in someone's inbox.
 * - No email address in the token, so the URL (and any access log that
 *   records it) carries no PII.
 *
 * Signing key: CAMPAIGN_UNSUBSCRIBE_SECRET when set, else a purpose-bound key
 * derived from ENCRYPTION_KEY (`lib/derived-secret.ts`, issue 2424). It used to
 * fall back to JWT_SECRET, so rotating the SESSION secret silently killed the
 * unsubscribe link in every campaign email already sent.
 *
 * Verify keys: the signing key, plus — only when no dedicated secret is set —
 * JWT_SECRET, so links signed before issue 2424 keep working until the next
 * JWT_SECRET rotation (after which they would have died anyway). New links no
 * longer depend on it.
 */
function signingKey(): string | Buffer {
  return (
    process.env.CAMPAIGN_UNSUBSCRIBE_SECRET || derivedSecret('fwb:campaign-unsubscribe-mac:v1')
  );
}

function verifyKeys(): Array<string | Buffer> {
  const dedicated = process.env.CAMPAIGN_UNSUBSCRIBE_SECRET;
  return dedicated
    ? [dedicated]
    : [derivedSecret('fwb:campaign-unsubscribe-mac:v1'), config.jwtSecret];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mac(key: string | Buffer, storeId: string, recipientId: string): Buffer {
  return createHmac('sha256', key)
    .update(`campaign-unsubscribe:v1:${storeId}:${recipientId}`)
    .digest();
}

export function signUnsubscribeToken(storeId: string, recipientId: string): string {
  return `${storeId}.${recipientId}.${mac(signingKey(), storeId, recipientId).toString('base64url')}`;
}

/**
 * Returns the ids the token was issued for, or null for anything malformed,
 * tampered, or signed with another secret. Never throws on input (only on a
 * missing ENCRYPTION_KEY outside production, see `derivedSecret`).
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

  const given = Buffer.from(sig, 'base64url');
  if (given.length !== 32) return null;
  for (const key of verifyKeys()) {
    if (timingSafeEqual(given, mac(key, storeId, recipientId))) return { storeId, recipientId };
  }
  return null;
}
