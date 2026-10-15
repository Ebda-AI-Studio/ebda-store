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
 * `+201012345678` → `+201 ****5678`; `0101 2345 678` → `****5678`.
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

/** Longest free text `scrubEmails` looks at; the rest is dropped BEFORE matching (bounded cost). */
export const SCRUB_EMAILS_MAX = 2000;

/**
 * Every spelling of "@" a mail provider (or an HTML/URL/JSON/MIME rendering of its text) may
 * use, for DETECTION: `@`, fullwidth U+FF20, small U+FE6B, `%40` (also double-encoded
 * `%2540`), `&#64` / `&#x40` (semicolon optional), `&commat;`, `&amp;`-wrapped entities,
 * quoted-printable `=40` (only before a domain-looking run: `limit=40` stays text), and the
 * escapes `\u0040`, `\x40`, `%u0040`.
 */
const AT_SRC = [
  '@',
  '\uFF20',
  '\uFE6B',
  '%(?:25)*40',
  '%u0040',
  '&(?:amp;)*(?:#0*64(?!\\d)|#x0*40(?![0-9a-f])|commat)(?:;)?',
  '\\\\u0*0040',
  '\\\\x40',
  '=40(?=[\\p{L}\\p{M}\\p{N}-]+\\.[\\p{L}\\p{M}\\p{N}])',
].join('|');
const AT_FORMS = new RegExp(AT_SRC, 'iu');
const AT_ENCODED = new RegExp(AT_SRC, 'giu');
/** `local @ domain`: spaces around any "@" form are dropped so the pair is read as one address. */
const SPACED_AT = new RegExp(`(?<=\\S)[\\p{Zs}\\t]*(?:${AT_SRC})[\\p{Zs}\\t]*(?=\\S)`, 'giu');
/**
 * A quoted local part (`"john doe"@x.com`, escaped quotes, any length): it may hold spaces, so
 * tokens alone miss it. Linear: the two alternatives of the body cannot match the same char.
 */
const QUOTED_LOCAL = new RegExp(`"(?:[^"\\\\\\r\\n]|\\\\.)*"(?=[\\p{Zs}\\t]*(?:${AT_SRC}))`, 'giu');
/** The ONLY address shape we split: dot-atom local part, dotted domain, one "@". */
const CLEAN_ADDRESS =
  /^([\p{L}\p{M}\p{N}._+*-]+)@([\p{L}\p{M}\p{N}-]+(?:\.[\p{L}\p{M}\p{N}-]+)+)$/u;

/** Case-insensitive replace-all with no index arithmetic (lowercasing `İ` changes the length). */
function caseInsensitiveReplaceAll(text: string, needle: string, by: string): string {
  if (!needle) return text;
  const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  return text.replace(re, () => by);
}

/**
 * One whitespace-free token that carries an "@" form. FAIL CLOSED: the token is split into
 * addresses only when every comma/semicolon-separated piece is either free of "@" or, once its
 * wrapping punctuation (`<>()[]"'`, `mailto:`, a trailing `.`/`:`) is set aside, a CLEAN_ADDRESS.
 * Anything a mail parser could read differently (two "@", a quoted or commented local part,
 * `a(x)@b.com`, `x<a@b.com>`, an "@" with no dotted domain) is replaced WHOLE by `***`, so no
 * local-part character beyond the first survives a split we are not sure of.
 */
function maskAddressToken(tok: string): string {
  const norm = tok.replace(AT_ENCODED, '@');
  const pieces = norm.split(/([,;])/);
  const out: string[] = [];
  for (const piece of pieces) {
    if (piece === ',' || piece === ';' || !piece.includes('@')) {
      out.push(piece);
      continue;
    }
    const lead = /^[<(["']*(?:mailto:)?/i.exec(piece)![0];
    const trail = /[>)\]"'.:!?]*$/.exec(piece.slice(lead.length))![0];
    const core = piece.slice(lead.length, piece.length - trail.length);
    const m = CLEAN_ADDRESS.exec(core);
    if (!m) return '***';
    out.push(`${lead}${Array.from(m[1])[0]}***@${m[2]}${trail}`);
  }
  return out.join('');
}

/**
 * Email addresses in free text (provider error text) replaced by their masked form, before it is
 * stored or shown. Hardened after commit security scans (parser differential, local-part split):
 *  1. the input is cut to SCRUB_EMAILS_MAX BEFORE any matching, so cost is bounded;
 *  2. the `known` recipient addresses are replaced first, exact and case-insensitive;
 *  3. spaces around an "@" form are dropped (`jane.doe @ gmail.com` is one address), then a
 *     quoted local part (`"john doe"@x.com`, escaped quotes, any length) is masked whole;
 *  4. every whitespace-delimited token holding any "@" form (see AT_SRC: fullwidth, `%2540`,
 *     `&#64`, `=40`, `\\x40` ..., incl. `mailto:` and unicode/IDN) goes through maskAddressToken, which keeps
 *     only `x***@domain` for an unambiguous address and otherwise masks the WHOLE token.
 * One linear pass over tokens: no nested quantifiers, no backtracking blow-up. Broad and
 * fail-closed on purpose: a false positive costs a masked word, a miss costs an address.
 */
export function scrubEmails(
  text: string,
  known: ReadonlyArray<string | null | undefined> = []
): string {
  let s = text.length > SCRUB_EMAILS_MAX ? text.slice(0, SCRUB_EMAILS_MAX) : text;
  for (const k of known) {
    if (k && k.trim()) s = caseInsensitiveReplaceAll(s, k.trim(), maskEmail(k.trim()) ?? '***');
  }
  s = s.replace(SPACED_AT, m => m.trim());
  s = s.replace(QUOTED_LOCAL, '"***"');
  return s.replace(/\S+/g, tok => (AT_FORMS.test(tok) ? maskAddressToken(tok) : tok));
}

/**
 * `203.0.113.45` -> `203.0.113.*`; `2001:db8:1:2:3:4:5:6` -> `2001:db8:1:2:*`; an IPv4-mapped
 * IPv6 (`::ffff:203.0.113.45`) is masked as its IPv4. Enough to recognise a network on a
 * super-admin evidence screen, not to single out a device. Empty/nullish input returns null.
 */
export function maskIp(ip: string | null | undefined): string | null {
  if (typeof ip !== 'string' || ip.trim() === '') return null;
  const v = ip.trim().replace(/^::ffff:/i, '');
  const v4 = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(v);
  if (v4) return `${v4[1]}.*`;
  if (v.includes(':')) {
    const groups = v.split(':').filter(Boolean).slice(0, 4);
    return groups.length > 0 ? `${groups.join(':')}:*` : '*';
  }
  return '*';
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
 * Shopper-authored free text (order `notes` / `customerNotes`) is where Egyptian
 * shoppers type street directions and a callback number — a field no schema
 * constrains. Redact anything shaped like a phone number (a run of 8+ digits,
 * spaces/dashes allowed between them, optional leading `+`) or an email
 * address; the rest of the note (delivery-time wishes, gift messages) stays
 * readable. Empty/nullish input returns null.
 */
// 8+ digits (an Egyptian mobile is 11 digits locally; with +20 it is 12), spaces/hyphens
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
