import { createHmac, timingSafeEqual } from 'crypto';
import { config } from '../config';

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
 * Signed opt-out token: `<consentId>.<base64url(HMAC-SHA256(...)[0..16])>`.
 *
 * - It rides inside an SMS, where every character costs, so the MAC is
 *   truncated to 128 bits (22 chars) and the store id is NOT in the token:
 *   the consent row carries it. 128 bits is far beyond guessing range.
 * - Domain-separated (`sms-optout:v1:`) because the secret is JWT_SECRET,
 *   which also signs sessions; a MAC valid here means nothing anywhere else.
 * - No expiry: an opt-out link must keep working as long as the SMS exists.
 * - No phone number in it, so the URL carries no PII.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mac(consentId: string): Buffer {
  return createHmac('sha256', config.jwtSecret)
    .update(`sms-optout:v1:${consentId}`)
    .digest()
    .subarray(0, 16);
}

export function signSmsOptOutToken(consentId: string): string {
  return `${consentId}.${mac(consentId).toString('base64url')}`;
}

/** The consent id the token was issued for, or null. Never throws. */
export function verifySmsOptOutToken(token: unknown): string | null {
  if (typeof token !== 'string' || token.length > 100) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [consentId, sig] = parts;
  if (!UUID_RE.test(consentId) || !/^[A-Za-z0-9_-]{22}$/.test(sig)) return null;
  const expected = mac(consentId);
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length) return null;
  return timingSafeEqual(given, expected) ? consentId : null;
}
