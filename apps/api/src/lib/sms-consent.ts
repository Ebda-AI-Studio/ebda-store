import { createHmac, timingSafeEqual } from 'crypto';
import { normalizeEgyptianMobile } from '@ebda/shared';
import { derivedSecret } from './derived-secret';

/**
 * Pure helpers for promotional-SMS consent (issue 206): the phone key the
 * consent gate matches on, and the signed opt-out token carried by every
 * promotional SMS.
 */

/**
 * Canonical, digits-only form of a phone number, used to match a consent row
 * to the number an SMS is about to go to.
 *
 *   "+20 10 1234 5678" → "201012345678"
 *   "0020 1012345678"  → "201012345678"
 *   "010 1234 5678"    → "201012345678"   (an Egyptian mobile, 0 + 10 digits)
 *   "1012345678"       → "201012345678"
 *
 * The Egyptian-mobile rule is the one `REGION.phone.mobileRegex` (shared with
 * the checkout form): the same shopper types the number with and without the
 * country code / trunk 0, and all of them must reach ONE consent.
 * Anything shorter than 7 digits is not a phone → null (no consent can match).
 */
export function smsConsentPhoneKey(phone: string | null | undefined): string | null {
  if (typeof phone !== 'string') return null;
  const egypt = normalizeEgyptianMobile(phone);
  if (egypt) return egypt.slice(1); // "+201012345678" → "201012345678"
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  return digits.length >= 7 && digits.length <= 15 ? digits : null;
}

/**
 * Signed opt-out token: `<base64url(consent uuid bytes)>.<base64url(MAC[0..16])>`,
 * exactly 45 characters (v2, issue 2426) or, from NEON-ZERO, 68 (v3, the store id rides in the token for a Durable Object store).
 *
 * - It rides inside an SMS, where every character is billed, so the consent
 *   uuid travels as its 16 raw bytes (22 chars, not 36), the MAC is truncated
 *   to 128 bits (22 chars), and (v2) the store id is NOT in the token: the consent
 *   row carries it. v3 adds the store id (22 chars): a Durable Object store has no
 *   cross-store id lookup to find it by. 128 bits is far beyond guessing range.
 * - Keyed on a purpose-bound key derived from ENCRYPTION_KEY
 *   (`derivedSecret('ebda:sms-optout-mac:v2')`), NOT JWT_SECRET (issue 2424):
 *   rotating the session secret signs everyone out, and must not also kill the
 *   only login-free way a guest has to stop marketing SMS. The message is
 *   still domain-separated, so a MAC here means nothing anywhere else.
 * - No expiry: an opt-out link must keep working as long as the SMS exists.
 * - No phone number in it, so the URL carries no PII.
 * - Both halves must be the CANONICAL base64url of their bytes: base64url's
 *   last character carries spare bits, and accepting a re-spelled token would
 *   give one link several valid spellings.
 *
 * v1 tokens (`<uuid>.<mac>` keyed on JWT_SECRET) are not accepted: v2 replaced
 * them while promotional SMS sending was still gated off, so no v1 link is
 * expected in any inbox (docs/RULINGS.md, SMS-6).
 */
const B64_16 = /^[A-Za-z0-9_-]{22}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Length of every v2 token (no store id). Kept for links already in inboxes; new links are v3. */
export const SMS_OPT_OUT_TOKEN_LENGTH = 45;
/** Length of every v3 token (`signSmsOptOutToken(consentId, storeId)`). */
export const SMS_OPT_OUT_TOKEN_V3_LENGTH = 68;

function mac(consentId: string, storeId?: string): Buffer {
  return createHmac('sha256', derivedSecret('ebda:sms-optout-mac:v2'))
    .update(storeId ? `sms-optout:v3:${consentId}:${storeId}` : `sms-optout:v2:${consentId}`)
    .digest()
    .subarray(0, 16);
}

/** 16 canonical base64url-decoded bytes, or null. */
function canonicalBytes(part: string): Buffer | null {
  if (!B64_16.test(part)) return null;
  const bytes = Buffer.from(part, 'base64url');
  return bytes.length === 16 && bytes.toString('base64url') === part ? bytes : null;
}

const uuidOf = (bytes: Buffer): string => {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const bytesOf = (uuid: string): string =>
  Buffer.from(uuid.replace(/-/g, ''), 'hex').toString('base64url');

/**
 * With `storeId` the token is v3 (`<id>.<store>.<mac>`, 68 chars): the store rides in the link and the MAC covers it, so the
 * unsubscribe endpoint reads the consent row from THAT store's Durable Object (no cross-store id lookup exists there). Without
 * it the token is the legacy v2 (45 chars, store looked up through Postgres).
 */
export function signSmsOptOutToken(consentId: string, storeId?: string): string {
  if (!UUID_RE.test(consentId)) throw new Error('signSmsOptOutToken: consent id is not a uuid');
  if (storeId !== undefined && !UUID_RE.test(storeId))
    throw new Error('signSmsOptOutToken: store id is not a uuid');
  const id = consentId.toLowerCase();
  if (storeId === undefined) return `${bytesOf(id)}.${mac(id).toString('base64url')}`;
  const store = storeId.toLowerCase();
  return `${bytesOf(id)}.${bytesOf(store)}.${mac(id, store).toString('base64url')}`;
}

/** The consent id (and the store id of a v3 token) the token was issued for, or null. Never throws on input. */
export function parseSmsOptOutToken(
  token: unknown
): { consentId: string; storeId: string | null } | null {
  if (typeof token !== 'string') return null;
  if (token.length !== SMS_OPT_OUT_TOKEN_LENGTH && token.length !== SMS_OPT_OUT_TOKEN_V3_LENGTH)
    return null;
  const parts = token.split('.');
  if (parts.length !== (token.length === SMS_OPT_OUT_TOKEN_LENGTH ? 2 : 3)) return null;
  const bytes = parts.map(canonicalBytes);
  if (bytes.some(b => b === null)) return null;
  const consentId = uuidOf(bytes[0]!);
  const storeId = bytes.length === 3 ? uuidOf(bytes[1]!) : null;
  const given = bytes[bytes.length - 1]!;
  return timingSafeEqual(given, mac(consentId, storeId ?? undefined))
    ? { consentId, storeId }
    : null;
}

/** The consent id the token was issued for, or null. Never throws on input. */
export function verifySmsOptOutToken(token: unknown): string | null {
  return parseSmsOptOutToken(token)?.consentId ?? null;
}
