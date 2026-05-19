/**
 * E.164 phone number validator
 *
 * Ported from WBS `backend/src/utils/phoneNumber.js` (normalizePhoneNumber).
 * WBS strips all non-digits; here we validate E.164 format for outbound
 * WhatsApp sends (Meta requires the `+` prefix and 7–15 digit international form).
 *
 * Returns the trimmed E.164 string if valid, or null if the value is
 * missing, empty, or doesn't match the format. The caller should silently
 * skip the send and log an INFO event when null is returned — many customers
 * don't enter a phone number.
 */

const E164_RE = /^\+[1-9]\d{6,14}$/;

/**
 * Validate that `phone` is a well-formed E.164 number.
 * Kuwait examples: +96512345678 (11 chars after +)
 * Returns the trimmed phone string or null.
 */
export function validateE164(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  return E164_RE.test(trimmed) ? trimmed : null;
}
