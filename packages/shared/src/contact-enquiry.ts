/**
 * Ebda AI Studio service-enquiry form: the contract shared by the marketing page (`/contact`, `/en/contact`) and the
 * API (`POST /public/contact/enquiry`). Zero dependencies on purpose: the marketing bundle imports it, so no zod here
 * (the API validates with zod against these same constants). Ruling CONTACT-FORM-1.
 */
import { BRAND } from './brand';
import { toAsciiDigits } from './ascii-digits';

/** What the visitor needs: the two products' support, each of the three studio services (ids from BRAND.services), other. */
export const CONTACT_TOPIC_IDS = [
  'store-support',
  'chat-support',
  ...BRAND.services.map(s => s.id),
  'other',
] as const;
export type ContactTopicId = (typeof CONTACT_TOPIC_IDS)[number];

const SERVICE_LABELS = Object.fromEntries(BRAND.services.map(s => [s.id, { ar: s.ar, en: s.en }]));
export const CONTACT_TOPIC_LABELS = {
  'store-support': { ar: 'دعم ابدأ ستور', en: 'Ebda Store support' },
  'chat-support': { ar: 'دعم ابدأ شات', en: 'Ebda Chat support' },
  ...SERVICE_LABELS,
  other: { ar: 'حاجة تانية', en: 'Something else' },
} as Record<ContactTopicId, { ar: string; en: string }>;

export const CONTACT_LIMITS = {
  name: 100,
  company: 120,
  phone: 40,
  email: 254,
  messageMin: 10,
  message: 4000,
} as const;

/** Honeypot field name (CSS-hidden, never labelled for people) and the minimum time the page must have been open. */
export const CONTACT_HONEYPOT_FIELD = 'website';
export const CONTACT_MIN_FILL_MS = 2500;
/** Field codes the API returns and the page localises; never user text. */
export type ContactFieldError =
  | 'required'
  | 'too_long'
  | 'too_short'
  | 'invalid_email'
  | 'invalid_phone'
  | 'invalid_topic'
  | 'consent_required';

/**
 * Normalise a phone number to E.164. Egyptian mobiles (01[0125]xxxxxxxx, +20 1xx..., 0020..., spaces/dashes/Arabic digits)
 * become `+201xxxxxxxxx`; any other international number must already start with `+` and carry 8-15 digits. Else null.
 */
export function normalizePhone(raw: string): string | null {
  const s = toAsciiDigits(raw).replace(/[\s\-().‎‏‪-‮]/g, '');
  const eg = /^(?:\+?20|0020)?0?(1[0125]\d{8})$/.exec(s);
  if (eg) return `+20${eg[1]}`;
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}

/** The site's number formatting (matches `whatsappDisplay()`): `+201012345678` -> `+20 101 234 5678`. */
export function formatPhoneDisplay(e164: string): string {
  return e164.replace(/^\+20(\d{3})(\d{3})(\d{4})$/, '+20 $1 $2 $3');
}

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;
export function normalizeEmail(raw: string): string | null {
  const e = raw.trim().toLowerCase();
  return e.length <= CONTACT_LIMITS.email && EMAIL_RE.test(e) ? e : null;
}
