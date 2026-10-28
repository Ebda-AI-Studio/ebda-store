/**
 * The suite-wide buyer key (Ebda Store <-> Ebda WhatsApp contract, section 6; CI-1): a lowercase-hex
 * HMAC-SHA256 of the buyer's E.164 phone, keyed with SUITE_BUYER_KEY_SECRET (the same secret in
 * every suite Worker). The raw phone never enters analytics or CI; only this key does.
 *
 * Both functions are the contract's normaliser and hash. A change to either changes every key, so
 * `tests/unit/buyer-key.test.ts` pins the contract's test vector.
 */

const E164 = /^\+[1-9]\d{7,14}$/;
// LRM/RLM, ALM, embeddings/overrides and isolates that WhatsApp's RTL UI adds around numbers.
const BIDI_MARKS = /[\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069]/g;

/** Egyptian fixed-line area codes (without the trunk 0): Cairo/Giza 2, Alexandria 3 and the governorate codes. */
const EG_AREA_3 = new Set([
  '13',
  '15',
  '40',
  '45',
  '46',
  '47',
  '48',
  '50',
  '55',
  '57',
  '62',
  '64',
  '65',
  '66',
  '68',
  '69',
  '82',
  '84',
  '86',
  '88',
  '92',
  '93',
  '95',
  '96',
  '97',
]);

/**
 * Is `national` (trunk 0 + digits, nothing else) a valid Egyptian number? Mobile `01[0125]` + 8 digits
 * (11 digits); Cairo/Giza `02` + 8; Alexandria `03` + 7; a governorate code (`EG_AREA_3`) + 7.
 */
export function isEgyptianNational(national: string): boolean {
  if (/^01[0125]\d{8}$/.test(national)) return true;
  if (/^02\d{8}$/.test(national)) return true;
  if (/^03\d{7}$/.test(national)) return true;
  const m = /^0(\d{2})\d{7}$/.exec(national);
  return !!m && EG_AREA_3.has(m[1]!);
}

function asciiDigits(s: string): string {
  return s
    .replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, d => String(d.charCodeAt(0) - 0x06f0));
}

/** Bumped when SUITE_BUYER_KEY_SECRET is rotated (CI envelope `keyVersion`). */
export const BUYER_KEY_VERSION = 1;

/**
 * Any phone a shopper typed -> E.164, or null when it cannot be one. THIS IS EBDA WHATSAPP'S
 * `normaliseE164` (src/core/phone.ts), line for line: two normalisers that differ give one customer two
 * keys (audit CODE-10). Do not "improve" it here; change both repos together and re-run the shared
 * vectors (tests/unit/buyer-key-vectors.test.ts).
 *
 * Without a `+`/`00` prefix only Egyptian forms are accepted: national `0...`, `20...` (12 digits) or a
 * 10-digit mobile typed without its leading 0. Anything else returns null rather than guessing a
 * country. (The Store's STORAGE format, `normalizePhoneForStorage`, is a different thing and unchanged,
 * Ruling FDN-PHONE-1; only the buyer-key input goes through this.)
 */
export function toE164(raw: string | null | undefined, defaultCountry: '20' = '20'): string | null {
  if (!raw) return null;
  let s = asciiDigits(raw.replace(BIDI_MARKS, '')).replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (!s.startsWith('+')) {
    if (s.startsWith('0')) {
      // Ruling PHONE-2: a national 0... number is Egyptian ONLY if it is a valid Egyptian number;
      // otherwise null (a UK 07911..., a Saudi 050... is never read as +20).
      if (!isEgyptianNational(s)) return null;
      s = `+${defaultCountry}${s.slice(1)}`;
    } else if (s.startsWith(defaultCountry) && s.length === 12) {
      // `20` + 10 digits: valid only if those digits are a valid Egyptian number (PHONE-2).
      if (!isEgyptianNational(`0${s.slice(defaultCountry.length)}`)) return null;
      s = '+' + s;
    } else if (/^1\d{9}$/.test(s)) {
      // a mobile typed without its leading 0: valid only as 01[0125] + 8 (PHONE-2).
      if (!isEgyptianNational(`0${s}`)) return null;
      s = `+${defaultCountry}${s}`;
    } else return null;
  }
  // A trunk 0 kept after the country code (+20 0100...) is dropped.
  if (s.startsWith(`+${defaultCountry}0`)) {
    s = `+${defaultCountry}${s.slice(defaultCountry.length + 2)}`;
  }
  return E164.test(s) ? s : null;
}

/** `HMAC-SHA256(secret, e164)` as lowercase hex, or null for a phone that is not E.164. */
export async function buyerKeyFor(
  secret: string,
  phone: string | null | undefined
): Promise<string | null> {
  if (!secret) throw new Error('SUITE_BUYER_KEY_SECRET is required to compute a buyer key');
  const e164 = toE164(phone);
  if (!e164) return null;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(e164)));
  return [...sig].map(b => b.toString(16).padStart(2, '0')).join('');
}
