import { createHmac, timingSafeEqual } from 'crypto';
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
 *   "+965 5123 4567" → "96551234567"
 *   "0096551234567"  → "96551234567"
 *   "5123 4567"      → "96551234567"   (an 8-digit Kuwait mobile/landline)
 *
 * The 8-digit rule is the checkout's own Kuwait format
 * (`^(965)?[24569]\d{7}$`, CheckoutClient.tsx): the same shopper types the
 * number with and without the country code, and both must reach ONE consent.
 * Anything shorter than 7 digits is not a phone → null (no consent can match).
 */
export function smsConsentPhoneKey(phone: string | null | undefined): string | null {
  if (typeof phone !== 'string') return null;
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (/^[24569]\d{7}$/.test(digits)) digits = `965${digits}`;
  return digits.length >= 7 && digits.length <= 15 ? digits : null;
}

/**
 * Signed opt-out token: `<base64url(consent uuid bytes)>.<base64url(MAC[0..16])>`,
 * always exactly 45 characters (issue 2426).
 *
 * - It rides inside an SMS, where every character is billed, so the consent
 *   uuid travels as its 16 raw bytes (22 chars, not 36), the MAC is truncated
 *   to 128 bits (22 chars), and the store id is NOT in the token: the consent
 *   row carries it. 128 bits is far beyond guessing range.
 * - Keyed on a purpose-bound key derived from ENCRYPTION_KEY
 *   (`derivedSecret('fwb:sms-optout-mac:v2')`), NOT JWT_SECRET (issue 2424):
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

/** Length of every token `signSmsOptOutToken` returns (the SMS length budget relies on it). */
export const SMS_OPT_OUT_TOKEN_LENGTH = 45;

function mac(consentId: string): Buffer {
  return createHmac('sha256', derivedSecret('fwb:sms-optout-mac:v2'))
    .update(`sms-optout:v2:${consentId}`)
    .digest()
    .subarray(0, 16);
}

/** 16 canonical base64url-decoded bytes, or null. */
function canonicalBytes(part: string): Buffer | null {
  if (!B64_16.test(part)) return null;
  const bytes = Buffer.from(part, 'base64url');
  return bytes.length === 16 && bytes.toString('base64url') === part ? bytes : null;
}

export function signSmsOptOutToken(consentId: string): string {
  if (!UUID_RE.test(consentId)) throw new Error('signSmsOptOutToken: consent id is not a uuid');
  const id = consentId.toLowerCase();
  const idPart = Buffer.from(id.replace(/-/g, ''), 'hex').toString('base64url');
  return `${idPart}.${mac(id).toString('base64url')}`;
}

/** The consent id the token was issued for, or null. Never throws on input. */
export function verifySmsOptOutToken(token: unknown): string | null {
  if (typeof token !== 'string' || token.length !== SMS_OPT_OUT_TOKEN_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const idBytes = canonicalBytes(parts[0]);
  const given = canonicalBytes(parts[1]);
  if (!idBytes || !given) return null;
  const hex = idBytes.toString('hex');
  const consentId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return timingSafeEqual(given, mac(consentId)) ? consentId : null;
}
