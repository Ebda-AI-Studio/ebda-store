/**
 * Contact masking for surfaces whose output leaves the platform:
 *  - the merchant MCP tools feed a third-party LLM's context, so a customer's
 *    contact details are masked there by default even though the merchant may
 *    see them in full on the dashboard;
 *  - application logs ship to the off-platform log drain (Axiom, 30-day
 *    retention), so every email / phone / recipient field passed to a logger
 *    call goes through these helpers (issue 2390). Enforced by
 *    tests/unit/no-raw-pii-in-logs.test.ts.
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
 * A recipient field that may be one address or a list (`EmailOptions.to`).
 * Each address is masked with `maskEmail`. Empty/nullish input returns null.
 */
export function maskEmailList(
  to: string | readonly string[] | null | undefined
): string | (string | null)[] | null {
  if (Array.isArray(to)) return to.map(maskEmail);
  return maskEmail(to as string | null | undefined);
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

/**
 * Shopper-authored free text (order `notes` / `customerNotes`) is where Kuwait
 * shoppers type street directions and a callback number — a field no schema
 * constrains. Redact anything shaped like a phone number (a run of 8+ digits,
 * spaces/dashes allowed between them, optional leading `+`) or an email
 * address; the rest of the note (delivery-time wishes, gift messages) stays
 * readable. Empty/nullish input returns null.
 */
// 8+ digits (a Kuwait mobile is 8; with +965 it is 11), spaces/hyphens
// allowed between them — but NOT an ISO date (`2026-09-30`, 8 digits) or a
// short order/building number, which a triage agent needs to read (PR 2301
// audit P3). Dates are masked out before the phone pass, and a digit run
// glued to a letter or hyphen (`ORD-20260930-001`) is a reference, not a phone.
const PHONE_LIKE = /(?<![A-Za-z0-9-])\+?\d(?:[\s-]?\d){7,}(?![A-Za-z0-9])/g;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/g;

export function redactFreeText(text: string | null | undefined): string | null {
  if (typeof text !== 'string' || text.trim() === '') return null;
  const dates: string[] = [];
  const shielded = text.replace(ISO_DATE, d => `\u0000${dates.push(d) - 1}\u0000`);
  return shielded
    .replace(EMAIL_LIKE, '[email]')
    .replace(PHONE_LIKE, '[phone]')
    .replace(/\u0000(\d+)\u0000/g, (_m, i) => dates[Number(i)]);
}
