/**
 * Contact masking for surfaces whose output leaves the platform — the
 * merchant MCP tools feed a third-party LLM's context, so a customer's
 * contact details are masked there by default even though the merchant may
 * see them in full on the dashboard.
 *
 * Enough survives for the merchant to recognise a customer ("the one ending
 * 1234 at gmail"), not enough to contact them from a transcript.
 */

/**
 * `+96512345678` → `+965 ****5678`; `9876 5432` → `****5432`.
 * A leading `+` keeps its (up to 3-digit) country code. Fewer than 5 digits
 * masks everything. Empty/nullish input returns null (unknown, not "").
 */
export function maskPhone(phone: string | null | undefined): string | null {
  if (typeof phone !== 'string' || phone.trim() === '') return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 5) return '****';
  const last4 = digits.slice(-4);
  if (phone.trim().startsWith('+') && digits.length > 8) {
    const cc = digits.slice(0, Math.min(3, digits.length - 8));
    return `+${cc} ****${last4}`;
  }
  return `****${last4}`;
}

/**
 * `ahmad@gmail.com` → `a***@gmail.com`. No `@` masks everything.
 * Empty/nullish input returns null.
 */
export function maskEmail(email: string | null | undefined): string | null {
  if (typeof email !== 'string' || email.trim() === '') return null;
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

/**
 * Address JSON keys that locate the customer's door (street, block, building,
 * flat, free-text lines, coordinates) — removed. The locality keys an agent
 * needs to reason about delivery (area, governorate, city, country) and the
 * name stay; phone/email are masked, not removed, so "is there a contact on
 * file" is still answerable.
 */
const STREET_LEVEL_KEYS = new Set([
  'address1',
  'address2',
  'street',
  'block',
  'building',
  'house',
  'floor',
  'apartment',
  'flat',
  'avenue',
  'jadda',
  'paci',
  'postalCode',
  'lat',
  'lng',
  'latitude',
  'longitude',
  'notes',
  'directions',
]);

export function maskAddress(address: unknown): Record<string, unknown> | null {
  if (!address || typeof address !== 'object' || Array.isArray(address)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(address as Record<string, unknown>)) {
    if (STREET_LEVEL_KEYS.has(k)) continue;
    if (k === 'phone') out.phone = maskPhone(typeof v === 'string' ? v : null);
    else if (k === 'email') out.email = maskEmail(typeof v === 'string' ? v : null);
    else out[k] = v;
  }
  return out;
}
